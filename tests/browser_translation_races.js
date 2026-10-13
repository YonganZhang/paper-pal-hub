// Local controlled editor: exercise delayed results, view/engine identity and reload caches.
async page=>{
 const origin='http://127.0.0.1:4413',script=await(await page.request.get(origin+'/translation.js')).text();
 let posts=0,revision='revision-one';const checks=[];
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 const fixture='<!doctype html><meta charset=utf-8><header class="topbar"></header><select id="document-select"><option value="a">A</option><option value="b">B</option></select><div class="editor-pane"><div id="structure-workspace" hidden></div><div id="editor"><section class="editor-block has-proposal"><span class="review-number">99</span><span class="proposal-delete">Old broken sentence</span><span class="proposal-add">Source A 1.0</span><figcaption><code>fig:fixture</code></figcaption></section></div></div><button id="show-text-workspace">正文</button><script>document.querySelector("#show-text-workspace").onclick=()=>document.querySelector("#structure-workspace").hidden=true;</script><script src="/translation.js"></script>';
 await page.route(origin+'/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/translation.js'))return route.fulfill({contentType:'text/javascript',body:script});
  if(url.endsWith('/hub/translation-config'))return route.fulfill({json:{default_engine:'ai',revisions:{ai:revision,offline:'offline-'+revision}}});
  if(url.endsWith('/hub/translate')){
   posts++;const body=route.request().postDataJSON(),text=body.texts[0];
   if(body.engine==='ai'&&text.includes('A'))await page.waitForTimeout(650);
   return route.fulfill({json:{status:'done',completed:1,total:1,translations:[(body.engine==='ai'?'精译':'草译')+' '+text]}});
  }
  return route.fulfill({contentType:'text/html',body:fixture});
 });
 await page.goto(origin+'/papers/fixture/');
 await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('paper-hub.translation-v3./papers/fixture')||key==='paper-hub.translation-enabled./papers/fixture')localStorage.removeItem(key);});
 await page.reload();posts=0;const sourceOriginal=await page.locator('#editor').innerText();
 const chinese=page.getByRole('button',{name:'翻译成中文',exact:true});
 check(!(await page.evaluate(()=>window.paperHubTranslationSnapshot().texts.join(' '))).includes('fig:fixture'),'technical figure label is excluded from translation');
 check(await page.evaluate(()=>window.paperHubTranslationSnapshot().texts[0])==='Source A 1.0','revision preview excludes deleted text and review number');
 check(await page.getByLabel('翻译方式').inputValue()==='ai','precise translation is the default');
 await chinese.click();await chinese.click();
 check(await page.getByText('待确认修改的中文预览',{exact:true}).count()===1,'pending candidate translation is explicitly labelled');
 await page.waitForTimeout(80);check(posts===1,'double click coalesces the same request');
 await page.evaluate(()=>{document.querySelector('#editor').innerHTML='<section class="editor-block">Source B 2.0</section>';document.querySelector('#document-select').value='b';window.dispatchEvent(new CustomEvent('paper-hub:document',{detail:{path:'b'}}));});
 await page.waitForFunction(()=>document.querySelector('#hub-translation-view').textContent.includes('精译 Source B'));
 await page.waitForTimeout(750);
 check((await page.locator('#hub-translation-view').innerText()).includes('Source B')&&!(await page.locator('#hub-translation-view').innerText()).includes('Source A'),'late A cannot overwrite B');
 const before=posts;
 await page.evaluate(()=>{document.querySelector('.editor-block').insertAdjacentHTML('afterbegin','<div class="latex-figure-image"><img alt="plot" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></div>');window.dispatchEvent(new CustomEvent('paper-hub:figures-rendered'));});
 check(posts===before,'image-only changes do not request another translation');
 check(await page.locator('#hub-translation-view img').count()===1,'image refresh retains cached translation and visual');
 await page.evaluate(()=>{document.querySelector('#editor').innerHTML='<section class="editor-block">Source A 1.0</section>';window.dispatchEvent(new CustomEvent('paper-hub:document',{detail:{path:'a'}}));});
 await page.waitForFunction(()=>document.querySelector('#hub-translation-view').textContent.includes('精译 Source A'));
 check(posts===before,'finished background A is reused on return');
 await page.getByLabel('翻译方式').selectOption('offline');
 await page.waitForFunction(()=>document.querySelector('#hub-translation-view').textContent.includes('草译 Source A'));
 check((await page.locator('#hub-translation-view').innerText()).includes('草译'),'engine switch has a separate cache');
 const beforeReload=posts;
 await page.reload();await chinese.click();
 await page.waitForFunction(()=>document.querySelector('#hub-translation-view').textContent.includes('精译 Source A'));
 check(posts===beforeReload,'reload reuses the private browser cache');
 revision='revision-two';await page.reload();await chinese.click();
 await page.waitForFunction(()=>document.querySelector('.hub-translation-status').textContent.includes('中文辅助阅读'));
 check(posts===beforeReload+1,'new server revision invalidates old local translation');
 await page.getByRole('button',{name:'英文原文',exact:true}).click();
 check(await page.locator('#editor').innerText()===sourceOriginal,'source survives all switches');
 await page.unroute(origin+'/**');return {checks,posts,realModelCalls:0};
}
