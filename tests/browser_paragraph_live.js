// Authenticated paper, actual engines; only explicit single-paragraph translation writes.
async page=>{
 const checks=[],timings=[],payloads=[];let otherWrites=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 await page.route('**/papers/*/**',route=>{
  const r=route.request();if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
  if(r.url().endsWith('/hub/translate')){const p=r.postDataJSON();payloads.push(p);if(p.texts?.length===1)return route.continue();}
  otherWrites++;return route.abort();
 });
 try{
  await page.getByRole('button',{name:'英文原文',exact:true}).click();
  const source=await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts));
  const texts=JSON.parse(source),index=texts.findIndex(t=>t.length>300&&!/^Figure /.test(t));
  check(index>=0,'real prose paragraph selected');
  const panel=page.locator('#editor>.hub-paragraph-tools').nth(index);
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});await panel.scrollIntoViewIfNeeded();
   const box=await panel.locator('.hub-paragraph-translate').boundingBox();
   check(box&&box.x>=0&&box.x+box.width<=width+1,'paragraph button fits width '+width);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal page overflow '+width);
  }
  await page.setViewportSize({width:390,height:844});
  async function waitForTranslation(){await page.waitForFunction(index=>{const p=document.querySelectorAll('#editor>.hub-paragraph-tools')[index];return p?.querySelector('.hub-paragraph-value')?.textContent.length>0&&!p.querySelector('.hub-paragraph-refresh').disabled;},index,{timeout:180000});}
  for(const selected of ['ai','offline']){
   const before=payloads.length;await page.getByLabel('翻译方式').selectOption(selected);await page.waitForTimeout(180);
   check(payloads.length===before,'selecting '+selected+' never starts translation');
   const start=Date.now();await panel.locator('.hub-paragraph-translate').click();await waitForTranslation();
   timings.push({engine:selected,operation:'first-open-cache-unknown',ms:Date.now()-start});
   const at=Date.now();await panel.locator('.hub-paragraph-refresh').click();await waitForTranslation();
   timings.push({engine:selected,operation:'forced-new-generation',ms:Date.now()-at});
   const last=payloads.at(-1);check(last.engine===selected&&last.refresh===true&&last.texts.length===1,'refresh generates exactly one '+selected+' paragraph');
   const translated=await panel.locator('.hub-paragraph-value').innerText();
   check(/[\u4e00-\u9fff]/.test(translated),'actual '+selected+' output contains Chinese');
   check(!translated.includes('Deleted wrong text'),'no fixture text in production translation');
   await panel.locator('.hub-paragraph-collapse').click();const n=payloads.length,showAt=Date.now();await panel.locator('.hub-paragraph-translate').click();
   await panel.locator('.hub-paragraph-value').waitFor();timings.push({engine:selected,operation:'show-saved-paragraph',ms:Date.now()-showAt});
   check(payloads.length===n,'showing saved '+selected+' paragraph creates no request');
  }
  const beforeReload=payloads.length;await page.reload();await page.locator('#editor>.hub-paragraph-tools').first().waitFor();
  check(await page.getByLabel('翻译方式').inputValue()==='offline','real page remembers selected machine engine');
  await panel.locator('.hub-paragraph-translate').click();await waitForTranslation();
  check(payloads.length===beforeReload,'real page reuses paragraph after reload');
  await page.getByRole('button',{name:'中文阅读',exact:true}).click();
  check(payloads.length===beforeReload,'switching to Chinese reading does not translate a chapter');
  const sourceImages=await page.locator('#editor img.latex-figure-image').count();
  check(await page.locator('#hub-translation-view img.latex-figure-image').count()===sourceImages,'Chinese reading retains figures');
  await page.getByRole('button',{name:'英文原文',exact:true}).click();await panel.locator('.hub-paragraph-translate').click();
  await page.screenshot({path:'_tests/_artifacts/translation-quality/paragraph-phone-live.png'});
  check(await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts))===source,'all original paragraphs unchanged');
  check(otherWrites===0,'no manuscript/model/archive writes');
  await page.getByLabel('翻译方式').selectOption('ai');
  return {checks,timings,sourceImages,translationRequests:payloads.map(p=>({engine:p.engine,count:p.texts.length,refresh:!!p.refresh})),otherWrites};
 }finally{await page.unroute('**/papers/*/**');}
}
