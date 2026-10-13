// Real authenticated paper: persistent quality caches, rapid toggles and chapter isolation.
async page=>{
 const checks=[],timings=[];let posts=0,writes=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 await page.route('**/papers/*/**',route=>{
  const r=route.request();
  if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
  if(r.url().endsWith('/hub/translate')&&r.postDataJSON().engine==='ai'){posts++;return route.continue();}
  writes++;return route.abort();
 });
 try{
  const original=page.getByRole('button',{name:'英文原文',exact:true}),chinese=page.getByRole('button',{name:'中文阅读',exact:true});
  await page.getByLabel('翻译方式').selectOption('ai');
  check(await page.getByLabel('翻译方式').inputValue()==='ai','precise translation is the default');
  for(const path of ['_paper/sections/01_introduction.tex','_paper/sections/04_discussion.tex','_paper/sections/05_conclusions.tex']){
   await original.click();await page.locator('#document-select').selectOption(path);
   await page.waitForFunction(path=>window.paperHubTranslationSnapshot().path===path,path);
   const source=await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts));await chinese.click();
   const index=await page.evaluate(()=>window.paperHubTranslationSnapshot().texts.findIndex(t=>t.length>200));
   const panel=page.locator('#hub-translation-view .hub-paragraph-tools').nth(index);
   if(!await panel.locator('.hub-paragraph-value').isVisible())await panel.locator('.hub-paragraph-translate').click();
   await page.waitForFunction(index=>document.querySelectorAll('#hub-translation-view .hub-paragraph-value')[index]?.textContent.length>0,index,{timeout:180000});
   const translated=await page.locator('#hub-translation-view').innerText();
   check(/[\u4e00-\u9fff]/.test(translated),'Chinese text produced for '+path);
   check(!/水泥债券|8个建筑|反复出现的模型|邮政包络/.test(translated),'known mistranslations absent for '+path);
   const count=posts;
   for(let i=0;i<5;i++){
    await original.click();const at=Date.now();await chinese.click();
    await page.waitForFunction(()=>document.querySelector('.hub-translation-status').textContent.includes('中文辅助阅读'));
    timings.push({path,cycle:i,ms:Date.now()-at});
   }
   check(posts===count,'five repeat switches do not submit another job for '+path);
   await page.getByRole('button',{name:'中英对照',exact:true}).click();
   check(await page.locator('.hub-translation-original').count()>0,'bilingual original paragraphs retained for '+path);
   await original.click();check(await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts))===source,'original text unchanged for '+path);
  }
  const before=posts;await page.reload();await page.locator('#editor .editor-block').first().waitFor();await chinese.click();
  await page.waitForFunction(()=>document.querySelector('.hub-translation-status').textContent.includes('中文辅助阅读'));
  check(posts===before,'refresh uses browser cache without a translation POST');
  check(writes===0,'no source/model/archive writes');
  await original.click();return {checks,timings,translationPosts:posts,otherWrites:writes,sourceIntact:true};
 }finally{await page.unroute('**/papers/*/**');}
}
