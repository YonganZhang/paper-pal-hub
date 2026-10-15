// Authenticated production UI, all write requests blocked. No messages are sent.
async page=>{
 const checks=[],geometry=[];let writes=0;
 const check=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name);};
 await page.route('**/papers/bondfusion/**',route=>{
  if(['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.continue();
  writes++;return route.abort();
 });
 const input=page.locator('#codex-chat-input');let draft=null,cdp;
 try{
  await page.reload();await page.setViewportSize({width:390,height:844});
  await page.locator('#editor .editor-block').first().waitFor({state:'attached'});
  await page.locator('.hub-mobile-nav [data-panel=ai]').click();await page.locator('#codex-chat-messages').waitFor();
  await page.waitForFunction(()=>!!document.querySelector('#codex-chat-input').dataset.chatSessionId);
  await page.waitForTimeout(250);draft=await input.inputValue();
  check(await page.locator('#hub-ai-options').isHidden(),'production settings default to collapsed');
  check(await page.locator('.topbar').isHidden()&&await page.locator('.hub-mobile-nav').isHidden(),'production AI dedicates the screen to chat');
  check((await page.locator('#codex-chat-messages').boundingBox()).height>844*.65,'production history occupies most of the phone');
  check(await page.locator('#codex-chat-messages .chat-message').count()>0,'actual existing conversation remains visible');
  await input.fill('界面验证草稿，不发送');
  cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:120,y:420}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:120,y:330}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('#codex-chat').classList.contains('hub-ai-composer-collapsed'));
  check(await input.isHidden()&&await page.locator('#hub-ai-resume-input').isVisible(),'production touch swipe minimizes input');
  await page.locator('#hub-ai-resume-input').click();check(await input.inputValue()==='界面验证草稿，不发送','production draft survives minimize and resume');
  await page.locator('#hub-ai-options-toggle').click();
  check(await page.locator('#agent-model-picker').isVisible()&&await page.locator('#hub-web-consultation').isVisible(),'production More contains settings and consultation');
  await page.locator('#toggle-chat-list').click();check(await page.locator('#hub-ai-options').isHidden()&&await page.locator('#codex-chat-list').isVisible(),'production history is independently expandable');
  await page.locator('#toggle-chat-list').click();
  for(const [width,height] of [[320,640],[390,500],[390,350]]){
   await page.setViewportSize({width,height});await page.waitForTimeout(120);
   const history=await page.locator('#codex-chat-messages').boundingBox(),send=await page.locator('#send-codex-chat').boundingBox();
   check(history.height>height*.45,'production history remains readable at '+width+'x'+height);
   check(send.y+send.height<=height+1,'production send stays within viewport at '+width+'x'+height);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'production has no horizontal overflow at '+width+'x'+height);
   geometry.push({width,height,historyHeight:history.height});
  }
  await page.setViewportSize({width:390,height:844});await input.fill(draft);
  await page.screenshot({path:'_tests/_artifacts/chat-focus-public-phone.png'});
  await page.locator('#close-codex-chat').click();
  check(await page.locator('.topbar').isVisible()&&await page.locator('.hub-mobile-nav').isVisible(),'production close restores document reading');
  check(writes===0,'production test sends no chat, model, manuscript or archive writes');
  return {checks,geometry,writes,realModelCalls:0};
 }finally{
  if(draft!==null&&await input.isVisible())await input.fill(draft);
  await cdp?.detach();await page.unroute('**/papers/bondfusion/**');
 }
}
