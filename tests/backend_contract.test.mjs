import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adaptServer} from '../backend-loader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('chat model reaches invocation, survives restart, and flows into an anchored proposal',async()=>{
  await fs.mkdir(path.join(root,'_tmp'),{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'_tmp/backend-test-'));
  const fake=path.join(dir,'fake-codex.mjs');
  await fs.writeFile(fake,`#!/usr/bin/env node
import {writeFileSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
writeFileSync(path.join(process.cwd(),'invocation.json'),JSON.stringify(args));
writeFileSync(${JSON.stringify(path.join(dir,'consult-invocation.json'))},JSON.stringify({args,cwd:process.cwd(),prompt}));
if(prompt.includes('CONSULT_TIMEOUT')){process.on('SIGTERM',()=>{});setInterval(()=>writeFileSync(path.join(process.cwd(),'late-write.txt'),'running'),20);await new Promise(()=>{});}
if(args.includes('-p')){console.log('这是 Claude 的可审阅意见。');process.exit(0);}
writeFileSync(get('--output-last-message'),'这是可审阅的修改意见。');
`);await fs.chmod(fake,0o755);
  const original='A uniquely anchored sentence about cement bond classification.';
  await fs.writeFile(path.join(dir,'main.tex'),'\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n'+original+'\n\\end{document}');
  await fs.writeFile(path.join(dir,'.paper-pal.json'),JSON.stringify({title:'Test',sourceRoot:'.',defaultDocument:'main.tex',pdf:'main.pdf',latex:{enabled:false},agent:{enabled:true,provider:'codex',allowOverride:true},codex:{model:'model-a',models:['model-a','model-b']},claude:{model:'haiku',models:['haiku','sonnet']}}));
  let child,base;
  async function start(){
    child=spawn(process.execPath,[path.join(root,'backend-launch.mjs'),'--repo',dir,'--port','0'],{env:{...process.env,PAPER_PAL_ENV_FILE:'none',PAPER_PAL_ALLOW_CUSTOM_COMMANDS:'1',CODEX_BIN:fake,CLAUDE_BIN:fake,TMPDIR:dir},stdio:['ignore','pipe','pipe']});
    let log='';base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Backend startup timeout '+log)),10000);
      const data=chunk=>{log+=String(chunk);const m=log.match(/running at (http:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}};
      child.stdout.on('data',data);child.stderr.on('data',data);child.once('exit',()=>{clearTimeout(timer);reject(new Error(log));});
    });
  }
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}}
  async function api(route,body){const response=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Paper-Pal':'1'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
  async function answer(id){for(let i=0;i<100;i++){const s=await api('/api/chat?id='+id);if(s.status==='idle')return s;if(s.status==='failed')throw new Error(s.error);await new Promise(r=>setTimeout(r,50));}throw new Error('Answer timeout');}
  try {
    await start();
    let session=await api('/api/chat/message',{message:'请修改选中句子',activePath:'main.tex',model:'model-b',selectionContext:{path:'main.tex',selectedText:original}});
    assert.equal(session.model,'model-b');session=await answer(session.id);
    assert.equal(session.messages.at(-1).model,'model-b');
    const args=JSON.parse(await fs.readFile(path.join(dir,'invocation.json')));
    assert.equal(args[args.indexOf('--model')+1],'model-b');assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    const proposal=await api('/api/chat/create-proposal',{sessionId:session.id,assistantMessageId:session.messages.at(-1).id,autoProcess:false});
    assert.equal(proposal.request.model,'model-b');assert.equal(proposal.request.provider,'codex');
    assert.ok((await fs.readFile(path.join(dir,'main.tex'),'utf8')).includes(original));
    await stop();await start();assert.equal((await api('/api/chat')).messages.at(-1).model,'model-b');
    const invalid=await api('/api/chat/message',{message:'不使用任意模型',model:'unapproved-model',autoProcess:false});assert.equal(invalid.model,'model-a');
    const rejected=await fetch(base+'/api/chat/message',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Pal':'1'},body:JSON.stringify({message:'API forbidden',provider:'anthropic'})});assert.equal(rejected.status,400);
    let claude=await api('/api/chat/message',{message:'请讨论选中原文',provider:'claude',model:'haiku',selectionContext:{path:'main.tex',selectedText:original}});claude=await answer(claude.id);
    assert.equal(claude.messages.at(-1).provider,'claude');assert.equal(claude.messages.at(-1).model,'haiku');assert.equal(claude.messages.at(-1).reasoningEffort,null);
    const ca=JSON.parse(await fs.readFile(path.join(dir,'invocation.json')));assert.equal(ca[ca.indexOf('--model')+1],'haiku');assert.ok(ca.includes('--strict-mcp-config'));assert.ok(!ca.includes('--effort'));assert.equal(ca[ca.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(ca.filter(a=>a==='--tools').length,1);
    const cp=await api('/api/chat/create-proposal',{sessionId:claude.id,assistantMessageId:claude.messages.at(-1).id,autoProcess:false});assert.equal(cp.request.provider,'claude');assert.equal(cp.request.model,'haiku');
    let web=await api('/api/chat/message',{message:'请网页咨询',provider:'codex',model:'model-b',webConsultation:true});web=await answer(web.id);
    assert.equal([...web.messages].reverse().find(message=>message.role==='user').webConsultation,true);
    assert.ok(web.messages.at(-1).content.includes('网页咨询尚未完成：'));
    const captured=JSON.parse(await fs.readFile(path.join(dir,'consult-invocation.json')));
    assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'workspace-write');
    assert.equal(captured.args[captured.args.indexOf('-C')+1],captured.cwd);
    assert.ok(captured.cwd.startsWith('/tmp/pph-consult-'));
    assert.ok(captured.prompt.includes('share-web-consultation'));
    assert.ok(captured.prompt.includes('Repository root: '+dir));
    for(let i=0;i<60;i++){try{await fs.stat(captured.cwd);}catch{break;}await new Promise(r=>setTimeout(r,25));}
    await assert.rejects(fs.stat(captured.cwd),{code:'ENOENT'});
    assert.ok((await fs.readFile(path.join(dir,'main.tex'),'utf8')).includes(original));
    let ordinary=await api('/api/chat/message',{message:'普通讨论',provider:'codex',webConsultation:'true'});ordinary=await answer(ordinary.id);
    const plain=JSON.parse(await fs.readFile(path.join(dir,'consult-invocation.json')));
    assert.equal(plain.cwd,dir);assert.equal(plain.args[plain.args.indexOf('--sandbox')+1],'read-only');
    await stop();
    const configuration=JSON.parse(await fs.readFile(path.join(dir,'.paper-pal.json')));configuration.codex.chatTimeoutMs=1000;
    await fs.writeFile(path.join(dir,'.paper-pal.json'),JSON.stringify(configuration));await start();
    const timed=await api('/api/chat/message',{message:'CONSULT_TIMEOUT',provider:'codex',webConsultation:true});
    let failed;
    for(let i=0;i<180;i++){failed=await api('/api/chat?id='+timed.id);if(failed.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(failed.status,'failed');
    const timedCall=JSON.parse(await fs.readFile(path.join(dir,'consult-invocation.json')));
    assert.ok(timedCall.prompt.includes('CONSULT_TIMEOUT'));
    for(let i=0;i<80;i++){try{await fs.stat(timedCall.cwd);}catch{break;}await new Promise(r=>setTimeout(r,25));}
    await assert.rejects(fs.stat(timedCall.cwd),{code:'ENOENT'});
    await new Promise(r=>setTimeout(r,100));await assert.rejects(fs.stat(timedCall.cwd),{code:'ENOENT'});
    await api('/api/chat/message',{message:'CONSULT_SHUTDOWN',provider:'codex',webConsultation:true});
    let shutdownCall;
    for(let i=0;i<100;i++){shutdownCall=JSON.parse(await fs.readFile(path.join(dir,'consult-invocation.json')));if(shutdownCall.prompt.includes('CONSULT_SHUTDOWN'))break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(shutdownCall.prompt.includes('CONSULT_SHUTDOWN'));
    await stop();await assert.rejects(fs.stat(shutdownCall.cwd),{code:'ENOENT'});
  } finally {await stop();await fs.rm(dir,{recursive:true,force:true});}
});
test('backend fails closed on anchor drift',()=>{
  assert.throws(()=>adaptServer('changed upstream'),/anchor changed/);
});
