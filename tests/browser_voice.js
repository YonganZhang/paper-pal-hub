// Run through playwright-cli run-code after serving only paper-ai.js and
// paper-ai.css from an isolated localhost fixture on port 4379. Speech results
// are controlled browser events, not a claim about real microphone recognition.
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
  await page.addInitScript(()=>{
    const mode=localStorage.getItem('voice-mode');
    window.recognizers=[];
    if(mode==='none'){window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;return;}
    class ControlledRecognition {
      constructor(){this.starts=0;this.stops=0;this.aborts=0;window.recognizers.push(this);}
      start(){this.starts++;if(localStorage.getItem('voice-mode')==='throws')throw new Error('blocked');}
      stop(){this.stops++;}
      abort(){this.aborts++;}
    }
    window.SpeechRecognition=mode==='webkit' ? undefined : ControlledRecognition;
    window.webkitSpeechRecognition=mode==='webkit' ? ControlledRecognition : undefined;
    window.voiceResult=(results,resultIndex=0)=>{
      const current=window.recognizers.at(-1);
      current.onresult({resultIndex,results:results.map(({text,final=true})=>Object.assign([{transcript:text}],{isFinal:final}))});
    };
    window.chatSession=id=>window.dispatchEvent(new CustomEvent('paper-hub:chat',{detail:{id}}));
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/papers/voice/');
  await page.evaluate(()=>localStorage.clear());await page.reload();
  await page.evaluate(()=>window.chatSession('A'));
  const input=page.getByRole('textbox',{name:'草稿'});
  const voice=()=>page.getByRole('button',{name:/^(语音输入|结束录音)$/});
  await voice().click();
  check(await page.evaluate(()=>window.recognizers.at(-1).lang==='zh-CN'&&window.recognizers.at(-1).interimResults===false),'recognition uses Chinese and final-only configuration');
  await page.evaluate(()=>window.voiceResult([{text:'第一句'}]));
  check(await input.inputValue()==='第一句','final recognition enters draft');
  await page.evaluate(()=>window.voiceResult([{text:'第一句'},{text:'第二句'}],1));
  check(await input.inputValue()==='第一句\n第二句','cumulative results append only new final items');
  await page.evaluate(()=>window.voiceResult([{text:'第一句'},{text:'第二句'}],1));
  check(await input.inputValue()==='第一句\n第二句','repeated final result is ignored');
  await page.evaluate(()=>window.voiceResult([{text:'第一句'},{text:'第二句'},{text:'尚未确认',final:false}],2));
  check(!(await input.inputValue()).includes('尚未确认'),'interim result stays out of saved draft');
  await page.locator('#mobile-close').click();await page.waitForTimeout(30);
  check(await page.evaluate(()=>window.recognizers.at(-1).stops+window.recognizers.at(-1).aborts>0),'mobile drawer close stops microphone');
  const before=await input.inputValue();
  await page.evaluate(()=>window.voiceResult([{text:'迟到的结果'}]));
  check(await input.inputValue()===before,'late result after close is ignored');
  await page.evaluate(()=>document.body.dataset.mobilePanel='ai');
  await voice().click();
  await page.evaluate(()=>window.chatSession('B'));
  await page.evaluate(()=>window.voiceResult([{text:'A会话的迟到结果'}]));
  check(await input.inputValue()==='','switching sessions cannot contaminate destination draft');
  check(await page.evaluate(()=>window.recognizers.at(-1).stops+window.recognizers.at(-1).aborts>0),'switching sessions stops microphone');
  await input.fill('B草稿');await voice().click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('paper-hub:stage-message',{detail:{sessionId:'C',message:'选区讨论'}})));
  await page.evaluate(()=>window.voiceResult([{text:'B会话的迟到结果'}]));
  check(await input.inputValue()==='选区讨论','staged selection cancels previous recognition');
  await voice().click();
  await page.locator('#close-codex-chat').click();await page.waitForTimeout(30);
  check(await page.evaluate(()=>window.recognizers.at(-1).stops+window.recognizers.at(-1).aborts>0),'desktop close stops microphone');
  await page.reload();await page.evaluate(()=>window.chatSession('C'));
  check(await input.inputValue()==='选区讨论','voice-related draft persists through reload');
  await voice().click();await voice().click();
  await page.evaluate(()=>window.voiceResult([{text:'结束前的最后一句'}]));
  check((await input.inputValue()).endsWith('结束前的最后一句'),'manual finish preserves last final utterance');
  await page.evaluate(()=>window.recognizers.at(-1).onend());
  check(await voice().innerText()==='语音输入'&&!(await page.locator('.hub-ai-help').innerText()).includes('正在'),'natural end clears recording indicator');
  await voice().click();await page.evaluate(()=>{window.previousVoice=window.recognizers.at(-1);window.dispatchEvent(new Event('pagehide'));});
  check(await page.evaluate(()=>window.previousVoice.aborts>0),'pagehide cancels microphone');
  await voice().click();await page.evaluate(()=>window.previousVoice.onend());
  check(await voice().innerText()==='结束录音','old recording end cannot reset new recording');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
  check(await page.evaluate(()=>window.recognizers.at(-1).aborts>0),'backgrounding cancels microphone');
  await voice().click();await page.evaluate(()=>window.recognizers.at(-1).onerror({error:'not-allowed'}));
  check(await voice().innerText()==='语音输入','permission denial restores idle voice control');
  check((await page.locator('.hub-ai-help').innerText()).includes('手机键盘'),'permission denial offers keyboard fallback');
  await page.evaluate(()=>localStorage.setItem('voice-mode','throws'));await page.reload();
  await voice().click();check(await voice().innerText()==='语音输入','synchronous recognition failure restores idle control');
  await page.evaluate(()=>localStorage.setItem('voice-mode','webkit'));await page.reload();
  await voice().click();await page.evaluate(()=>window.voiceResult([{text:'WebKit兼容输入'}]));
  check((await input.inputValue()).endsWith('WebKit兼容输入'),'prefixed WebKit recognition is supported');
  await page.screenshot({path:'_tests/_artifacts/voice/mobile-voice-recording.png',fullPage:true});
  await page.evaluate(()=>localStorage.setItem('voice-mode','none'));await page.reload();
  check(await voice().count()===0,'missing browser speech API hides unsupported voice button');
  check((await page.locator('.hub-ai-help').innerText()).includes('手机键盘'),'missing speech API explains keyboard fallback');
  const widths=[];
  for(const width of [320,360,390,768]){
    await page.setViewportSize({width,height:844});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow at '+width);widths.push(width);
  }
  check(posts===0&&await page.evaluate(()=>window.sent===0),'voice and lifecycle changes never send messages');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'_tests/_artifacts/voice/mobile-voice-fallback.png',fullPage:true});
  if(errors.length)throw new Error(JSON.stringify({checks,errors,posts}));
  return {mode:'controlled SpeechRecognition events in Chromium',checks,widths,posts,realMicrophoneTested:false};
}
