// Isolated mobile reader fixture: math, media-only blocks and recoverable config errors.
async page=>{
 const origin='http://127.0.0.1:4413',script=await(await page.request.get(origin+'/translation.js')).text();
 const checks=[],posts=[];let unavailable=true;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 const math=String.raw`\operatorname{F1}=\frac{2PR}{P+R}`;
 const fixture='<!doctype html><meta charset=utf-8><header class="topbar"></header><div class="editor-pane"><div id="editor"><section class="editor-block"><em>The metric</em> <span class="katex"><span class="katex-html">F1 = 2PR / (P+R)</span><annotation>'+math+'</annotation></span> is reported.</section><section class="editor-block kind-equation"><div class="display-formula">Displayed formula</div></section><section class="editor-block kind-table"><div class="latex-table-wrap"><table><tr><td>27</td></tr></table></div></section></div></div><script src="/translation.js"></script>';
 await page.route(origin+'/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/translation.js'))return route.fulfill({contentType:'text/javascript',body:script});
  if(url.endsWith('/hub/translation-config'))return unavailable?route.fulfill({status:503,json:{error:'fixture failure'}}):route.fulfill({json:{revisions:{ai:'semantics-ai',offline:'semantics-machine'}}});
  if(url.endsWith('/hub/translate')){const body=route.request().postDataJSON();posts.push(body);return route.fulfill({json:{status:'done',translations:[body.texts[0].replace('The metric','指标').replace('is reported.','已报告。')+' <img src=x onerror=alert(1)>']}});}
  return route.fulfill({contentType:'text/html',body:fixture});
 });
 try{
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/papers/semantics-fixture/');
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.includes('/papers/semantics-fixture'))localStorage.removeItem(key);});
  await page.reload();await page.getByRole('button',{name:'中文阅读',exact:true}).click();
  check(await page.locator('#hub-translation-view .katex').count()===1,'untranslated preview preserves rendered inline math');
  check(await page.locator('#hub-translation-view .hub-translation-original em').count()===1,'untranslated preview preserves emphasis');
  check(await page.locator('#hub-translation-view table').count()===1&&await page.locator('#hub-translation-view .display-formula').count()===1,'media-only table and equation remain visible');
  check(await page.locator('#hub-translation-view .hub-paragraph-translate').count()===1,'media-only blocks have no pointless translation buttons');
  check((await page.evaluate(()=>window.paperHubTranslationSnapshot().texts)).length===1,'no shared media placeholder enters translation input');
  const panel=page.locator('#hub-translation-view .hub-paragraph-tools');
  await panel.locator('.hub-paragraph-translate').click();
  await page.waitForFunction(()=>!document.querySelector('#hub-translation-view .hub-paragraph-status').hidden&&document.querySelector('#hub-translation-view .hub-paragraph-status').textContent.includes('失败'));
  check(await panel.locator('.hub-paragraph-status').isVisible(),'config failure is visible in Chinese reading');
  check(posts.length===0,'config failure never starts a model');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  check(await page.locator('#editor>.hub-paragraph-tools .hub-paragraph-status').isVisible(),'config failure is also visible beside original');
  unavailable=false;await page.getByRole('button',{name:'中文阅读',exact:true}).click();
  await panel.locator('.hub-paragraph-translate').click();
  await page.waitForFunction(()=>document.querySelector('#hub-translation-view .hub-paragraph-value').textContent.includes('指标'));
  check(posts.length===1&&posts[0].texts.length===1&&posts[0].texts[0].includes('\\('+math+'\\)'),'retry recovers and sends one paragraph with protected math');
  check(await panel.locator('.hub-paragraph-value .katex').count()===1,'translated math reuses trusted rendered formula');
  check(await panel.locator('.hub-paragraph-value img').count()===0,'translation markup is displayed as text, never executed');
  check(!(await panel.locator('.hub-paragraph-status').innerText()).includes('失败'),'successful retry clears stale failure');
  await page.getByRole('button',{name:'中英对照',exact:true}).click();
  check(await page.locator('#hub-translation-view .katex').count()===2,'bilingual view preserves original and translated math');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  check(await page.locator('#editor .editor-block .katex').count()===1&&await page.locator('#editor .editor-block em').innerText()==='The metric','original source markup is unchanged');
  check(posts.length===1,'view changes do not generate extra translations');
  return {checks,requests:posts.length,realModelCalls:0};
 }finally{await page.unroute(origin+'/**');}
}
