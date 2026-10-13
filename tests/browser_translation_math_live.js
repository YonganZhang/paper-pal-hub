// Production paper checks. Only two explicit single-paragraph translations may write.
async page=>{
 const checks=[],posts=[];let candidate=null,blocked=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 await page.route('**/papers/bondfusion/**',async route=>{
  const request=route.request();if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
  if(request.url().endsWith('/hub/translate')){const body=request.postDataJSON();if(body.texts.length===1){posts.push(body);return route.continue();}}
  if(request.url().endsWith('/api/rewrite'))candidate=request.postDataJSON();
  blocked++;return route.fulfill({status:400,json:{error:'QA read-only check: source writes blocked'}});
 });
 try{
  await page.reload();await page.locator('#document-select option').first().waitFor({state:'attached'});
  await page.locator('#document-select').selectOption('_paper/sections/03_results.tex');
  await page.waitForFunction(()=>window.paperHubTranslationSnapshot().path==='_paper/sections/03_results.tex');
  await page.waitForFunction(()=>document.querySelectorAll('#editor img.latex-figure-image').length===6);
  await page.waitForFunction(()=>[...document.querySelectorAll('#editor .kind-figure .structure-caption-text')].some(el=>el.querySelector('.katex')));
  const before=await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts));
  check((await page.evaluate(()=>window.paperHubTranslationSnapshot().texts)).some(t=>t.includes('\\(\\pm\\)')),'real figure caption exposes protected inline math to translation');
  await page.setViewportSize({width:1280,height:900});
  const selected=await page.evaluate(()=>{
   const caption=[...document.querySelectorAll('#editor .structure-caption-text')].find(el=>el.querySelector('.katex')&&el.textContent.includes('standard deviation'));
   const node=[...caption.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.includes('standard deviation'));
   const offset=node.textContent.indexOf('standard deviation');caption.scrollIntoView({block:'center'});
   const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+'standard deviation'.length);
   const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
   return range.toString();
  });
  await page.locator('#comment-selection').click();await page.locator('#comment-input').fill('只检查选句定位，不生成修改。');await page.locator('#submit-comment').click();
  await page.waitForTimeout(300);
  check(candidate?.selectedText===selected,'selecting text after a typeset formula maps to the correct source');
  await page.locator('#cancel-comment').click();
  await page.waitForFunction(()=>document.querySelectorAll('#editor img.latex-figure-image').length===6);
  check(blocked===1,'candidate write was intercepted; no manuscript edit was sent');
  for(const engine of ['ai','offline']){
   await page.getByLabel('翻译方式').selectOption(engine);
   const block=page.locator('#editor .editor-block').filter({has:page.locator('.structure-caption-text .katex')}).last();
   const panel=block.locator('xpath=following-sibling::aside[1]');
   if(!await panel.locator('.hub-paragraph-value').isVisible())await panel.locator('.hub-paragraph-translate').click();
   await panel.locator('.hub-paragraph-value .katex').waitFor({timeout:180000});
   check(await panel.locator('.hub-paragraph-value .katex').count()===1,engine+' translation preserves the rendered formula');
   check(/标准(?:差|偏差)/.test(await panel.locator('.hub-paragraph-value').innerText()),engine+' real translated caption contains Chinese prose');
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'中英对照',exact:true}).click();
  await page.locator('#hub-translation-view .hub-paragraph-value .katex').last().scrollIntoViewIfNeeded();
  check(await page.locator('#hub-translation-view .hub-paragraph-value .katex').count()>=1,'phone bilingual reading keeps translated formulas');
  await page.waitForFunction(()=>document.querySelectorAll('#hub-translation-view img.latex-figure-image').length===6);
  check(await page.locator('#hub-translation-view img.latex-figure-image').count()===6,'phone bilingual reading keeps all six figures after opening and closing a comment');
  await page.screenshot({path:'_tests/_artifacts/translation-review/phone-math.png'});
  check(await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts))===before,'source text is unchanged after selection and translation');
  await page.getByLabel('翻译方式').selectOption('ai');
  return {checks,translationRequests:posts.map(p=>({engine:p.engine,count:p.texts.length,refresh:!!p.refresh})),blockedCandidateWrites:blocked,sourceWrites:0};
 }finally{await page.unroute('**/papers/bondfusion/**');}
}
