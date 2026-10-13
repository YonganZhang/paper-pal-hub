"""Read-only Argos translation jobs and per-paper, content-addressed cache."""
import asyncio
import hashlib
import json
import os
import logging
import signal
import re
import tempfile
from pathlib import Path

from aiohttp import web

ENGINE = 'argos-1.11.0-en-zh-1.9-int8-beam1-v3'
AI_REVISION = 'v4-isolated-checked'


def translation_revision(engine, glossary, model=None, provider='codex'):
    return cache_digest(f'paper-pal-{provider}-{model}-low-{AI_REVISION}' if engine == 'ai' else ENGINE, glossary, [])


def validate_translation(source, translated, glossary, *, strict=False):
    from collections import Counter
    # Keep decimals, percentages, signed values and citation years; punctuation
    # surrounding numbers may change naturally between English and Chinese.
    def numbers(text):
        text=text.replace('−','-').replace('％','%').replace('\\%','%')
        # Commas separate citations unless they form a thousands group.
        tokens=re.findall(r'(?<![A-Za-z0-9])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?',text)
        return Counter(token.replace(',','').lstrip('+') for token in tokens)
    words=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty']
    aliases={word:str(index) for index,word in enumerate(words)}
    aliases.update({word:str(index) for index,word in enumerate(['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'],1)})
    spelled=Counter(aliases[word.lower()] for word in re.findall(r'\b(?:'+ '|'.join(aliases)+r')\b',source,re.I))
    original=numbers(source);target=numbers(translated)
    # English "four models (1...4)" may naturally become "4个模型（1...4）".
    # Still reject missing original values, changed units and invented values.
    if any(target[value]<count for value,count in original.items()) or any(count>original[value]+spelled[value] for value,count in target.items()):
        raise ValueError('Translation changed numeric values')
    if strict:
        for term,rule in glossary.items():
            if rule['variants']: continue
            pattern=r'(?<![A-Za-z0-9])'+re.escape(term)+r'(?![A-Za-z0-9])'
            if re.search(pattern,source) and not re.search(pattern,translated):
                raise ValueError('Translation changed a protected label')


def worker_environment(source, task_tmp, *, browser=False):
    """Keep runtime, locale, certificate and network settings; no unrelated keys."""
    keep = {'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'CODEX_HOME', 'CODEX_BIN',
            'PAPER_PAL_DIR', 'PAPER_HUB_TRANSLATION_MODEL', 'PAPER_HUB_TRANSLATION_PROVIDER', 'CLAUDE_BIN',
            'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
            'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE',
            'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'}
    if browser:
        keep |= {'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CHATGPT_WEB_WRITE_LOCK', 'CHATGPT_WEB_CDP'}
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
        except asyncio.TimeoutError:
            pass
        if sig == signal.SIGTERM:
            # A reaped leader can still leave a CLI descendant in its process group.
            await asyncio.sleep(min(grace, .05))
        elif getattr(process, 'returncode', None) is not None:
            return
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


def project_ai_provider(paper):
    config_path=Path(paper['repo'])/'.paper-pal.json'
    config=json.loads(config_path.read_text()) if config_path.is_file() else {}
    provider=config.get('translation',{}).get('aiProvider') or os.environ.get('PAPER_HUB_TRANSLATION_PROVIDER') or 'codex'
    if provider not in ('codex','claude'):raise ValueError('Unsupported translation subscription provider')
    return provider


def project_ai_model(paper):
    """Freeze the requested translation model and use it in cache identity."""
    config_path = Path(paper['repo']) / '.paper-pal.json'
    config = json.loads(config_path.read_text()) if config_path.is_file() else {}
    model = config.get('translation', {}).get('aiModel') or os.environ.get('PAPER_HUB_TRANSLATION_MODEL') or ('haiku' if project_ai_provider(paper)=='claude' else 'gpt-5.6-luna')
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}', model):
        raise ValueError('Invalid translation model')
    return model


