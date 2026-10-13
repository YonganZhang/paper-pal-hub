import asyncio
import json
import os
import sys
import tempfile
import time
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from figures import FigureStudio, figure_records, validate_asset, digest

ROOT = Path(__file__).resolve().parents[1]


class FigureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        (ROOT/'_tmp').mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT/'_tmp')
        self.root = Path(self.tmp.name)
        self.repo = self.root/'alpha'
        self.repo.mkdir()
        self.other = self.root/'beta'
        self.other.mkdir()
        self.cli = self.root/'fake-cli'
        self.cli.write_text('''#!/usr/bin/env python3
import json,sys,os,time
from pathlib import Path
if sys.argv[1:3]==['login','status']:
 print('Logged in using ChatGPT');sys.exit(0)
if sys.argv[1:3]==['auth','status']:
 print(json.dumps({'loggedIn':True,'authMethod':'claude.ai','apiProvider':'firstParty'}));sys.exit(0)
if sys.argv[1:3]==['features','list']:
 print('image_generation stable '+('true' if Path(__file__+'.image-enabled').exists() else 'false'));sys.exit(0)
prompt=sys.stdin.read()
Path('argv.json').write_text(json.dumps(sys.argv[1:]))
Path('env.json').write_text(json.dumps({k:os.environ.get(k) for k in ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CUDA_VISIBLE_DEVICES']}))
Path('received-prompt.txt').write_text(prompt)
if 'SLOW_TASK' in prompt:
 Path('worker-pid.txt').write_text(str(os.getpid()))
 time.sleep(60)
if 'MAKE_NO_OUTPUT' not in prompt:
 from PIL import Image
 Image.new('RGB',(8,8),'blue').save('candidate.png')
 Path('scripts/draw.py').write_text('# updated staged drawing script\\n')
if 'REPORT_FAILURE' in prompt:
 Path('failure-receipt.json').write_text(json.dumps({'reason':'fixture browser needs_login'}))
if '--json' in sys.argv:
 print(json.dumps({'type':'item.completed','item':{'type':'image_generation_call','status':'completed','model':'fixture-image-model','result':{'b64_json':'fixture-secret-image-data'}}}))
else:
 print('已生成暂存候选')
''')
        self.cli.chmod(0o700)
        self.config = {'codex':{'command':str(self.cli),'model':'configured-model','models':['configured-model','other-model']},
            'claude':{'command':str(self.cli),'model':'configured-claude','models':['configured-claude']}}
        for repo in (self.repo,self.other):
            (repo/'.paper-pal.json').write_text(json.dumps(self.config))
            (repo/'figures').mkdir()
            Image.new('RGB',(8,8),'red').save(repo/'figures/main.png')
            (repo/'scripts').mkdir()
            (repo/'scripts/draw.py').write_text('# frozen original script\n')
            (repo/'data.csv').write_text('x,y\n1,2\n')
            (repo/'AGENTS.md').write_text('Preserve all original scientific inputs.')
            (repo/'.paper-figures.json').write_text(json.dumps({'schema_version':1,'figures':[{
                'id':'fig1','title':'First scientific figure','kind':'plot','path':'figures/main.png',
                'source_paths':['scripts/draw.py'],'data_paths':['data.csv'],
                'command':['python3','scripts/draw.py']}]}))
        self.papers = [{'id':'alpha','repo':str(self.repo)},{'id':'beta','repo':str(self.other)}]
        self.studio = FigureStudio(lambda:self.papers,ROOT)
        app = web.Application()
        self.studio.install(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.original = (self.repo/'figures/main.png').read_bytes()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def start(self,instruction='Change line color to blue',provider='codex',request_id='request-1'):
        response = await self.client.post('/papers/alpha/hub/figures/jobs',json={
            'figure_id':'fig1','instruction':instruction,'provider':provider,
            'model':self.config[provider]['model'],'request_id':request_id})
        self.assertEqual(response.status,202,await response.text())
        return await response.json()

    async def wait(self,job):
        for _ in range(200):
            response = await self.client.get('/papers/alpha/hub/figures/jobs/'+job['id'])
            value = await response.json()
            if value['status'] not in ('running','queued'):
                return value
            await asyncio.sleep(.02)
        self.fail('Timed out waiting for isolated figure worker')

    async def test_real_fake_cli_pipeline_accept_archives_both_code_versions(self):
        job = await self.wait(await self.start())
        self.assertEqual(job['status'],'proposed',job)
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)
        self.assertEqual((self.repo/'scripts/draw.py').read_text(),'# frozen original script\n')
        workspace = Path(job['workspace_path'])
        runtime = json.loads((workspace/'browser-runtime.json').read_text())
        self.assertFalse(Path(runtime['TMPDIR']).exists(), 'completed worker leaked its tool runtime')
        args = json.loads((workspace/'argv.json').read_text())
        self.assertEqual(args[args.index('--sandbox')+1],'workspace-write')
        self.assertEqual(args[args.index('--model')+1],'configured-model')
        self.assertEqual(json.loads((workspace/'env.json').read_text())['CUDA_VISIBLE_DEVICES'],'')
        prompt=(workspace/'received-prompt.txt').read_text()
        self.assertIn(str(Path.home()/'.ai-shared/rules'),prompt)
        self.assertIn(str(Path.home()/'.agents/skills'),prompt)
        self.assertIn('share-web-consultation',prompt)
        self.assertIn('failure-receipt.json',prompt)
        self.assertEqual((await self.client.get('/papers/beta/hub/figures/jobs/'+job['id'])).status,404)
        candidate = await self.client.get(job['candidate_url'])
        self.assertEqual(candidate.status,200)
        self.assertNotEqual(await candidate.read(),self.original)
        response = await self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',json={'expected_sha256':job['original_sha256']})
        self.assertEqual(response.status,200,await response.text())
        accepted = await response.json()
        self.assertEqual(accepted['status'],'accepted')
        archive = Path(accepted['archive_path'])
        self.assertEqual((archive/'original.png').read_bytes(),self.original)
        self.assertEqual((archive/'inputs/scripts/draw.py').read_text(),'# frozen original script\n')
        self.assertEqual((archive/'workspace/scripts/draw.py').read_text(),'# updated staged drawing script\n')
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),(archive/'candidate.png').read_bytes())
        lineage = figure_records(self.repo,self.config)[0]
        self.assertIn(str((archive/'workspace/scripts/draw.py').relative_to(self.repo)),lineage['revision_paths'])
        self.assertEqual(lineage['reproduction_workspace'],str((archive/'workspace').relative_to(self.repo)))
        again = await self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',json={})
        self.assertEqual(again.status,200)
        self.assertEqual((await again.json())['accepted_at'],accepted['accepted_at'])
        # Accepted candidate serves immutable archived image, not mutable staging output.
        (workspace/'candidate.png').write_text('modified after approval')
        self.assertEqual(await (await self.client.get(job['candidate_url'])).read(),(archive/'candidate.png').read_bytes())

    async def test_stale_accept_rejects_other_window_changes(self):
        job = await self.wait(await self.start())
        Image.new('RGB',(8,8),'green').save(self.repo/'figures/main.png')
        new = (self.repo/'figures/main.png').read_bytes()
        result = await self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',json={'expected_sha256':job['original_sha256']})
        self.assertEqual(result.status,409)
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),new)
        self.assertFalse((Path(job['manifest_path']).parent/'accepted-archive').exists())

    async def test_manifest_missing_lineage_and_symlink_escape(self):
        records = figure_records(self.repo,self.config)
        self.assertTrue(records[0]['reproducible'])
        (self.repo/'data.csv').unlink()
        incomplete = figure_records(self.repo,self.config)[0]
        self.assertFalse(incomplete['reproducible'])
        self.assertEqual(incomplete['missing_paths'],['data.csv'])
        (self.repo/'data.csv').symlink_to(self.other/'data.csv')
        with self.assertRaises(ValueError):
            figure_records(self.repo,self.config)
        (self.repo/'data.csv').unlink()
        manifest = json.loads((self.repo/'.paper-figures.json').read_text())
        manifest['figures'][0]['path'] = '../outside.png'
        (self.repo/'.paper-figures.json').write_text(json.dumps(manifest))
        result = await self.client.get('/papers/alpha/hub/figures')
        self.assertEqual(result.status,400)

    async def test_no_output_is_error_not_proposed_and_model_is_whitelisted(self):
        missing = await self.wait(await self.start(instruction='MAKE_NO_OUTPUT'))
        self.assertEqual(missing['status'],'error')
        self.assertNotIn('candidate_url',missing)
        result = await self.client.post('/papers/alpha/hub/figures/jobs',json={
            'figure_id':'fig1','instruction':'edit','provider':'codex','model':'unregistered', 'request_id':'req-2'})
        self.assertEqual(result.status,400)
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)

    async def test_actual_tool_failure_is_reported_instead_of_missing_image_only(self):
        job=await self.wait(await self.start(instruction='MAKE_NO_OUTPUT REPORT_FAILURE'))
        self.assertEqual(job['status'],'error')
        self.assertIn('fixture browser needs_login',job['error'])
        self.assertNotIn('candidate_url',job)
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)

    async def test_claude_tool_policy_and_request_idempotence(self):
        job = await self.wait(await self.start(provider='claude'))
        self.assertEqual(job['status'],'proposed',job)
        args = json.loads((Path(job['workspace_path'])/'argv.json').read_text())
        self.assertNotIn('--disallowedTools',args)
        self.assertEqual(args[args.index('--tools')+1],'Read,Glob,Grep,Write,Edit,Bash')
        self.assertIn('--strict-mcp-config',args)
        self.assertNotIn('--dangerously-skip-permissions',args)
        duplicate = await self.start(provider='claude')
        self.assertEqual(duplicate['id'],job['id'])
        self.assertEqual(duplicate['status'],'proposed')

    async def test_local_import_and_actual_byte_validation(self):
        invalid = self.root/'invalid.png'
        invalid.write_text('This is not an actual PNG')
        with self.assertRaises((ValueError,OSError)):
            self.studio.import_candidate('alpha','fig1',invalid)
        imported = self.root/'local.png'
        Image.new('RGB',(5,5),'black').save(imported)
        job = self.studio.import_candidate('alpha','fig1',imported,model='external-image-tool')
        self.assertEqual(job['provider'],'local-import')
        self.assertEqual(job['status'],'proposed')
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)
        self.assertEqual((await self.client.get('/papers/alpha/hub/figures/jobs/'+job['id'])).status,200)
        self.assertEqual((await self.client.post('/papers/alpha/hub/figures/import',json={'path':str(imported)})).status,404)

    async def test_pdf_preview_and_active_svg_rejection(self):
        import fitz as pymupdf
        pdf = self.root/'valid.pdf'
        with pymupdf.open() as document:
            document.new_page()
            document.save(pdf)
        self.assertTrue(validate_asset(pdf))
        for contents in ('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                         '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>'):
            svg = self.root/'bad.svg'
            svg.write_text(contents)
            with self.assertRaises(ValueError):
                validate_asset(svg)

    async def test_timeout_stops_process_group_and_retains_original(self):
        self.studio.timeout = 3
        job = await self.wait(await self.start(instruction='SLOW_TASK'))
        self.assertEqual(job['status'],'error',job)
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)
        log = Path(job['manifest_path']).parent/'worker.log'
        runtime=json.loads((Path(job['workspace_path'])/'browser-runtime.json').read_text())
        self.assertFalse(Path(runtime['TMPDIR']).exists(), 'forced stop leaked its tool runtime')
        self.assertIn('timed out after 3 seconds', log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        pid_path = Path(job['workspace_path'])/'worker-pid.txt'
        self.assertTrue(pid_path.is_file(), 'fake CLI was not launched before timeout')
        pid = int(pid_path.read_text())
        # Linux may briefly retain an orphan as zombie; it must no longer execute.
        for _ in range(40):
            status = Path('/proc')/str(pid)/'stat'
            if not status.exists() or status.read_text().split()[2] == 'Z':
                break
            await asyncio.sleep(.025)
        else:
            self.fail('Timed-out figure subprocess is still running')

    async def test_shutdown_during_worker_cleanup_waits_for_process_exit(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original_stop = self.studio.stop_worker
        async def delayed_stop(process):
            entered.set()
            await release.wait()
            await original_stop(process)
        with patch.object(self.studio,'stop_worker',side_effect=delayed_stop):
            job = await self.start(instruction='SLOW_TASK',request_id='shutdown-during-cleanup')
            pid_path=Path(job['workspace_path'])/'worker-pid.txt'
            for _ in range(250):
                if pid_path.is_file():
                    break
                await asyncio.sleep(.02)
            self.assertTrue(pid_path.is_file(),'fake CLI never started')
            pid=int(pid_path.read_text())
            task=next(iter(self.studio.tasks))
            task.cancel()
            await asyncio.wait_for(entered.wait(),2)
            # Shutdown cancels the same task again while stop_worker is suspended.
            closing=asyncio.create_task(self.client.close())
            await asyncio.sleep(.05)
            self.assertFalse(closing.done(),'service closed before worker cleanup completed')
            self.assertEqual(self.studio.jobs[('alpha',job['id'])]['status'],'running')
            release.set()
            await asyncio.wait_for(closing,5)
        durable=json.loads(Path(job['manifest_path']).read_text())
        self.assertEqual(durable['status'],'error')
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)
        stat=Path('/proc')/str(pid)/'stat'
        self.assertTrue(not stat.exists() or stat.read_text().split()[2]=='Z')
        self.assertFalse(self.studio.tasks)
        runtime=json.loads((Path(job['workspace_path'])/'browser-runtime.json').read_text())
        self.assertFalse(Path(runtime['TMPDIR']).exists(), 'cancelled worker leaked its tool runtime')

    async def test_interrupted_accept_recovers_and_next_edit_uses_latest_recipe(self):
        job = await self.wait(await self.start())
        route = '/papers/alpha/hub/figures/jobs/'+job['id']+'/accept'
        with patch.object(self.studio,'persist',side_effect=OSError('fixture interrupted commit')):
            failed = await self.client.post(route,json={'expected_sha256':job['original_sha256']})
            self.assertEqual(failed.status,400)
        self.studio.jobs.clear()  # Recover from durable job.json, as after a gateway restart.
        recovered = await self.client.post(route,json={'expected_sha256':job['original_sha256']})
        self.assertEqual(recovered.status,200,await recovered.text())
        accepted = await recovered.json()
        self.assertEqual(accepted['status'],'accepted')
        second = await self.wait(await self.start(request_id='request-second'))
        self.assertEqual(second['status'],'proposed',second)
        baseline = Path(second['manifest_path']).parent/'inputs/scripts/draw.py'
        self.assertEqual(baseline.read_text(),'# updated staged drawing script\n')
        self.assertIn('accepted-archive/workspace/scripts/draw.py',second['input_sources']['scripts/draw.py'])

    async def test_accepted_new_dependencies_survive_two_followup_jobs(self):
        job, _ = self.studio.create('alpha','fig1','new helper','local-import',None,'closure-first')
        for index in range(2):
            workspace = Path(job['workspace_path'])
            (workspace/'scripts/helper.py').write_text('from pathlib import Path\nVALUE = Path("processed.csv").read_text().strip()\n')
            (workspace/'scripts/draw.py').write_text('from helper import VALUE\nprint(VALUE)\n')
            (workspace/'processed.csv').write_text('processed-round-'+str(index))
            (workspace/'.mpl-cache').mkdir(exist_ok=True)
            (workspace/'.mpl-cache/fontlist.json').write_text('cache')
            (workspace/'assistant-summary.txt').write_text('transient assistant output')
            (workspace/'browser-runtime.json').write_text('{"TMPDIR":"/tmp/old-job"}')
            Image.new('RGB',(8,8),'blue' if index == 0 else 'green').save(workspace/'candidate.png')
            job.update(status='proposed',candidate_sha256=validate_asset(workspace/'candidate.png'))
            self.studio.persist(job)
            response = await self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',
                json={'expected_sha256':job['original_sha256']})
            self.assertEqual(response.status,200,await response.text())
            accepted = await response.json()
            job, _ = self.studio.create('alpha','fig1','followup '+str(index),'local-import',None,'closure-next-'+str(index))
            next_workspace = Path(job['workspace_path'])
            result = subprocess.run([sys.executable,'scripts/draw.py'],cwd=next_workspace,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'processed-round-'+str(index))
            self.assertEqual(job['input_hashes']['processed.csv'],digest(next_workspace/'processed.csv'))
            self.assertIn('accepted-archive/workspace/processed.csv',job['input_sources']['processed.csv'])
            self.assertFalse((next_workspace/'assistant-summary.txt').exists())
            self.assertFalse((next_workspace/'browser-runtime.json').exists())
            self.assertFalse((next_workspace/'.mpl-cache').exists())
            self.assertFalse((next_workspace/'candidate.png').exists())
            self.assertEqual(job['original_sha256'],accepted['accepted_sha256'])
        self.assertEqual((self.repo/'scripts/draw.py').read_text(),'# frozen original script\n')

    async def test_context_uses_current_guidance_and_all_project_skills(self):
        (self.repo/'paper').mkdir();(self.repo/'paper/main.tex').write_text('Current paper text')
        (self.repo/'guide.md').write_text('current guidance v1')
        (self.repo/'entry.md').write_text('entry point')
        skill=self.repo/'.agents/skills/other-skill';skill.mkdir(parents=True)
        (skill/'SKILL.md').write_text('other project skill v1')
        (skill/'resource.txt').write_text('skill supporting material')
        self.config.update(sourceRoot='paper',defaultDocument='paper/main.tex',
            agent={'guidanceFiles':['guide.md'],'entryPoints':['entry.md']})
        (self.repo/'.paper-pal.json').write_text(json.dumps(self.config))
        first=self.studio.import_candidate('alpha','fig1',self.repo/'figures/main.png',request_id='context-first')
        response=await self.client.post('/papers/alpha/hub/figures/jobs/'+first['id']+'/accept',
            json={'expected_sha256':first['original_sha256']})
        self.assertEqual(response.status,200,await response.text())
        (self.repo/'guide.md').write_text('current guidance v2')
        (skill/'SKILL.md').write_text('other project skill v2')
        second,_=self.studio.create('alpha','fig1','read updated guidance','local-import',None,'context-second')
        workspace=Path(second['workspace_path'])
        self.assertEqual((workspace/'guide.md').read_text(),'current guidance v2')
        self.assertEqual((workspace/'.agents/skills/other-skill/SKILL.md').read_text(),'other project skill v2')
        self.assertEqual((workspace/'.agents/skills/other-skill/resource.txt').read_text(),'skill supporting material')
        self.assertIn('entry.md',second['context_paths'])
        self.assertIn('paper/main.tex',second['context_paths'])
        self.assertEqual(second['original_project_root'],str(self.repo))
        self.assertFalse((workspace/'.paper-pal.json').exists())
        self.assertEqual(second['input_sources']['guide.md'],'guide.md')

    async def test_context_rejects_escape_private_config_and_excess_budget(self):
        outside=self.root/'outside.md';outside.write_text('must not copy')
        (self.repo/'escape.md').symlink_to(outside)
        for name in ('../outside.md','escape.md','.paper-pal.json'):
            self.config['agent']={'guidanceFiles':[name]}
            (self.repo/'.paper-pal.json').write_text(json.dumps(self.config))
            with self.assertRaises(ValueError):
                self.studio.create('alpha','fig1','unsafe context','local-import',None,'unsafe-'+name)
        (self.repo/'escape.md').unlink()
        self.config['agent']={'guidanceFiles':['AGENTS.md']}
        (self.repo/'.paper-pal.json').write_text(json.dumps(self.config))
        with patch('figures.MAX_INPUT',1),self.assertRaises(ValueError):
            self.studio.create('alpha','fig1','budget','local-import',None,'budget-input')
        self.assertFalse(list(self.studio.storage(self.repo).glob('fig_*')))

    async def test_input_change_during_copy_rejects_mixed_job(self):
        copyfile=__import__('shutil').copyfile
        changed=False
        def changing_copy(source,target,*args,**kwargs):
            nonlocal changed
            result=copyfile(source,target,*args,**kwargs)
            if not changed and Path(source)==self.repo/'data.csv':
                changed=True
                (self.repo/'data.csv').write_text('x,y\n1,999\n')
            return result
        with patch('figures.shutil.copyfile',side_effect=changing_copy),self.assertRaisesRegex(ValueError,'复制期间发生更新'):
            self.studio.create('alpha','fig1','concurrent edit','local-import',None,'mixed-input-copy')
        self.assertTrue(changed)
        self.assertFalse(list(self.studio.storage(self.repo).glob('fig_*')))

    async def test_root_context_discovery_skips_history_but_honors_explicit_entry(self):
        for directory in ('_legacy','_tmp','_archive','_drafts','_snapshots'):
            folder=self.repo/directory;folder.mkdir()
            (folder/'old.tex').write_text('unrelated old draft')
        (self.repo/'current.tex').write_text('current manuscript')
        (self.repo/'_archive/reference.md').write_text('explicitly requested reference')
        self.config['agent']={'entryPoints':['_archive/reference.md']}
        (self.repo/'.paper-pal.json').write_text(json.dumps(self.config))
        job,_=self.studio.create('alpha','fig1','context','local-import',None,'skip-history')
        workspace=Path(job['workspace_path'])
        self.assertTrue((workspace/'current.tex').is_file())
        self.assertTrue((workspace/'_archive/reference.md').is_file())
        for directory in ('_legacy','_tmp','_archive','_drafts','_snapshots'):
            self.assertFalse((workspace/directory/'old.tex').exists())

    async def test_terminal_persist_failure_releases_worker_slot(self):
        job,_=self.studio.create('alpha','fig1','no process','local-import',None,'persist-slot')
        # No CLI executes: injected durable-store failure occurs before spawning.
        with patch.object(self.studio,'persist',side_effect=OSError('fixture storage unavailable')):
            with self.assertRaises(OSError):
                await self.studio.run('alpha',job,self.config)
        await asyncio.wait_for(self.studio.semaphore.acquire(),1)
        self.studio.semaphore.release()

    async def test_svg_local_clip_and_plot_style_are_valid(self):
        svg = self.root/'plot.svg'
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"><style>*{stroke-linejoin:round}</style><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><path d="M0 0 L10 10" clip-path="url(#clip)"/></svg>')
        self.assertTrue(validate_asset(svg))

    async def test_listing_recovers_saved_jobs_filters_other_papers_and_bounds_history(self):
        local = self.root/'history-candidate.png'
        Image.new('RGB',(5,5),'blue').save(local)
        identifiers = []
        for index in range(53):
            job = self.studio.import_candidate('alpha','fig1',local,request_id='history-'+str(index))
            identifiers.append(job['id'])
        # This paper's interrupted durable job must normalize after a restart.
        path = Path(job['manifest_path'])
        durable = json.loads(path.read_text())
        durable['status'] = 'running'
        path.write_text(json.dumps(durable))
        self.studio.jobs.clear()
        # A malformed record and a valid other-paper record must not leak into this list.
        bad = self.repo/'.paper-pal/figure-studio/invalid/job.json'
        bad.parent.mkdir()
        bad.write_text('{"schema_version":1,"status":"running"}')
        other = self.studio.import_candidate('beta','fig1',local,request_id='other-project')
        listing = await (await self.client.get('/papers/alpha/hub/figures')).json()
        self.assertEqual(len(listing['jobs']),50)
        self.assertEqual(listing['jobs'][0]['id'],identifiers[-1])
        self.assertEqual(listing['jobs'][0]['status'],'error')
        self.assertNotIn(other['id'],[saved['id'] for saved in listing['jobs']])
        self.assertNotIn('invalid',[saved['id'] for saved in listing['jobs']])
        self.assertEqual(json.loads(path.read_text())['status'],'error')
        self.assertEqual((self.repo/'figures/main.png').read_bytes(),self.original)

    async def test_explicit_incomplete_provenance_stays_incomplete(self):
        path = self.repo/'.paper-figures.json'
        manifest = json.loads(path.read_text())
        manifest['figures'][0].update(reproducible=False,provenance_status='transitive-inputs-not-verified')
        path.write_text(json.dumps(manifest))
        record = figure_records(self.repo,self.config)[0]
        self.assertFalse(record['reproducible'])
        self.assertEqual(record['provenance_status'],'transitive-inputs-not-verified')
        self.assertEqual(record['missing_paths'],[])

    async def test_import_png_into_pdf_retains_original_raster_and_prompt(self):
        import fitz as pymupdf
        pdf = self.repo/'figures/main.pdf'
        with pymupdf.open() as document:
            document.new_page()
            document.save(pdf)
        manifest_path = self.repo/'.paper-figures.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['figures'][0]['path'] = 'figures/main.pdf'
        manifest_path.write_text(json.dumps(manifest))
        original = pdf.read_bytes()
        png = self.root/'external-image2.png'
        Image.new('RGBA',(20,10),(0,0,255,128)).save(png)
        job = self.studio.import_candidate('alpha','fig1',png,instruction='保留结构，调整蓝色',model='user-declared-image2')
        self.assertEqual(job['status'],'proposed')
        self.assertEqual(pdf.read_bytes(),original)
        self.assertEqual(Path(job['candidate_path']).suffix,'.pdf')
        self.assertTrue(validate_asset(Path(job['candidate_path'])))
        imported = Path(job['import_provenance']['retained_source'])
        self.assertEqual(imported.read_bytes(),png.read_bytes())
        self.assertEqual(job['import_provenance']['prompt'],'保留结构，调整蓝色')
        self.assertEqual(job['import_provenance']['model'],'user-declared-image2')
        self.assertIn('no image generation invoked',job['import_provenance']['invocation'])
        self.assertEqual((Path(job['manifest_path']).parent/'inputs'/imported.name).read_bytes(),png.read_bytes())
        self.assertEqual((Path(job['workspace_path'])/'copiedtaskmanifest.json').stat().st_mode&0o777,0o600)
        result = await self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',json={'expected_sha256':job['original_sha256']})
        self.assertEqual(result.status,200,await result.text())
        archive = Path((await result.json())['archive_path'])
        self.assertEqual((archive/'workspace'/imported.name).read_bytes(),png.read_bytes())

    async def test_async_create_is_nonblocking_and_duplicate_request_is_serialized(self):
        create = self.studio._create_unlocked
        def slow_create(*args):
            time.sleep(.2)
            return create(*args)
        with patch.object(self.studio,'_create_unlocked',side_effect=slow_create):
            first = asyncio.create_task(self.start(request_id='same-concurrent-request'))
            second = asyncio.create_task(self.start(request_id='same-concurrent-request'))
            await asyncio.sleep(.03)
            start = time.monotonic()
            listing = await self.client.get('/papers/alpha/hub/figures')
            self.assertEqual(listing.status,200)
            self.assertLess(time.monotonic()-start,.15,'large input copy blocked gateway event loop')
            a,b = await asyncio.gather(first,second)
        self.assertEqual(a['id'],b['id'])
        self.assertEqual(len(list((self.repo/'.paper-pal/figure-studio').glob('*/job.json'))),1)
        finished = await self.wait(a)
        self.assertEqual(finished['status'],'proposed',finished)

    async def test_accept_archive_copy_does_not_block_gateway(self):
        job = await self.wait(await self.start())
        original_copy = __import__('shutil').copytree
        def slow_copy(*args,**kwargs):
            time.sleep(.25)
            return original_copy(*args,**kwargs)
        with patch('figures.shutil.copytree',side_effect=slow_copy):
            pending = asyncio.create_task(self.client.post('/papers/alpha/hub/figures/jobs/'+job['id']+'/accept',json={'expected_sha256':job['original_sha256']}))
            await asyncio.sleep(.05)
            start = time.monotonic()
            status = await self.client.get('/papers/alpha/hub/figures/jobs/'+job['id'])
            self.assertEqual(status.status,200)
            self.assertLess(time.monotonic()-start,.15,'archive copy blocked gateway')
            accepted = await pending
        self.assertEqual(accepted.status,200,await accepted.text())

    async def test_native_image_feature_trace_and_png_to_pdf_packaging(self):
        import fitz as pymupdf
        pdf = self.repo/'figures/main.pdf'
        with pymupdf.open() as document:
            document.new_page()
            document.save(pdf)
        path = self.repo/'.paper-figures.json'
        manifest = json.loads(path.read_text())
        manifest['figures'][0]['path'] = 'figures/main.pdf'
        path.write_text(json.dumps(manifest))
        Path(str(self.cli)+'.image-enabled').touch()
        job = await self.wait(await self.start(instruction='Use applicable global imagegen skill to adjust colors'))
        self.assertEqual(job['status'],'proposed',job)
        workspace = Path(job['workspace_path'])
        args = json.loads((workspace/'argv.json').read_text())
        self.assertEqual(args[args.index('--enable')+1],'image_generation')
        self.assertIn('--json',args)
        self.assertIn('sandbox_workspace_write.network_access=true',args)
        self.assertTrue(job['execution']['native_image_feature'])
        self.assertTrue(job['execution']['image_generation_observed'])
        self.assertEqual(job['execution']['observed_tools'][0]['model'],'fixture-image-model')
        self.assertNotIn('fixture-secret-image-data',(workspace/'cli-output.txt').read_text())
        self.assertTrue((workspace/'candidate.png').is_file())
        self.assertTrue(validate_asset(workspace/'candidate.pdf'))
        self.assertIn('Pillow raster to PDF',job['raster_packaging']['conversion'])
        prompt = (workspace/'received-prompt.txt').read_text()
        self.assertIn('share-web-consultation',prompt)
        self.assertIn(str(Path.home()/'.agents/skills'),prompt)
