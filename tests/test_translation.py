import asyncio
import json
import tempfile
import unittest
import sys
import os
import signal
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from translation import TranslationJobs, project_glossary, project_ai_model, worker_environment, stop_process_group, ENGINE, validate_translation, translation_revision, project_ai_provider


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
            self.jobs.jobs[key].update(status='done',translations=['中文 96.1%'],completed=1)
            cached.parent.mkdir(parents=True)
            cached.write_text(json.dumps({'engine':engine_id,'translations':['中文 96.1%']}))
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
        self.assertEqual(cached['translations'],['中文 96.1%'])

    async def test_glossary_is_inside_workspace_and_changes_cache(self):
        repo=Path(self.papers[0]['repo'])
        (repo/'.paper-pal.json').write_text(json.dumps({'translation':{'glossary':'terms.json'}}))
        (repo/'terms.json').write_text(json.dumps({'cement bond':{'target':'固井胶结','variants':['水泥债券']}}))
        self.assertEqual(project_glossary(self.papers[0])['cement bond']['target'],'固井胶结')
        (repo/'.paper-pal.json').write_text(json.dumps({'translation':{'glossary':'../outside.json'}}))
        with self.assertRaises(ValueError):
            project_glossary(self.papers[0])

    async def test_configuration_revision_fences_model_changes(self):
        repo=Path(self.papers[0]['repo']);config=repo/'.paper-pal.json'
        config.write_text(json.dumps({'translation':{'aiProvider':'claude','aiModel':'haiku'}}))
        first=await(await self.client.get('/papers/alpha/hub/translation-config')).json()
        self.assertEqual(first['default_engine'],'ai')
        self.assertEqual(project_ai_provider(self.papers[0]),'claude')
        config.write_text(json.dumps({'translation':{'aiProvider':'codex','aiModel':'model-b'}}))
        second=await(await self.client.get('/papers/alpha/hub/translation-config')).json()
        self.assertNotEqual(first['revisions']['ai'],second['revisions']['ai'])
        response=await self.client.post('/papers/alpha/hub/translate',json={'engine':'ai','texts':['Original'],'revision':first['revisions']['ai']})
        self.assertEqual(response.status,409)
        config.write_text(json.dumps({'translation':{'aiProvider':'api'}}))
        with self.assertRaises(ValueError):project_ai_provider(self.papers[0])

    async def test_wrong_numeric_translation_is_not_cached_as_done(self):
        self.jobs.python=Path(sys.executable)
        (self.jobs.root/'translate-worker.py').write_text("import json,sys\np=json.load(sys.stdin)\nprint(json.dumps({'index':0,'text':'准确率99%'}),flush=True)\n")
        job=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':['Accuracy 96.1%']})).json()
        for _ in range(100):
            current=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
            if current['status']=='error':break
            await asyncio.sleep(.01)
        self.assertEqual(current['status'],'error')
        self.assertEqual(current['completed'],0)
        self.assertEqual(list((Path(self.papers[0]['repo'])/'.paper-pal/translations').glob('*.json')),[])

    async def test_unresolved_table_identifier_is_preserved_without_model(self):
        with patch('translation.asyncio.create_subprocess_exec',side_effect=AssertionError('No translation needed')):
            job=await(await self.client.post('/papers/alpha/hub/translate',json={'engine':'ai','texts':['table_01_wells']})).json()
            for _ in range(100):
                current=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if current['status'] in ('done','error'):break
                await asyncio.sleep(.01)
        self.assertEqual(current['status'],'done')
        self.assertEqual(current['translations'],['table_01_wells'])

    async def test_refresh_bypasses_both_caches_and_replaces_saved_paragraph(self):
        self.jobs.python=Path(sys.executable)
        (self.jobs.root/'translate-worker.py').write_text("import json,sys\nfrom pathlib import Path\np=json.load(sys.stdin)\nc=Path(__file__).with_name('called')\nvalue='新译文' if c.exists() else '旧译文'\nc.write_text(value)\nprint(json.dumps({'index':0,'text':value}),flush=True)\n")
        async def translate(**extra):
            response=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original'],**extra})
            self.assertEqual(response.status,202)
            job=await response.json()
            for _ in range(100):
                job=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if job['status'] in ('done','error'):break
                await asyncio.sleep(.01)
            self.assertEqual(job['status'],'done')
            return job['translations']
        self.assertEqual(await translate(),['旧译文'])
        self.assertEqual(await translate(),['旧译文'])
        self.assertEqual(await translate(refresh=True),['新译文'])
        self.jobs.jobs.clear()
        self.assertEqual(await translate(),['新译文'])
        for body in ({'texts':['Original'],'refresh':'true'},{'texts':['One','Two'],'refresh':True}):
            self.assertEqual((await self.client.post('/papers/alpha/hub/translate',json=body)).status,400)

    async def test_ready_paragraph_does_not_wait_behind_active_translation_limit(self):
        from translation import cache_digest,save_cache
        repo=Path(self.papers[0]['repo']);directory=repo/'.paper-pal/translations'
        save_cache(directory/('p-'+cache_digest(ENGINE,{},'Original')+'.json'),{'engine':ENGINE,'text':'已有译文'})
        for index in range(4):self.jobs.jobs[('beta',str(index))]={'status':'running'}
        with patch('translation.asyncio.create_subprocess_exec',side_effect=AssertionError('Cached result needs no worker')):
            result=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original']})
            self.assertEqual(result.status,202)
            job=await result.json()
            self.assertEqual(job['status'],'done')
            self.assertEqual(job['translations'],['已有译文'])

    async def test_refresh_fences_an_older_inflight_batch(self):
        self.jobs.python=Path(sys.executable)
        root=self.jobs.root
        (root/'translate-worker.py').write_text("import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nroot=Path(__file__).parent\nif len(p['texts'])>1:\n (root/'bulk-started').touch()\n while not (root/'release-bulk').exists():time.sleep(.01)\nfor i,t in enumerate(p['texts']):print(json.dumps({'index':i,'text':('旧译文' if len(p['texts'])>1 else '新译文')+t}),flush=True)\n")
        async def start(texts,**extra):
            response=await self.client.post('/papers/alpha/hub/translate',json={'texts':texts,**extra})
            self.assertEqual(response.status,202)
            return await response.json()
        async def finished(job):
            for _ in range(300):
                current=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if current['status'] in ('done','error'):return current
                await asyncio.sleep(.01)
            self.fail('Translation race fixture timed out')
        bulk=await start(['Original','Other'])
        for _ in range(300):
            if (root/'bulk-started').exists():break
            await asyncio.sleep(.01)
        self.assertTrue((root/'bulk-started').exists())
        fresh=await finished(await start(['Original'],refresh=True))
        self.assertEqual(fresh['translations'],['新译文Original'])
        (root/'release-bulk').touch()
        self.assertEqual((await finished(bulk))['status'],'error')
        self.jobs.jobs.clear()
        self.assertEqual((await finished(await start(['Original','Other'])))['translations'][0],'新译文Original')
        self.jobs.jobs.clear()
        self.assertEqual((await finished(await start(['Original','Changed'])))['translations'][0],'新译文Original')
        self.assertEqual(self.jobs.segment_epochs,{})

    async def test_cache_only_reads_bound_history_and_keep_active_jobs(self):
        from translation import cache_digest,save_cache
        directory=Path(self.papers[0]['repo'])/'.paper-pal/translations'
        active=('beta','active');self.jobs.jobs[active]={'status':'running'}
        with patch('translation.asyncio.create_subprocess_exec',side_effect=AssertionError('Cache-only read')):
            for index in range(125):
                text=f'Paragraph {index}'
                save_cache(directory/('p-'+cache_digest(ENGINE,{},text)+'.json'),{'engine':ENGINE,'text':f'段落 {index}'})
                result=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':[text]})).json()
                self.assertEqual(result['status'],'done')
        self.assertLessEqual(len(self.jobs.jobs),100)
        self.assertLessEqual(len(self.jobs.job_segments),100)
        self.assertIn(active,self.jobs.jobs)

    async def test_new_batch_cannot_read_old_cache_during_refresh(self):
        from translation import cache_digest,save_cache
        self.jobs.python=Path(sys.executable)
        root=self.jobs.root;directory=Path(self.papers[0]['repo'])/'.paper-pal/translations'
        paragraph=directory/('p-'+cache_digest(ENGINE,{},'Original')+'.json')
        save_cache(paragraph,{'engine':ENGINE,'text':'旧译文Original'})
        (root/'translate-worker.py').write_text("import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nroot=Path(__file__).parent\nwhile not (root/'release-refresh').exists():time.sleep(.01)\nfor i,t in enumerate(p['texts']):print(json.dumps({'index':i,'text':'新译文'+t}),flush=True)\n")
        fresh=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original'],'refresh':True})).json()
        self.assertFalse(paragraph.exists())
        response=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original','Other']})
        self.assertEqual(response.status,429)
        failed_key=('alpha',cache_digest(ENGINE,{},['Original','Other']))
        self.jobs.jobs[failed_key]={'status':'error'}
        response=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original','Other']})
        self.assertEqual(response.status,429,'a previous error must not bypass a pending refresh')
        same=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original']})).json()
        self.assertEqual(same['id'],fresh['id'])
        (root/'release-refresh').touch()
        for _ in range(300):
            current=await(await self.client.get('/papers/alpha/hub/translate/'+fresh['id'])).json()
            if current['status']=='done':break
            await asyncio.sleep(.01)
        self.assertEqual(current['status'],'done');self.assertEqual(self.jobs.refreshing,{})
        result=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original','Other']})).json()
        self.assertEqual(result['translations'][0],'新译文Original')

    async def test_refresh_of_nonlinguistic_identifier_leaves_no_pending_marker(self):
        result=await(await self.client.post('/papers/alpha/hub/translate',json={'engine':'ai','texts':['table_01_data'],'refresh':True})).json()
        self.assertEqual(result['status'],'done')
        self.assertEqual(self.jobs.refreshing,{})
        self.assertEqual(self.jobs.segment_epochs,{})

    async def test_refresh_preserves_unrelated_completed_polling_states(self):
        from translation import cache_digest,save_cache
        directory=Path(self.papers[0]['repo'])/'.paper-pal/translations'
        save_cache(directory/('p-'+cache_digest(ENGINE,{},'Unrelated')+'.json'),{'engine':ENGINE,'text':'其他段落'})
        unrelated=await(await self.client.post('/papers/alpha/hub/translate',json={'texts':['Unrelated']})).json()
        async def fake_run(key,*args):self.jobs.jobs[key].update(status='done',translations=['新译文'],completed=1)
        with patch.object(self.jobs,'run',side_effect=fake_run):
            await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original'],'refresh':True})
            await asyncio.sleep(.01)
        response=await self.client.get('/papers/alpha/hub/translate/'+unrelated['id'])
        self.assertEqual(response.status,200)
        self.assertEqual((await response.json())['translations'],['其他段落'])

    async def test_typesetter_assignments_cannot_reuse_legacy_cache_but_math_is_allowed(self):
        from translation import cache_digest,save_cache
        raw=r'\cs_gset:Nn __short_title: BondFusion-TCN'
        directory=Path(self.papers[0]['repo'])/'.paper-pal/translations'
        save_cache(directory/(cache_digest(ENGINE,{},[raw])+'.json'),{'engine':ENGINE,'translations':[raw+' 中文']})
        async def fake_run(key,*args):self.jobs.jobs[key].update(status='done',translations=['数学表达式'],completed=1)
        with patch.object(self.jobs,'run',side_effect=fake_run) as run:
            for text in [raw,r'\newcommand{\name}{Not prose}',r'\let\name\other']:
                response=await self.client.post('/papers/alpha/hub/translate',json={'texts':[text]})
                self.assertEqual(response.status,400)
            self.assertEqual(run.call_count,0)
            response=await self.client.post('/papers/alpha/hub/translate',json={'texts':[r'\operatorname{slog}(x) and \frac{a}{b} describe the formula.']})
            self.assertEqual(response.status,202)
            await asyncio.sleep(.01)
            self.assertEqual(run.call_count,1)

    async def test_stuck_worker_cleanup_is_bounded(self):
        class StuckProcess:
            pid = 12345
            async def wait(self):
                await asyncio.Event().wait()
        with patch('translation.os.killpg') as kill, self.assertLogs('translation', level='WARNING'):
            # The two 10ms grace periods remain; allow shared-host scheduling
            # jitter while still detecting an unbounded process wait.
            await asyncio.wait_for(stop_process_group(StuckProcess(), grace=.01), 1)
        self.assertEqual(kill.call_count, 2)

    async def test_browser_runtime_environment_is_only_passed_to_browser_workers(self):
        source={'HOME':'/same-user','XDG_RUNTIME_DIR':'/run/user/42','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/42/bus',
                'CHATGPT_WEB_WRITE_LOCK':'/shared/consult/lock','CHATGPT_WEB_CDP':'http://127.0.0.1:19223','ANTHROPIC_API_KEY':'unused'}
        plain=worker_environment(source,self.jobs.root)
        browser=worker_environment(source,self.jobs.root,browser=True)
        for key in ('XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'):
            self.assertEqual(plain[key],source[key])
        for key in ('CHATGPT_WEB_WRITE_LOCK','CHATGPT_WEB_CDP'):
            self.assertNotIn(key,plain)
            self.assertEqual(browser[key],source[key])
        self.assertNotIn('ANTHROPIC_API_KEY',browser)

    async def test_ai_model_reaches_worker_and_separates_cached_translations(self):
        repo=Path(self.papers[0]['repo'])
        config=repo/'.paper-pal.json'
        worker=self.jobs.root/'translation-ai.mjs'
        worker.write_text("let s='';for await(const c of process.stdin)s+=c;const p=JSON.parse(s);for(let i=0;i<p.texts.length;i++)console.log(JSON.stringify({index:i,text:p.aiModel+': '+p.texts[i]}));")
        async def translated():
            response=await self.client.post('/papers/alpha/hub/translate',json={'engine':'ai','texts':['Original 96.1%']})
            self.assertEqual(response.status,202)
            job=await response.json()
            for _ in range(100):
                current=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if current['status']=='done':return current
                if current['status']=='error':self.fail(current['error'])
                await asyncio.sleep(.01)
            self.fail('AI fixture worker did not complete')
        config.write_text(json.dumps({'translation':{'aiModel':'model-a'}}))
        first=await translated()
        config.write_text(json.dumps({'translation':{'aiModel':'model-b'}}))
        second=await translated()
        self.assertNotEqual(first['id'],second['id'])
        self.assertEqual(first['translations'],['model-a: Original 96.1%'])
        self.assertEqual(second['translations'],['model-b: Original 96.1%'])
        self.jobs.jobs.clear()
        config.write_text(json.dumps({'translation':{'aiModel':'model-a'}}))
        with patch.object(self.jobs,'run',side_effect=AssertionError('Model A should come from disk cache')):
            again=await translated()
        self.assertEqual(again['id'],first['id'])
        with patch.dict('os.environ',{'PAPER_HUB_TRANSLATION_MODEL':'environment-model'}):
            self.assertEqual(project_ai_model(self.papers[0]),'model-a')
            config.write_text('{}')
            self.assertEqual(project_ai_model(self.papers[0]),'environment-model')

    async def test_failed_worker_terminates_its_remaining_descendants(self):
        self.jobs.python=Path(sys.executable)
        child=self.jobs.root/'child.py'
        child.write_text("import os,signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath(__file__+'.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n")
        worker=self.jobs.root/'translate-worker.py'
        worker.write_text("import subprocess,sys,time,json\nfrom pathlib import Path\njson.load(sys.stdin)\nchild=Path(__file__).with_name('child.py')\nsubprocess.Popen([sys.executable,str(child)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile not Path(str(child)+'.pid').exists():time.sleep(.01)\nsys.exit(2)\n")
        pid=None
        try:
            response=await self.client.post('/papers/alpha/hub/translate',json={'texts':['Original']})
            job=await response.json()
            for _ in range(100):
                current=await(await self.client.get('/papers/alpha/hub/translate/'+job['id'])).json()
                if current['status']=='error':break
                await asyncio.sleep(.01)
            self.assertEqual(current['status'],'error')
            pid=int(Path(str(child)+'.pid').read_text())
            for _ in range(50):
                status=Path('/proc')/str(pid)/'stat'
                if not status.exists() or status.read_text().split()[2]=='Z':break
                await asyncio.sleep(.01)
            else:self.fail('Failed translation left a CLI descendant running')
        finally:
            if pid:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass

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
                                      'https_proxy':'http://fixture-proxy','LC_CTYPE':'C.UTF-8',
                                      'CODEX_BIN':'/fixture/bin/codex','PAPER_HUB_TRANSLATION_MODEL':'fixture-model'}):
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
            self.assertEqual(env['CODEX_BIN'],'/fixture/bin/codex')
            self.assertEqual(env['PAPER_HUB_TRANSLATION_MODEL'],'fixture-model')
        second=await (await self.client.post('/papers/alpha/hub/translate',json={'texts':['First','Changed']})).json()
        self.assertEqual(second['translations'][0],'中文 First')
        result=await wait(second)
        self.assertEqual(result['translations'],['中文 First','中文 Changed'])
        self.assertEqual(json.loads(Path(str(worker)+'.input').read_text()),['Changed'])
        for cache in (Path(self.papers[0]['repo'])/'.paper-pal/translations').glob('*.json'):
            self.assertEqual(cache.stat().st_mode & 0o777,0o600)


