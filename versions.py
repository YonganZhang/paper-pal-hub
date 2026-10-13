"""Per-paper immutable, self-contained snapshots; explicit publication, never source restore."""
import asyncio
import difflib
import fcntl
import functools
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import web

TEXT = {'.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.txt', '.py', '.js', '.mjs', '.json', '.yaml', '.yml', '.csv', '.sh', '.drawio', '.svg'}
IMAGES = {'.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf'}
SOURCE = {'.tex', '.bib', '.sty', '.cls', '.bst', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf', '.eps'}
VERSION = re.compile(r'^v(0|[1-9]\d*)\.0$')
SKIP = {'.git', '.paper-pal', '.draft-review', 'node_modules', '__pycache__', '_archive', '_drafts', '_snapshots'}
MAX_TOTAL = 2 * 1024**3


class ArchiveError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def contained(repo, name):
    value = Path(name)
    if value.is_absolute() or '..' in value.parts or '\\' in str(name) or '\x00' in str(name):
        raise ArchiveError('文件路径必须位于当前论文目录内。')
    target = (repo / value).resolve()
    if not target.is_relative_to(repo) or target == repo:
        raise ArchiveError('文件路径越出了当前论文目录。')
    return target


def digest_file(path):
    path = Path(path)
    stat = path.stat()
    return _digest_cached(str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


@functools.lru_cache(maxsize=8192)
def _digest_cached(name, size, modified, changed):
    path = Path(name)
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_config(repo):
    value = json.loads((repo / '.paper-pal.json').read_text())
    if not isinstance(value, dict):
        raise ArchiveError('论文配置不是对象。')
    return value


def inventory(repo, config):
    """Source root, recorded TeX inputs, declared extras and registered figure recipes."""
    from figures import figure_records
    root = repo if config.get('sourceRoot', '.') == '.' else contained(repo, config['sourceRoot'])
    paths = set()
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if any(p in SKIP for p in relative.parts) or path.suffix.lower() not in SOURCE or not path.is_file():
            continue
        resolved = contained(repo, path.relative_to(repo).as_posix())
        paths.add(resolved.relative_to(repo).as_posix())
    if not paths:
        raise ArchiveError('没有找到可存档的论文源文件。')
    for name in ['AGENTS.md', 'CLAUDE.md', '.agents/skills/paper-ai/SKILL.md', *config.get('agent', {}).get('guidanceFiles', [])]:
        if contained(repo, name).is_file():
            paths.add(name)
    figure_manifest = config.get('figures', {}).get('manifest', '.paper-figures.json')
    if contained(repo, figure_manifest).is_file():
        paths.add(figure_manifest)
    figures = figure_records(repo, config)
    missing = []
    for figure in figures:
        for name in [figure['path'], *figure.get('source_paths', []), *figure.get('data_paths', []), *figure.get('reference_paths', []), *figure.get('revision_paths', [])]:
            path = contained(repo, name)
            if path.is_file():
                paths.add(name)
            else:
                missing.append(name)
    for name in config.get('versions', {}).get('include', []):
        path = contained(repo, name)
        if not path.is_file():
            raise ArchiveError('登记的存档附件不存在：' + name)
        paths.add(name)
    pdf = config.get('pdf')
    pdf_path = contained(repo, pdf) if pdf else None
    if pdf_path and pdf_path.is_file():
        paths.add(pdf)
        # Recorder tracks custom input/table/graphics commands without guessing macros.
        fls = pdf_path.with_suffix('.fls')
        if fls.is_file():
            for line in fls.read_text(errors='replace').splitlines():
                if not line.startswith('INPUT '):
                    continue
                value = Path(line[6:])
                value = value if value.is_absolute() else pdf_path.parent / value
                value = value.resolve()
                if value.is_relative_to(repo) and value.is_file() and value.suffix.lower() in SOURCE:
                    name = value.relative_to(repo).as_posix()
                    if not any(part in SKIP for part in Path(name).parts):
                        paths.add(name)
    # Keep structured pending edits/history as records; never accept them on archive.
    for sub in ('requests', 'chat/sessions'):
        base = contained(repo, '.paper-pal/' + sub)
        if base.is_dir():
            for path in base.glob('*.json'):
                if path.is_file():
                    paths.add(path.relative_to(repo).as_posix())
    return sorted(paths), figures, sorted(set(missing))


def root_for(repo):
    base = contained(repo, '.paper-pal/versions')
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    return base


def summaries(repo):
    base = root_for(repo)
    result = []
    for directory in base.iterdir():
        if VERSION.fullmatch(directory.name):
            path = contained(repo, directory.relative_to(repo).as_posix() + '/manifest.json')
            value = json.loads(path.read_text())
            if value.get('id') != directory.name:
                raise ArchiveError('存档清单不一致，请联系维护窗口。', 503)
            result.append({k: v for k, v in value.items() if k not in ('files', 'figures', 'request_id', 'config')})
    return sorted(result, key=lambda item: int(item['id'][1:-2]))


def manifest(repo, version):
    if not VERSION.fullmatch(version):
        raise ArchiveError('版本不存在。', 404)
    path = contained(repo, '.paper-pal/versions/' + version + '/manifest.json')
    if not path.is_file():
        raise ArchiveError('版本不存在。', 404)
    value = json.loads(path.read_text())
    if value.get('id') != version or not isinstance(value.get('files'), dict):
        raise ArchiveError('版本清单损坏。', 503)
    return value


def create_snapshot(repo, name='', note='', expected_parent=None, request_id=None):
    repo = Path(repo).resolve()
    if not isinstance(name, str) or len(name) > 120 or not isinstance(note, str) or len(note) > 4000:
        raise ArchiveError('版本名称最多120字，说明最多4000字。')
    request_id = request_id or str(uuid.uuid4())
    if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_id):
        raise ArchiveError('无效的存档请求编号。')
    base = root_for(repo)
    with (base / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = summaries(repo)
        for record in previous:
            old = manifest(repo, record['id'])
            if old.get('request_id') == request_id:
                default_name = '起始基线' if record['id'] == 'v0.0' else '论文存档'
                if old['name'] != (name or default_name) or old['note'] != note:
                    raise ArchiveError('此请求编号已用于另一份存档说明，请刷新记录。', 409)
                return {'schema_version': 1, 'created': False, 'version': record}
        actual_parent = previous[-1]['id'] if previous else None
        if expected_parent != actual_parent:
            raise ArchiveError('已有新版本，请刷新后再存档。', 409)
        number = int(actual_parent[1:-2]) + 1 if actual_parent else 0
        version = f'v{number}.0'
        config = read_config(repo)
        paths, figures, missing = inventory(repo, config)
        size = sum(contained(repo, p).stat().st_size for p in paths)
        if size > MAX_TOTAL:
            raise ArchiveError('本次存档超过2GB，请精简已登记附件；没有生成半个版本。')
        temporary = Path(tempfile.mkdtemp(prefix='.creating-', dir=base))
        target = base / version
        records = {}
        try:
            for name_path in paths:
                source = contained(repo, name_path)
                destination = temporary / 'files' / name_path
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(source, destination)
                destination.chmod(0o600)
                records[name_path] = {'sha256': digest_file(destination), 'size': destination.stat().st_size}
            # Detect external edits during copying rather than publishing a mixed snapshot.
            if inventory(repo, config)[0] != paths or any(digest_file(contained(repo, p)) != r['sha256'] for p, r in records.items()):
                raise ArchiveError('文件在存档期间发生更新，请稍后重新存档。', 409)
            pdf = config.get('pdf') if config.get('pdf') in records else None
            dependencies = [contained(repo, p).stat().st_mtime for p in paths if Path(p).suffix.lower() in SOURCE and p != pdf and not p.startswith('.paper-pal/')]
            pdf_current = bool(pdf and contained(repo, pdf).stat().st_mtime >= max(dependencies, default=0))
            warnings = (['部分图片来源未齐全，详见清单：' + ', '.join(missing)] if missing else [])
            if pdf and not pdf_current:
                warnings.append('此PDF可能早于当前源文件；存档已保留它的真实字节，最新正文以源文件为准。')
            git = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=5)
            dirty = subprocess.run(['git', '-C', str(repo), 'status', '--porcelain'], capture_output=True, text=True, timeout=5)
            result = {'schema_version': 1, 'id': version, 'version': version[1:], 'name': name or ('起始基线' if number == 0 else '论文存档'), 'note': note,
                      'created_at': datetime.now(timezone.utc).isoformat(), 'parent_id': actual_parent,
                      'snapshot_path': str(target), 'manifest_path': str(target / 'manifest.json'), 'file_count': len(records), 'figure_count': len(figures),
                      'pdf_available': bool(pdf), 'pdf_path': pdf, 'pdf_current': pdf_current, 'warnings': warnings,
                      'source_git_head': git.stdout.strip() if git.returncode == 0 else None,
                      'source_git_dirty': bool(dirty.stdout.strip()) if dirty.returncode == 0 else None,
                      'request_id': request_id, 'files': records, 'figures': figures,
                      'config': {'sourceRoot': config.get('sourceRoot', '.'), 'defaultDocument': config.get('defaultDocument'), 'pdf': pdf}}
            (temporary / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            (temporary / 'HANDOFF.md').write_text(f'# 论文 {version[1:]} · {result["name"]}\n\n时间：{result["created_at"]}\n\n{note}\n\n正文入口：files/{config.get("defaultDocument", "main.tex")}\n\n各文件原始相对路径、SHA256、图片代码/数据/重绘命令在 manifest.json。files/ 是本版本固定内容，不应直接编辑；继续修改请回到论文工作目录。未接受候选仅作为记录保留，不自动写入正文。\n\n' + '\n'.join(warnings) + '\n')
            temporary.rename(target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        record = {k: v for k, v in result.items() if k not in ('files', 'figures', 'request_id', 'config')}
        return {'schema_version': 1, 'created': True, 'version': record}


def file_path(repo, version, name):
    if version == 'working':
        paths, _, _ = inventory(repo, read_config(repo))
        if name not in paths:
            raise ArchiveError('文件未登记到当前论文。', 404)
        return contained(repo, name)
    value = manifest(repo, version)
    if name not in value['files']:
        raise ArchiveError('该版本没有此文件。', 404)
    path = contained(repo, '.paper-pal/versions/' + version + '/files/' + name)
    if not path.is_file() or digest_file(path) != value['files'][name]['sha256']:
        raise ArchiveError('存档文件完整性验证失败。', 409)
    return path


def preview_bytes(path):
    import pymupdf
    with pymupdf.open(path) as document:
        if len(document) < 1:
            raise ArchiveError('PDF没有可预览的页面。')
        page = document[0]
        scale = min(2, 1400 / max(page.rect.width, page.rect.height))
        return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes('png')


def compare(repo, slug, base, target, focus=None):
    focus = focus or read_config(repo).get('defaultDocument')
    def state(version):
        if version == 'working':
            paths, figures, _ = inventory(repo, read_config(repo))
            contents = {}
            if focus in paths and contained(repo, focus).stat().st_size < 2*1024**2:
                contents[focus] = contained(repo, focus).read_bytes()
            records = {}
            for path in paths:
                source = contained(repo, path)
                records[path] = ({'sha256': hashlib.sha256(contents[path]).hexdigest(), 'size': len(contents[path])}
                                 if path in contents else {'sha256': digest_file(source), 'size': source.stat().st_size})
            return {'files': records, 'figures': figures, '_contents': contents}
        return manifest(repo, version)
    if base == 'working':
        raise ArchiveError('对比起点请选择已存档版本。')
    old, new = state(base), state(target)
    def info(version, path, record):
        if record is None:
            return None
        url = f'/papers/{slug}/hub/versions/{version}/file?' + urlencode({'path': path, 'sha256': record['sha256']})
        return dict(record, path=path, url=url, preview_url=url + '&preview=1' if Path(path).suffix.lower() == '.pdf' else url)
    files = []
    summary = {'added': 0, 'modified': 0, 'deleted': 0, 'figures_changed': 0}
    for path in sorted(set(old['files']) | set(new['files'])):
        before, after = old['files'].get(path), new['files'].get(path)
        status = 'added' if before is None else 'deleted' if after is None else 'equal' if before['sha256'] == after['sha256'] else 'modified'
        if status != 'equal':
            summary[status] += 1
        suffix = Path(path).suffix.lower()
        kind = 'image' if suffix in IMAGES else 'text' if suffix in TEXT else 'binary'
        diff, latest = [], None
        if path == focus and kind == 'text' and max((before or {}).get('size', 0), (after or {}).get('size', 0)) < 2*1024**2:
            a = file_path(repo, base, path).read_text(errors='replace') if before else ''
            b = (new['_contents'][path].decode(errors='replace') if target == 'working'
                 else file_path(repo, target, path).read_text(errors='replace')) if after else ''
            latest = b
            left, right = a.splitlines(keepends=True), b.splitlines(keepends=True)
            for tag, i, j, x, y in difflib.SequenceMatcher(None, left, right, autojunk=False).get_opcodes():
                if tag in ('replace', 'delete'):
                    diff.append({'type': 'delete', 'text': ''.join(left[i:j])})
                if tag in ('replace', 'insert'):
                    diff.append({'type': 'insert', 'text': ''.join(right[x:y])})
                if tag == 'equal':
                    diff.append({'type': 'equal', 'text': ''.join(right[x:y])})
        files.append({'path': path, 'status': status, 'kind': kind, 'before': info(base, path, before), 'after': info(target, path, after), 'diff': diff, 'latest_text': latest})
    figures = []
    old_fig = {f['id']: f for f in old['figures']}
    new_fig = {f['id']: f for f in new['figures']}
    for key in sorted(old_fig.keys() | new_fig.keys()):
        a, b = old_fig.get(key), new_fig.get(key)
        before = info(base, a['path'], old['files'].get(a['path'])) if a else None
        after = info(target, b['path'], new['files'].get(b['path'])) if b else None
        status = 'added' if not before else 'deleted' if not after else 'equal' if before['sha256'] == after['sha256'] else 'modified'
        if status != 'equal':
            summary['figures_changed'] += 1
        figures.append({'id': key, 'title': (b or a).get('title', key), 'status': status, 'before': before, 'after': after})
    return {'schema_version': 1, 'base': base, 'target': target, 'focus_path': focus, 'files': files, 'figures': figures, 'summary': summary}


class VersionService:
    def __init__(self, registry_reader):
        self.registry_reader = registry_reader

    def repo(self, slug):
        paper = next((p for p in self.registry_reader() if p['id'] == slug), None)
        if not paper:
            raise ArchiveError('论文未登记。', 404)
        return Path(paper['repo']).resolve()

    async def handle(self, request):
        try:
            repo = self.repo(request.match_info['slug'])
            action = request.match_info.get('action')
            version = request.match_info.get('version')
            if action == 'compare':
                value = await asyncio.to_thread(compare, repo, request.match_info['slug'], request.query.get('base', ''), request.query.get('target', 'working'), request.query.get('path'))
            elif action == 'file':
                path = await asyncio.to_thread(file_path, repo, version, request.query.get('path', ''))
                if version == 'working' and path.stat().st_size <= 32*1024**2:
                    raw = await asyncio.to_thread(path.read_bytes)
                    expected = request.query.get('sha256')
                    if expected and hashlib.sha256(raw).hexdigest() != expected:
                        raise ArchiveError('当前文件已更新，请刷新版本对比。', 409)
                    if request.query.get('preview') == '1' and path.suffix.lower() == '.pdf':
                        def render_bytes():
                            import pymupdf
                            with pymupdf.open(stream=raw, filetype='pdf') as document:
                                page=document[0];scale=min(2,1400/max(page.rect.width,page.rect.height))
                                return page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False).tobytes('png')
                        return web.Response(body=await asyncio.to_thread(render_bytes),content_type='image/png')
                    return web.Response(body=raw,content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                                        headers={'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
                if request.query.get('preview') == '1' and path.suffix.lower() == '.pdf':
                    return web.Response(body=await asyncio.to_thread(preview_bytes, path), content_type='image/png')
                return web.FileResponse(path, headers={'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
            elif action == 'download':
                await asyncio.to_thread(manifest, repo, version)
                directory = root_for(repo) / version
                target = root_for(repo) / (version + '.zip')
                def bundle():
                    for name in manifest(repo, version)['files']:
                        file_path(repo, version, name)
                    descriptor, temporary = tempfile.mkstemp(prefix='.zip-', dir=root_for(repo))
                    os.close(descriptor)
                    try:
                        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
                            for path in sorted(directory.rglob('*')):
                                if path.is_file():
                                    archive.write(path, path.relative_to(directory))
                        os.replace(temporary, target)
                    finally:
                        Path(temporary).unlink(missing_ok=True)
                await asyncio.to_thread(bundle)
                return web.FileResponse(target, headers={'Content-Disposition': f'attachment; filename="paper-{version}.zip"'})
            elif request.method == 'POST':
                data = await request.json()
                if not isinstance(data, dict) or 'expected_parent' not in data:
                    raise ArchiveError('请提供当前父版本编号。')
                value = await asyncio.to_thread(create_snapshot, repo, data.get('name', ''), data.get('note', ''), data['expected_parent'], data.get('request_id'))
                return web.json_response(value, status=201 if value['created'] else 200)
            else:
                values = await asyncio.to_thread(summaries, repo)
                value = {'schema_version': 1, 'versions': values, 'latest_id': values[-1]['id'] if values else None}
            return web.json_response(value)
        except ArchiveError as error:
            return web.json_response({'error': str(error)}, status=error.status)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            return web.json_response({'error': '版本资料暂不可用，请检查论文配置或存档完整性。'}, status=503)

    def install(self, app):
        app.router.add_get('/papers/{slug}/hub/versions', self.handle)
        app.router.add_post('/papers/{slug}/hub/versions', self.handle)
        app.router.add_get('/papers/{slug}/hub/versions/{action:compare}', self.handle)
        app.router.add_get('/papers/{slug}/hub/versions/{version}/{action:file|download}', self.handle)
