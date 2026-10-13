// Local fixture reproducing the reader rebuild when opening/closing a comment.
async page=>{
 const origin='http://127.0.0.1:4413',script=await(await page.request.get(origin+'/figure-inline.js')).text();
 const checks=[];let requests=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 const source='<section class="editor-block kind-figure"><div class="compiled-fallback"><div>Full figure in PDF</div><a href="/paper.pdf">PDF</a></div><figcaption>Actual figure caption</figcaption></section>';
 await page.route(origin+'/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/figure-inline.js'))return route.fulfill({contentType:'text/javascript',body:script});
  if(url.endsWith('/hub/figures')){requests++;return route.fulfill({json:{figures:[{path:'plot.pdf',sha256:'fixed-hash',title:'Plot',asset_url:'/plot.pdf',preview_url:'/preview.svg?x=1'}]}});}
  if(url.includes('/preview.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="30"><rect width="100" height="30" fill="green"/></svg>'});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor">'+source+'</div><script>document.querySelector(".kind-figure").reviewBlock={raw:"\\\\paperfigure{plot.pdf}"};</script><script src="/figure-inline.js"></script>'});
 });
 try{
  await page.goto(origin+'/papers/remount-fixture/');await page.waitForFunction(()=>document.querySelector('#editor img')?.naturalWidth>0);
  check(await page.locator('#editor img').count()===1,'initial registered preview is visible');
  for(const label of ['open comment','close comment']){
   await page.evaluate(html=>{const editor=document.querySelector('#editor');editor.innerHTML=html;editor.querySelector('.kind-figure').reviewBlock={raw:'\\paperfigure{plot.pdf}'};},source);
   await page.waitForFunction(()=>document.querySelector('#editor img')?.naturalWidth>0);
   check(await page.locator('#editor img').count()===1,label+' rebuild remounts exactly one preview');
   check(await page.locator('#editor .compiled-fallback a').isVisible(),label+' preserves PDF entrance');
  }
  const count=requests;await page.evaluate(()=>document.querySelector('#editor').append(document.createElement('aside')));await page.waitForTimeout(150);
  check(requests===count,'translation sidecar changes do not refetch figures');
  check(requests===3,'each source rebuild makes one coalesced registry request');
  return {checks,registryRequests:requests,realModelCalls:0};
 }finally{await page.unroute(origin+'/**');}
}
