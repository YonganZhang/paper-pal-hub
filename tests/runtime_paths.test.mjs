import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function fixture(){
  const parent=path.join(root,'_tmp/audit-release');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'runtime-'));
  const fake=path.join(dir,'codex');
  await fs.writeFile(fake,`#!${process.execPath}
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
for await(const chunk of process.stdin){};
writeFileSync(path.join(process.cwd(),'invocation.json'),JSON.stringify(args));
appendFileSync(${JSON.stringify(path.join(dir,'calls.jsonl'))},JSON.stringify(args)+'\\n');
const result=args.includes('--output-schema')?JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(readFileSync(get('--output-schema'),'utf8')).properties).map(key=>[key,'测试译文']))):'测试回复';
writeFileSync(get('--output-last-message'),result);
`);
  // Extensionless official-style executable, still interpreted as ESM.
  await fs.writeFile(path.join(dir,'package.json'),' {"type":"module"} ');
  await fs.chmod(fake,0o755);
  const env={...process.env,PAPER_PAL_ENV_FILE:'none',PATH:dir+path.delimiter+process.env.PATH,TMPDIR:dir};
  delete env.CODEX_BIN;
  return {dir,fake,env};
}

test('backend resolves a Codex CLI on PATH without a hard-coded npm installation',async()=>{
  const {dir,env}=await fixture();let child;
  try {
    await fs.writeFile(path.join(dir,'main.tex'),'\\documentclass{article}\n\\begin{document}A fixture.\\end{document}');
    await fs.writeFile(path.join(dir,'.paper-pal.json'),JSON.stringify({sourceRoot:'.',defaultDocument:'main.tex',pdf:'main.pdf',latex:{enabled:false},agent:{enabled:true,provider:'codex'},codex:{model:'configured-model'}}));
    child=spawn(process.execPath,[path.join(root,'backend-launch.mjs'),'--repo',dir,'--port','0'],{env,stdio:['ignore','pipe','pipe']});
    const base=await new Promise((resolve,reject)=>{
      let log='';const timer=setTimeout(()=>reject(new Error('Startup timeout: '+log)),10000);
      const data=chunk=>{log+=chunk;const match=log.match(/running at (http:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}};
      child.stdout.on('data',data);child.stderr.on('data',data);child.once('exit',()=>{clearTimeout(timer);reject(new Error(log));});
    });
    let response=await fetch(base+'/api/chat/message',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Pal':'1'},body:JSON.stringify({message:'Fixture only',model:'configured-model'})});
    assert.equal(response.status,202);let session=await response.json();
    for(let i=0;i<100&&session.status!=='idle';i++){
      if(session.status==='failed')throw new Error(session.error);
      await new Promise(resolve=>setTimeout(resolve,40));session=await (await fetch(base+'/api/chat?id='+session.id)).json();
    }
    assert.equal(session.status,'idle');assert.equal(session.messages.at(-1).content,'测试回复');
    const args=JSON.parse(await fs.readFile(path.join(dir,'invocation.json'),'utf8'));
    assert.equal(args[args.indexOf('--model')+1],'configured-model');
  } finally {
    if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('AI translation honors explicit CLI and configured model without using a real model',async()=>{
  const {dir,fake,env}=await fixture();
  async function run(aiModel){
    const child=spawn(process.execPath,[path.join(root,'translation-ai.mjs')],{env:{...env,CODEX_BIN:fake,PAPER_HUB_TRANSLATION_MODEL:'global-translation-model'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.stdin.end(JSON.stringify({texts:['English fixture.'],glossary:{},...(aiModel?{aiModel}:{})}));
    const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,stderr);
    assert.equal(JSON.parse(stdout.trim()).text,'测试译文');
    const calls=(await fs.readFile(path.join(dir,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const args=calls.at(-1);assert.equal(args[args.indexOf('--model')+1],aiModel||'global-translation-model');
  }
  try {await run('paper-translation-model');await run(null);}finally {await fs.rm(dir,{recursive:true,force:true});}
});
