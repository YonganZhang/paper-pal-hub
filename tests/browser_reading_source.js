// Real paper: template code is absent from all reading modes and translation input.
async page=>{
 const checks=[],requests=[];let otherWrites=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 const junk=/\\cs_|__short_title|\\sep\b|table_\d+_/;
 await page.route('**/papers/*/**',route=>{
  const r=route.request();if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
  if(r.url().endsWith('/hub/translate')){const body=r.postDataJSON();requests.push(body);if(body.texts.length===1&&!junk.test(body.texts[0]))return route.continue();}
  otherWrites++;return route.abort();
 });
 try{
  await page.getByLabel('翻译方式').selectOption('ai');
  await page.locator('#document-select').selectOption('_paper/main.tex');
  await page.waitForFunction(()=>window.paperHubTranslationSnapshot().path==='_paper/main.tex');
  check(!junk.test(await page.locator('#editor').innerText()),'original main text has no typesetter fields');
  const title=await page.locator('#editor .paper-title').innerText();
  check(title.includes('BondFusion-TCN')&&title.includes('fusion'),'actual manuscript title retained');
  const snapshot=await page.evaluate(()=>window.paperHubTranslationSnapshot());
  check(snapshot.texts[0]===title&&!snapshot.texts.some(s=>junk.test(s)),'translation input begins with the real title');
  check(snapshot.texts.some(s=>s.includes('96.1%')&&s.includes('37.7%')),'abstract numbers retained');
  check(snapshot.texts.some(s=>s.includes('Cement bond evaluation')&&s.includes(' · ')),'keywords use visible punctuation');
  const titlePanel=page.locator('#editor .paper-front>.hub-paragraph-tools');
  await titlePanel.locator('.hub-paragraph-translate').click();
  await page.waitForFunction(()=>document.querySelector('#editor .paper-front>.hub-paragraph-tools .hub-paragraph-value')?.textContent.length>0,{},{timeout:180000});
  await titlePanel.locator('.hub-paragraph-refresh').click();
  await page.waitForFunction(()=>!document.querySelector('#editor .paper-front>.hub-paragraph-tools .hub-paragraph-refresh')?.disabled,{},{timeout:180000});
  check(!junk.test(await titlePanel.locator('.hub-paragraph-value').innerText()),'real translated title has no internal commands');
  check(/[\u4e00-\u9fff]/.test(await titlePanel.locator('.hub-paragraph-value').innerText()),'actual title translated into Chinese');
  for(const name of ['中文阅读','中英对照','英文原文']){
   await page.getByRole('button',{name,exact:true}).click();
   const reading=page.locator(name==='英文原文'?'#editor':'#hub-translation-view');
   check(!junk.test(await reading.innerText()),'no template junk in '+name);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.editor-pane').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:'_tests/_artifacts/translation-quality/reading-source-phone.png'});
  for(const path of ['_paper/sections/02_data_methods.tex','_paper/sections/03_results.tex']){
   await page.locator('#document-select').selectOption(path);await page.waitForFunction(p=>window.paperHubTranslationSnapshot().path===p,path);
   check(!junk.test(await page.locator('#editor').innerText()),'no table file name in '+path);
   check(await page.locator('#editor .kind-table .compiled-fallback a').count()>=1,'unsupported external table has PDF access in '+path);
   check(!(await page.evaluate(()=>window.paperHubTranslationSnapshot().texts)).some(t=>junk.test(t)),'table identifiers never enter translation in '+path);
  }
  await page.waitForFunction(()=>document.querySelectorAll('#editor img.latex-figure-image').length===6,{},{timeout:15000});
  check(await page.locator('#editor img.latex-figure-image').count()===6,'all six Results figures retained');
  check(otherWrites===0,'no manuscript/model/archive writes');
  return {checks,translationRequests:requests.map(r=>({count:r.texts.length,engine:r.engine,refresh:!!r.refresh,clean:!junk.test(r.texts[0])})),otherWrites};
 }finally{await page.unroute('**/papers/*/**');}
}
