"""Project-contained figure lineage and explicit staged redraw/accept jobs.

The HTTP gateway supplies authentication/origin checks. Local import_candidate is
an intentional Python integration seam; no HTTP endpoint accepts a source path.
"""
import asyncio
import fcntl
import threading
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import shutil
import signal
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree

from aiohttp import web
from translation import save_cache, worker_environment

MAX_ASSET = 32 * 1024 * 1024
MAX_INPUT = 384 * 1024 * 1024
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
FORMATS = {'.png', '.jpg', '.jpeg', '.svg', '.pdf'}
CONTEXT_TEXT = {'.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.txt'}
CONTEXT_DISCOVERY_SKIP = {'_archive', '_legacy', '_tmp', '_drafts', '_snapshots'}
RUNTIME_PARTS = {'.git', '.paper-pal', '.draft-review', '.mpl-cache', '__pycache__', 'node_modules'}
RUNTIME_FILES = {'copiedtaskmanifest.json', 'assistant-summary.txt', 'cli-output.txt',
                 'argv.json', 'env.json', 'received-prompt.txt', 'worker-pid.txt'}


def reusable_path(name):
    """Files eligible as recipe/context, excluding private or transient outputs."""
    path = Path(name)
    return (not any(part in RUNTIME_PARTS or part.startswith('.cache') for part in path.parts)
            and path.name not in RUNTIME_FILES
            and path.name not in {'.paper-pal.json', 'auth.json', 'credentials.json', 'hub-session.key'}
            and not path.name.startswith('.env')
            and path.suffix.lower() not in {'.pem', '.key', '.p12', '.pfx', '.pyc'}
            and not (len(path.parts) == 1 and (path.stem == 'candidate' or path.name.startswith('assistant-')
                                             or path.name.startswith('imported-source.'))))