class TranslationJobs:
    def __init__(self, registry_reader, root):
        self.registry_reader = registry_reader
        self.root = root
        self.jobs = {}
        self.tasks = set()
        self.semaphore = asyncio.Semaphore(2)
        self.python = Path.home() / 'envs/paper-hub-translation/bin/python'

    def paper(self, slug):
        try:
            paper = next((p for p in self.registry_reader() if p['id'] == slug), None)
        except (OSError, ValueError, KeyError, TypeError):
            raise web.HTTPServiceUnavailable(text='论文目录暂不可用')
        if not paper:
            raise web.HTTPNotFound(text='论文未登记')
        return paper

    async def configuration(self, request):
        paper=self.paper(request.match_info['slug'])
        try:
            glossary=project_glossary(paper);model=project_ai_model(paper);provider=project_ai_provider(paper)
            value={'default_engine':'ai','revisions':{engine:translation_revision(engine,glossary,model,provider) for engine in ('ai','offline')}}
            return web.json_response(value,headers={'Cache-Control':'no-store, private'})
        except (OSError,ValueError,KeyError,TypeError):
            return web.json_response({'error':'论文翻译配置有误，请联系维护窗口。'},status=503)

    async def start(self, request):
        slug = request.match_info['slug']
        paper = self.paper(slug)
        body = await request.json()
        texts = body.get('texts') if isinstance(body, dict) else None
        if not isinstance(texts, list) or not 1 <= len(texts) <= 80 or any(
                not isinstance(t, str) or not t.strip() or len(t) > 16000 for t in texts) or sum(map(len, texts)) > 120000:
            return web.json_response({'error': '请按章节翻译，每次最多 80 段、12 万字。'}, status=400)
        # Reject typesetter assignments before consulting any legacy cache.
        # Mathematical commands (frac, operatorname, etc.) are valid content.
        if any(re.match(r'^\s*\\(?:cs_[A-Za-z_]+:[A-Za-z]+|(?:newcommand|renewcommand|providecommand|[egx]?def|let|ExplSyntaxOn|ExplSyntaxOff)(?![A-Za-z]))',text) for text in texts):
            return web.json_response({'error':'检测到LaTeX排版配置，不属于论文正文，请刷新阅读页面。'},status=400)
        engine = body.get('engine', 'offline')
        refresh=body.get('refresh',False)
        if not isinstance(refresh,bool) or (refresh and len(texts)!=1):
            return web.json_response({'error':'重新翻译仅支持单段，请使用布尔值refresh。'},status=400)
        if engine not in ('ai', 'offline'):
            return web.json_response({'error': '请选择 AI 精译或离线速译。'}, status=400)
        if engine == 'offline' and not self.python.exists():
            return web.json_response({'error': '翻译引擎尚未安装。'}, status=503)
        try:
            glossary = project_glossary(paper)
            model = project_ai_model(paper) if engine == 'ai' else None
            provider=project_ai_provider(paper) if engine=='ai' else None
        except (OSError, ValueError, KeyError, TypeError):
            return web.json_response({'error': '论文翻译配置有误，请联系维护窗口。'}, status=503)
        engine_id = f'paper-pal-{provider}-{model}-low-{AI_REVISION}' if engine == 'ai' else ENGINE
        revision=translation_revision(engine,glossary,model,provider)
        if body.get('revision') not in (None,revision):
            return web.json_response({'error':'翻译配置已更新，请刷新页面后重试。'},status=409)
        digest = cache_digest(engine_id, glossary, texts)
        key = (slug, digest)
        existing=self.jobs.get(key)
        if refresh and existing and existing['status'] in ('queued','running'):
            return web.json_response(existing,status=202)
        if refresh:
            if sum(j['status'] in ('queued','running') for j in self.jobs.values())>=4:
                return web.json_response({'error':'翻译任务较多，请稍后再试。'},status=429)
            # Legacy chapter aggregates must not keep a pre-refresh paragraph.
            for old_key,old_job in list(self.jobs.items()):
                if old_key[0]==slug and old_job['status']=='done':self.jobs.pop(old_key)
            directory=Path(paper['repo'])/'.paper-pal/translations'
            for aggregate in directory.glob('[0-9a-f]*.json'):
                try:
                    if json.loads(aggregate.read_text()).get('engine')==engine_id:aggregate.unlink()
                except (OSError,ValueError):continue
        if self.jobs.get(key, {}).get('status') == 'error':
            del self.jobs[key]
        cached = Path(paper['repo']) / '.paper-pal/translations' / (digest + '.json')
        if key not in self.jobs:
            if cached.exists() and not refresh:
                try:
                    data = json.loads(cached.read_text())
                    if data.get('engine') != engine_id or not isinstance(data.get('translations'),list) or len(data['translations']) != len(texts) or any(not isinstance(t,str) or not t.strip() for t in data['translations']):
                        raise ValueError('Translation cache mismatch')
                    for source,target in zip(texts,data['translations']):validate_translation(source,target,glossary,strict=engine=='ai')
                    self.jobs[key] = {'id': digest, 'status': 'done', 'translations': data['translations'], 'total': len(texts), 'completed': len(texts), 'model': model, 'provider':provider,'revision':revision}
                except (OSError, ValueError, KeyError, TypeError):
                    cached.unlink(missing_ok=True)
            if key not in self.jobs:
                translated=[]
                for text in texts:
                    # Unresolved LaTeX include identifiers have no linguistic
                    # content. Keep them intact, including leading zeroes.
                    if re.fullmatch(r'(?:table|fig|eq|sec|app)_[A-Za-z0-9_]+',text):
                        translated.append(text)
                        continue
                    if refresh:
                        translated.append(None)
                        continue
                    segment=cached.parent/('p-'+cache_digest(engine_id,glossary,text)+'.json')
                    try:
                        value=json.loads(segment.read_text())
                        target=value['text']
                        if value['engine']!=engine_id or not isinstance(target,str) or not target.strip():raise ValueError('Invalid paragraph cache')
                        validate_translation(text,target,glossary,strict=engine=='ai')
                        translated.append(target)
                    except (OSError,ValueError,KeyError,TypeError): translated.append(None)
                ready=all(t is not None for t in translated)
                if not ready and sum(j['status'] in ('queued', 'running') for j in self.jobs.values())>=4:
                    return web.json_response({'error':'翻译任务较多，请稍后再试。'},status=429)
                self.jobs[key] = {'id': digest, 'status': 'done' if ready else 'queued', 'translations': translated, 'total': len(texts), 'completed': sum(t is not None for t in translated), 'model': model, 'provider':provider,'revision':revision}
                if ready:save_cache(cached,{'engine':engine_id,'translations':translated})
                else:
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
        terminal = None
        acquired = False
        try:
            await self.semaphore.acquire()
            acquired = True
            job['status'] = 'running'
            missing=[i for i,t in enumerate(job['translations']) if t is None]
            if not missing:
                save_cache(cached,{'engine':engine_id,'translations':job['translations']})
                terminal = {'status':'done'}
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
                process.stdin.write(json.dumps({'texts': [texts[i] for i in missing], 'glossary': glossary, 'aiModel': job.get('model'), 'aiProvider':job.get('provider')}).encode())
                await process.stdin.drain()
                process.stdin.close()
                received=0
                async for line in process.stdout:
                    result = json.loads(line)
                    if result['index'] != received or received>=len(missing) or not isinstance(result['text'], str) or not result['text'].strip():
                        raise ValueError('Invalid translation result')
                    index=missing[received]
                    validate_translation(texts[index],result['text'],glossary,strict=engine_id!=ENGINE)
                    job['translations'][index]=result['text']
                    save_cache(cached.parent/('p-'+cache_digest(engine_id,glossary,texts[index])+'.json'),{'engine':engine_id,'text':result['text']})
                    received+=1
                    job['completed'] += 1
                if await process.wait() != 0 or job['completed'] != len(texts):
                    raise ValueError('Translation worker failed')
            await asyncio.wait_for(collect(), 600)
            cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            save_cache(cached,{'engine':engine_id,'translations':job['translations']})
            terminal = {'status':'done'}
        except asyncio.CancelledError:
            terminal = {'status':'error', 'error':'服务已重启，请重新点击翻译。'}
            raise
        except (OSError, ValueError, KeyError, asyncio.TimeoutError) as error:
            logging.getLogger(__name__).warning('Translation task failed: %s',type(error).__name__+': '+str(error)[:180])
            terminal = {'status':'error', 'error':'本次翻译未完成，请重试。原文仍保留。'}
        finally:
            try:
                if process:
                    stopping = asyncio.create_task(stop_process_group(process))
                    try:
                        await asyncio.shield(stopping)
                    except asyncio.CancelledError:
                        await stopping
                        raise
            finally:
                if acquired:
                    self.semaphore.release()
                if diagnostics:
                    diagnostics.close()
                if terminal:
                    job.update(terminal)
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
        app.router.add_get('/papers/{slug}/hub/translation-config', self.configuration)
        app.router.add_post('/papers/{slug}/hub/translate', self.start)
        app.router.add_get('/papers/{slug}/hub/translate/{job}', self.status)
        app.on_cleanup.append(self.cleanup)
