// Formal paper read-only: translate caption text through a stub, preserve real PDF links.
async page=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.locator('#editor .kind-figure').first().waitFor();
  await page.locator('#editor .compiled-fallback a').first().waitFor();
  const source=await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts));
  const hrefs=await page.locator('#editor .compiled-fallback a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
  check(hrefs.length>0,'Open a chapter containing compiled figure links');
  await page.route('**/hub/translate',async route=>{
    const texts=route.request().postDataJSON().texts;
    await route.fulfill({json:{id:'reading-artifacts',status:'done',translations:texts.map(t=>'译文 '+t),total:texts.length,completed:texts.length}});
  });
  try{
    await page.getByRole('button',{name:'中文阅读',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.hub-translation-status').textContent.includes('中文辅助阅读'));
    const translated=await page.locator('#hub-translation-view a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
    check(hrefs.every(href=>translated.includes(href)),'Chinese view lost original figure PDF destinations');
    check(await page.locator('#hub-translation-view .hub-translation-media').count()>=hrefs.length,'Figures missing from Chinese reading');
    check(await page.locator('#hub-translation-view [contenteditable=true],#hub-translation-view .review-number').count()===0,'Editable source controls entered the translation');
    await page.getByRole('button',{name:'中英对照',exact:true}).click();
    const bilingual=await page.locator('#hub-translation-view .hub-translation-media a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
    check(hrefs.every(href=>bilingual.includes(href)),'Bilingual view lost figures');
    for(const width of [360,390,768,1440]){
      await page.setViewportSize({width,height:844});
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Translation caused page overflow');
    }
    await page.getByRole('button',{name:'英文原文',exact:true}).click();
    check(await page.evaluate(()=>JSON.stringify(window.paperHubTranslationSnapshot().texts))===source,'Read-only translation altered the manuscript');
    return {figurePdfLinks:hrefs.length,chineseAndBilingualKeepDestinations:true,figureControlsChinese:true,noSourceEditControls:true,sourceIntact:true};
  }finally{await page.unroute('**/hub/translate');await page.setViewportSize({width:390,height:844});await page.reload();}
}
