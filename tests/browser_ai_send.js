// Run only on an isolated registered fixture. Store a turn, but do not run a model.
async page => {
  if(!page.url().includes('/papers/qa-ai/'))throw new Error('Isolated qa-ai fixture required');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.locator('#editor .editor-block').first().waitFor();
  await page.locator('.hub-mobile-nav [data-panel=ai]').click();
  await page.waitForFunction(()=>document.querySelector('#codex-chat-input').dataset.chatSessionId);
  const input=page.locator('#codex-chat-input');
  const first=await input.getAttribute('data-chat-session-id');
  await input.fill('会话甲的未发送草稿');
  await page.locator('#new-codex-chat').click();
  await page.waitForFunction(id=>document.querySelector('#codex-chat-input').dataset.chatSessionId!==id,first);
  const second=await input.getAttribute('data-chat-session-id');
  check((await input.inputValue())==='','New chat inherited another draft');
  await input.fill('会话乙的未发送草稿');
  await page.locator('#toggle-chat-list').click();
  await page.locator(`[data-chat-id="${first}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value==='会话甲的未发送草稿');
  await page.locator('#toggle-chat-list').click();
  await page.locator(`[data-chat-id="${second}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value==='会话乙的未发送草稿');
  let sent=null;
  await page.route('**/papers/qa-ai/api/chat/message',async route=>{
    sent=route.request().postDataJSON();
    await route.continue({postData:JSON.stringify({...sent,autoProcess:false})});
  });
  try {
    await page.locator('#agent-model').selectOption('gpt-6.1-sol');
    await page.locator('#send-codex-chat').click();
    await page.waitForFunction(()=>document.querySelector('#codex-chat-input').value==='');
    check(sent?.message==='会话乙的未发送草稿'&&sent.model==='gpt-6.1-sol','Send lost text or model');
    const response=await page.request.get(page.url()+'api/chat');const session=await response.json();
    check(session.messages.at(-1).content===sent.message&&session.model==='gpt-6.1-sol','Backend did not persist sent text/model');
    await page.request.post(page.url()+'api/chat/stop',{headers:{'X-Paper-Pal':'1'},data:{sessionId:second}});
    await page.reload();await page.locator('.hub-mobile-nav [data-panel=ai]').click();
    await page.waitForFunction(()=>!!document.querySelector('#codex-chat-input').dataset.chatSessionId);
    check((await page.locator('#codex-chat-input').inputValue())==='','Sent draft reappeared after reload');
    return {sessionDraftsIsolated:true,explicitSendWorks:true,chosenModelInRequestAndSession:true,successfulSendClearsDraft:true,modelInvoked:false};
  } finally {await page.unroute('**/papers/qa-ai/api/chat/message');}
}
