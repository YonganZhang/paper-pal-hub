import asyncio
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
from versions import VersionService, create_snapshot, compare, file_path, digest_file, inventory, ArchiveError

ROOT=Path(__file__).resolve().parents[1]


class VersionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        (ROOT/'_tmp').mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'_tmp')
        self.repo=Path(self.tmp.name)/'alpha';self.repo.mkdir()
        self.beta=Path(self.tmp.name)/'beta';self.beta.mkdir()
        for repo in (self.repo,self.beta):
            (repo/'paper').mkdir();(repo/'figs').mkdir()
            (repo/'paper/main.tex').write_text('First original paragraph.\n')
            (repo/'draw.py').write_text('# original drawing recipe\n')
            (repo/'data.csv').write_text('x,y\n1,2\n')
            Image.new('RGB',(12,12),'red').save(repo/'figs/one.png')
            (repo/'.paper-pal.json').write_text(json.dumps({'sourceRoot':'paper','defaultDocument':'paper/main.tex'}))
            (repo/'.paper-figures.json').write_text(json.dumps({'schema_version':1,'figures':[{'id':'fig1','title':'First figure','kind':'plot','path':'figs/one.png','source_paths':['draw.py'],'data_paths':['data.csv'],'command':['python3','draw.py']}]}))
        papers=[{'id':'alpha','repo':str(self.repo)},{'id':'beta','repo':str(self.beta)}]
        app=web.Application();VersionService(lambda:papers).install(app)
        self.client=TestClient(TestServer(app));await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close();self.tmp.cleanup()

    async def archive(self,parent=None,request_id='request-0000'):
        response=await self.client.post('/papers/alpha/hub/versions',json={'name':'中文存档','note':'验收说明','expected_parent':parent,'request_id':request_id})
        self.assertIn(response.status,(200,201),await response.text())
        return await response.json()

    async def test_numbering_metadata_files_download_and_arbitrary_diff(self):
        baseline=await self.archive()
        record=baseline['version'];self.assertEqual(record['version'],'0.0')
        self.assertTrue(Path(record['manifest_path']).is_file())
        self.assertTrue((Path(record['snapshot_path'])/'HANDOFF.md').is_file())
        self.assertEqual((Path(record['snapshot_path'])/'files/data.csv').read_text(),'x,y\n1,2\n')
        (self.repo/'paper/main.tex').write_text('Changed current paragraph.\n')
        Image.new('RGB',(12,12),'blue').save(self.repo/'figs/one.png')
        result=await(await self.client.get('/papers/alpha/hub/versions/compare?base=v0.0&target=working')).json()
        text=next(r for r in result['files'] if r['path']=='paper/main.tex')
        self.assertEqual(text['latest_text'],'Changed current paragraph.\n')
        self.assertEqual([r['type'] for r in text['diff']],['delete','insert'])
        self.assertEqual(result['figures'][0]['status'],'modified')
        self.assertNotEqual(result['figures'][0]['before']['sha256'],result['figures'][0]['after']['sha256'])
        first=await self.archive('v0.0','request-0001');self.assertEqual(first['version']['version'],'1.0')
        second=await self.archive('v1.0','request-0002');self.assertEqual(second['version']['version'],'2.0')
        historical=await(await self.client.get('/papers/alpha/hub/versions/compare?base=v0.0&target=v2.0')).json()
        self.assertEqual(historical['figures'][0]['status'],'modified')
        snapshot=await self.client.get('/papers/alpha/hub/versions/v0.0/file?path=paper/main.tex')
        self.assertEqual(await snapshot.text(),'First original paragraph.\n')
        zipped=await self.client.get('/papers/alpha/hub/versions/v2.0/download')
        self.assertIn('attachment',zipped.headers['Content-Disposition'])
        with zipfile.ZipFile(io.BytesIO(await zipped.read())) as archive:
            self.assertEqual(archive.read('files/paper/main.tex').decode(),'Changed current paragraph.\n')
            self.assertIn('manifest.json',archive.namelist())

    async def test_idempotence_and_concurrent_parent_compare_and_swap(self):
        await self.archive()
        again=await self.archive();self.assertFalse(again['created'])
        mismatch=await self.client.post('/papers/alpha/hub/versions',json={'name':'different payload','expected_parent':None,'request_id':'request-0000'})
        self.assertEqual(mismatch.status,409)
        outcomes=await asyncio.gather(*[self.client.post('/papers/alpha/hub/versions',json={'expected_parent':'v0.0','request_id':'concurrent-'+str(i)}) for i in range(2)])
        self.assertEqual(sorted(r.status for r in outcomes),[201,409])
        listing=await(await self.client.get('/papers/alpha/hub/versions')).json()
        self.assertEqual([v['id'] for v in listing['versions']],['v0.0','v1.0'])

    async def test_isolation_containment_integrity_and_no_fake_history(self):
        await self.archive()
        self.assertEqual((await self.client.get('/papers/beta/hub/versions/v0.0/file?path=paper/main.tex')).status,404)
        for name in ('../data.csv','/etc/passwd','.paper-pal.json'):
            self.assertEqual((await self.client.get('/papers/alpha/hub/versions/working/file',params={'path':name})).status,404)
        (self.repo/'.paper-pal/versions/v0.0/files/paper/main.tex').write_text('tampered')
        self.assertEqual((await self.client.get('/papers/alpha/hub/versions/v0.0/file?path=paper/main.tex')).status,409)
        outside=Path(self.tmp.name)/'outside.tex';outside.write_text('outside')
        (self.repo/'paper/escape.tex').symlink_to(outside)
        with self.assertRaises(ArchiveError):create_snapshot(self.repo,expected_parent='v0.0',request_id='unsafe-request')
        self.assertFalse((self.repo/'.paper-pal/versions/v1.0').exists())

    async def test_recorder_includes_custom_macro_inputs_and_pending_candidates(self):
        (self.repo/'build').mkdir();(self.repo/'build/paper.pdf').write_bytes(b'%PDF-test')
        (self.repo/'generated-table.tex').write_text('Exact table values 27.3%')
        (self.repo/'build/paper.fls').write_text('INPUT ../generated-table.tex\nINPUT /etc/passwd\n')
        config=json.loads((self.repo/'.paper-pal.json').read_text());config['pdf']='build/paper.pdf'
        (self.repo/'.paper-pal.json').write_text(json.dumps(config))
        candidate=self.repo/'.paper-pal/requests/proposed.json';candidate.parent.mkdir(parents=True)
        candidate.write_text(json.dumps({'status':'proposed','replacement':'unaccepted candidate'}))
        record=(await self.archive())['version']
        folder=Path(record['snapshot_path'])/'files'
        self.assertEqual((folder/'generated-table.tex').read_text(),'Exact table values 27.3%')
        self.assertEqual(json.loads((folder/'.paper-pal/requests/proposed.json').read_text())['status'],'proposed')
        self.assertEqual((self.repo/'paper/main.tex').read_text(),'First original paragraph.\n')
        self.assertFalse((folder/'etc/passwd').exists())

    async def test_working_text_and_hash_come_from_same_bytes(self):
        await self.archive()
        updated=False
        def concurrent_edit(path):
            nonlocal updated
            if not updated:
                updated=True
                (self.repo/'paper/main.tex').write_text('Concurrent later edit.\n')
            return digest_file(path)
        with patch('versions.digest_file',side_effect=concurrent_edit):
            result=compare(self.repo,'alpha','v0.0','working','paper/main.tex')
        text=next(f for f in result['files'] if f['path']=='paper/main.tex')
        self.assertEqual(text['status'],'equal')
        self.assertEqual(text['latest_text'],'First original paragraph.\n')
        self.assertEqual(text['before']['sha256'],text['after']['sha256'])
        stale=await self.client.get(text['after']['url'])
        self.assertEqual(stale.status,409)

    async def test_snapshot_rejects_figure_metadata_changed_before_copy(self):
        first = True
        def change_after_inventory(repo, config):
            nonlocal first
            captured = inventory(repo, config)
            if first:
                first = False
                Image.new('RGB',(12,12),'blue').save(self.repo/'figs/one.png')
            return captured
        with patch('versions.inventory',side_effect=change_after_inventory):
            with self.assertRaises(ArchiveError) as conflict:
                create_snapshot(self.repo,request_id='mixed-figure-request')
        self.assertEqual(conflict.exception.status,409)
        self.assertFalse((self.repo/'.paper-pal/versions/v0.0').exists())
        record=(await self.archive())['version']
        value=json.loads(Path(record['manifest_path']).read_text())
        self.assertEqual(value['figures'][0]['sha256'],value['files']['figs/one.png']['sha256'])

    async def test_snapshot_rejects_configuration_changed_before_copy(self):
        first = True
        def change_after_inventory(repo, config):
            nonlocal first
            captured = inventory(repo, config)
            if first:
                first = False
                changed=dict(config,defaultDocument='paper/different.tex')
                (self.repo/'.paper-pal.json').write_text(json.dumps(changed))
            return captured
        with patch('versions.inventory',side_effect=change_after_inventory):
            with self.assertRaises(ArchiveError) as conflict:
                create_snapshot(self.repo,request_id='mixed-config-request')
        self.assertEqual(conflict.exception.status,409)
        self.assertFalse((self.repo/'.paper-pal/versions/v0.0').exists())


if __name__=='__main__':unittest.main()
