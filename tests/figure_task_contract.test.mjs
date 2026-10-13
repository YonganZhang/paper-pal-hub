import test from 'node:test';
import assert from 'node:assert/strict';
import {stagedInvocation,upstreamProviderPath,figureReasoningEffort,compactFigureTask,observedTools,safeTrace} from '../figure-task.mjs';
test('Codex staging changes only pinned sandbox and rejects changed contract',()=>{
  const original={command:'codex',args:['exec','--sandbox','read-only','--model','configured']};
  const staged=stagedInvocation(original,'codex');
  assert.deepEqual(staged.args,['exec','--config','sandbox_workspace_write.network_access=true','--sandbox','workspace-write','--model','configured']);
  assert.equal(original.args[2],'read-only');
  assert.throws(()=>stagedInvocation({args:['exec']},'codex'),/contract changed/);
});
test('Claude explicit staged-write tools replace readonly policy without permission bypass',()=>{
  const staged=stagedInvocation({args:['-p','--allowedTools','Read','Glob','Grep','--disallowedTools','Write','Edit','Bash','--permission-mode','default']},'claude');
  assert.equal(staged.args.includes('--disallowedTools'),false);
  assert.equal(staged.args[staged.args.indexOf('--tools')+1],'Read,Glob,Grep,Write,Edit,Bash');
  assert.equal(staged.args[staged.args.indexOf('--permission-mode')+1],'acceptEdits');
  assert.equal(staged.args.includes('--strict-mcp-config'),true);
  assert.equal(staged.args.includes('--dangerously-skip-permissions'),false);
  assert.throws(()=>stagedInvocation({args:[]},'anthropic'),/Only subscription/);
});

test('Upstream provider path honors deployment override',()=>{
  assert.equal(upstreamProviderPath({PAPER_PAL_DIR:'/tmp/reviewed-upstream'}),'/tmp/reviewed-upstream/agent-providers.mjs');
  assert.equal(upstreamProviderPath({}).endsWith('/.local/share/paper-pal/agent-providers.mjs'),true);
});

test('Figure task keeps the full data inventory out of the model prompt and handles Haiku effort',()=>{
  const data=Array.from({length:800},(_,i)=>'raw/large-evidence-'+i+'.csv');
  const job={instruction:'edit only colors',figure:{title:'Figure',kind:'plot',source_paths:['plot.py'],data_paths:data,command:['python3','plot.py']},input_hashes:Object.fromEntries(data.map(p=>[p,'a'.repeat(64)]))};
  const prompt=JSON.stringify(compactFigureTask(job,'/workspace/copiedtaskmanifest.json'));
  assert.ok(prompt.length<1000);
  assert.ok(!prompt.includes('large-evidence-'));
  assert.equal(JSON.parse(prompt).data_file_count,800);
  assert.equal(figureReasoningEffort('codex','configured-model'),'low');
  assert.equal(figureReasoningEffort('claude','haiku'),null);
  assert.equal(figureReasoningEffort('claude','claude-haiku-5-5'),null);
  assert.equal(figureReasoningEffort('claude','sonnet'),'low');
});

test('Image feature flags require availability and tool receipts require actual structured events',()=>{
  const call={args:['exec','--sandbox','read-only','-']};
  assert.equal(stagedInvocation(call,'codex').args.includes('--enable'),false);
  const enabled=stagedInvocation(call,'codex',{imageGeneration:true});
  assert.equal(enabled.args[enabled.args.indexOf('--enable')+1],'image_generation');
  assert.equal(enabled.args.includes('--json'),true);
  assert.deepEqual(observedTools({item:{type:'agent_message',text:'I used image_gen'}}),[]);
  const calls=observedTools({type:'item.completed',item:{type:'image_generation_call',status:'completed',model:'observed-tool-model'}});
  assert.equal(calls[0].image_generation,true);
  assert.equal(calls[0].model,'observed-tool-model');
  assert.equal(safeTrace({result:{b64_json:'private-image-bytes'}}).includes('private-image-bytes'),false);
});
