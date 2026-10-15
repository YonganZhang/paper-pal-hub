"""Loopback-only UI fixture. Chat replies are synthetic; no provider is invoked."""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile

from aiohttp import ClientSession, web

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hub import adapt_asset


async def main():
    with tempfile.TemporaryDirectory(dir=ROOT / '_tmp', prefix='chat-focus-') as directory:
        repo=Path(directory)
        (repo/'main.tex').write_text('\\documentclass{article}\n\\begin{document}\n\\section{Fixture}\nRead-only fixture manuscript.\n\\end{document}')
        (repo/'.paper-pal.json').write_text(json.dumps({'sourceRoot':'.','defaultDocument':'main.tex','pdf':'main.pdf','latex':{'enabled':False},'agent':{'enabled':False,'provider':'codex'},'codex':{'model':'gpt-6-sol','models':['gpt-6-sol','gpt-6.1-sol']},'claude':{'model':'haiku','models':['haiku','sonnet']}}))
        child=await asyncio.create_subprocess_exec('node',str(ROOT/'backend-launch.mjs'),'--repo',str(repo),'--port','0',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT,env={**os.environ,'PAPER_PAL_ENV_FILE':'none'})
        try:
            while True:
                line=(await asyncio.wait_for(child.stdout.readline(),15)).decode()
                match=re.search(r'running at (http://\S+)',line)
                if match:base=match.group(1);break
                if not line:raise RuntimeError('Fixture backend failed to start')
            async with ClientSession() as client:
                sessions={name:{'id':name,'title':'长回复阅读' if name=='alpha' else '另一篇讨论','provider':'codex','model':'gpt-6-sol','status':'idle','createdAt':'2026-10-15T00:00:00Z','updatedAt':'2026-10-15T00:00:00Z','messages':[]} for name in ['alpha','beta']}
                sessions['alpha']['messages']=[{'id':'u1','role':'user','content':'请解释这篇论文的主线。'},{'id':'a1','role':'assistant','provider':'codex','content':'\n\n'.join(f'第{i}段：这是用于验证手机长回复阅读的模拟内容，检查完整历史、滑动、草稿和设置折叠，不调用模型。' for i in range(1,25))}]
                initial_sessions=json.dumps(sessions)
                current='alpha';sends=[]
                async def route(request):
                    nonlocal current
                    path=request.path
                    if path=='/qa-reset' and request.method=='POST':
                        sessions.clear();sessions.update(json.loads(initial_sessions));current='alpha';sends.clear();return web.json_response({'reset':True})
                    if path=='/qa-working' and request.method=='POST':sessions[current]['status']='running';return web.json_response({'running':True})
                    if path.startswith('/hub-assets/'):
                        name=Path(path).name
                        return web.FileResponse(ROOT/'web'/name)
                    if path=='/qa-observations':return web.json_response({'sends':sends,'modelCalls':0})
                    relative=path.removeprefix('/papers/qa-ai/')
                    if relative=='hub/translation-config':return web.json_response({'default_engine':'ai','revisions':{'ai':'fixture-ai','offline':'fixture-machine'}})
                    if relative=='hub/figures':return web.json_response({'figures':[],'jobs':[]})
                    if relative=='hub/versions':return web.json_response({'versions':[]})
                    if relative=='api/chat':return web.json_response(sessions.get(request.query.get('id'),sessions[current]))
                    if relative=='api/chats':return web.json_response(list(sessions.values()))
                    if relative=='api/chat/select':current=(await request.json())['id'];return web.json_response(sessions[current])
                    if relative=='api/chat/new':
                        current='new-'+str(len(sessions));sessions[current]={**sessions['beta'],'id':current,'messages':[]};return web.json_response(sessions[current])
                    if relative=='api/chat/message':
                        body=await request.json();sends.append(body);current=body.get('sessionId') or current
                        session=sessions[current];session['model']=body.get('model') or 'gpt-6-sol';session['provider']=body.get('provider') or 'codex'
                        session['messages'].extend([{'id':'u'+str(len(sends)+1),'role':'user','content':body['message']},{'id':'a'+str(len(sends)+1),'role':'assistant','content':'模拟回复：仅验证发送按钮和草稿，不运行真实模型。'}]);return web.json_response(session)
                    if relative=='api/chat/stop':sessions[current]['status']='stopped';return web.json_response(sessions[current])
                    if relative=='api/events':return web.Response(text=': fixture\n\n',content_type='text/event-stream')
                    if relative in ['','app.js','styles.css']:
                        name=relative or 'index.html';data=(Path.home()/'.local/share/paper-pal/public'/name).read_bytes()
                        return web.Response(body=adapt_asset(name,data,'qa-ai'),content_type={'index.html':'text/html','app.js':'text/javascript','styles.css':'text/css'}[name])
                    async with client.request(request.method,base+'/'+relative+('?' +request.query_string if request.query_string else ''),data=await request.read(),headers={'X-Paper-Pal':'1','Origin':base,'Content-Type':'application/json'}) as response:
                        data=await response.read()
                        if relative=='api/bootstrap':
                            value=json.loads(data)
                            value.get('agent',{})['enabled']=True
                            value.get('chat',{})['enabled']=True
                            value['agent']['providers']=[p for p in value['agent']['providers'] if p['id'] in ['codex','claude']]
                            for p in value.get('agent',{}).get('providers',[]):p.update(available=True,reason=None)
                            return web.json_response(value)
                        return web.Response(body=data,status=response.status,headers={'Content-Type':response.headers.get('Content-Type','application/json')})
                app=web.Application();app.router.add_route('*','/{tail:.*}',route)
                runner=web.AppRunner(app);await runner.setup();await web.TCPSite(runner,'127.0.0.1',4440).start()
                print('UI fixture http://127.0.0.1:4440/papers/qa-ai/',flush=True)
                stop=asyncio.Event()
                for sig in (signal.SIGINT,signal.SIGTERM):asyncio.get_running_loop().add_signal_handler(sig,stop.set)
                try:await stop.wait()
                finally:await runner.cleanup()
        finally:
            if child.returncode is None:
                child.terminate()
                try:await asyncio.wait_for(child.wait(),5)
                except asyncio.TimeoutError:child.kill();await child.wait()


if __name__=='__main__':
    try:asyncio.run(main())
    except KeyboardInterrupt:pass
