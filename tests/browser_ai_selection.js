// Isolated fixture only: selecting a passage stages a draft; only Send posts it.
async page => {
  if (!page.url().includes('/papers/qa-ai/')) throw new Error('Isolated qa-ai fixture required');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  let sent=null,count=0;
  await page.route('**/papers/qa-ai/api/chat/message',async route=>{
    count++;sent=route.request().postDataJSON();
    await route.continue({postData:JSON.stringify({...sent,autoProcess:false})});
  });
  try {
    await page.locator('#ask-comment-in-chat').click();
    await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value.includes('把这句话写得更清楚，先讨论。'));
    check(count===0,'Selection submitted without explicit Send');
    const input=page.locator('#codex-chat-input');
    const id=await input.getAttribute('data-chat-session-id');
    const draft=await input.inputValue();
    const context=await page.evaluate(id=>window.paperHubChatContext(id),id);
    check(!!context.selectionContext,'Selected passage context missing');
    await page.locator('#close-codex-chat').click();
    await page.reload();
    await page.locator('.hub-mobile-nav [data-panel=ai]').click();
    await page.waitForFunction(()=>!!document.querySelector('#codex-chat-input').dataset.chatSessionId);
    check(await page.locator('#codex-chat-input').inputValue()===draft,'Staged draft lost on reload');
    check(!!await page.evaluate(id=>window.paperHubChatContext(id).selectionContext,id),'Staged context lost on reload');
    check(count===0,'Reload submitted staged draft');
    await page.locator('#send-codex-chat').click();
    await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value==='');
    check(count===1&&!!sent.selectionContext&&sent.message===draft,'Explicit send lost passage or draft');
    const r=await page.request.get(page.url()+'api/chat');const session=await r.json();
    await page.request.post(page.url()+'api/chat/stop',{headers:{'X-Paper-Pal':'1'},data:{sessionId:session.id}});
    return {selectionOnlyStagesDraft:true,closeReloadPreservesDraftAndContext:true,explicitSendPostsOnceWithSelection:true,modelInvoked:false};
  } finally {await page.unroute('**/papers/qa-ai/api/chat/message');}
}
