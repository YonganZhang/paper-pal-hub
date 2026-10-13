// Isolated browser routes only; no real paper, service, model or subscription calls.
async page => {
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const origin='http://localhost:19981';
  const records={version:new Map(),figure:new Map()},calls=[];
  let versions=[],loseNext=null,delayNext=null,release=null;
  const figures=['fig1','fig2'].map(id=>({id,title:id,kind:'plot',path:`figures/${id}.png`,sha256:'a'.repeat(64),preview_url:'/image?preview=1',asset_url:'/image',source_paths:[],data_paths:[]}));
  await page.route(origin+'/**',async route=>{
    const request=route.request(),path=request.url().slice(origin.length).split('?')[0];
    if(path==='/papers/qa-retry/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><div class="top-actions"></div><select id="document-select"><option>main.tex</option></select>'});
    if(path==='/hub-assets/versions.js'||path==='/hub-assets/figure-studio.js')return route.fulfill({path:'web/'+path.split('/').at(-1),contentType:'application/javascript; charset=utf-8'});
    if(path==='/papers/qa-retry/api/bootstrap')return route.fulfill({json:{agent:{providers:[{id:'codex',available:true,model:'m',models:['m','m2']},{id:'claude',available:true,model:'c',models:['c']}]}}});
    if(path==='/papers/qa-retry/hub/figures')return route.fulfill({json:{figures,jobs:[]}});
    const kind=path==='/papers/qa-retry/hub/versions'?'version':path==='/papers/qa-retry/hub/figures/jobs'?'figure':null;
    if(kind&&request.method()==='POST'){
      const body=JSON.parse(request.postData()),{request_id,...payload}=body,key=JSON.stringify(payload);
      calls.push({kind,request_id,payload});
      let saved=records[kind].get(request_id);
      if(saved&&saved.key!==key)return route.fulfill({status:409,json:{error:'请求内容冲突'}});
      if(!saved){
        if(kind==='version'){
          if(body.expected_parent!==(versions.at(-1)?.id||null))return route.fulfill({status:409,json:{error:'已有新版本，请刷新后再存档。'}});
          const version={id:`v${versions.length}.0`,version:`${versions.length}.0`,name:body.name,note:body.note,created_at:new Date().toISOString(),snapshot_path:'/fixture/version',manifest_path:'/fixture/version/manifest.json'};
          versions.push(version);saved={key,value:{created:true,version}};
        }else saved={key,value:{id:`job${records.figure.size}`,status:'proposed',figure_id:body.figure_id,instruction:body.instruction,provider:body.provider,model:body.model,created_at:new Date().toISOString()}};
        records[kind].set(request_id,saved);
      }
      if(loseNext===kind){loseNext=null;return route.fulfill({status:503,json:{error:'模拟回执丢失'}});}
      if(delayNext===kind){delayNext=null;await new Promise(resolve=>{release=resolve;});}
      return route.fulfill({json:saved.value});
    }
    if(kind==='version')return route.fulfill({json:{versions}});
    if(path.endsWith('/versions/compare'))return route.fulfill({json:{files:[],figures:[],summary:{}}});
    return route.fulfill({json:{}});
  });
  await page.goto(origin+'/papers/qa-retry/');
  await page.evaluate(()=>{window.paperHubFlush=async()=>{};});
  await page.addScriptTag({url:origin+'/hub-assets/versions.js'});
  await page.addScriptTag({url:origin+'/hub-assets/figure-studio.js'});
  await page.locator('#hub-versions-open').click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('首次存档'));
  await page.locator('#hub-version-name').fill('初稿');loseNext='version';await page.locator('#hub-version-archive').click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('模拟'));
  await page.locator('#hub-version-archive').click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('存档完成'));
  check(versions.length===1&&calls[0].request_id===calls[1].request_id,'Same archive retry duplicated stored version');
  await page.locator('#hub-version-name').fill('第二稿');loseNext='version';await page.locator('#hub-version-archive').click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('模拟'));
  await page.locator('#hub-version-name').fill('第三稿');await page.locator('#hub-version-archive').click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('已有新版本'));
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('仅供阅读'));
  delayNext='version';await page.locator('#hub-version-archive').click();await page.waitForFunction(()=>document.querySelector('#hub-version-archive').disabled);await page.waitForTimeout(100);
  await page.locator('#hub-version-name').fill('发送期间的新草稿');await page.locator('#hub-version-note').fill('等待期间新说明');release();await page.waitForFunction(()=>document.querySelector('.hub-version-status').textContent.includes('存档完成'));
  check(versions.length===3&&calls[2].request_id!==calls[3].request_id&&calls[3].request_id!==calls[4].request_id,'Edited archive submission reused unknown request identity');
  check(await page.locator('#hub-version-name').inputValue()==='发送期间的新草稿','Slow archive response cleared new draft');
  check(await page.locator('#hub-version-note').inputValue()==='等待期间新说明','Slow archive response cleared new note');
  await page.locator('#hub-versions-dialog > header button').click();
  await page.locator('#hub-figures-open').click();await page.waitForFunction(()=>document.querySelectorAll('.hub-figure-card').length===2);
  await page.locator('.hub-figure-card').first().getByRole('button',{name:'修改这张图',exact:true}).click();
  await page.locator('#hub-figure-instruction').fill('改蓝色');loseNext='figure';await page.locator('#hub-figure-generate').click();await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('模拟'));
  await page.locator('#hub-figure-generate').click();await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('已提交'));
  let fc=calls.filter(call=>call.kind==='figure');check(records.figure.size===1&&fc[0].request_id===fc[1].request_id,'Same figure retry duplicated model job');
  await page.locator('#hub-figure-instruction').fill('改绿色');loseNext='figure';await page.locator('#hub-figure-generate').click();await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('模拟'));
  await page.locator('#hub-figure-instruction').fill('改字号');await page.locator('#hub-figure-model').selectOption('m2');delayNext='figure';await page.locator('#hub-figure-generate').click();await page.waitForTimeout(100);
  await page.locator('#hub-figure-instruction').fill('下一张图的草稿');await page.locator('#hub-figure-dialog > header button').click();
  await page.locator('#hub-figures-open').click();await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('已登记'));
  await page.locator('.hub-figure-card').last().getByRole('button',{name:'修改这张图',exact:true}).click();await page.locator('#hub-figure-instruction').fill('第二张图');await page.locator('#hub-figure-provider').selectOption('claude');check(await page.locator('#hub-figure-generate').isDisabled(),'Switching figures allowed overlapping submit');release();await page.waitForFunction(()=>!document.querySelector('#hub-figure-generate').disabled);check(await page.locator('#hub-figure-instruction').inputValue()==='第二张图','Pending previous figure response cleared switched draft');await page.locator('#hub-figure-generate').click();await page.waitForFunction(()=>document.querySelector('.hub-figure-status').textContent.includes('已提交'));
  fc=calls.filter(call=>call.kind==='figure');check(records.figure.size===4&&new Set(fc.slice(2).map(call=>call.request_id)).size===3,'Changed figure/model/provider submission reused old identity');
  await page.locator('.hub-figure-card').first().getByRole('button',{name:'修改这张图',exact:true}).click();check(await page.locator('#hub-figure-instruction').inputValue()==='下一张图的草稿','Slow figure response cleared newer draft');
  return {archiveRetryIdempotent:true,editedArchiveNewIdentity:true,figureRetryIdempotent:true,editedFigureNewIdentity:true,closeAndSwitchFigure:true,newerDraftsPreserved:true,realCalls:false};
}
