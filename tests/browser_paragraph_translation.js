// Own local fixture, no model calls: paragraph scope, refresh, edits and late replies.
async page=>{
 const origin='http://127.0.0.1:4413';
 const script=await(await page.request.get(origin+'/translation.js')).text();
 const checks=[],posts=[];let revision='paragraph-v1';
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 const fixture='<!doctype html><meta charset=utf-8><header class="topbar"></header><div class="editor-pane"><div id="structure-workspace" hidden></div><div id="editor"><section class="editor-block has-proposal" data-block-id="a"><span class="review-number">99</span><span class="proposal-delete">Deleted wrong text</span><span class="source-prose proposal-add">Source A 1.0</span></section><section class="editor-block" data-block-id="b">Source B 2.0</section></div></div><script src="/translation.js"></script>';
 await page.route(origin+'/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/translation.js'))return route.fulfill({contentType:'text/javascript',body:script});
  if(url.endsWith('/hub/translation-config'))return route.fulfill({json:{default_engine:'ai',revisions:{ai:revision,offline:'offline-'+revision}}});
  if(url.endsWith('/hub/translate')){
   const body=route.request().postDataJSON();posts.push(body);const serial=posts.length;
   if(body.texts[0].includes('Slow'))await page.waitForTimeout(800);
   else await page.waitForTimeout(120);
   return route.fulfill({json:{status:'done',completed:1,total:1,translations:[(body.engine==='ai'?'精翻':'机翻')+' '+body.texts[0]+' #'+serial]}});
  }
  return route.fulfill({contentType:'text/html',body:fixture});
 });
 try{
  await page.goto(origin+'/papers/paragraph-fixture/');
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.includes('/papers/paragraph-fixture'))localStorage.removeItem(key);});
  await page.reload();await page.locator('.hub-paragraph-tools').first().waitFor();
  check(await page.locator('#editor>.hub-paragraph-tools').count()===2,'each source paragraph has a separate translation control');
  check(posts.length===0,'loading never automatically translates a chapter');
  check(await page.getByLabel('翻译方式').inputValue()==='ai','initial mode is precise translation');
  check(await page.evaluate(()=>window.paperHubTranslationSnapshot().texts[0])==='Source A 1.0','revision marker and deleted sentence excluded');
  const first=page.locator('#editor>.hub-paragraph-tools').first();
  await first.locator('.hub-paragraph-translate').click();
  await first.locator('.hub-paragraph-value').filter({hasText:'精翻 Source A'}).waitFor();
  check(posts.length===1&&posts[0].texts.length===1&&posts[0].texts[0]==='Source A 1.0','single click submits only its paragraph');
  check(await first.getByText('待确认修改的中文预览',{exact:true}).count()===1,'candidate preview is labelled');
  await first.locator('.hub-paragraph-collapse').click();await first.locator('.hub-paragraph-translate').click();
  check(posts.length===1,'showing an existing translation makes no request');
  await first.locator('.hub-paragraph-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#editor>.hub-paragraph-tools .hub-paragraph-value').textContent.endsWith('#2'));
  check(posts.length===2&&posts[1].refresh===true,'refresh explicitly bypasses the old translation');
  await page.getByLabel('翻译方式').selectOption('offline');await page.waitForTimeout(150);
  check(posts.length===2,'changing engine does not start a model');
  await first.locator('.hub-paragraph-translate').click();
  await first.locator('.hub-paragraph-value').filter({hasText:'机翻 Source A'}).waitFor();
  check(posts.length===3&&posts[2].engine==='offline','next paragraph click uses the selected machine mode');
  await page.reload();await page.locator('.hub-paragraph-tools').first().waitFor();
  check(await page.getByLabel('翻译方式').inputValue()==='offline','engine choice survives refresh');
  await first.locator('.hub-paragraph-translate').click();
  await first.locator('.hub-paragraph-value').filter({hasText:'机翻 Source A'}).waitFor();
  check(posts.length===3,'paragraph translation survives refresh without a POST');
  await page.locator('#editor .source-prose').evaluate(el=>{el.textContent='Edited A 3.0';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('#editor>.hub-paragraph-tools').textContent.includes('原文已修改'));
  check(!(await first.innerText()).includes('机翻 Source A'),'editing immediately removes the old translation from that paragraph');
  await first.locator('.hub-paragraph-translate').click();
  await first.locator('.hub-paragraph-value').filter({hasText:'Edited A 3.0'}).waitFor();
  check(posts.length===4&&posts[3].texts[0]==='Edited A 3.0','edited source is translated independently');
  await page.locator('#editor .source-prose').evaluate(el=>el.textContent='Slow A 4.0');
  await page.waitForFunction(()=>document.querySelector('#editor>.hub-paragraph-tools .hub-paragraph-value').textContent==='');
  await first.locator('.hub-paragraph-translate').click();await page.waitForTimeout(80);
  await page.locator('#editor .source-prose').evaluate(el=>el.textContent='Newest A 5.0');
  await page.waitForTimeout(200);await first.locator('.hub-paragraph-translate').click();
  await first.locator('.hub-paragraph-value').filter({hasText:'Newest A 5.0'}).waitFor();await page.waitForTimeout(900);
  check(!(await first.innerText()).includes('精翻 Slow')&&!(await first.innerText()).includes('机翻 Slow'),'late reply cannot overwrite edited prose');
  const before=posts.length;await page.getByRole('button',{name:'中文阅读',exact:true}).click();await page.waitForTimeout(150);
  check(posts.length===before,'Chinese reading only changes view and never translates the chapter');
  check(await page.locator('#hub-translation-view .hub-paragraph-translate').count()===2,'Chinese reading also has independent paragraph buttons');
  await page.getByRole('button',{name:'中英对照',exact:true}).click();
  check(await page.locator('.hub-translation-original').count()===2,'bilingual reading preserves each source');
  revision='paragraph-v2';await page.reload();await page.locator('.hub-paragraph-tools').first().waitFor();
  await first.locator('.hub-paragraph-translate').click();await first.locator('.hub-paragraph-value').filter({hasText:'机翻 Source A'}).waitFor();
  check(posts.length===before+1,'new server revision invalidates old paragraph cache');
  check(await page.locator('#editor .review-number').innerText()==='99'&&await page.locator('#editor .proposal-delete').innerText()==='Deleted wrong text','translation controls never change original revision markup');
  return {checks,requests:posts.map(p=>({engine:p.engine,count:p.texts.length,refresh:!!p.refresh})),realModelCalls:0};
 }finally{await page.unroute(origin+'/**');}
}
