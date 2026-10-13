// Actual gateway APIs; only an isolated qa-versions project may be changed.
async page => {
  if(!page.url().includes('/papers/qa-versions/'))throw new Error('Isolated qa-versions fixture required');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const prefix=page.url().replace(/\/$/,'')+'/hub';
  await page.locator('#hub-versions-open').click();
  await page.waitForFunction(()=>document.querySelector('#hub-version-archive')&&!document.querySelector('.hub-version-status').textContent.includes('正在'));
  const initial=await(await page.request.get(prefix+'/versions')).json();
  const last=initial.versions.at(-1);
  await page.locator('#hub-version-name').fill('浏览器验收存档');
  await page.locator('#hub-version-note').fill('隔离项目：保留版本编号、时间和接手路径。');
  await page.locator('#hub-version-archive').click();
  await page.waitForFunction(()=>document.querySelector('.hub-version-receipt')?.hidden===false&&document.querySelector('.hub-version-status').textContent.includes('存档完成'),{},{timeout:30000});
  const after=await(await page.request.get(prefix+'/versions')).json();
  const created=after.versions.at(-1);
  check(after.versions.length===initial.versions.length+1,'Archive was not created exactly once');
  check(created.version===(last?`${parseInt(last.version,10)+1}.0`:'0.0'),'Sequential version numbering failed');
  check(created.name==='浏览器验收存档'&&created.note.includes('隔离项目')&&!!created.created_at,'Version metadata missing');
  check((await page.locator('.hub-version-receipt').innerText()).includes(created.snapshot_path),'Archive path not visible');
  check(await page.locator('#hub-version-base').inputValue()===created.id,'Default comparison is not last archived version');
  check(await page.locator('#hub-version-target').inputValue()==='working','Default target is not current working source');
  const zip=await page.request.get(prefix+'/versions/'+encodeURIComponent(created.id)+'/download');
  check(zip.ok()&&/attachment/.test(zip.headers()['content-disposition']||''),'Archive download failed');
  if(after.versions.length>1){
    await page.locator('#hub-version-target').selectOption(created.id);
    await page.locator('#hub-version-base').selectOption(after.versions[0].id);
    await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('仅供阅读'));
    const comparison=await(await page.request.get(prefix+'/versions/compare?base='+encodeURIComponent(after.versions[0].id)+'&target='+encodeURIComponent(created.id))).json();
    check(Array.isArray(comparison.files)&&Array.isArray(comparison.figures),'Arbitrary historical comparison unavailable');
  }
  await page.locator('#hub-version-mode').selectOption('latest');
  check(await page.locator('#hub-version-comparison del').count()===0,'Latest result mode still contains deletion markup');
  const focusedPath=await page.locator('#hub-version-file').inputValue();
  const focused=await(await page.request.get(prefix+'/versions/compare?base='+encodeURIComponent(await page.locator('#hub-version-base').inputValue())+'&target='+encodeURIComponent(await page.locator('#hub-version-target').inputValue())+'&path='+encodeURIComponent(focusedPath))).json();
  const focusedFile=focused.files.find(file=>file.path===focusedPath);
  check(focusedFile?.latest_text!==null&&focusedFile?.latest_text!==undefined,'Selected source was not loaded');
  check(await page.locator('.hub-version-source').innerText()===focusedFile.latest_text,'Latest result does not match selected source');
  check(focused.files.filter(file=>file.kind==='text'&&file.latest_text!==null).length===1,'Unselected source contents inflated comparison payload');
  const other=focused.files.find(file=>file.kind==='text'&&file.path!==focusedPath&&/\.py$/i.test(file.path));
  if(other){
    const responsePromise=page.waitForResponse(response=>response.url().startsWith(prefix+'/versions/compare?')&&response.url().includes('path='+encodeURIComponent(other.path)));
    await page.locator('#hub-version-file').selectOption(other.path);
    const response=await responsePromise;const changed=await response.json();
    await page.waitForFunction(path=>document.querySelector('.hub-version-focused-file h3')?.textContent.startsWith(path),other.path);
    check(changed.focus_path===other.path,'Source selector did not fetch focused file');
    check(await page.locator('.hub-version-source').innerText()===changed.files.find(file=>file.path===other.path).latest_text,'Source selector shows stale text');
  }
  const currentText=await page.locator('#editor').innerText();
  await page.getByRole('button',{name:'查看当前正文',exact:true}).click();
  check(!await page.locator('#hub-versions-dialog').evaluate(node=>node.open),'Version dialog did not close');
  check(await page.locator('#editor').innerText()===currentText,'Read-only comparison changed editor');
  for(const width of [360,390,768]){
    await page.setViewportSize({width,height:760});await page.locator('#hub-versions-open').click();
    const size=await page.locator('#hub-versions-dialog').evaluate(node=>({width:node.getBoundingClientRect().width,viewport:innerWidth,overflow:node.scrollWidth>node.clientWidth+1}));
    check(size.width<=size.viewport+1&&!size.overflow,'Version dialog overflows mobile viewport');
    await page.locator('#hub-versions-dialog > header button').click();
  }
  return {sequentialVersion:created.version,timeAndPathsVisible:true,zipDownloaded:true,arbitraryVersions:true,latestWithoutDiff:true,focusedFileOnly:true,sourceSelectorRefetch:!!other,sourceUnchanged:true,mobileWidths:[360,390,768]};
}
