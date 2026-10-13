import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createConsultationInvocation,cleanupConsultationRuntime,consultationArguments,safeConsultationReceipt,renderConsultationAnswer} from '../consultation-cli.mjs';

test('consultation preserves models, confines Codex tools, and gives Claude only browser helper tools',()=>{
  const env={HOME:'/home/author',TMPDIR:'/tmp/pph-consult-example',XDG_CACHE_HOME:'/tmp/pph-consult-example/cache',XDG_RUNTIME_DIR:'/run/user/42'};
  const args=consultationArguments(['exec','--sandbox','read-only','--model','chosen-model','-C','/paper','-'],'codex',env.TMPDIR,env);
  assert.equal(args[args.indexOf('--model')+1],'chosen-model');
  assert.equal(args[args.indexOf('-C')+1],env.TMPDIR);
  assert.ok(args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.equal(args.includes('danger-full-access'),false);
  assert.throws(()=>consultationArguments(['exec','--sandbox','read-only','-C','/paper'],'codex',env.TMPDIR,{...env,XDG_RUNTIME_DIR:undefined}),/scoped runtime/);
  const claude=consultationArguments(['-p','--allowedTools','Read','--disallowedTools','Write','Bash'],'claude',env.TMPDIR,env);
  assert.equal(claude[claude.indexOf('--tools')+1],'Read,Glob,Grep,Bash');
  assert.deepEqual(claude.slice(claude.indexOf('--disallowedTools')+1,claude.indexOf('--strict-mcp-config')),['Write','Edit','NotebookEdit']);
});

test('minimal receipt rejects forged URL/completion and excludes private payloads',()=>{
  const receipt={status:'success',conversation_url:'https://chatgpt.com/c/test-id?private=discarded',workspace_label:'paper',message_present:true,assistant_completed:true,original_tab_preserved:true,send_count:1,unexpected_sends:0,transcript:'must never be archived'};
  assert.equal(safeConsultationReceipt(receipt).conversation_url,'https://chatgpt.com/c/test-id');
  assert.equal('transcript' in safeConsultationReceipt(receipt),false);
  assert.equal(safeConsultationReceipt({...receipt,conversation_url:'https://chatgpt.com/g/g-p-project/c/thread'}).conversation_url,'https://chatgpt.com/g/g-p-project/c/thread');
  assert.throws(()=>safeConsultationReceipt({...receipt,conversation_url:'https://example.org/c/test-id'}),/URL/);
  assert.throws(()=>safeConsultationReceipt({...receipt,assistant_completed:false}),/Incomplete/);
  assert.throws(()=>safeConsultationReceipt({...receipt,unexpected_sends:1}),/Incomplete/);
  assert.throws(()=>safeConsultationReceipt({...receipt,original_tab_preserved:false}),/Incomplete/);
});

test('host cleanup removes scratch even when a worker fails before starting or supplies invalid receipt',async()=>{
  const repo=await fs.mkdtemp('/tmp/pph-consult-contract-');
  try {
    for(const valid of [true,false]) {
      const outputPath=path.join(repo,valid?'answer.txt':'failed.txt');
      const call=await createConsultationInvocation({provider:'codex',command:'fake-cli',args:[],input:'private task'}, {repoRoot:repo,outputPath});
      const payload=JSON.parse(call.input);
      assert.equal((await fs.stat(payload.runtime)).mode&0o777,0o700);
      await fs.writeFile(path.join(payload.runtime,'failure-receipt.json'),valid?JSON.stringify({reason:'fixture browser blocked',secret:'must not survive'}):'invalid JSON');
      await cleanupConsultationRuntime(outputPath);
      await assert.rejects(fs.stat(payload.runtime),{code:'ENOENT'});
      if(valid){const saved=JSON.parse(await fs.readFile(payload.receipt));assert.equal(saved.reason,'fixture browser blocked');assert.equal('secret' in saved,false);}
    }
  } finally {await fs.rm(repo,{recursive:true,force:true});}
});


test('successful receipt links survive scratch cleanup and only verified threads are offered again',async()=>{
  const repo=await fs.mkdtemp('/tmp/pph-consult-reuse-');
  const receipt={status:'success',conversation_url:'https://chatgpt.com/c/verified-id',workspace_label:'paper',message_present:true,assistant_completed:true,original_tab_preserved:true,send_count:1,unexpected_sends:0,thread_reusable:true};
  try {
    const first=await createConsultationInvocation({provider:'codex',command:'fake-cli',args:[],input:'task'}, {repoRoot:repo,outputPath:path.join(repo,'first.txt')});
    const payload=JSON.parse(first.input),temp=path.join(payload.runtime,'web-consultation-receipt.json');
    await fs.writeFile(temp,JSON.stringify(receipt));
    const answer=await renderConsultationAnswer(path.join(repo,'first.txt'),`Receipt: ${temp}`);
    assert.equal(answer,`Receipt: ${payload.receipt}`);
    await cleanupConsultationRuntime(path.join(repo,'first.txt'));
    assert.equal(JSON.parse(await fs.readFile(payload.receipt)).status,'success');
    const second=await createConsultationInvocation({provider:'codex',command:'fake-cli',args:[],input:'task'}, {repoRoot:repo,outputPath:path.join(repo,'second.txt')});
    assert.deepEqual(JSON.parse(second.input).previousThread,{conversation_url:receipt.conversation_url,workspace_label:'paper'});
    await cleanupConsultationRuntime(path.join(repo,'second.txt'));
    await fs.writeFile(payload.receipt,JSON.stringify({...receipt,thread_reusable:false}));
    const third=await createConsultationInvocation({provider:'codex',command:'fake-cli',args:[],input:'task'}, {repoRoot:repo,outputPath:path.join(repo,'third.txt')});
    assert.equal(JSON.parse(third.input).previousThread,null);
    await cleanupConsultationRuntime(path.join(repo,'third.txt'));
  } finally {await fs.rm(repo,{recursive:true,force:true});}
});
