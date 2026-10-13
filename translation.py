"""Read-only Argos translation jobs and per-paper, content-addressed cache."""
import asyncio
import hashlib
import json
import os
import logging
import signal
import tempfile
from pathlib import Path

from aiohttp import web

ENGINE = 'argos-1.11.0-en-zh-1.9-int8-beam1-v3'


def worker_environment(source, task_tmp):
    """Keep runtime, locale, certificate and network settings; no unrelated keys."""
    keep = {'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'CODEX_HOME', 'PAPER_PAL_DIR',
            'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE',
            'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'}
    proxy = {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'}
    env = {k: v for k, v in source.items() if k in keep or k.startswith('LC_') or k.upper() in proxy}
    env.update(CUDA_VISIBLE_DEVICES='', TOKENIZERS_PARALLELISM='false', TMPDIR=str(task_tmp))
    return env


def cache_digest(engine, glossary, texts):
    return hashlib.sha256(json.dumps([engine, glossary, texts], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def save_cache(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor,name=tempfile.mkstemp(prefix=path.stem+'.',suffix='.tmp',dir=path.parent)
    temporary=Path(name)
    try:
        with os.fdopen(descriptor,'w') as output: json.dump(data,output,ensure_ascii=False)
        temporary.replace(path)
    finally: temporary.unlink(missing_ok=True)


async def stop_process_group(process, grace=3):
    """Bound both termination stages, including stuck process/pipe shutdown."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), grace)
            return
        except asyncio.TimeoutError:
            continue
    logging.getLogger(__name__).warning('Translation worker %s has not reaped after SIGKILL', process.pid)


def project_glossary(paper):
    """Read only a configured, repository-contained glossary; include it in cache identity."""
    repo = Path(paper['repo']).resolve()
    try:
        config = json.loads((repo / '.paper-pal.json').read_text())
        name = config.get('translation', {}).get('glossary')
        if not name:
            return {}
        target = (repo / name).resolve()
        if not target.is_relative_to(repo):
            raise ValueError('Glossary must remain inside this paper workspace')
        glossary = json.loads(target.read_text())
        if not isinstance(glossary, dict) or any(
            not isinstance(term, str) or not isinstance(value, dict) or
            not isinstance(value.get('target'), str) or not isinstance(value.get('variants'), list) or
            any(not isinstance(v, str) or not v for v in value['variants']) for term, value in glossary.items()
        ):
            raise ValueError('Invalid glossary')
        return glossary
    except FileNotFoundError:
        return {}


class TranslationJobs:
    def __init__(self, registry_reader, root):
        self.registry_reader = registry_reader
        self.root = root
        self.jobs = {}
        self.tasks = set()
        self.semaphore = asyncio.Semaphore(1)
        self.python = Path.home() / 'envs/paper-hub-translation/bin/python'

    def paper(self, slug):
        try:
            paper = next((p for p in self.registry_reader() if p['id'] == slug), None)
        except (OSError, ValueError, KeyError, TypeError):
            raise web.HTTPServiceUnavailable(text='论文目录暂不可用')
        if not paper:
            raise web.HTTPNotFound(text='论文未登记')
        return paper

    async def start(self, request):
        slug = request.match_info['slug']
        paper = self.paper(slug)
        body = await request.json()
        texts = body.get('texts') if isinstance(body, dict) else None
        if not isinstance(texts, list) or not 1 <= len(texts) <= 80 or any(
                not isinstance(t, str) or not t.strip() or len(t) > 16000 for t in texts) or sum(map(len, texts)) > 120000:
            return web.json_response({'error': '请按章节翻译，每次最多 80 段、12 万字。'}, status=400)
        engine = body.get('engine', 'offline')
        if engine not in ('ai', 'offline'):
            return web.json_response({'error': '请选择 AI 精译或离线速译。'}, status=400)
        if engine == 'offline' and not self.python.exists():
            return web.json_response({'error': '翻译引擎尚未安装。'}, status=503)
        try:
            glossary = project_glossary(paper)
        except (OSError, ValueError, KeyError, TypeError):
            return web.json_response({'error': '论文术语表配置有误，请联系维护窗口。'}, status=503)
        engine_id = 'paper-pal-codex-gpt-5.6-luna-low-v2' if engine == 'ai' else ENGINE
        digest = cache_digest(engine_id, glossary, texts)
        key = (slug, digest)
        if self.jobs.get(key, {}).get('status') == 'error':
            del self.jobs[key]
        cached = Path(paper['repo']) / '.paper-pal/translations' / (digest + '.json')
        if key not in self.jobs:
            if cached.exists():
                try:
                    data = json.loads(cached.read_text())
                    if data.get('engine') != engine_id or not isinstance(data.get('translations'),list) or len(data['translations']) != len(texts) or any(not isinstance(t,str) or not t.strip() for t in data['translations']):
                        raise ValueError('Translation cache mismatch')
                    self.jobs[key] = {'id': digest, 'status': 'done', 'translations': data['translations'], 'total': len(texts), 'completed': len(texts)}
                except (OSError, ValueError, KeyError, TypeError):
                    cached.unlink(missing_ok=True)
            if key not in self.jobs:
                if sum(j['status'] in ('queued', 'running') for j in self.jobs.values()) >= 4:
                    return web.json_response({'error': '翻译任务较多，请稍后再试。'}, status=429)
                translated=[]
                for text in texts:
                    segment=cached.parent/('p-'+cache_digest(engine_id,glossary,text)+'.json')
                    try:
                        value=json.loads(segment.read_text())
                        translated.append(value['text'] if value['engine']==engine_id and isinstance(value['text'],str) else None)
                    except (OSError,ValueError,KeyError,TypeError): translated.append(None)
                self.jobs[key] = {'id': digest, 'status': 'queued', 'translations': translated, 'total': len(texts), 'completed': sum(t is not None for t in translated)}
                task = asyncio.create_task(self.run(key, texts, cached, glossary, engine_id))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
        return web.json_response(self.jobs[key], status=202)

    async def status(self, request):
        slug = request.match_info['slug']
        self.paper(slug)
        job = self.jobs.get((slug, request.match_info['job']))
        if not job:
            raise web.HTTPNotFound(text='翻译任务不存在，请重新点击翻译')
        return web.json_response(job)

    async def run(self, key, texts, cached, glossary, engine_id):
        job = self.jobs[key]
        process = None
        diagnostics = None
        try:
            async with self.semaphore:
                job['status'] = 'running'
                missing=[i for i,t in enumerate(job['translations']) if t is None]
                if not missing:
                    save_cache(cached,{'engine':engine_id,'translations':job['translations']})
                    job['status']='done'
                    return
                command = [str(self.python), str(self.root / 'translate-worker.py')] if engine_id == ENGINE else ['node', str(self.root / 'translation-ai.mjs')]
                cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                diagnostic_path = cached.with_suffix('.log')
                diagnostics = open(diagnostic_path, 'wb')
                diagnostic_path.chmod(0o600)
                task_tmp = Path.home() / 'tmp/paper-hub-translation'
                task_tmp.mkdir(parents=True, exist_ok=True, mode=0o700)
                process = await asyncio.create_subprocess_exec(
                    *command,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=diagnostics, start_new_session=True,
                    env=worker_environment(os.environ, task_tmp))
                async def collect():
                    process.stdin.write(json.dumps({'texts': [texts[i] for i in missing], 'glossary': glossary}).encode())
                    await process.stdin.drain()
                    process.stdin.close()
                    received=0
                    async for line in process.stdout:
                        result = json.loads(line)
                        if result['index'] != received or received>=len(missing) or not isinstance(result['text'], str) or not result['text'].strip():
                            raise ValueError('Invalid translation result')
                        index=missing[received]
                        job['translations'][index]=result['text']
                        save_cache(cached.parent/('p-'+cache_digest(engine_id,glossary,texts[index])+'.json'),{'engine':engine_id,'text':result['text']})
                        received+=1
                        job['completed'] += 1
                    if await process.wait() != 0 or job['completed'] != len(texts):
                        raise ValueError('Translation worker failed')
                await asyncio.wait_for(collect(), 600)
                cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                save_cache(cached,{'engine':engine_id,'translations':job['translations']})
                job['status'] = 'done'
        except asyncio.CancelledError:
            job.update(status='error', error='服务已重启，请重新点击翻译。')
            raise
        except (OSError, ValueError, KeyError, asyncio.TimeoutError):
            job.update(status='error', error='本次翻译未完成，请重试。原文仍保留。')
        finally:
            if process and process.returncode is None:
                await stop_process_group(process)
            if diagnostics:
                diagnostics.close()
            # Bound in-memory history; successful translations remain on disk.
            if len(self.jobs) > 100:
                for old in list(self.jobs):
                    if old != key and self.jobs[old]['status'] not in ('queued', 'running'):
                        del self.jobs[old]
                        if len(self.jobs) <= 80:
                            break

    async def cleanup(self, app):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def install(self, app):
        app.router.add_post('/papers/{slug}/hub/translate', self.start)
        app.router.add_get('/papers/{slug}/hub/translate/{job}', self.status)
        app.on_cleanup.append(self.cleanup)
