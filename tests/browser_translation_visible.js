// Authenticated production reading test: real CPU translation only; source writes blocked.
async page=>{
 const checks=[];const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 await page.locator('#editor .editor-block').first().waitFor({timeout:60000});
 const source=await page.locator('#editor').innerText();
 let translations=0,blockedWrites=0;
 await page.route('**/papers/*/**',route=>{
  const request=route.request();
  if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
  if(request.url().endsWith('/hub/translate')&&request.method()==='POST'&&request.postDataJSON().engine==='offline'){translations++;return route.continue();}
  blockedWrites++;return route.abort();
 });
 try{
  const chinese=page.getByRole('button',{name:'翻译成中文',exact:true});
  check(await page.locator('.topbar .hub-reading-toolbar').count()===1,'translation controls are in the persistent header');
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   await page.locator('.editor-pane').evaluate(pane=>pane.scrollTop=pane.scrollHeight);
   const box=await chinese.boundingBox();
   check(await chinese.isVisible()&&box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<844,'translation button visible after scroll at '+width);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow at '+width);
   const header=await page.locator('.topbar').boundingBox(),pane=await page.locator('.editor-pane').boundingBox();
   check(box.y+box.height<=header.y+header.height+1&&pane.y>=header.y+header.height-1,'header controls fit above reading pane at '+width);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.editor-pane').evaluate(pane=>pane.scrollTop=0);
  const structure=page.locator('#show-structure-workspace');
  if(await structure.isVisible()){
   await structure.click();
   check(await chinese.isVisible(),'translation stays visible in structure view');
  }
  const began=Date.now();await chinese.click();
  await page.waitForFunction(()=>document.querySelector('.hub-translation-status').textContent.includes('中文辅助阅读'),{},{timeout:180000});
  check(await page.locator('#hub-translation-view').isVisible(),'click opens translated reading view');
  check(await page.locator('#structure-workspace').isHidden(),'translation leaves structure view');
  check(/[\u4e00-\u9fff]/.test(await page.locator('#hub-translation-view').innerText()),'actual machine translation contains Chinese');
  check(await page.locator('#hub-translation-view [contenteditable=true]').count()===0,'translation cannot overwrite editable source');
  const translatedMs=Date.now()-began,firstRequests=translations;
  await page.locator('.hub-mobile-nav [data-panel=ai]').click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('paper-hub:figures-rendered')));
  await page.waitForTimeout(700);
  check(await page.evaluate(()=>document.body.dataset.mobilePanel==='ai'),'background translation refresh preserves open AI panel');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  check(await page.evaluate(()=>!document.body.dataset.mobilePanel),'explicit language click returns from AI to reading');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  check(await page.locator('#editor').innerText()===source,'switching to English preserves source');
  await chinese.click();
  check(translations===firstRequests,'cached Chinese switch makes no new translation request');
  await page.getByRole('button',{name:'中英对照',exact:true}).click();
  check(await page.locator('.hub-translation-original').count()>0,'bilingual view displays original paragraphs');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  check(await page.locator('#editor').innerText()===source,'source is unchanged after all switches');
  check(blockedWrites===0,'no manuscript/model/archive writes attempted');
  await page.locator('.editor-pane').evaluate(pane=>pane.scrollTop=0);
  await page.screenshot({path:'_tests/_artifacts/translation-visible-mobile.png'});
  return {checks,engine:'offline-cpu',translatedMs,translationRequests:translations,blockedWrites,sourceIntact:true};
 }finally{await page.unroute('**/papers/*/**');}
}
