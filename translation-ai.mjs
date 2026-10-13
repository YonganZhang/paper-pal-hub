// Reuse Paper Pal's open-source Codex provider, not a second agent runtime.
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
delete process.env.TINYFISH_API_KEY;
const {buildAgentInvocation,childEnvironment,redactSecrets}=await import(pathToFileURL(path.join(process.env.PAPER_PAL_DIR || path.join(homedir(),'.local/share/paper-pal'),'agent-providers.mjs')));
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const {texts,glossary}=JSON.parse(Buffer.concat(chunks));
const root=await fs.mkdtemp(path.join(tmpdir(),'paper-translation-'));
let active;
process.on('SIGTERM',()=>{if(active&&!active.killed)active.kill('SIGTERM');});
try {
  const schema=path.join(root,'schema.json');
  const config={codex:{command:path.join(homedir(),'.npm-global/bin/codex'),model:'gpt-5.6-luna'}};
  for(let start=0;start<texts.length;start+=10){
    const batch=texts.slice(start,start+10),outputPath=path.join(root,'answer.json');
    const paragraphs=Object.fromEntries(batch.map((text,index)=>['p'+index,text]));
    await fs.writeFile(schema,JSON.stringify({type:'object',properties:Object.fromEntries(Object.keys(paragraphs).map(key=>[key,{type:'string'}])),required:Object.keys(paragraphs),additionalProperties:false}));
    const prompt='Translate the supplied English academic paragraphs into precise, natural Simplified Chinese. This is a fully specified, isolated translation task. Do not use tools or inspect files. Preserve every number, percentage, sign, citation, named model, LaTeX/math fragment, and named category label exactly. Do not add explanations or change scientific claims. Follow the supplied project glossary, applying each source term in its scientific context, including hyphenated variants. Return a JSON object with exactly the SAME KEYS as paragraphs (p0, p1, ...). Every value must be the complete translation of that key, including short titles.\n'+JSON.stringify({glossary,paragraphs});
    const invocation=await buildAgentInvocation({provider:'codex',config,prompt,outputPath,repoRoot:root,model:'gpt-5.6-luna',reasoningEffort:'low',schemaPath:schema});
    // Fully supplied one-shot translation, deliberately separate from the project's Paper AI workspace.
    invocation.args.splice(1,0,'--config','project_doc_max_bytes=0');
    await new Promise((resolve,reject)=>{
      let errors='';
      active=spawn(process.execPath,[fileURLToPath(new URL('./subscription-cli.mjs',import.meta.url)),'codex',invocation.command,...invocation.args],{cwd:root,env:childEnvironment({provider:'codex',config}),stdio:['pipe','ignore','pipe']});
      active.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-3000);});
      const timer=setTimeout(()=>{active.kill('SIGTERM');reject(new Error('Translation timed out'));},150000);
      active.on('error',error=>{clearTimeout(timer);reject(error);});
      active.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Translation provider failed: '+redactSecrets(errors,config)));});
      active.stdin.on('error',()=>{});active.stdin.end(invocation.input);
    });
    const result=JSON.parse(await fs.readFile(outputPath,'utf8'));
    if(Object.keys(result).length!==batch.length||Object.keys(paragraphs).some(key=>typeof result[key]!=='string'||!result[key].trim()))throw new Error('Translation count mismatch');
    for(let index=0;index<batch.length;index++)console.log(JSON.stringify({index:start+index,text:result['p'+index]}));
  }
} finally {await fs.rm(root,{recursive:true,force:true});}
