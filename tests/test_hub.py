import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hub

UPSTREAM = Path.home() / '.local/share/paper-pal'
TEMP_ROOT = Path(__file__).resolve().parents[1] / '_tmp'
TEMP_ROOT.mkdir(exist_ok=True, mode=0o700)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.backends = []
        papers = []
        for slug in ['alpha', 'beta']:
            async def endpoint(request, identity=slug):
                if request.path == '/api/events':
                    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                    await response.prepare(request)
                    await response.write(f'data: {identity}\n\n'.encode())
                    await asyncio.sleep(.05)
                    await response.write_eof()
                    return response
                if request.path == '/api/pdf':
                    return web.Response(body=b'%PDF-fixture', content_type='application/pdf')
                name = request.path.lstrip('/') or 'index.html'
                if name in ['index.html', 'styles.css', 'app.js']:
                    types = {'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript'}
                    return web.Response(body=(UPSTREAM / 'public' / name).read_bytes(), content_type=types[name])
                return web.json_response({'paper': identity, 'path': request.path,
                                          'authorization': request.headers.get('Authorization'),
                                          'cookie': request.headers.get('Cookie'),
                                          'origin': request.headers.get('Origin'),
                                          'body': await request.text()})
            app = web.Application(); app.router.add_route('*', '/{path:.*}', endpoint)
            server = TestServer(app); await server.start_server(); self.backends.append(server)
            papers.append({'id': slug, 'title': slug.title(), 'port': server.port, 'repo': self.tmp.name, 'tags': []})
        self.registry = Path(self.tmp.name) / 'registry.json'
        self.registry.write_text(json.dumps({'schema_version': 1, 'papers': papers}))
        self.client = TestClient(TestServer(hub.build_app(self.registry, {'username': 'test', 'password': 'fixture'},
                                                        {'papers.test', 'papers.yongan.site', 'bondfusion.yongan.site'}, UPSTREAM)))
        await self.client.start_server()
        self.headers = {'Host': 'papers.test', 'Authorization': 'Basic ' + base64.b64encode(b'test:fixture').decode()}

    async def asyncTearDown(self):
        await self.client.close()
        for server in self.backends:
            await server.close()
        self.tmp.cleanup()

    async def test_auth_host_and_cross_site_writes(self):
        self.assertEqual((await self.client.get('/', headers={'Host': 'papers.test'})).status, 401)
        self.assertEqual((await self.client.get('/', headers=self.headers | {'Host': 'other.test'})).status, 421)
        for extra in ({'Origin': 'https://evil.test'}, {'Sec-Fetch-Site': 'same-site', 'X-Paper-Pal': '1'}, {}):
            response = await self.client.post('/papers/alpha/api/request', headers=self.headers | extra)
            self.assertEqual(response.status, 403)
        response = await self.client.post('/papers/alpha/api/request', headers=self.headers | {'Origin': 'https://papers.test'}, json={'value': 'unchanged'})
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertIsNone(data['authorization'])
        self.assertEqual(data['origin'], f'http://127.0.0.1:{self.backends[0].port}')
        self.assertEqual(json.loads(data['body']), {'value': 'unchanged'})

    async def test_cards_and_parallel_paper_isolation(self):
        response = await self.client.get('/api/papers', headers=self.headers)
        data = await response.json()
        self.assertEqual([p['id'] for p in data['papers']], ['alpha', 'beta'])
        self.assertTrue(all(p['ready'] for p in data['papers']))
        self.assertNotIn('repo', data['papers'][0])
        for slug in ['alpha', 'beta', 'alpha']:
            response = await self.client.get(f'/papers/{slug}/api/requests', headers=self.headers)
            self.assertEqual((await response.json())['paper'], slug)
        self.assertEqual((await self.client.get('/papers/missing/api/requests', headers=self.headers)).status, 404)

    async def test_asset_prefixes_pdf_and_sse(self):
        response = await self.client.get('/papers/alpha/', headers=self.headers)
        html = await response.text()
        self.assertIn('href="/papers/alpha/styles.css"', html)
        self.assertIn('/hub-assets/mobile.js', html)
        self.assertIn('/hub-assets/reader.js', html)
        response = await self.client.get('/papers/alpha/app.js', headers=self.headers)
        script = await response.text()
        self.assertNotIn('"/api/', script)
        self.assertIn('new EventSource("/papers/alpha/api/events")', script)
        self.assertIn('[/]papers[/]alpha[/]api[/]', script)
        self.assertIn('paper-pal.alpha.openDocument', script)
        self.assertEqual(script.count('new CustomEvent("paper-hub:document"'), 1)
        response = await self.client.get('/papers/alpha/styles.css', headers=self.headers)
        self.assertIn('url("/papers/alpha/fonts/', await response.text())
        response = await self.client.get('/papers/alpha/api/pdf', headers=self.headers)
        self.assertEqual(await response.read(), b'%PDF-fixture')
        response = await self.client.get('/papers/beta/api/events', headers=self.headers)
        self.assertEqual(await response.content.readuntil(b'\n\n'), b'data: beta\n\n')

    async def test_registry_failure_and_recovery(self):
        original = self.registry.read_text()
        for broken in ['{', '[]', '{"schema_version":1,"papers":null}',
                       '{"schema_version":1,"papers":[{}]}', None]:
            if broken is None:
                self.registry.unlink()
            else:
                self.registry.write_text(broken)
            for path in ['/api/papers', '/papers/alpha/api/bootstrap']:
                response = await self.client.get(path, headers=self.headers)
                self.assertEqual(response.status, 503)
                self.assertNotIn(self.tmp.name, await response.text())
        self.registry.write_text(original)
        response = await self.client.get('/api/papers', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual(len((await response.json())['papers']), 2)

    async def test_asset_incompatibility_is_explicit_and_recovers(self):
        with self.assertRaises(ValueError):
            hub.adapt_asset('index.html',b'<html><head></head><head></head></html>','alpha')
        with patch('hub.adapt_asset', side_effect=ValueError('anchor changed')):
            response = await self.client.get('/papers/alpha/app.js', headers=self.headers)
            self.assertEqual(response.status, 502)
            self.assertIn('服务需要更新', await response.text())
            self.assertNotIn('anchor changed', await response.text())
        response = await self.client.get('/papers/alpha/app.js', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertIn('paper-hub:document', await response.text())

    async def test_form_login_keeps_session_without_authorization(self):
        anonymous = {'Host': 'papers.test', 'Accept': 'text/html'}
        response = await self.client.get('/papers/alpha/', headers=anonymous, allow_redirects=False)
        self.assertEqual(response.status, 303)
        self.assertNotIn('WWW-Authenticate', response.headers)
        login = await self.client.get(response.headers['Location'], headers=anonymous)
        self.assertIn('autocomplete="current-password"', await login.text())
        response = await self.client.post('/login', headers=anonymous | {'Origin': 'https://papers.test'},
                                          data={'username': 'test', 'password': 'fixture', 'next': '/papers/alpha/'},
                                          allow_redirects=False)
        self.assertEqual(response.status, 303)
        self.assertEqual(response.headers['Location'], '/papers/alpha/')
        cookie = response.cookies['__Host-paper_hub']
        self.assertTrue(cookie['secure']); self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], '/')
        self.assertEqual(int(cookie['max-age']), 400 * 24 * 60 * 60)
        session_headers = {'Host': 'papers.test', 'Cookie': f'__Host-paper_hub={cookie.value}'}
        response = await self.client.get('/login?next=/papers/alpha/', headers=session_headers, allow_redirects=False)
        self.assertEqual(response.status, 303)
        self.assertEqual(response.headers['Location'], '/papers/alpha/')
        self.assertIn('__Host-paper_hub', response.cookies)
        for path in ['/', '/api/papers', '/papers/alpha/', '/papers/alpha/app.js', '/papers/alpha/api/pdf']:
            self.assertEqual((await self.client.get(path, headers=session_headers)).status, 200, path)
        response = await self.client.get('/papers/beta/api/events', headers=session_headers)
        self.assertIn('__Host-paper_hub', response.cookies)
        self.assertEqual(await response.content.readuntil(b'\n\n'), b'data: beta\n\n')
        response = await self.client.post('/papers/alpha/api/request', headers=session_headers | {'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/papers/alpha/api/request', headers=session_headers | {'Origin': 'https://papers.test'}, json={'message': 'fixture'})
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertIsNone(data['authorization'])
        self.assertIsNone(data['cookie'])

    async def test_form_login_rejects_invalid_password_and_cross_site(self):
        headers = {'Host': 'papers.test', 'Origin': 'https://papers.test'}
        response = await self.client.post('/login', headers=headers, data={'username': 'test', 'password': 'wrong'})
        self.assertEqual(response.status, 401)
        self.assertNotIn('WWW-Authenticate', response.headers)
        self.assertNotIn('Set-Cookie', response.headers)
        self.assertNotIn('wrong', await response.text())
        response = await self.client.post('/login', headers=headers | {'Origin': 'https://evil.test'},
                                          data={'username': 'test', 'password': 'fixture'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/login', headers=headers,
                                          data={'username': 'test', 'password': 'fixture', 'next': '//evil.test/'},
                                          allow_redirects=False)
        self.assertEqual(response.headers['Location'], '/')

    async def test_invalid_cookie_never_triggers_browser_auth_dialog(self):
        response = await self.client.get('/api/papers', headers={
            'Host': 'papers.test', 'Cookie': '__Host-paper_hub=invalid'})
        self.assertEqual(response.status, 401)
        self.assertNotIn('WWW-Authenticate', response.headers)

    async def test_old_domain_uses_one_canonical_login(self):
        response = await self.client.get('/papers/bondfusion/', headers={
            'Host': 'bondfusion.yongan.site', 'Accept': 'text/html'}, allow_redirects=False)
        self.assertEqual(response.status, 308)
        self.assertEqual(response.headers['Location'], 'https://papers.yongan.site/papers/bondfusion/')
        self.assertNotIn('WWW-Authenticate', response.headers)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.root = Path(self.tmp.name)
        self.registry = self.root / 'registry.json'
        self.repo = self.root / 'project'; self.repo.mkdir()
        (self.repo / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n')
        (self.repo / '.paper-pal.json').write_text(json.dumps({'sourceRoot': '.', 'defaultDocument': 'main.tex', 'pdf': 'main.pdf'}))

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, str(hub.ROOT / 'cli.py'), *args, '--registry', str(self.registry), '--json'], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=15)

    def test_idempotence_conflict_and_failure_isolation(self):
        config_before = (self.repo / '.paper-pal.json').read_bytes()
        first = self.cli('add', str(self.repo), '--id', 'alpha', '--title', 'Alpha', '--no-start')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue(json.loads(first.stdout)['created'])
        before = self.registry.read_bytes()
        second = self.cli('add', str(self.repo), '--id', 'alpha', '--title', 'Alpha', '--no-start')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse(json.loads(second.stdout)['created'])
        other = self.root / 'other'; other.mkdir()
        failed = self.cli('add', str(other), '--id', 'alpha', '--title', 'Other', '--no-start')
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(failed.stdout, '')
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual((self.repo / '.paper-pal.json').read_bytes(), config_before)
        self.assertFalse((other / '.paper-pal.json').exists())
        status = self.cli('status')
        self.assertEqual(status.returncode, 1)
        self.assertFalse(json.loads(status.stdout)['papers'][0]['ready'])

    def test_concurrent_registrations_keep_both_projects(self):
        jobs = []
        for slug in ['alpha', 'beta']:
            repo = self.root / slug; repo.mkdir()
            (repo / 'main.tex').write_text('Fixture')
            (repo / '.paper-pal.json').write_text(json.dumps({'sourceRoot': '.', 'defaultDocument': 'main.tex'}))
            jobs.append(subprocess.Popen([sys.executable, str(hub.ROOT / 'cli.py'), 'add', str(repo), '--id', slug,
                                          '--title', slug, '--no-start', '--registry', str(self.registry), '--json'],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        for job in jobs:
            out, err = job.communicate(timeout=15)
            self.assertEqual(job.returncode, 0, err)
            self.assertTrue(json.loads(out)['created'])
        self.assertEqual({p['id'] for p in json.loads(self.registry.read_text())['papers']}, {'alpha', 'beta'})


class SessionTests(unittest.TestCase):
    def test_restart_rotation_long_term_and_tampering(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            path = Path(directory) / 'session.key'
            key = hub.load_session_key(path)
            token = hub.issue_session(key, b'test:fixture', 'papers.test')
            # Reopening the runtime key simulates a new service process.
            self.assertTrue(hub.valid_session(token, hub.load_session_key(path), b'test:fixture', 'papers.test'))
            self.assertFalse(path.stat().st_mode & 0o077)
            self.assertFalse(hub.valid_session(token, key, b'test:new-password', 'papers.test'))
            self.assertFalse(hub.valid_session(token, key, b'test:fixture', 'alias.test'))
            self.assertFalse(hub.valid_session(token[:-1] + ('0' if token[-1] != '0' else '1'), key, b'test:fixture', 'papers.test'))
            with patch.object(hub.time, 'time', return_value=10**11):
                self.assertTrue(hub.valid_session(token, key, b'test:fixture', 'papers.test'))
            for invalid in ['', 'invalid', 'v1.999999999999.a.é']:
                self.assertFalse(hub.valid_session(invalid, key, b'test:fixture', 'papers.test'))


if __name__ == '__main__':
    unittest.main()
