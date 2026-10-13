// Controlled rich editor: Enter submits; multiline fill/restore must never submit.
async page=>{
  await page.setContent('<style>[contenteditable]{white-space:pre-wrap}[contenteditable] p{margin:0}</style><div role="textbox" contenteditable="true"><p>第一段</p><p>第二段</p></div><script>window.sent=0;document.querySelector("[contenteditable]").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();window.sent++;}});</script>');
  const editor=page.getByRole('textbox');
  const original=await editor.locator('p').allTextContents();
  await editor.fill('');
  if((await editor.innerText()).trim())throw new Error('Clearing must produce an empty editor');
  await editor.fill('身份块\n验收问题');
  if(await page.evaluate(()=>window.sent)!==0)throw new Error('Multiline fill submitted');
  await editor.press('Enter');
  if(await page.evaluate(()=>window.sent)!==1)throw new Error('Explicit send must submit once');
  await editor.fill(original.join('\n'));
  const restored=(await editor.innerText()).split(/\n+/).filter(Boolean);
  if(JSON.stringify(restored)!==JSON.stringify(original)||await page.evaluate(()=>window.sent)!==1)throw new Error(JSON.stringify({original,restored,sent:await page.evaluate(()=>window.sent)}));
  return {multilineFillSends:0,explicitSends:1,restorationSends:0,paragraphsRestored:true};
}
