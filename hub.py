#!/usr/bin/env python3
"""Authenticated multi-project gateway; manuscript writes remain in Paper Pal."""
import argparse
import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import unquote

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from yarl import URL
from translation import TranslationJobs
from versions import VersionService
from figures import FigureStudio

ROOT = Path(__file__).resolve().parent
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
       'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding'}
CLIENT = web.AppKey('client', ClientSession)
SESSION_AUTH = web.RequestKey('session_authenticated', bool)
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
# Browsers cap persistent cookies; renew on each authenticated visit. The
# server-side signature has no time expiry and survives service restarts.
COOKIE_MAX_AGE = 400 * 24 * 60 * 60


def load_session_key(path):
    """Persist independently from service restarts; never log or publish the key."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'wb') as out:
            out.write(secrets.token_bytes(32))
    if path.stat().st_mode & 0o077:
        raise ValueError('Session key must be private (0600)')
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid session key')
    return key


def session_signature(key, identity, host, payload):
    return hmac.new(key, identity + b'\0' + host.encode() + b'\0' + payload.encode(), hashlib.sha256).hexdigest()


def issue_session(key, identity, host):
    payload = f'v2.{int(time.time())}.{secrets.token_hex(16)}'
    return payload + '.' + session_signature(key, identity, host, payload)


def valid_session(token, key, identity, host):
    if not re.fullmatch(r'v2\.\d{1,12}\.[a-f0-9]{32}\.[a-f0-9]{64}', token):
        return False
    parts = token.split('.')
    expected = session_signature(key, identity, host, '.'.join(parts[:3]))
    return hmac.compare_digest(expected, parts[3])


def login_destination(value):
    value = str(value or '/')
    decoded = unquote(value)
    if not decoded.startswith('/') or decoded.startswith('//') or any(ord(c) < 33 or c == '\\' for c in decoded):
        return '/'
    if decoded.split('?')[0] in ('/login', '/logout'):
        return '/'
    return value


def read_registry(path):
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or data.get('schema_version') != 1 or not isinstance(data.get('papers'), list):
        raise ValueError('Unsupported registry schema')
    if any(not isinstance(p, dict) or not SLUG.fullmatch(str(p.get('id', '')))
           or not isinstance(p.get('port'), int) or not 1024 <= p['port'] <= 65535
           for p in data['papers']):
        raise ValueError('Invalid paper registry entry')
    return data['papers']


def check_assets(upstream):
    lock = json.loads((ROOT / 'sources.lock.json').read_text())
    for name, digest in lock['assets'].items():
        if hashlib.sha256((upstream / 'public' / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f'Paper Pal asset changed: {name}; review overlay before upgrading')


def adapt_asset(name, body, slug):
    prefix = f'/papers/{slug}'
    text = body.decode()
    if name == 'app.js':
        # API constants and call sites change together, including SSE and PDFs.
        text = text.replace('/api/', prefix + '/api/')
        text = text.replace('[/]api[/]', f'[/]papers[/]{slug}[/]api[/]')
        text = text.replace('paper-pal.', f'paper-pal.{slug}.')
        text = text.replace('Paper Pal', '论文共改')
        flush_marker = 'async function settlePendingEdits() {'
        if text.count(flush_marker) != 1:
            raise ValueError('Archive save hook changed')
        text = text.replace(flush_marker, 'window.paperHubFlush = async () => {\n'
                            '  const ok = await settlePendingEdits();\n'
                            '  if (!ok || state.saveConflict) throw new Error("正文尚未保存成功，请先处理保存冲突。");\n'
                            '  return true;\n};\n\n' + flush_marker)
        effort_marker='[model, chatEffortLabel()].filter(Boolean)'
        if text.count(effort_marker)!=1: raise ValueError('Chat effort label anchor changed')
        text=text.replace(effort_marker,'[model, state.agentProvider === "claude" && /(^|-)haiku($|-)/i.test(model) ? null : chatEffortLabel()].filter(Boolean)')
        for english, chinese in {
            'I want to discuss this passage rather than request an inline edit.':'先讨论下面这段原文，暂不直接改稿。',
            'My question:':'我的问题：',
            'Please answer the question using the paper and project context. Do not edit the manuscript unless I later ask for a reviewable proposal.':'请结合论文和项目资料，用中文回答；需要改稿时再生成候选供我确认。',
            '<selected_passage>':'【选中原文】', '</selected_passage>':'【原文结束】',
            '`Source: ${draft.path}`':'`来源：${draft.path}`', '`Location: ${location}`':'`位置：${location}`',
            'I want to discuss and explore the organization of these paper sections before rewriting prose.':'先讨论这些章节的组织方式，再决定如何改写。',
        }.items():
            text=text.replace(english,chinese)
        # The first-paint inline script shares a global theme; other preferences
        # (model, provider and pane widths) remain per paper.
        text = text.replace(f'paper-pal.{slug}.theme', 'paper-pal.theme')
        marker = '    return true;\n  } catch (error) {\n    if (loadToken !== state.documentLoadToken) return false;'
        if text.count(marker) != 1:
            raise ValueError('Document-load hook changed; review reading-position overlay')
        text = text.replace(marker,
                            '    window.dispatchEvent(new CustomEvent("paper-hub:document", '
                            '{detail: {path: relativePath}}));\n' + marker)
        chat_marker = '  const session = state.chat;\n  const signature = chatRenderSignature(session);'
        if text.count(chat_marker) != 1:
            raise ValueError('Chat session hook changed')
        text = text.replace(chat_marker, '  const session = state.chat;\n'
                            '  window.dispatchEvent(new CustomEvent("paper-hub:chat", '
                            '{detail: {id: session?.id || null, status: session?.status}}));\n'
                            '  const signature = chatRenderSignature(session);')
        send_start = ('  dom.sendCodexChat.disabled = true;\n  try {\n'
                      f'    state.chat = await api("{prefix}/api/chat/message", {{')
        if text.count(send_start) != 1:
            raise ValueError('Chat submit snapshot anchor changed')
        text = text.replace(send_start,
                            '  dom.sendCodexChat.disabled = true;\n'
                            '  const submitted = {sessionId: state.chat?.id || null, draft: dom.codexChatInput.value,\n'
                            '    context: window.paperHubChatContext?.(state.chat?.id) || {}};\n  try {\n'
                            f'    const sentChat = await api("{prefix}/api/chat/message", {{')
        sent_marker = '    dom.codexChatInput.value = "";\n    renderChatSession();'
        if text.count(sent_marker) != 1:
            raise ValueError('Chat send hook changed')
        text = text.replace(sent_marker, '    if (state.chat?.id === submitted.sessionId) state.chat = sentChat;\n'
                            '    window.dispatchEvent(new CustomEvent("paper-hub:chat-sent", '
                            '{detail: {id: sentChat.id, fromId: submitted.sessionId, '
                            'draft: submitted.draft, context: submitted.context}}));\n    renderChatSession();')
        model_listener = ('  if (dom.agentModel) {\n'
                          '    dom.agentModel.addEventListener("change", (event) => {\n'
                          '      setAgentModel(event.target.value);\n'
                          '    });\n  }')
        init_marker = 'function initAgentProvider() {\n  const agent = state.bootstrap?.agent;'
        if text.count(model_listener) != 1 or text.count(init_marker) != 1:
            raise ValueError('Model control hook changed')
        # Upstream attaches this after a provider-count early return. A Codex-only
        # workspace still needs the model state updated, not merely the label.
        text = text.replace(model_listener, '')
        text = text.replace(init_marker, init_marker + '\n'
                            '  if (dom.agentModel) dom.agentModel.addEventListener("change", event => {\n'
                            '    setAgentModel(event.target.value);\n    updateChatMetaLabel();\n  });')
        api_marker = 'async function api(url, options = {}) {\n  options = withAgentProvider(url, options);'
        if text.count(api_marker) != 1:
            raise ValueError('Explicit-send API hook changed')
        text = text.replace(api_marker, 'async function api(url, options = {}) {\n'
                            f'  if (url === "{prefix}/api/chat/message" && options.method === "POST" && !options.paperHubExplicitSend) {{\n'
                            '    const payload = JSON.parse(options.body || "{}");\n'
                            f'    const session = await api("{prefix}/api/chat");\n'
                            '    window.dispatchEvent(new CustomEvent("paper-hub:stage-message", {detail: {...payload, sessionId: session.id}}));\n'
                            '    return session;\n  }\n  options = withAgentProvider(url, options);')
        send_body = ('      body: JSON.stringify({ message, activePath: state.document?.path || null, '
                     'sessionId: state.chat?.id || null }),')
        if text.count(send_body) != 1:
            raise ValueError('Explicit-send body hook changed')
        text = text.replace(send_body, '      paperHubExplicitSend: true,\n'
                            '      body: JSON.stringify({...submitted.context, '
                            'message, activePath: state.document?.path || null, sessionId: submitted.sessionId}),')
        text = text.replace('`${providerDisplayNameStart()} is analyzing the selected structure. Continue in Chat while it works.`',
                            '"已放入论文 AI 草稿，请点击发送。"')
    elif name == 'index.html':
        if text.count('</head>') != 1:
            raise ValueError('Index head anchor changed')
        text = re.sub(r'((?:src|href)=["\'])/(?!/)', r'\1' + prefix + '/', text)
        text = text.replace('lang="en"', 'lang="zh-CN"')
        text = text.replace('width=device-width, initial-scale=1.0',
                            'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content')
        text = text.replace('</head>', '<link rel="stylesheet" href="/hub-assets/mobile.css">\n'
                            '<link rel="stylesheet" href="/hub-assets/paper-ai.css">\n'
                            '<link rel="stylesheet" href="/hub-assets/versions.css">\n'
                            '<link rel="stylesheet" href="/hub-assets/figure-studio.css">\n'
                            '<script src="/hub-assets/zh.js" defer></script>\n'
                            '<script src="/hub-assets/reader.js" defer></script>\n'
                            '<script src="/hub-assets/mobile.js" defer></script>\n'
                            '<script src="/hub-assets/paper-ai.js" defer></script>\n'
                            '<script src="/hub-assets/translation.js" defer></script>\n</head>')
        text = text.replace('</head>', '<script src="/hub-assets/versions.js" defer></script>\n'
                            '<script src="/hub-assets/figure-studio.js" defer></script>\n'
                            '<script src="/hub-assets/figure-inline.js" defer></script>\n</head>')
    elif name == 'styles.css':
        text = text.replace('url("/', 'url("' + prefix + '/')
    return text.encode()


def build_app(registry, auth, hosts, upstream_dir, local_origin=None, session_key=None):
    check_assets(upstream_dir)
    expected = f"{auth['username']}:{auth['password']}".encode()
    session_key = session_key or secrets.token_bytes(32)
    cookie_name = 'paper_hub_local' if local_origin else '__Host-paper_hub'
    allowed_origins = {f'https://{host}' for host in hosts}
    if local_origin:
        allowed_origins.add(local_origin)

    @web.middleware
    async def security(request, handler):
        if request.host.lower() not in hosts:
            raise web.HTTPMisdirectedRequest()
        origin = request.headers.get('Origin')
        if origin is not None and origin not in allowed_origins:
            raise web.HTTPForbidden(text='Origin is not allowed')
        # Each alias is a separate browser origin, not a cross-site write shortcut.
        if origin and URL(origin).raw_authority.lower() != request.host.lower():
            raise web.HTTPForbidden(text='Origin must match the current site')
        if request.method not in ('GET', 'HEAD'):
            if request.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'):
                raise web.HTTPForbidden(text='Cross-site writes are not allowed')
            if not origin and request.headers.get('X-Paper-Pal') != '1':
                raise web.HTTPForbidden(text='Origin or X-Paper-Pal header is required')
        if not local_origin and request.host.lower() == 'bondfusion.yongan.site' and request.method in ('GET', 'HEAD'):
            return web.Response(status=308, headers={'Location': 'https://papers.yongan.site' + request.raw_path,
                                                     'Cache-Control': 'no-store'})
        public = request.path in ('/login', '/hub-assets/login.css', '/hub-assets/icon.svg')
        signed_in = valid_session(request.cookies.get(cookie_name, ''), session_key, expected, request.host.lower())
        request[SESSION_AUTH] = signed_in
        # Explicit Basic headers remain usable by local automation. Browsers are
        # never challenged: their interactive path is the same-origin form.
        scheme, _, token = request.headers.get('Authorization', '').partition(' ')
        try:
            given = base64.b64decode(token, validate=True) if scheme.lower() == 'basic' else b''
        except ValueError:
            given = b''
        signed_in = signed_in or hmac.compare_digest(expected, given)
        if not public and not signed_in:
            if request.method in ('GET', 'HEAD') and ('text/html' in request.headers.get('Accept', '')
                                                     or request.headers.get('Sec-Fetch-Mode') == 'navigate'):
                return web.Response(status=303, headers={'Location': str(URL('/login').with_query(next=request.raw_path)),
                                                        'Cache-Control': 'no-store'})
            return web.json_response({'error': 'Sign in required', 'login': '/login'}, status=401,
                                     headers={'Cache-Control': 'no-store'})
        response = await handler(request)
        if not response.prepared:
            renew_cookie(request, response)
            response.headers.update({'Cache-Control': 'no-store, private',
                                     'X-Content-Type-Options': 'nosniff',
                                     'Referrer-Policy': 'same-origin'})
        return response

    def set_session_cookie(response, token):
        response.set_cookie(cookie_name, token, max_age=COOKIE_MAX_AGE,
                            secure=not local_origin, httponly=True, samesite='Lax', path='/')

    def renew_cookie(request, response):
        if request.get(SESSION_AUTH) and response.status < 400 and cookie_name not in response.cookies:
            set_session_cookie(response, request.cookies[cookie_name])

    def login_page(next_path, error='', status=200):
        body = (ROOT / 'web/login.html').read_text().replace('__NEXT__', html.escape(next_path, quote=True))
        body = body.replace('__ERROR__', html.escape(error))
        return web.Response(text=body, status=status, content_type='text/html', headers={
            'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; "
                                       "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})

    async def login(request):
        if request.method == 'GET':
            next_path = login_destination(request.query.get('next'))
            if request[SESSION_AUTH]:
                return web.Response(status=303, headers={'Location': next_path})
            return login_page(next_path)
        form = await request.post()
        next_path = login_destination(form.get('next'))
        given = (str(form.get('username', '')) + ':' + str(form.get('password', ''))).encode()
        if not hmac.compare_digest(expected, given):
            return login_page(next_path, '账号或密码不正确，请重新输入。', 401)
        response = web.Response(status=303, headers={'Location': next_path})
        set_session_cookie(response, issue_session(session_key, expected, request.host.lower()))
        return response

    async def client_context(app):
        app[CLIENT] = ClientSession(timeout=ClientTimeout(total=None, connect=5),
                                    auto_decompress=False, trust_env=False)
        yield
        await app[CLIENT].close()

    async def home(request):
        return web.FileResponse(ROOT / 'web/index.html', headers={
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; "
                                       "img-src 'self' data:; object-src 'none'; base-uri 'none'; "
                                       "frame-ancestors 'none'; form-action 'self'"})

    async def papers(request):
        try:
            registered = read_registry(registry)
        except (OSError, ValueError, KeyError, TypeError):
            return web.json_response({'error': 'Paper registry unavailable. Please retry later.'}, status=503)
        async def status(paper):
            ready = False
            try:
                async with request.app[CLIENT].get(f"http://127.0.0.1:{paper['port']}/api/bootstrap",
                                                    timeout=ClientTimeout(total=2)) as response:
                    ready = response.status == 200
            except (ClientError, asyncio.TimeoutError):
                pass
            return {key: paper.get(key, '') for key in ('id', 'title', 'description', 'tags')} | {
                'url': f"/papers/{paper['id']}/", 'ready': ready}
        return web.json_response({'schema_version': 1, 'papers': await asyncio.gather(
            *(status(p) for p in registered))})

    async def redirect(request):
        raise web.HTTPFound(request.path + '/')

    async def proxy(request):
        slug = request.match_info['slug']
        if not SLUG.fullmatch(slug):
            raise web.HTTPNotFound()
        try:
            paper = next((p for p in read_registry(registry) if p['id'] == slug), None)
        except (OSError, ValueError, KeyError, TypeError):
            return web.Response(status=503, text='Paper registry unavailable. Please retry later.')
        if not paper:
            raise web.HTTPNotFound(text='Paper not registered')
        tail = request.match_info.get('tail', '')
        decoded = unquote(tail)
        if '\x00' in decoded or '\\' in decoded or '..' in decoded.split('/'):
            raise web.HTTPForbidden()
        upstream = f"http://127.0.0.1:{paper['port']}"
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in HOP | {'authorization', 'cookie', 'host', 'origin', 'forwarded', 'accept-encoding'}
                   and not k.lower().startswith('x-forwarded-')}
        headers['Host'] = URL(upstream).authority
        if 'Origin' in request.headers:
            headers['Origin'] = upstream
        headers['Accept-Encoding'] = 'identity'
        # raw_path preserves encoding and query strings (especially source paths).
        raw_tail = request.raw_path[len(f'/papers/{slug}/'):]
        target = URL(upstream + '/' + raw_tail, encoded=True)
        try:
            async with request.app[CLIENT].request(request.method, target, headers=headers,
                                                    data=await request.read(), allow_redirects=False) as response:
                out = {k: v for k, v in response.headers.items() if k.lower() not in HOP | {'set-cookie', 'www-authenticate'}}
                out.update({'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff',
                            'Referrer-Policy': 'same-origin', 'X-Accel-Buffering': 'no'})
                # Never leak a localhost redirect into the public browser.
                if out.get('Location', '').startswith('/'):
                    out['Location'] = f'/papers/{slug}' + out['Location']
                name = tail or 'index.html'
                if response.status == 200 and name in ('index.html', 'app.js', 'styles.css'):
                    try:
                        body = adapt_asset(name, await response.read(), slug)
                    except ValueError:
                        return web.Response(status=502, text='论文页面暂时无法加载，服务需要更新。请稍后重试。')
                    out.pop('ETag', None)
                    out.pop('Last-Modified', None)
                    return web.Response(body=body, status=200, headers=out)
                if response.status == 200 and tail == 'api/bootstrap':
                    data = json.loads(await response.read())
                    if 'agent' in data:
                        data['agent']['providers'] = [p for p in data['agent'].get('providers', []) if p['id'] in ('codex', 'claude')]
                    data['projectLabel'] = '论文工作区'
                    return web.json_response(data)
                result = web.StreamResponse(status=response.status, headers=out)
                renew_cookie(request, result)
                await result.prepare(request)
                async for chunk in response.content.iter_any():
                    await result.write(chunk)
                await result.write_eof()
                return result
        except (ClientError, asyncio.TimeoutError):
            return web.Response(status=502, text='本篇论文服务暂不可用，请回到论文库稍后重试。')

    app = web.Application(middlewares=[security], client_max_size=2_000_000)
    app.cleanup_ctx.append(client_context)
    app.router.add_get('/', home)
    app.router.add_get('/login', login)
    app.router.add_post('/login', login)
    app.router.add_get('/api/papers', papers)
    app.router.add_static('/hub-assets/', ROOT / 'web', show_index=False)
    TranslationJobs(lambda: read_registry(registry), ROOT).install(app)
    VersionService(lambda: read_registry(registry)).install(app)
    FigureStudio(lambda: read_registry(registry), ROOT).install(app)
    app.router.add_get('/papers/{slug}', redirect)
    app.router.add_route('*', '/papers/{slug}/{tail:.*}', proxy)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--auth-file', type=Path, required=True)
    parser.add_argument('--host', action='append', required=True)
    parser.add_argument('--port', type=int, default=4318)
    parser.add_argument('--local', action='store_true', help='Permit local HTTP for staging only')
    parser.add_argument('--upstream-dir', type=Path,
                        default=Path(os.environ.get('PAPER_PAL_DIR') or Path.home() / '.local/share/paper-pal').expanduser())
    args = parser.parse_args()
    if args.auth_file.stat().st_mode & 0o077:
        parser.error('Auth file must be private (0600)')
    auth = json.loads(args.auth_file.read_text())
    if not auth.get('username') or not auth.get('password'):
        parser.error('Missing credentials')
    key = load_session_key(args.auth_file.parent / 'hub-session.key')
    app = build_app(args.registry, auth, set(args.host), args.upstream_dir,
                    f'http://127.0.0.1:{args.port}' if args.local else None, key)
    web.run_app(app, host='127.0.0.1', port=args.port, access_log=None, shutdown_timeout=3)


if __name__ == '__main__':
    main()
