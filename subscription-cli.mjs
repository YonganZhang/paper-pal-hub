#!/usr/bin/env node
// Delegate to the official CLI's current login. Never read/copy its token store.
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function subscriptionEnvironment(source) {
  const env={...source};
  for(const key of Object.keys(env)) if(
    /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key) ||
    /^(?:ANTHROPIC_BASE_URL|OPENAI_BASE_URL|OPENAI_API_BASE|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(key)
  ) delete env[key];
  return env;
}
export function signedIn(provider,command,env) {
  const args=provider==='codex'?['login','status']:['auth','status'];
  const r=spawnSync(command,args,{env,encoding:'utf8',timeout:10000,maxBuffer:128000});
  if(r.status!==0)return false;
  if(provider==='codex')return /logged in using ChatGPT/i.test(r.stdout+r.stderr);
  try {const s=JSON.parse(r.stdout);return s.loggedIn===true&&s.authMethod==='claude.ai'&&s.apiProvider==='firstParty';}catch{return false;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [provider,command,...args]=process.argv.slice(2),env=subscriptionEnvironment(process.env);
  if(!['codex','claude'].includes(provider)||!command||!signedIn(provider,command,env)){
    process.stderr.write('订阅登录未就绪，请在服务器上重新登录对应的 Codex / Claude；不会改用 API。\n');process.exit(1);
  }
  const child=spawn(command,args,{env,stdio:'inherit'});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
  child.on('error',()=>{process.stderr.write('论文 AI 客户端启动失败。\n');process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
