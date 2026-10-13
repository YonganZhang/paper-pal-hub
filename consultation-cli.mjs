// Opt-in browser skills for the existing subscription CLI, in a private scratch cwd.
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stagedInvocation,browserRuntimeRoots} from './figure-task.mjs';
import {subscriptionEnvironment} from './subscription-cli.mjs';

const runs=new Map();
const preparing=new Set();
let closing=false;
const script=fileURLToPath(import.meta.url);
async function previousThread(repo) {
  const base=path.join(repo,'.paper-pal','consultations');
  let entries;try{entries=await fs.readdir(base,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const found=[];
  for(const entry of entries.filter(item=>item.isDirectory()).slice(-100)) {
    const file=path.join(base,entry.name,'receipt.json');
    try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16384)continue;
      const value=JSON.parse(await fs.readFile(file,'utf8')),receipt=safeConsultationReceipt(value);
      if(receipt.status==='success'&&receipt.thread_reusable===true)found.push({...receipt,recorded_at:String(value.recorded_at||'')});
    }catch{continue;}
  }
  const latest=found.sort((a,b)=>b.recorded_at.localeCompare(a.recorded_at))[0];
  return latest?{conversation_url:latest.conversation_url,workspace_label:latest.workspace_label}:null;
}
export function trackConsultationChild(outputPath,child) {const record=runs.get(outputPath);if(record)record.child=child;}
export async function settleConsultationChild(outputPath) {
  const child=runs.get(outputPath)?.child;if(!child?.pid)return;
  const signal=name=>{try {if(child.paperPalGroup)process.kill(-child.pid,name);else child.kill(name);}catch(error){if(error.code!=='ESRCH')throw error;}};
  const wait=ms=>new Promise(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null)return resolve();
    const done=()=>{clearTimeout(timer);child.off('exit',done);resolve();};
    const timer=setTimeout(done,ms);child.once('exit',done);
  });
  signal('SIGTERM');await wait(2500);signal('SIGKILL');await wait(1000);
  if(child.exitCode===null&&child.signalCode===null)throw new Error('Consultation process did not stop');
}
export async function createConsultationInvocation(call,options) {
  if(closing)throw new Error('Consultation service is stopping');
  let prepared;const pending=new Promise(resolve=>{prepared=resolve;});preparing.add(pending);
  let runtime;
  const repo=path.resolve(options.repoRoot);
  try {
    runtime=await fs.mkdtemp('/tmp/pph-consult-');
    await fs.mkdir(path.join(runtime,'cache'),{mode:0o700});
    const environment={TMPDIR:runtime,XDG_CACHE_HOME:path.join(runtime,'cache')};
    await fs.writeFile(path.join(runtime,'browser-runtime.json'),JSON.stringify(environment),{mode:0o600});
    const record={runtime,repo,receipt:path.join(repo,'.paper-pal','consultations',path.basename(runtime),'receipt.json')};
    runs.set(options.outputPath,record);
    return {...call,command:process.execPath,args:[script,call.provider,call.command,...call.args],
      input:JSON.stringify({prompt:call.input,...record,previousThread:await previousThread(repo)})};
  } catch(error) {if(runtime)await fs.rm(runtime,{recursive:true,force:true});throw error;}
  finally {preparing.delete(pending);prepared();}
}
export function safeConsultationReceipt(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid consultation receipt');
  const result={status:value.status==='success'?'success':'blocked'};
  if(value.conversation_url) {
    const url=new URL(value.conversation_url);
    if(url.protocol!=='https:'||url.hostname!=='chatgpt.com'||url.username||url.password||!/^\/(?:g\/[a-zA-Z0-9-]+\/)?c\/[a-zA-Z0-9-]+$/.test(url.pathname))throw new Error('Invalid consultation conversation URL');
    result.conversation_url=url.origin+url.pathname;
  }
  for(const key of ['workspace_label','reason'])if(typeof value[key]==='string')result[key]=value[key].slice(0,key==='reason'?1000:160);
  for(const key of ['message_present','assistant_completed','canary_matched','original_tab_preserved','thread_reusable'])if(typeof value[key]==='boolean')result[key]=value[key];
  for(const key of ['send_count','unexpected_sends'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=10000)result[key]=value[key];
  if(result.status==='success'&&(!result.conversation_url||!result.workspace_label||result.message_present!==true||result.assistant_completed!==true||result.original_tab_preserved!==true||result.unexpected_sends!==0||!(result.send_count>=1)))throw new Error('Incomplete consultation receipt');
  return result;
}
export async function consultationOutcome(outputPath) {
  const record=runs.get(outputPath);if(!record)return null;
    for(const name of ['web-consultation-receipt.json','failure-receipt.json']) {
      const source=path.join(record.runtime,name);
      let info;try{info=await fs.lstat(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!info.isFile()||info.isSymbolicLink()||info.size>16384)continue;
      let receipt;try{receipt=safeConsultationReceipt(JSON.parse(await fs.readFile(source,'utf8')));}catch{continue;}
      return receipt;
    }
  return {status:'blocked',reason:'工作进程没有提交有效的网页咨询完成回执。'};
}
export async function renderConsultationAnswer(outputPath,text) {
  const record=runs.get(outputPath);if(!record)return text;
  for(const name of ['web-consultation-receipt.json','failure-receipt.json'])text=text.replaceAll(path.join(record.runtime,name),record.receipt);
  const outcome=await consultationOutcome(outputPath);
  return outcome?.status==='success'?text:'网页咨询尚未完成：'+(outcome?.reason||'工作进程没有说明未完成原因，请检查咨询回执。')+'\n\n'+text;
}
export async function cleanupConsultationRuntime(outputPath) {
  const record=runs.get(outputPath);if(!record)return;
  await settleConsultationChild(outputPath);
  try {
    const receipt=await consultationOutcome(outputPath);
    await fs.mkdir(path.dirname(record.receipt),{recursive:true,mode:0o700});
    await fs.writeFile(record.receipt,JSON.stringify({...receipt,recorded_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  } finally {await fs.rm(record.runtime,{recursive:true,force:true});runs.delete(outputPath);}
}
export async function cleanupAllConsultationRuntimes() {
  closing=true;
  await Promise.allSettled([...preparing]);
  await Promise.allSettled([...runs.keys()].map(cleanupConsultationRuntime));
}

export function consultationArguments(args,provider,runtime,environment) {
  if(provider==='codex') {
    const roots=browserRuntimeRoots(environment);
    if(roots.includes('/tmp'))throw new Error('Set the shared consultation lock inside a scoped runtime directory');
    const invocation=stagedInvocation({args},provider,{writableRoots:roots});
    invocation.args.splice(1,0,'--config','sandbox_workspace_write.exclude_slash_tmp=true',
      '--config','sandbox_workspace_write.exclude_tmpdir_env_var=true');
    const index=invocation.args.indexOf('-C');
    if(index<0)throw new Error('Missing Codex cwd contract');
    invocation.args[index+1]=runtime;
    return invocation.args;
  }
  if(provider!=='claude')throw new Error('Unsupported consultation provider');
  const result=[...args];
  for(const flag of ['--allowedTools','--disallowedTools','--tools']) {
    const i=result.indexOf(flag);if(i<0)continue;
    let end=i+1;while(end<result.length&&!result[end].startsWith('--'))end++;
    result.splice(i,end-i);
  }
  result.push('--tools','Read,Glob,Grep,Bash','--allowedTools','Read','Glob','Grep','Bash',
    '--disallowedTools','Write','Edit','NotebookEdit','--strict-mcp-config');
  return result;
}

async function main() {
  const [provider,command,...args]=process.argv.slice(2);
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2*1024*1024)throw new Error('Consultation input too large');}
  const payload=JSON.parse(input),runtime=payload.runtime;
  if(typeof runtime!=='string'||path.dirname(runtime)!=='/tmp'||!path.basename(runtime).startsWith('pph-consult-'))throw new Error('Invalid consultation runtime');
  const stat=await fs.lstat(runtime);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe consultation runtime');
  const environment=subscriptionEnvironment(process.env);
  Object.assign(environment,JSON.parse(await fs.readFile(path.join(runtime,'browser-runtime.json'),'utf8')));
  const roots=browserRuntimeRoots(environment);for(const dir of roots)await fs.mkdir(dir,{recursive:true,mode:0o700});
  const argv=consultationArguments(args,provider,runtime,environment);
  const prompt=payload.prompt.replace('Repository root: . (your working directory)',`Repository root: ${payload.repo} (read-only project context)`)+`\nThe user explicitly enabled ChatGPT web consultation for this message. You are the corresponding 论文 AI and must execute the applicable global share-web-consultation skill yourself. A previously successful thread recorded by this same paper is ${JSON.stringify(payload.previousThread)}. If provided, inspect its first identity block and match the recorded workspace before reuse; do not guess from titles. Use ${payload.repo} as the stable 工作目录 in new conversation identity headers, never this temporary scratch directory. Read current global rules/skills and ${payload.repo}/AGENTS.md and ${payload.repo}/.agents/skills/paper-ai/SKILL.md when present. Your working directory is a private scratch directory, not the manuscript. You may create browser helper scripts and minimal receipts ONLY here; never edit/create/delete manuscript files or review proposals. Original project paths in earlier instructions are relative to ${payload.repo}; read that project only. Read browser-runtime.json and restore its TMPDIR/XDG_CACHE_HOME explicitly before browser tools because login shells may override them. Run attach/login-check/guards/browser operations in one shell tool call, under the global shared write lock. Preserve other tabs and drafts. Use an empty conversation or a verified same-project thread. A Page created inside run-code does not automatically become the CLI current page: set a unique temporary window.__chatgptConsultTarget on your owned page and pass it to consult-guard.sh check <workspace> --target-token <token>, exactly as the current global skill describes. Do not clear the original current page to make its guard pass. The consultation checkbox authorizes sending the submitted question only. It does not authorize clearing, moving or restoring pre-existing drafts. Preserve all original tabs and drafts. If a new tab inherits any existing draft, stop without editing it and explain the draft conflict; do not attempt draft staging as a workaround. Never guess thread ownership, skip a failed guard, read credentials/cookie/storage exports or switch accounts. Use locator.fill(text) for multi-line messages and draft restoration, never CLI type or keyboard typing containing newlines; those can submit unexpectedly. Read back the filled/restored text. Only the explicit Send step may press Enter or click Send. Only explicit user-authorized questions may be sent. Confirm the new user message and a nonempty completed assistant response before claiming success. Write web-consultation-receipt.json with status=success, conversation_url, workspace_label, message_present=true, assistant_completed=true, original_tab_preserved=true, send_count (actual count), unexpected_sends=0 and thread_reusable (true only after successful reopening and identity recheck); otherwise failure-receipt.json with a concise reason and status=blocked. Never save conversation copies or private draft contents. Your minimal receipt will be archived at ${payload.receipt}. Reply in Chinese with the external consultation summary and its URL, then your independent assessment; if blocked explain it without fabricating a reply. This mode enables the browser tools, not manuscript editing.\n`;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./subscription-cli.mjs',import.meta.url)),provider,command,...argv],{cwd:runtime,env:environment,stdio:['pipe','inherit','inherit']});
    const stop=()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2500).unref();};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    child.on('error',reject);
    child.on('exit',code=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);code===0?resolve():reject(new Error('Consultation subscription CLI failed'));});
    child.stdin.on('error',()=>{});child.stdin.end(prompt);
  });
}
if(process.argv[1]===script)main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
