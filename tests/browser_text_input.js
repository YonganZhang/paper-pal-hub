// Isolated text-only paper AI fixture; serve web assets on localhost:4379.
async page => {
  page.setDefaultTimeout(4000);page.setDefaultNavigationTimeout(10000);
  const origin='http://127.0.0.1:4379';
  const source=await (await page.request.get(origin+'/paper-ai.js')).text();
  const style=await (await page.request.get(origin+'/paper-ai.css')).text();
  const checks=[], errors=[];
  const check=(condition,name)=>{checks.push({name,passed:!!condition});if(!condition)errors.push(name);};
  let posts=0;
  page.on('request',r=>{if(r.method()==='POST')posts++;});
  await page.route(origin+'/**',async route=>{
    const path=route.request().url().slice(origin.length).split('?')[0];
    if(path==='/paper-ai.js')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:source});
    if(path==='/paper-ai.css')return route.fulfill({contentType:'text/css; charset=utf-8',body:style});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/paper-ai.css">
      <style>body{margin:0;font-family:sans-serif}#codex-chat{box-sizing:border-box;max-width:100%;padding:12px}.codex-chat-composer textarea{box-sizing:border-box;width:100%;min-height:90px}.codex-chat-composer-actions{display:flex;gap:8px}.text-button{min-height:44px}.hub-ai-help{overflow-wrap:anywhere}</style>
      <button id="mobile-close" onclick="document.body.dataset.mobilePanel=''">收起论文 AI</button>
      <section id="codex-chat" class="codex-chat"><header class="codex-chat-header">论文 AI<button id="close-codex-chat" onclick="document.querySelector('#codex-chat').hidden=true">关闭</button></header>
      <div class="codex-chat-context">当前论文</div><div class="codex-chat-composer"><textarea id="codex-chat-input" aria-label="草稿"></textarea><div class="codex-chat-composer-actions"><button id="send" onclick="window.sent=(window.sent||0)+1;fetch('/send',{method:'POST'})">发送</button></div></div></section>
      <script>document.body.dataset.mobilePanel='ai';window.sent=0;</script><script src="/paper-ai.js"></script>`});
  });
  await page.addInitScript(()=>{window.recognizers=0;window.SpeechRecognition=window.webkitSpeechRecognition=class{constructor(){window.recognizers++;throw new Error('Voice must stay disabled');}};window.chatSession=id=>window.dispatchEvent(new CustomEvent('paper-hub:chat',{detail:{id}}));});
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/papers/text-input/');
  await page.evaluate(()=>localStorage.clear());await page.reload();
  const input=page.getByRole('textbox',{name:'草稿'});
  await page.evaluate(()=>window.chatSession('A'));
  check(await page.getByRole('button',{name:/语音|录音/}).count()===0,'no microphone button');
  check(!(await page.locator('.hub-ai-help').innerText()).match(/语音|录音/),'no obsolete speech instructions');
  check(await page.evaluate(()=>window.recognizers===0),'speech API never instantiated');
  await input.fill('A未发送草稿');
  await page.evaluate(()=>document.querySelector('#codex-chat-input').addEventListener('keydown',event=>{if(event.key==='Enter')document.querySelector('#send').click();}));
  await input.press('Enter');
  check((await input.inputValue()).includes('\n'),'Enter inserts newline');
  check(posts===0,'Enter never sends');
  const a=await input.inputValue();
  await page.locator('#mobile-close').click();
  check(await input.inputValue()===a,'closing panel retains draft');
  await page.reload();await page.evaluate(()=>window.chatSession('A'));
  check(await input.inputValue()===a,'reload restores draft');
  await page.evaluate(()=>window.chatSession('B'));
  check(await input.inputValue()==='','new conversation has independent draft');
  await input.fill('B未发送草稿');await page.evaluate(()=>window.chatSession('A'));
  check(await input.inputValue()===a,'switching back restores correct draft');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('paper-hub:stage-message',{detail:{sessionId:'C',message:'选区讨论'}})));
  check(await input.inputValue()==='选区讨论','selection staging remains available');
  check(posts===0,'typing and staging never send');
  await page.locator('#send').click();await page.waitForFunction(()=>window.sent===1);
  check(posts===1,'explicit Send submits exactly once in isolated fixture');
  if(errors.length)throw new Error(JSON.stringify({checks,errors,posts}));
  return {checks,posts,syntheticSend:true,microphone:false};
}
