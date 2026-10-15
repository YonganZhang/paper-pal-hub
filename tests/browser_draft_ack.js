// QA only: delayed real HTTP acknowledgements, never start a model.
async page=>{
  if(!page.url().includes('/papers/qa-ai/'))throw new Error('Isolated qa-ai fixture required');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.locator('#editor .editor-block').first().waitFor();
  if(await page.locator('body').getAttribute('data-mobile-panel')!=='ai')await page.locator('.hub-mobile-nav [data-panel=ai]').click();
  const input=page.locator('#codex-chat-input');
  await page.waitForFunction(()=>document.querySelector('#codex-chat-input').dataset.chatSessionId);
  async function newChat(){
    const previous=await input.getAttribute('data-chat-session-id');
    if(!await page.locator('#new-codex-chat').isVisible())await page.locator('#hub-ai-options-toggle').click();
    await page.locator('#new-codex-chat').click();
    await page.waitForFunction(id=>document.querySelector('#codex-chat-input').dataset.chatSessionId!==id,previous);
    return input.getAttribute('data-chat-session-id');
  }
  async function delayedSend(change){
    const id=await newChat();
    await input.fill('已经点击发送的内容');
    let release,entered;
    const gate=new Promise(resolve=>release=resolve),arrived=new Promise(resolve=>entered=resolve);
    const pattern='**/papers/qa-ai/api/chat/message';
    await page.route(pattern,async route=>{
      const payload=route.request().postDataJSON();entered();await gate;
      await route.continue({postData:JSON.stringify({...payload,autoProcess:false})});
    });
    try{
      const response=page.waitForResponse(r=>r.url().endsWith('/api/chat/message')&&r.request().method()==='POST');
      await page.locator('#send-codex-chat').click();await arrived;
      const expectedId=await change(id);
      release();await (await response).finished();
      await page.waitForTimeout(300); // Let the acknowledgement and SSE both settle.
      check(await input.getAttribute('data-chat-session-id')===expectedId,'Old response switched the active conversation');
      check(await input.inputValue()==='后来写的未发送草稿','Acknowledgement erased later typing');
      const saved=await (await page.request.get(page.url()+'api/chat?id='+id)).json();
      check(saved.messages.at(-1).content==='已经点击发送的内容','Submitted message was not saved');
      await page.request.post(page.url()+'api/chat/stop',{headers:{'X-Paper-Pal':'1'},data:{sessionId:id}});
      return expectedId;
    }finally{release();await page.unroute(pattern);}
  }
  await delayedSend(async id=>{await input.fill('后来写的未发送草稿');return id;});
  await delayedSend(async()=>{const id=await newChat();await input.fill('后来写的未发送草稿');return id;});
  await page.reload();await page.locator('.hub-mobile-nav [data-panel=ai]').click();
  await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value==='后来写的未发送草稿');
  return {laterTypingSurvives:true,otherSessionSurvives:true,draftSurvivesReload:true,realHttp:true,modelInvoked:false};
}