def context_paths(repo, config, recipe_paths=()):
    """Current project guidance and paper text; global skills remain live reads."""
    names = set()
    for name in ('AGENTS.md', 'CLAUDE.md', config.get('defaultDocument')):
        if name is not None:
            path = contained(repo, name)
            if not reusable_path(name):
                raise ValueError('项目上下文不能包含凭证配置或运行文件')
            if path.is_file():
                names.add(name)
    for settings in (config, config.get('agent', {}), config.get('codex', {}), config.get('claude', {})):
        if not isinstance(settings, dict):
            raise ValueError('项目上下文配置必须是对象')
        for key in ('guidanceFiles', 'entryPoints', 'context_paths'):
            values = settings.get(key, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise ValueError('项目上下文必须是相对文件路径列表')
            for name in values:
                path = contained(repo, name)
                if not reusable_path(name):
                    raise ValueError('项目上下文不能包含凭证配置或运行文件')
                if path.is_file():
                    names.add(name)
    source_name = config.get('sourceRoot', '.')
    source_root = repo if source_name == '.' else contained(repo, source_name)
    for directory, text_only in ((source_root, True), (repo/'.agents/skills', False)):
        if directory.is_symlink() or not directory.resolve().is_relative_to(repo):
            raise ValueError('项目上下文目录不能指向项目外部')
        if not directory.is_dir():
            continue
        for path in directory.rglob('*'):
            name = path.relative_to(repo).as_posix()
            if text_only and any(part in CONTEXT_DISCOVERY_SKIP for part in path.relative_to(directory).parts):
                continue
            if not reusable_path(name) or (text_only and path.suffix.lower() not in CONTEXT_TEXT):
                continue
            if text_only and name in recipe_paths and name not in names:
                continue
            contained(repo, name)
            if path.is_symlink():
                raise ValueError('项目上下文不能包含软链接')
            if path.is_file():
                names.add(name)
    return sorted(names)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with Path(path).open('rb') as source:
        value = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
        return value.hexdigest()


def contained(repo, name):
    """Reject lexical escapes, runtime metadata, and resolved symlink escapes."""
    if not isinstance(name, str) or not name or '\\' in name:
        raise ValueError('图片登记路径必须是项目内相对路径')
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or relative.parts[0] in ('.git', '.paper-pal'):
        raise ValueError('图片登记路径不能离开项目或指向运行记录')
    target = (repo / relative).resolve()
    if not target.is_relative_to(repo.resolve()):
        raise ValueError('图片路径的软链接指向项目外部')
    return target


def manifest_name(config):
    settings = config.get('figures', {})
    if not isinstance(settings, dict):
        raise ValueError('figures 配置必须是对象')
    name = settings.get('manifest', '.paper-figures.json')
    return name


def figure_records(repo, config):
    repo = Path(repo).resolve()
    manifest = contained(repo, manifest_name(config))
    if not manifest.exists():
        return []
    if manifest.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('图片登记表过大')
    value = json.loads(manifest.read_text())
    if not isinstance(value, dict) or value.get('schema_version') != 1 or not isinstance(value.get('figures'), list):
        raise ValueError('图片登记表 schema_version 必须为 1')
    if len(value['figures']) > 500:
        raise ValueError('图片登记数量超过 500')
    records, seen = [], set()
    for raw in value['figures']:
        if not isinstance(raw, dict) or not ID.fullmatch(str(raw.get('id', ''))) or raw['id'] in seen:
            raise ValueError('图片 ID 无效或重复')
        seen.add(raw['id'])
        record = {key: raw[key] for key in ('id','title','path','kind','prompt','model','notes','provenance_status') if key in raw}
        if not isinstance(record.get('title'), str) or record.get('kind') not in ('plot','diagram','generated'):
            raise ValueError('图片标题或类型无效')
        names = [record.get('path')]
        for key in ('source_paths', 'data_paths', 'reference_paths'):
            items = raw.get(key, [])
            if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
                raise ValueError('图片依赖必须是相对文件路径列表')
            record[key] = items
            names.extend(items)
        command = raw.get('command', [])
        if not isinstance(command, list) or any(not isinstance(arg, str) or '\x00' in arg for arg in command):
            raise ValueError('绘图命令必须是参数列表，不支持 shell 字符串')
        record['command'] = command
        paths = {name: contained(repo, name) for name in names}
        if Path(record['path']).suffix.lower() not in FORMATS:
            raise ValueError('图片文件类型不支持')
        record['missing_paths'] = [name for name, path in paths.items() if not path.is_file()]
        record['sha256'] = digest(paths[record['path']]) if paths[record['path']].is_file() else None
        if 'reproducible' in raw and not isinstance(raw['reproducible'], bool):
            raise ValueError('reproducible 必须是布尔值')
        record['reproducible'] = raw.get('reproducible', True) and not record['missing_paths'] and bool(record['source_paths']) and bool(command)
        record['reproducibility_status'] = 'recipe-recorded-not-rerun'
        records.append(record)
    # An accepted redraw may have edited scripts only in staging. Surface that
    # exact retained recipe so snapshots/other agents do not mistake old live
    # source files for the recipe that produced the current accepted image.
    history = repo / '.paper-pal/figure-studio'
    if history.is_dir() and history.resolve().is_relative_to(repo):
        accepted = {}
        for job_path in sorted(history.glob('*/job.json')):
            if job_path.is_symlink() or not job_path.resolve().is_relative_to(history.resolve()):
                continue
            try:
                job = json.loads(job_path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(job, dict) and job.get('status') == 'accepted':
                key = (job.get('figure_id'),job.get('accepted_sha256'))
                if job.get('accepted_at','') > accepted.get(key,{}).get('accepted_at',''):
                    accepted[key] = dict(job, _job_path=job_path)
        for record in records:
            job = accepted.get((record['id'],record['sha256']))
            if not job:
                continue
            job_path = job['_job_path']
            archive = job_path.parent / 'accepted-archive'
            if not archive.is_dir() or not archive.resolve().is_relative_to(history.resolve()):
                record['reproducible'] = False
                continue
            retained = safe_tree_files(archive, max_bytes=MAX_INPUT*2+MAX_ASSET*2, max_files=4008)
            record.update(revision_manifest=str(job_path.relative_to(repo)),
                revision_paths=[str(path.relative_to(repo)) for path in retained]+[str(job_path.relative_to(repo))],
                reproduction_workspace=str((archive/'workspace').relative_to(repo)),
                reproduction_command=record['command'],accepted_at=job['accepted_at'],
                reproducibility_status='recipe-recorded-not-rerun')
    return records


def validate_asset(path):
    path = Path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_ASSET:
        raise ValueError('候选图片缺失、为空或超过 32 MB')
    suffix = path.suffix.lower()
    if suffix in ('.png', '.jpg', '.jpeg'):
        from PIL import Image
        with Image.open(path) as image:
            if image.format not in ({'PNG'} if suffix == '.png' else {'JPEG'}):
                raise ValueError('候选图片的内容与扩展名不符')
            if image.width * image.height > 100_000_000:
                raise ValueError('图片像素过多')
            image.verify()
    elif suffix == '.pdf':
        import fitz as pymupdf
        with pymupdf.open(path) as document:
            if document.page_count < 1 or document.needs_pass:
                raise ValueError('候选 PDF 无法预览')
            page = document[0]
            length = max(page.rect.width, page.rect.height)
            if not math.isfinite(length) or length <= 0:
                raise ValueError('PDF 页面尺寸无效')
            page.get_pixmap(matrix=pymupdf.Matrix(min(.25, 400/length), min(.25,400/length)))
    elif suffix == '.svg':
        data = path.read_bytes()
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise ValueError('SVG 不允许外部实体')
        root = ElementTree.fromstring(data)
        if root.tag.rsplit('}', 1)[-1] != 'svg':
            raise ValueError('无效 SVG')
        for element in root.iter():
            if element.tag.rsplit('}', 1)[-1] in ('script','foreignObject','iframe','animate','animateMotion','animateTransform','set'):
                raise ValueError('SVG 不允许脚本、样式或嵌入网页')
            if element.tag.rsplit('}', 1)[-1] == 'style' and re.search(r'url\s*\(|@import|expression\s*\(|javascript:', element.text or '',re.I):
                raise ValueError('SVG 样式不允许外部资源或脚本')
            for key, value in element.attrib.items():
                local_urls = re.sub(r'''url\(\s*["']?#[A-Za-z0-9_.:-]+["']?\s*\)''','',value,flags=re.I)
                if key.lower().startswith('on') or ('href' in key.lower() and not value.startswith('#')) or re.search(r'url\s*\(|javascript:|expression\s*\(',local_urls,re.I):
                    raise ValueError('SVG 不允许事件或外部资源')
    else:
        raise ValueError('候选图片格式不支持')
    return digest(path)


def safe_tree_files(root, max_bytes=MAX_INPUT, max_files=2000):
    files, total = [], 0
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('暂存目录中不能有软链接')
        if path.is_file():
            total += path.stat().st_size
            files.append(path)
            if len(files) > max_files or total > max_bytes:
                raise ValueError('暂存文件超过数量或体积限制')
    return files


def package_raster_pdf(source, target):
    """Package image pixels into PDF without requesting or altering image content."""
    from PIL import Image
    with Image.open(source) as image:
        if 'A' in image.getbands() or image.mode == 'P':
            rgba = image.convert('RGBA')
            rgb = Image.new('RGB',rgba.size,'white')
            rgb.paste(rgba,mask=rgba.getchannel('A'))
        else:
            rgb = image.convert('RGB')
        rgb.save(target,'PDF',resolution=150.0)
    Path(target).chmod(0o600)


class FigureQueueFull(ValueError):
    pass


class FigureStudio:
    def __init__(self, registry_reader, root):
        self.registry_reader, self.root = registry_reader, Path(root)
        self.tasks, self.jobs = set(), {}
        self.semaphore = asyncio.Semaphore(1)
        self.timeout = 600
        self.accept_lock = asyncio.Lock()
        self.create_lock = threading.RLock()

    def paper(self, slug):
        paper = next((paper for paper in self.registry_reader() if paper['id'] == slug), None)
        if not paper:
            raise web.HTTPNotFound(text='论文未登记')
        repo = Path(paper['repo']).resolve()
        config = json.loads((repo / '.paper-pal.json').read_text())
        return repo, config

    def storage(self, repo):
        directory = repo / '.paper-pal/figure-studio'
        # Runtime metadata cannot be redirected outside the project by a symlink.
        if not directory.resolve().is_relative_to(repo) or (repo / '.paper-pal').is_symlink():
            raise ValueError('图片运行目录不能指向项目外部')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return directory

    def lookup(self, repo, config, identifier):
        record = next((r for r in figure_records(repo, config) if r['id'] == identifier), None)
        if record is None:
            raise web.HTTPNotFound(text='图片尚未登记')
        return record

    def persist(self, job):
        save_cache(Path(job['manifest_path']), job)

    def load(self, slug, identifier):
        if not ID.fullmatch(identifier):
            raise web.HTTPNotFound(text='图片任务不存在')
        repo, _ = self.paper(slug)
        directory = self.storage(repo)
        path = directory / identifier / 'job.json'
        if not path.resolve().is_relative_to(directory.resolve()) or path.is_symlink():
            raise web.HTTPNotFound(text='图片任务路径无效')
        if not path.is_file():
            raise web.HTTPNotFound(text='图片任务不存在')
        if path.stat().st_size > 4 * 1024 * 1024:
            raise web.HTTPNotFound(text='图片任务记录无效')
        job = self.jobs.get((slug, identifier)) or json.loads(path.read_text())
        if (not isinstance(job, dict) or job.get('schema_version') != 1 or job.get('id') != identifier
                or job.get('status') not in ('queued','running','proposed','accepted','error')
                or not isinstance(job.get('created_at'),str)
                or not isinstance(job.get('instruction'),str)
                or not isinstance(job.get('provider'),str)
                or not isinstance(job.get('original_sha256'),str) or not re.fullmatch(r'[0-9a-f]{64}',job['original_sha256'])
                or not isinstance(job.get('figure'),dict)
                or not isinstance(job.get('input_hashes'),dict)
                or not isinstance(job.get('figure_id'),str) or not ID.fullmatch(job['figure_id'])
                or job.get('workspace_path') != str(path.parent/'workspace')
                or job.get('manifest_path') != str(path)
                or not isinstance(job.get('candidate_path'),str)
                or Path(job['candidate_path']).parent != path.parent/'workspace'):
            raise web.HTTPNotFound(text='图片任务记录无效')
        figure_path = job['figure'].get('path')
        if not isinstance(figure_path,str) or job['figure'].get('id') != job['figure_id']:
            raise web.HTTPNotFound(text='图片任务记录无效')
        contained(repo,figure_path)
        if (Path(figure_path).suffix.lower() not in FORMATS
                or Path(job['candidate_path']).name != 'candidate'+Path(figure_path).suffix.lower()):
            raise web.HTTPNotFound(text='图片任务记录无效')
        if job['status'] in ('running', 'queued') and (slug, identifier) not in self.jobs:
            job.update(status='error', error='服务已重启，任务已中断，请重新发起。')
            self.persist(job)
        return repo, job

    def public(self, slug, job):
        result = dict(job)
        if job['status'] in ('proposed','accepted'):
            route = f'/papers/{quote(slug)}/hub/figures/jobs/{job["id"]}/asset'
            result.update(candidate_url=route, candidate_preview_url=route+'?preview=1')
        return result

    async def listing(self, request):
        slug = request.match_info['slug']
        try:
            repo, config = self.paper(slug)
            figures = figure_records(repo, config)
            for record in figures:
                route = f'/papers/{quote(slug)}/hub/figures/{quote(record["id"])}/asset'
                record.update(asset_url=route, preview_url=route+'?preview=1')
            jobs = []
            for path in self.storage(repo).glob('*/job.json'):
                try:
                    _, job = self.load(slug,path.parent.name)
                    jobs.append(job)
                except (web.HTTPNotFound,OSError,ValueError,TypeError,KeyError):
                    continue
            jobs.sort(key=lambda job:job['created_at'],reverse=True)
            return web.json_response({'schema_version':1, 'figures':figures, 'jobs':[self.public(slug,job) for job in jobs[:50]], 'manifest_path':str(repo / manifest_name(config)),
                'capabilities':{'providers':['codex','claude'], 'global_skill_routing':True, 'image_generation':False,
                    'image_generation_mode':'global-skill-routing',
                    'image_generation_note':'论文 AI 按当前全局技能调用图像或网页咨询工具；取决于对应 CLI 的工具与已登录会话，未保证固定 Image2。',
                    'claude_isolation':'Claude 使用暂存副本和工具约束，不是操作系统沙箱。'}})
        except (OSError, ValueError, TypeError, KeyError) as error:
            return web.json_response({'error':str(error)}, status=400)

    @contextmanager
    def creation_guard(self, slug):
        # Sync importers and HTTP worker threads share the same serialized writer.
        with self.create_lock:
            repo, _ = self.paper(slug)
            lock_path = self.storage(repo)/'.create.lock'
            descriptor = os.open(lock_path,os.O_CREAT|os.O_RDWR,0o600)
            with os.fdopen(descriptor,'a+b') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock,fcntl.LOCK_UN)

    def create(self, slug, figure_id, instruction, provider, model, request_id):
        with self.creation_guard(slug):
            return self._create_unlocked(slug,figure_id,instruction,provider,model,request_id)

    def _create_unlocked(self, slug, figure_id, instruction, provider, model, request_id):
        repo, config = self.paper(slug)
        record = self.lookup(repo, config, figure_id)
        directory = self.storage(repo)
        # Cross-restart idempotence is bounded to existing project job records.
        for item in directory.glob('*/job.json'):
            if item.is_symlink() or not item.resolve().is_relative_to(directory.resolve()):
                raise ValueError('图片任务路径无效')
            previous = json.loads(item.read_text())
            if previous.get('request_id') == request_id:
                if (previous['figure_id'],previous['instruction'],previous['provider'],previous['model']) != (figure_id,instruction,provider,model):
                    raise ValueError('请求号码已经用于其他图片任务')
                return previous, False
        if sum(job['status'] in ('running','queued') for job in list(self.jobs.values())) >= 4:
            raise FigureQueueFull('绘图任务较多，请稍后重试')
        if not record['sha256']:
            raise ValueError('原图不存在，不能建立修订任务')
        identifier = 'fig_' + uuid.uuid4().hex
        folder = directory / identifier
        workspace = folder / 'workspace'
        current_context = context_paths(repo, config,
            record['source_paths'] + record['data_paths'] + record['reference_paths'])
        names = [record['path']] + record['source_paths'] + record['data_paths'] + record['reference_paths'] + current_context
        inputs, input_sources, total = {}, {}, 0
        revision_root = (repo / record['reproduction_workspace']) if record.get('reproduction_workspace') else None
        if revision_root and not revision_root.resolve().is_relative_to(repo):
            raise ValueError('已采用绘图配方路径无效')
        recipe_names = set(record['source_paths'] + record['data_paths'] + record['reference_paths'])
        if revision_root:
            previous = json.loads((repo/record['revision_manifest']).read_text())
            previous_context = set(previous.get('context_paths', []))
            # Preserve newly introduced helpers/data, not only the originally
            # registered filenames. Current guidance always wins over an old copy.
            for path in safe_tree_files(revision_root):
                name = path.relative_to(revision_root).as_posix()
                if (reusable_path(name) and name != record['path']
                        and name not in previous_context and name not in current_context
                        and name not in ('AGENTS.md', 'CLAUDE.md')
                        and not name.startswith('.agents/skills/')):
                    recipe_names.add(name)
                    names.append(name)
        recipe_names.difference_update(current_context)
        try:
            if len(set(names)) > 2000:
                raise ValueError('绘图输入超过 2000 个文件')
            workspace.mkdir(parents=True, mode=0o700)
            for name in dict.fromkeys(names):
                original = contained(repo, name)
                revised = revision_root / name if revision_root and name in recipe_names else None
                if revised and revised.is_file():
                    if revised.is_symlink() or not revised.resolve().is_relative_to(revision_root.resolve()):
                        raise ValueError('已采用绘图配方路径无效')
                    original = revised
                if not original.is_file():
                    continue
                total += original.stat().st_size
                if total > MAX_INPUT:
                    raise ValueError('绘图输入超过 384 MB')
                target = workspace / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                baseline = folder / 'inputs' / name
                baseline.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(original, baseline)
                baseline.chmod(0o600)
                shutil.copyfile(baseline, target)
                target.chmod(0o600)
                inputs[name] = digest(target)
                input_sources[name] = str(original.relative_to(repo))
            if digest(contained(repo,record['path'])) != record['sha256'] or any(
                    not (repo/source).is_file() or digest(repo/source) != inputs[name]
                    for name, source in input_sources.items()):
                raise ValueError('图片或输入在复制期间发生更新，请重新生成候选')
            job = {'schema_version':1,'id':identifier,'request_id':request_id,'status':'queued','figure_id':figure_id,
                'provider':provider,'model':model,'instruction':instruction,'created_at':now(),
                'workspace_path':str(workspace),'manifest_path':str(folder/'job.json'),
                'original_project_root':str(repo),'context_paths':current_context,
                'figure':record,'original_sha256':record['sha256'],'input_hashes':inputs,'input_sources':input_sources,
                'candidate_path':str(workspace/('candidate'+Path(record['path']).suffix.lower())),
                'tools_policy':'Codex workspace-write 沙箱；Claude 仅限暂存副本的读写和 Bash 工具（无操作系统隔离）。'}
            save_cache(workspace/'copiedtaskmanifest.json',job)
            self.jobs[(slug,identifier)] = job
            self.persist(job)
            return job, True
        except Exception:
            self.jobs.pop((slug,identifier),None)
            if folder.exists():
                shutil.rmtree(folder)
            raise

    async def start(self, request):
        slug = request.match_info['slug']
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError('请求必须是 JSON 对象')
            instruction, provider = body.get('instruction',''), body.get('provider')
            if not isinstance(instruction,str) or not 1 <= len(instruction.strip()) <= 12000:
                raise ValueError('请填写不超过 12000 字的绘图修改要求')
            if provider not in ('codex','claude'):
                raise ValueError('请选择 Codex 或 Claude 订阅')
            repo, config = self.paper(slug)
            settings = config.get(provider, {})
            model = body.get('model') or settings.get('model')
            allowed = settings.get('models', [])
            allowed = [item.get('id') if isinstance(item,dict) else item for item in allowed]
            if not isinstance(model,str) or model not in set(allowed + [settings.get('model')]):
                raise ValueError('模型未在论文项目配置中登记')
            request_id = body.get('request_id')
            if not isinstance(request_id,str) or not ID.fullmatch(request_id):
                raise ValueError('请提供有效的唯一请求号码')
            job, created = await asyncio.to_thread(self.create,slug,body.get('figure_id'),instruction,provider,model,request_id)
            if created:
                task = asyncio.create_task(self.run(slug,job,config))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            return web.json_response(self.public(slug,job),status=202)
        except FigureQueueFull as error:
            return web.json_response({'error':str(error)},status=503)
        except (OSError, ValueError, TypeError, KeyError) as error:
            return web.json_response({'error':str(error)},status=400)

    async def run(self, slug, job, config):
        process = None
        acquired = cancelled = False
        terminal = {}
        try:
            await self.semaphore.acquire()
            acquired = True
            job.update(status='running',started_at=now())
            self.persist(job)
            workspace = Path(job['workspace_path'])
            payload = {'job':job,'config':{key:config.get(key,{}) for key in ('codex','claude')}}
            environment = worker_environment(os.environ, workspace)
            if os.environ.get('PAPER_PAL_DIR'):
                environment['PAPER_PAL_DIR'] = os.environ['PAPER_PAL_DIR']
            process = await asyncio.create_subprocess_exec('node',str(self.root/'figure-task.mjs'),
                cwd=workspace, env=environment, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,start_new_session=True)
            # Node worker bounds stdout/stderr independently to avoid unbounded communicate buffers.
            output, errors = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()),self.timeout)
            if process.returncode == 0:
                receipt = json.loads(output)
                if receipt.get('provider') != job['provider'] or receipt.get('model') != job['model']:
                    raise ValueError('绘图客户端执行回执不符')
                job['execution'] = receipt
            (workspace.parent/'worker.log').write_bytes((output+errors)[-65536:])
            (workspace.parent/'worker.log').chmod(0o600)
            if process.returncode:
                raise ValueError('绘图客户端未成功完成，请检查订阅登录与任务日志')
            candidate = Path(job['candidate_path'])
            if candidate.is_symlink() or not candidate.resolve().is_relative_to(workspace):
                raise ValueError('候选图片不能指向暂存目录外部')
            if (candidate.suffix.lower()=='.pdf' and not candidate.exists()
                    and (workspace/'candidate.png').is_file()):
                raster = workspace/'candidate.png'
                validate_asset(raster)
                await asyncio.to_thread(package_raster_pdf,raster,candidate)
                job['raster_packaging'] = {'source':'candidate.png','source_sha256':digest(raster),
                    'conversion':'Pillow raster to PDF; no image editing'}
            candidate_hash = validate_asset(candidate)
            files = safe_tree_files(workspace)
            terminal.update(status='proposed',finished_at=now(),candidate_sha256=candidate_hash,
                output_hashes={str(path.relative_to(workspace)):digest(path) for path in files},
                summary='候选图片已生成；确认采用后才替换原图。')
        except asyncio.CancelledError:
            terminal.update(status='error',error='服务停止，绘图任务已中断',finished_at=now())
            cancelled = True
        except asyncio.TimeoutError:
            log=Path(job['manifest_path']).parent/'worker.log'
            descriptor=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(descriptor,'w') as output:
                output.write(f'Figure worker timed out after {self.timeout} seconds; process group terminated.\n')
            terminal.update(status='error',error='绘图超时，请查看任务日志并重试。',finished_at=now())
        except (OSError, ValueError, TypeError, KeyError, ImportError, RuntimeError, asyncio.TimeoutError) as error:
            terminal.update(status='error',error=str(error) or '绘图超时',finished_at=now())
        finally:
            # Cancellation must not interrupt process/pipe cleanup. Do not expose
            # proposed/error until no worker can still write the staging files.
            if process:
                stopping = asyncio.create_task(self.stop_worker(process))
                while not stopping.done():
                    try:
                        await asyncio.shield(stopping)
                    except asyncio.CancelledError:
                        cancelled = True
                    except Exception:
                        break
                try:
                    stopping.result()
                except Exception as error:
                    terminal.update(status='error',error=str(error),finished_at=now())
            try:
                job.update(terminal)
                self.persist(job)
            finally:
                if acquired:
                    self.semaphore.release()
        if cancelled:
            raise asyncio.CancelledError


    def import_candidate(self, slug, figure_id, source, instruction='', provider='local-import', model=None, request_id=None):
        """Trusted local Python seam. Never expose `source` as a public HTTP read."""
        with self.creation_guard(slug):
            return self._import_unlocked(slug,figure_id,source,instruction,provider,model,request_id)

    def _import_unlocked(self, slug, figure_id, source, instruction, provider, model, request_id):
        source = Path(source).resolve()
        validate_asset(source)
        repo, config = self.paper(slug)
        record = self.lookup(repo, config, figure_id)
        source_suffix, target_suffix = source.suffix.lower(), Path(record['path']).suffix.lower()
        raster_to_pdf = source_suffix in ('.png','.jpg','.jpeg') and target_suffix == '.pdf'
        if source_suffix != target_suffix and not raster_to_pdf:
            raise ValueError('导入格式需与原图一致，或使用 PNG/JPEG 转 PDF')
        job, created = self._create_unlocked(slug,figure_id,instruction,provider,model,request_id or uuid.uuid4().hex)
        if created:
            try:
                target = Path(job['candidate_path'])
                imported = Path(job['workspace_path'])/('imported-source'+source_suffix)
                shutil.copyfile(source,imported)
                imported.chmod(0o600)
                baseline = Path(job['manifest_path']).parent/'inputs'/imported.name
                shutil.copyfile(imported,baseline)
                baseline.chmod(0o600)
                job['input_hashes'][imported.name] = digest(imported)
                job['input_sources'][imported.name] = 'trusted-local-import:'+source.name
                if raster_to_pdf:
                    package_raster_pdf(imported,target)
                else:
                    shutil.copyfile(imported,target)
                target.chmod(0o600)
                job['import_provenance'] = {'source_name':source.name,'source_sha256':digest(imported),
                    'retained_source':str(imported),'source_format':source_suffix,'model':model,'provider':provider,
                    'prompt':instruction,'conversion':'Pillow raster to PDF' if raster_to_pdf else 'none',
                    'invocation':'external candidate imported; no image generation invoked by this platform'}
                save_cache(Path(job['workspace_path'])/'copiedtaskmanifest.json',job)
                job.update(status='proposed',finished_at=now(),candidate_sha256=validate_asset(target),
                    output_hashes={str(path.relative_to(Path(job['workspace_path']))):digest(path) for path in safe_tree_files(Path(job['workspace_path']))},
                    summary='已导入本地 AI 候选；确认采用后才替换原图。')
            except Exception as error:
                job.update(status='error',error=str(error),finished_at=now())
                self.persist(job)
                raise
            self.persist(job)
        return self.public(slug,job)

    async def status(self, request):
        _, job = self.load(request.match_info['slug'],request.match_info['job'])
        return web.json_response(self.public(request.match_info['slug'],job))

    async def accept(self, request):
        slug = request.match_info['slug']
        body = await request.json()
        async with self.accept_lock:
            return await asyncio.to_thread(self._accept_sync,slug,request.match_info['job'],body)

    def _accept_sync(self, slug, identifier, body):
        with self.creation_guard(slug):
            try:
                repo, job = self.load(slug,identifier)
                if job['status'] == 'accepted':
                    return web.json_response(self.public(slug,job))
                if not isinstance(body, dict):
                    raise ValueError('请求必须是 JSON 对象')
                if job['status'] != 'proposed':
                    return web.json_response({'error':'任务尚无可采用的候选'},status=409)
                original = contained(repo,job['figure']['path'])
                archive = Path(job['manifest_path']).parent / 'accepted-archive'
                # Recover a crash after atomic replacement but before job.json commit.
                if (body.get('expected_sha256') == job['original_sha256'] and original.is_file()
                        and digest(original) == job['candidate_sha256'] and archive.is_dir()
                        and (archive/('original'+original.suffix)).is_file()
                        and digest(archive/('original'+original.suffix)) == job['original_sha256']
                        and (archive/('candidate'+original.suffix)).is_file()
                        and digest(archive/('candidate'+original.suffix)) == job['candidate_sha256']):
                    job.update(status='accepted',accepted_at=now(),archive_path=str(archive),accepted_sha256=job['candidate_sha256'],
                        summary='已采用；恢复了服务中断前的完整归档记录。')
                    self.persist(job)
                    return web.json_response(self.public(slug,job))
                if not original.is_file() or body.get('expected_sha256') != job['original_sha256'] or digest(original) != job['original_sha256']:
                    return web.json_response({'error':'原图已被其他窗口修改，请重新生成候选'},status=409)
                candidate = Path(job['candidate_path'])
                workspace = Path(job['workspace_path'])
                if candidate.is_symlink() or not candidate.resolve().is_relative_to(workspace):
                    raise ValueError('候选路径不安全')
                if validate_asset(candidate) != job['candidate_sha256']:
                    raise ValueError('候选图片已发生变化，请重新生成')
                files = safe_tree_files(workspace)
                if not archive.exists():
                    building = Path(tempfile.mkdtemp(prefix='.archive-',dir=archive.parent))
                    try:
                        shutil.copyfile(original,building/('original'+original.suffix))
                        shutil.copyfile(candidate,building/('candidate'+candidate.suffix))
                        # Include exact modified scripts/data plus the baseline input copies.
                        for path in files:
                            target = building/'workspace'/path.relative_to(workspace)
                            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                            shutil.copyfile(path,target)
                        shutil.copytree(Path(job['manifest_path']).parent/'inputs',building/'inputs')
                        save_cache(building/'provenance.json',job)
                        if digest(building/('original'+original.suffix)) != job['original_sha256']:
                            return web.json_response({'error':'归档期间原图发生变化，请重试'},status=409)
                        building.replace(archive)
                    finally:
                        if building.exists():
                            shutil.rmtree(building)
                if (not (archive/'provenance.json').is_file()
                        or digest(archive/('original'+original.suffix)) != job['original_sha256']
                        or digest(archive/('candidate'+candidate.suffix)) != job['candidate_sha256']):
                    raise ValueError('采用归档不完整，未替换原图')
                descriptor, temporary_name = tempfile.mkstemp(dir=original.parent,prefix='.figure-',suffix=original.suffix)
                temporary = Path(temporary_name)
                try:
                    with os.fdopen(descriptor,'wb') as output:
                        output.write(candidate.read_bytes())
                        output.flush()
                        os.fsync(output.fileno())
                    # Recheck after archive creation, immediately before the atomic replacement.
                    if digest(original) != job['original_sha256']:
                        return web.json_response({'error':'归档期间原图发生变化，请重试'},status=409)
                    temporary.chmod(original.stat().st_mode & 0o777)
                    temporary.replace(original)
                finally:
                    temporary.unlink(missing_ok=True)
                job.update(status='accepted',accepted_at=now(),archive_path=str(archive),
                    accepted_sha256=digest(original),summary='已采用并保留旧图、候选图、绘图代码、数据副本及任务记录。')
                self.persist(job)
                return web.json_response(self.public(slug,job))
            except (OSError, ValueError, TypeError, KeyError) as error:
                return web.json_response({'error':str(error)},status=400)

    async def asset(self, request):
        repo, config = self.paper(request.match_info['slug'])
        if 'job' in request.match_info:
            _, job = self.load(request.match_info['slug'],request.match_info['job'])
            if job['status'] not in ('proposed','accepted'):
                raise web.HTTPNotFound(text='候选图片尚未生成')
            path = (Path(job['archive_path']) / ('candidate'+Path(job['candidate_path']).suffix)) if job['status']=='accepted' else Path(job['candidate_path'])
            if path.is_symlink() or not path.resolve().is_relative_to(Path(job['manifest_path']).parent):
                raise web.HTTPNotFound(text='图片路径无效')
        else:
            record = self.lookup(repo,config,request.match_info['figure'])
            path = contained(repo,record['path'])
        if not path.is_file():
            raise web.HTTPNotFound(text='图片不存在')
        if request.query.get('preview') == '1' and path.suffix.lower() == '.pdf':
            import fitz as pymupdf
            with pymupdf.open(path) as document:
                if document.page_count < 1 or document.needs_pass:
                    raise web.HTTPBadRequest(text='PDF 不能预览')
                page = document[0]
                length = max(page.rect.width,page.rect.height)
                if not math.isfinite(length) or length <= 0:
                    raise web.HTTPBadRequest(text='PDF 页面尺寸无效')
                scale = min(1.5,1600/length)
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False)
                return web.Response(body=pixmap.tobytes('png'),content_type='image/png',headers={'Cache-Control':'no-store'})
        headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
        if path.suffix.lower() == '.svg':
            validate_asset(path)
            headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return web.FileResponse(path,headers=headers)

    async def stop_worker(self, process):
        # Even if the Node leader exits early, terminate any surviving CLI descendants.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                pass
        await asyncio.sleep(.05)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            # communicate also closes pipe transports after a timed-out reader.
            await asyncio.wait_for(process.communicate(), 2)
        except asyncio.TimeoutError:
            raise RuntimeError('Figure worker did not reap after SIGKILL')

    async def cleanup(self, app):
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)

    def install(self, app):
        prefix = '/papers/{slug}/hub/figures'
        routes = [('GET',prefix,self.listing),('POST',prefix+'/jobs',self.start),
            ('GET',prefix+'/jobs/{job}',self.status),('POST',prefix+'/jobs/{job}/accept',self.accept),
            ('GET',prefix+'/jobs/{job}/asset',self.asset),('GET',prefix+'/{figure}/asset',self.asset)]
        for method, path, handler in routes:
            async def guarded(request, handler=handler):
                try:
                    return await handler(request)
                except web.HTTPException as error:
                    return web.json_response({'error':error.text},status=error.status)
                except ImportError:
                    return web.json_response({'error':'图片依赖未安装，请安装 Pillow / PyMuPDF'},status=503)
                except (OSError,ValueError,TypeError,KeyError,RuntimeError) as error:
                    return web.json_response({'error':str(error)},status=400)
            app.router.add_route(method,path,guarded)
        app.on_cleanup.append(self.cleanup)
