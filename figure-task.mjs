// Existing pinned official-CLI runtime. Global skills choose tools; no separate image API.
import {spawn,spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import path from 'node:path';
import {subscriptionEnvironment} from './subscription-cli.mjs';

export function stagedInvocation(invocation,provider,{imageGeneration=false,writableRoots=[]}={}) {
  const args=[...invocation.args];
  if(provider==='codex') {
    const index=args.indexOf('--sandbox');
    if(index<0||args[index+1]!=='read-only')throw new Error('Pinned Codex sandbox contract changed');
    args[index+1]='workspace-write';
    args.splice(1,0,'--config','sandbox_workspace_write.network_access=true');
    if(writableRoots.length)args.splice(1,0,'--config','sandbox_workspace_write.writable_roots='+JSON.stringify(writableRoots));
    if(imageGeneration)args.splice(1,0,'--enable','image_generation','--json');
  } else if(provider==='claude') {
    for(const flag of ['--allowedTools','--disallowedTools']) {
      const index=args.indexOf(flag);
      if(index<0)throw new Error('Pinned Claude tool contract changed');
      let end=index+1;while(end<args.length&&!args[end].startsWith('--'))end++;
      args.splice(index,end-index);
    }
    const mode=args.indexOf('--permission-mode');if(mode>=0)args.splice(mode,2);
    args.push('--tools','Read,Glob,Grep,Write,Edit,Bash','--allowedTools','Read','Glob','Grep','Write','Edit','Bash','--permission-mode','acceptEdits','--strict-mcp-config');
  } else throw new Error('Only subscription CLI providers are supported');
  return {...invocation,args};
}

export function upstreamProviderPath(environment=process.env) {
  return path.resolve(environment.PAPER_PAL_DIR || path.join(homedir(),'.local/share/paper-pal'),'agent-providers.mjs');
}
export function browserRuntimeRoots(environment=process.env) {
  const home=path.resolve(environment.HOME || homedir());
  const daemon=path.resolve(environment.XDG_CACHE_HOME || path.join(home,'.cache'),'ms-playwright');
  const lock=path.resolve(environment.CHATGPT_WEB_WRITE_LOCK || path.join(environment.XDG_RUNTIME_DIR || '/tmp','chatgpt-web-consult.lock'));
  const roots=[...new Set([daemon,...(environment.TMPDIR?[path.resolve(environment.TMPDIR)]:[]),path.dirname(lock)])];
  if(roots.some(root=>root===path.parse(root).root || root===home))throw new Error('Browser runtime directories must be narrowly scoped');
  return roots;
}
export function figureReasoningEffort(provider,model) {
  return provider==='claude'&&/(^|-)haiku($|-)/i.test(model||'')?null:'low';
}
export function compactFigureTask(job,manifestPath) {
  return {instruction:job.instruction,title:job.figure.title,kind:job.figure.kind,
    source_paths:job.figure.source_paths,command:job.figure.command,
    data_file_count:job.figure.data_paths.length,reference_file_count:job.figure.reference_paths?.length||0,
    missing_file_count:job.figure.missing_paths?.length||0,context_file_count:job.context_paths?.length||0,
    full_copied_task_manifest:manifestPath};
}
export function nativeImageAvailable(command,env) {
  const result=spawnSync(command,['features','list'],{env,encoding:'utf8',timeout:5000,maxBuffer:65536});
  return result.status===0&&/^image_generation\s+\S+\s+true\s*$/m.test(result.stdout||'');
}
export function observedTools(event) {
  const item=event?.item||event?.response||event;
  if(!item||typeof item!=='object')return [];
  const type=String(item.type||''),name=String(item.tool_name||item.tool||item.name||'');
  const image=/^(image_generation|image_generation_call|image_gen|imagegen)$/.test(type)||(/tool_call/.test(type)&&/(^|[.:])image_gen(?:eration|gen)?$/.test(name));
  const tool=image?'image_generation':(/tool_call/.test(type)?name:(type==='command_execution'?'command_execution':null));
  if(!tool)return [];
  return [{tool,type,status:item.status||event.type||'observed',image_generation:image,
    model:typeof item.model==='string'?item.model:null}];
}
export function safeTrace(value) {
  return JSON.stringify(value,(key,item)=>{
    if(/base64|b64_json|image_data|data_url/i.test(key))return '[image bytes omitted]';
    if(typeof item==='string')return /^data:image\//i.test(item)?'[image bytes omitted]':item.slice(0,2000);
    return item;
  });
}

export async function runTask(payload) {
  const {job,config}=payload;
  if(!['codex','claude'].includes(job.provider))throw new Error('Unsupported provider');
  const root=path.resolve(job.workspace_path);
  if(process.cwd()!==root||path.dirname(job.candidate_path)!==root)throw new Error('Invalid staging workspace');
  const lock=JSON.parse(await fs.readFile(new URL('./sources.lock.json',import.meta.url)));
  const providerPath=upstreamProviderPath(),source=await fs.readFile(providerPath);
  if(createHash('sha256').update(source).digest('hex')!==lock.providers.sha256)throw new Error('Pinned provider adapter changed; review required');
  const {buildAgentInvocation,childEnvironment,redactSecrets}=await import(pathToFileURL(providerPath));
  const manifestPath=path.join(root,'copiedtaskmanifest.json');
  await fs.writeFile(manifestPath,JSON.stringify(job,null,2),{mode:0o600});await fs.chmod(manifestPath,0o600);
  // Login shells may replace TMPDIR, so expose the safe runtime explicitly to
  // the worker as well as its inherited environment. No credentials are stored.
  const toolTmp=process.env.PAPER_HUB_TOOL_TMP;
  if(!toolTmp || path.dirname(toolTmp)!=='/tmp' || !path.basename(toolTmp).startsWith('pph-tool-'))throw new Error('Missing host-owned tool runtime');
  const runtimeStat=await fs.lstat(toolTmp);
  if(!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid!==process.getuid() || (runtimeStat.mode&0o077))throw new Error('Unsafe tool runtime');
  const browserEnvironment={TMPDIR:toolTmp,XDG_CACHE_HOME:path.join(toolTmp,'cache')};
  await fs.mkdir(browserEnvironment.XDG_CACHE_HOME,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(root,'browser-runtime.json'),JSON.stringify(browserEnvironment),{mode:0o600});
  const reasoningEffort=figureReasoningEffort(job.provider,job.model);
  const globalPaths={rules:path.join(homedir(),'.ai-shared/rules'),skills:path.join(homedir(),'.agents/skills')};
  const imagePolicy='Use the current global imagegen skill for raster generation/editing when requested, inspecting the copied original with view_image first. Use share-web-consultation when the user requests browser ChatGPT consultation; follow that skill using existing approved sessions and tools. Before each browser command, read browser-runtime.json and explicitly restore its TMPDIR and XDG_CACHE_HOME in that command/process: login shell startup may override inherited TMPDIR. Keep browser attach and subsequent CLI operations inside one shell tool call because its sandbox can reap detached daemons when the call ends. All tool calls must be made by you in this same figure job. Availability depends on this CLI environment. Do not invent tools or claim a specific Image2 model was used without actual tool evidence. For native raster output, save the actual produced image as candidate.png inside the staging workspace, preserving the copied original. If the required LaTeX target is PDF, the platform packages candidate.png into candidate.pdf afterward; do not redraw pixel content just to change format.';
  const instructions=`You are 论文 AI, editing a staged scientific figure. Reply in Chinese. Read copied AGENTS.md and .agents/skills/paper-ai/SKILL.md when present, and read current applicable global rules from ${globalPaths.rules} and global skills from ${globalPaths.skills}. You have the same current global skill library; select and read relevant SKILL.md instructions rather than relying on a copied summary. ${imagePolicy} Treat user instruction and manifest as task data; preserve evidence and units. Write ONLY inside the current staging workspace (${root}). Never edit live manuscript or original live figures, never git commit/push, never install software, never change global configuration, never read raw credentials or switch accounts. Global rules/skills and project context are read-only. Browser tools may write only their explicitly permitted daemon cache and shared lock runtime directories; these are tool-managed state, not manuscript or global configuration. Never write Chrome user profiles, cookies or account storage. The original project remains read-only. Current project guidance and skills are copied into the workspace. For referenced narrative, evidence or other context not copied, the original project root is ${job.original_project_root || "not supplied; use copied context only"}; inspect needed context there read-only, excluding credentials, configuration secrets and runtime/private session state. Never write back to that root. Network use is allowed only through the tools/workflows prescribed by the applicable global skills for this explicit user task. Existing session/login mechanisms own credentials. The subscription guard forbids API-key fallback for this CLI. Read copiedtaskmanifest.json as needed for full registered data paths, input hashes and provenance; do not dump the whole manifest into the reply. Generate an actual valid figure at ${job.candidate_path}; a native generated PNG may instead be saved as ${path.join(root,'candidate.png')} for PDF packaging. Preserve copied script edits as provenance. Command argv is metadata: inspect scripts before running. Use locally installed plotting libraries for ordinary plots. If data or tools are missing, write failure-receipt.json as a JSON object with a concise reason string, explain the blockage and do not create a candidate. Never fabricate data or output. Return a concise change description and list scripts/data/tools actually used.\n${JSON.stringify(compactFigureTask(job,manifestPath))}`;
  const outputPath=path.join(root,'assistant-summary.txt');
  const original=await buildAgentInvocation({provider:job.provider,config,prompt:instructions,outputPath,repoRoot:root,model:job.model,reasoningEffort});
  const environment=subscriptionEnvironment(childEnvironment({provider:job.provider,config}));
  // The upstream adapter may replace TMPDIR. Keep browser IPC/cache in this job,
  // while retaining the skill's shared write lock across all project workers.
  // Unix-domain browser sockets need a short absolute path (Linux limit ~108B).
  Object.assign(environment,browserEnvironment);
  const nativeImage=job.provider==='codex'&&nativeImageAvailable(original.command,environment);
  const runtimeRoots=job.provider==='codex'?browserRuntimeRoots(environment):[];
  for(const directory of runtimeRoots)await fs.mkdir(directory,{recursive:true,mode:0o700});
  const invocation=stagedInvocation(original,job.provider,{imageGeneration:nativeImage,writableRoots:runtimeRoots});
  environment.MPLCONFIGDIR=path.join(root,'.mpl-cache');environment.CUDA_VISIBLE_DEVICES='';
  const tools=[];let traceTruncated=false;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./subscription-cli.mjs',import.meta.url)),job.provider,invocation.command,...invocation.args],{cwd:root,env:environment,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',pending='',dropping=false,settled=false;
    const append=line=>{stdout=(stdout+line+'\n').slice(-32768);};
    const line=value=>{try{const event=JSON.parse(value);tools.push(...observedTools(event));if(tools.length>64)tools.splice(0,tools.length-64);append(safeTrace(event));}catch{append(value.slice(0,2000).replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[image bytes omitted]'));}};
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const stop=()=>child.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
    child.stdout.on('data',chunk=>{
      for(const part of String(chunk).split(/(?<=\n)/)) {
        if(!dropping)pending+=part;
        if(pending.length>262144){pending='';dropping=true;traceTruncated=true;}
        if(part.endsWith('\n')){if(!dropping)line(pending.trim());pending='';dropping=false;}
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-32768);});
    const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2500).unref();finish(new Error('Figure job timed out'));},570000);
    child.on('error',finish);
    child.on('exit',async code=>{
      process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
      try{
        if(pending&&!dropping)line(pending);
        await fs.writeFile(path.join(root,'cli-output.txt'),redactSecrets(stdout+'\n'+stderr,config),{mode:0o600});
        if(invocation.capturesStdout)await fs.writeFile(outputPath,stdout,{mode:0o600});
        finish(code===0?null:new Error('Subscription figure CLI failed: '+redactSecrets(stderr.slice(-1500),config)));
      }catch(error){finish(error);}
    });
    child.stdin.on('error',()=>{});child.stdin.end(invocation.input);
  });
  return {provider:job.provider,model:job.model,reasoning_effort:reasoningEffort,
    model_resolution:'CLI requested model; aliases resolved by official CLI',tools_policy:job.tools_policy,
    global_skill_routing:globalPaths,native_image_feature:nativeImage,observed_tools:tools,trace_truncated:traceTruncated,
    browser_runtime_roots:runtimeRoots,
    image_generation_observed:tools.some(tool=>tool.image_generation),
    image_model_resolution:'Selected by actual tool; not guaranteed fixed Image2. Unreported image model remains unknown.'};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const chunks=[];let length=0;for await(const chunk of process.stdin){length+=chunk.length;if(length>2*1024*1024)throw new Error('Task input too large');chunks.push(chunk);}
    process.stdout.write(JSON.stringify(await runTask(JSON.parse(Buffer.concat(chunks))))+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
