// Isolated fixture: serve current web assets plus pinned upstream base.css on localhost:4379.
async page=>{
  page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);
  const origin='http://127.0.0.1:4379',assets={};
  for(const name of ['base.css','mobile.css','versions.css','figure-studio.css','figure-inline.js'])assets[name]=await(await page.request.get(origin+'/'+name)).text();
  let revision='1',failed=false;const checks=[];const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(JSON.stringify(checks));};
  await page.route(origin+'/**',async route=>{
    const path=route.request().url().slice(origin.length).split('?')[0],name=path.slice(1);
    if(assets[name])return route.fulfill({contentType:name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:assets[name]});
    if(path.endsWith('/hub/figures'))return route.fulfill({json:{figures:[{path:'good.pdf',sha256:revision,title:'真实预览',asset_url:'/assets/good.pdf',preview_url:failed?'/preview/bad.svg?x=1':'/preview/good.svg?x=1'},{path:'bad.pdf',sha256:'bad',title:'失败预览',asset_url:'/assets/bad.pdf',preview_url:'/preview/bad.svg?x=1'}]}});
    if(path==='/preview/good.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#a8c8af"/></svg>'});
    if(path==='/preview/bad.svg')return route.fulfill({status:404,body:'missing'});
    if(path!='/papers/visual/')return route.fulfill({status:404,body:'missing'});
    const figure=(id,file)=>`<section id="${id}" class="kind-figure editor-block"><div class="compiled-fallback"><div><strong>请在 PDF 中查看原图</strong><span>完整图表保留在编译后的 PDF</span></div><a href="/api/pdf#page=1">查看 PDF 第 1 页</a></div><figcaption>图 ${id}</figcaption></section>`;
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/mobile.css"><link rel="stylesheet" href="/versions.css"><link rel="stylesheet" href="/figure-studio.css"><div class="app-shell"><header class="topbar"><div class="brand"><svg class="brand-mark"></svg><span class="brand-copy"><strong>论文共改</strong><small>阅读</small></span></div><div class="paper-identity"><label class="source-picker"><select><option>结果</option></select></label></div><div class="top-actions"><button id="save-button" class="button button-status is-saved">已保存</button><button id="compile-button" class="button button-ghost">编译</button><button id="preview-button" class="button button-ghost">PDF</button><button>版本存档</button><button>论文图片</button></div></header><main class="workspace"><article class="editor-pane"><div id="editor" class="editor">${figure('good','good.pdf')}${figure('bad','bad.pdf')}${figure('unregistered','other.pdf')}</div></article></main></div><script>for(const [id,file]of[['good','good.pdf'],['bad','bad.pdf'],['unregistered','other.pdf']])document.getElementById(id).reviewBlock={raw:'{'+file+'}'};</script><script src="/figure-inline.js"></script>`});
  });
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/papers/visual/');
  await page.waitForFunction(()=>document.querySelector('#good img')?.naturalWidth>0);
  check(await page.locator('#good .compiled-fallback strong').isHidden(),'successful preview hides obsolete fallback copy');
  check(await page.locator('#good .compiled-fallback a').isVisible(),'successful preview preserves PDF entrance');
  await page.locator('#bad').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('#bad img')?.hidden);
  check(await page.locator('#bad .compiled-fallback strong').isVisible(),'failed preview retains original fallback');
  check(await page.locator('#bad .compiled-fallback a').isVisible(),'failed preview preserves PDF entrance');
  await page.locator('#unregistered').scrollIntoViewIfNeeded();
  check(await page.locator('#unregistered .compiled-fallback strong').isVisible(),'unregistered figure retains fallback');
  for(const width of [320,360,390]){
    await page.setViewportSize({width,height:844});
    check(await page.locator('.brand-copy').isHidden(),'brand copy cannot stack at '+width);
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.top-actions button')].every(b=>b.getBoundingClientRect().right<=innerWidth+1)),'header actions fit '+width);
  }
  await page.locator('#good').scrollIntoViewIfNeeded();await page.screenshot({path:'_tests/_artifacts/voice/mobile-visual-fixed.png',fullPage:true});
  failed=true;revision='2';await page.evaluate(()=>window.dispatchEvent(new Event('paper-hub:figure-accepted')));
  await page.waitForFunction(()=>document.querySelector('#good img')?.hidden);
  check(await page.locator('#good .compiled-fallback strong').isVisible(),'failed replacement restores previously hidden fallback');
  check(await page.locator('#good .compiled-fallback a').getAttribute('href')==='/api/pdf#page=1','PDF destination survives replacement');
  return {checks,figures:'success/failure/unregistered/replacement failure',widths:[320,360,390]};
}