class TranslationQualityTests(unittest.TestCase):
    def test_inline_math_is_preserved_by_validation_and_machine_worker(self):
        import io,runpy,types
        formula=r'\(\operatorname{F1}=\frac{2PR}{P+R}\)'
        source='The metric '+formula+' is reported.'
        validate_translation(source,'指标'+formula+'已报告。',{})
        for result in ['指标已报告。',r'指标\(\frac{3PR}{P+R}\)已报告。']:
            with self.assertRaises(ValueError):validate_translation(source,result,{})
        calls=[]
        class Translator:
            def translate(self,text):
                self_test.assertNotIn('\\',text)
                calls.append(text)
                return '译文'
        self_test=self
        argos=types.ModuleType('argostranslate');module=types.ModuleType('argostranslate.translate')
        module.get_translation_from_codes=lambda *args:Translator();argos.translate=module
        output=io.StringIO()
        with patch.dict(sys.modules,{'argostranslate':argos,'argostranslate.translate':module}),patch('sys.stdin',io.StringIO(json.dumps({'texts':[source],'glossary':{}}))),patch('sys.stdout',output),patch.dict(os.environ):
            runpy.run_path(str(Path(__file__).resolve().parents[1]/'translate-worker.py'))
        self.assertEqual(json.loads(output.getvalue())['text'],'译文'+formula+'译文')
        self.assertEqual(calls,['The metric ',' is reported.'])

    def test_numeric_percentage_and_protected_class_integrity(self):
        glossary={'Good':{'target':'Good','variants':[]}}
        validate_translation('Recall for Good is 0.65, not 0.91.','Good的召回率为0.65，而不是0.91。',glossary,strict=True)
        for result in ['Good的召回率为0.91。','Good的召回率为65%，而不是91%。','良好的召回率为0.65，而不是0.91。']:
            with self.subTest(result=result),self.assertRaises(ValueError):validate_translation('Recall for Good is 0.65, not 0.91.',result,glossary,strict=True)
        validate_translation('Four models (1, 2, 3, 4) have weights whose mean is one.','4个模型（1、2、3、4）的权重均值为1。',{},strict=True)
        validate_translation('Samples 1, 2 have a total of 1,900.','样本1、2合计1900。',{})
        with self.assertRaises(ValueError):validate_translation('Two percentage points.','2%。',{})
        validate_translation('Good is compared with Good in this check.','本检查将Good类与该类比较。',glossary,strict=True)
        validate_translation('The rare good-bond class.','罕见的Good胶结类别。',glossary,strict=True)
        self.assertNotEqual(translation_revision('ai',{},'a'),translation_revision('ai',{},'b'))


if __name__=='__main__':
    unittest.main()
