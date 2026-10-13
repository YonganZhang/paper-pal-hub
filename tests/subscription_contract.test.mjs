import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionEnvironment,signedIn} from '../subscription-cli.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import path from 'node:path';
test('subscription environment removes API/token/cloud overrides without changing HOME',()=>{
  const env=subscriptionEnvironment({HOME:'/same-user',ANTHROPIC_API_KEY:'fake',OPENAI_API_KEY:'fake',ANTHROPIC_AUTH_TOKEN:'fake',CLAUDE_CODE_OAUTH_TOKEN:'fake',CLAUDE_CODE_USE_VERTEX:'1',ANTHROPIC_BASE_URL:'fake',PATH:'/same-path'});
  assert.deepEqual(env,{HOME:'/same-user',PATH:'/same-path'});
});
test('each preflight reads the current login and rejects API auth',()=>{
  mkdirSync(path.join(process.cwd(),'_tmp'),{recursive:true});
  const root=mkdtempSync(path.join(process.cwd(),'_tmp/subscription-'));
  try {
    const command=path.join(root,'fake-cli'),state=path.join(root,'state.json');
    writeFileSync(command,`#!/usr/bin/env node\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(state)},'utf8'));`);chmodSync(command,0o755);
    for(const account of ['A','B']){writeFileSync(state,JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',account}));assert.equal(signedIn('claude',command,process.env),true);}
    writeFileSync(state,JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}));assert.equal(signedIn('claude',command,process.env),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
