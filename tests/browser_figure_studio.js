// Isolated fixture must use a fake subscription CLI producing a real PNG candidate.
async page => {
  if(!page.url().includes('/papers/qa-versions/'))throw new Error('Isolated qa-versions fixture required');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const prefix=page.url().replace(/\/$/,'')+'/hub';
  const initial=await(await page.request.get(prefix+'/figures')).json();
  check(initial.figures?.length>0,'Fixture needs a registered figure');
  const figure=initial.figures[0];
  let jobsPosted=0;const listener=request=>{if(request.url().endsWith('/hub/figures/jobs')&&request.method()==='POST')jobsPosted++;};page.on('request',listener);
  try{
    await page.locator('#hub-figures-open').click();
    await page.waitForFunction(()=>document.querySelector('.hub-figure-card'));
    const first=page.locator('.hub-figure-card').first();
    await first.locator('img').waitFor();
    await page.waitForFunction(()=>{const img=document.querySelector('.hub-figure-card img');return img?.complete&&img.naturalWidth>0;});
    await first.locator('summary').click();
    const provenance=await first.innerText();
    check(provenance.includes(figure.path),'Figure path not visible');
    for(const path of [...(figure.source_paths||[]),...(figure.data_paths||[])])check(provenance.includes(path),'Source/data provenance missing');
    await first.getByRole('button',{name:'修改这张图',exact:true}).click();
    await page.locator('#hub-figure-instruction').fill('隔离验收：生成颜色不同的图片候选，保留原始数据。');
    check(jobsPosted===0,'Figure job started without explicit button click');
    await page.waitForFunction(()=>!document.querySelector('#hub-figure-generate').disabled);
    await page.locator('#hub-figure-generate').click();
    await page.waitForFunction(()=>document.querySelector('#hub-figure-jobs [data-action=accept-figure]'),{},{timeout:30000});
    check(jobsPosted===1,'Figure generate did not create exactly one job');
    const beforeAccept=await(await page.request.get(prefix+'/figures')).json();
    check(beforeAccept.figures[0].sha256===figure.sha256,'Candidate generation changed live figure');
    const jobCard=page.locator('#hub-figure-jobs .hub-figure-job').filter({has:page.locator('[data-action=accept-figure]')}).first();
    const jobId=await jobCard.getAttribute('data-job-id');
    const job=await(await page.request.get(prefix+'/figures/jobs/'+encodeURIComponent(jobId))).json();
    check(job.status==='proposed'&&!!job.candidate_url,'Backend did not create an actual candidate');
    const candidateUrl=job.candidate_url.startsWith('/')?page.url().split('/').slice(0,3).join('/')+job.candidate_url:job.candidate_url;
    const image=await page.request.get(candidateUrl);check(image.ok()&&(await image.body()).length>0,'Candidate asset unavailable');
    await jobCard.locator('[data-action=accept-figure]').click();
    await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('图片已替换'),{},{timeout:15000});
    const accepted=await(await page.request.get(prefix+'/figures/jobs/'+encodeURIComponent(jobId))).json();
    check(accepted.status==='accepted','Explicit approval was not persisted');
    const current=await(await page.request.get(prefix+'/figures')).json();
    check(current.figures[0].sha256!==figure.sha256,'Fixture candidate did not replace image bytes');
    check((await page.locator('.hub-figure-card img').first().getAttribute('src')).includes(current.figures[0].sha256),'Accepted figure preview is missing version hash; browser may retain old image');
    for(const width of [360,390,768]){await page.setViewportSize({width,height:760});const dimensions=await page.locator('#hub-figure-dialog').evaluate(node=>({width:node.getBoundingClientRect().width,viewport:innerWidth,overflow:node.scrollWidth>node.clientWidth+1}));check(dimensions.width<=dimensions.viewport+1&&!dimensions.overflow,'Figure studio overflows mobile viewport');}
    await page.locator('#hub-figure-dialog > header button').click();
    check(!await page.locator('#hub-figure-dialog').evaluate(node=>node.open),'Figure studio did not close');
    const versions=await(await page.request.get(prefix+'/versions')).json();
    if(versions.versions?.length){
      await page.locator('#hub-versions-open').click();
      await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('仅供阅读'));
      await page.locator('#hub-version-target').selectOption('working');
      await page.locator('#hub-version-base').selectOption(versions.versions.at(-1).id);
      await page.locator('#hub-version-mode').selectOption('diff');
      await page.waitForFunction(()=>document.querySelector('#hub-version-comparison .hub-version-old-figure img'),{},{timeout:15000});
      check(await page.locator('#hub-version-comparison .hub-version-figure-pair img').count()>=2,'Version comparison did not show old and new image');
      await page.locator('#hub-versions-dialog > header button').click();
    }
    return {realImageVisible:true,sourceAndDataVisible:true,explicitGenerateOnly:true,originalPreservedUntilAccept:true,candidateAssetServed:true,explicitAcceptPersisted:true,changedImageComparison:!!versions.versions?.length,fakeCliOnly:true,mobileWidths:[360,390,768]};
  }finally{page.off('request',listener);}
}
