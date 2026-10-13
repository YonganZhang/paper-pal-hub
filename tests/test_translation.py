import asyncio
import json
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from translation import TranslationJobs, project_glossary, stop_process_group, ENGINE


class TranslationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '_tmp')
        root = Path(self.tmp.name)
        self.papers = [{'id': 'alpha', 'repo': str(root / 'alpha')}, {'id': 'beta', 'repo': str(root / 'beta')}]
        for paper in self.papers:
            Path(paper['repo']).mkdir()
        self.jobs = TranslationJobs(lambda: self.papers, root)
        app = web.Application()
        self.jobs.install(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_bounds_isolation_cache_and_real_status(self):
        for value in ({}, {'texts':['']}, {'texts':[5]}, {'texts':['a']*81}):
            result=await self.client.post('/papers/alpha/hub/translate',json=value)
            self.assertEqual(result.status,400)
        async def fake_run(key,texts,cached,glossary,engine_id):
            self.jobs.jobs[key].update(status='done',translations=['中文'],completed=1)
            cached.parent.mkdir(parents=True)
            cached.write_text(json.dumps({'engine':engine_id,'translations':['中文']}))
        with patch.object(self.jobs,'run',side_effect=fake_run):
            result=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original 96.1%']})
            data=await result.json()
            await asyncio.sleep(.01)
        route='/papers/alpha/hub/translate/'+data['id']
        self.assertEqual((await (await self.client.get(route)).json())['status'],'done')
        self.assertEqual((await self.client.get(route.replace('alpha','beta'))).status,404)
        self.jobs.jobs.clear()
        cached=await (await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original 96.1%']})).json()
        self.assertEqual(cached['status'],'done')
        self.assertEqual(cached['translations'],['中文'])

    async def test_glossary_is_inside_workspace_and_changes_cache(self):
        repo=Path(self.papers[0]['repo'])
        (repo/'.paper-pal.json').write_text(json.dumps({'translation':{'glossary':'terms.json'}}))
        (repo/'terms.json').write_text(json.dumps({'cement bond':{'target':'固井胶结','variants':['水泥债券']}}))
        self.assertEqual(project_glossary(self.papers[0])['cement bond']['target'],'固井胶结')
        (repo/'.paper-pal.json').write_text(json.dumps({'translation':{'glossary':'../outside.json'}}))
        with self.assertRaises(ValueError):
            project_glossary(self.papers[0])

    async def test_stuck_worker_cleanup_is_bounded(self):
        class StuckProcess:
            pid = 12345
            async def wait(self):
                await asyncio.Event().wait()
        with patch('translation.os.killpg') as kill, self.assertLogs('translation', level='WARNING'):
            await asyncio.wait_for(stop_process_group(StuckProcess(), grace=.01), .1)
        self.assertEqual(kill.call_count, 2)

    async def test_progress_and_paragraph_reuse_after_one_paragraph_changes(self):
        self.jobs.python=Path(sys.executable)
        worker=self.jobs.root/'translate-worker.py'
        worker.write_text("import sys,json,time,os\np=json.load(sys.stdin)\nopen(__file__+'.input','w').write(json.dumps(p['texts']))\nopen(__file__+'.env','w').write(json.dumps(dict(os.environ)))\nfor i,t in enumerate(p['texts']):\n print(json.dumps({'index':i,'text':'中文 '+t}),flush=True)\n time.sleep(.15)\n")
        async def wait(job,done=True):
            for _ in range(100):
                value=await (await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if (done and value['status']=='done') or (not done and value['completed']==1):return value
                if value['status']=='error':self.fail(value['error'])
                await asyncio.sleep(.01)
            self.fail('Worker progress timeout')
        with patch.dict('os.environ',{'ANTHROPIC_API_KEY':'fixture-key','UNRELATED_SECRET':'fixture-secret',
                                      'https_proxy':'http://fixture-proxy','LC_CTYPE':'C.UTF-8'}):
            first=await (await self.client.post('/papers/alpha/hub/translate',json={'texts':['First','Second']})).json()
            partial=await wait(first,False)
            self.assertEqual(partial['translations'],['中文 First',None])
            await wait(first)
            env=json.loads(Path(str(worker)+'.env').read_text())
            self.assertNotIn('ANTHROPIC_API_KEY',env)
            self.assertNotIn('UNRELATED_SECRET',env)
            self.assertEqual(env['https_proxy'],'http://fixture-proxy')
            self.assertEqual(env['LC_CTYPE'],'C.UTF-8')
            self.assertEqual(env['CUDA_VISIBLE_DEVICES'],'')
        second=await (await self.client.post('/papers/alpha/hub/translate',json={'texts':['First','Changed']})).json()
        self.assertEqual(second['translations'][0],'中文 First')
        result=await wait(second)
        self.assertEqual(result['translations'],['中文 First','中文 Changed'])
        self.assertEqual(json.loads(Path(str(worker)+'.input').read_text()),['Changed'])
        for cache in (Path(self.papers[0]['repo'])/'.paper-pal/translations').glob('*.json'):
            self.assertEqual(cache.stat().st_mode & 0o777,0o600)


if __name__=='__main__':
    unittest.main()
