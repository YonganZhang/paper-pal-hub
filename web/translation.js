/* Translation is a separate reading view, never contenteditable or serialized as source. */
(() => {
  const editor = document.querySelector('#editor');
  const pane = document.querySelector('.editor-pane');
  if (!editor || !pane) return;
  const prefix = location.pathname.replace(/\/$/, '');
  const toolbar = document.createElement('div'); toolbar.className = 'hub-reading-toolbar';
  toolbar.setAttribute('aria-label','翻译与阅读');
  const view = document.createElement('section'); view.id = 'hub-translation-view'; view.hidden = true;
  view.setAttribute('aria-label','中文辅助阅读');
  const status = document.createElement('span'); status.className = 'hub-translation-status'; status.setAttribute('role','status');
  let mode = 'original', epoch = 0, path = '', sourceText = '', blocks = [], translations = [], originalScroll = 0;
  const buttons = {};
  const completedViews=new Map(), runningViews=new Map();
  let activeKey='', preparationTimer;
  const preparationPreference='paper-hub.translation-enabled.'+prefix;
  const localPrefix='paper-hub.translation-v3.'+prefix;
  const configuration=fetch(prefix+'/hub/translation-config').then(async response=>{if(!response.ok)throw new Error('无法读取翻译配置，请刷新后重试。');return response.json();});
  configuration.catch(()=>{});
  for (const [id, label] of [['original','英文原文'],['chinese','翻译成中文'],['bilingual','中英对照']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.readingMode = id; button.setAttribute('aria-pressed',String(id===mode));
    button.addEventListener('click', () => { revealReading(); void choose(id); }); buttons[id] = button; toolbar.append(button);
  }
  toolbar.append(status);
  const header=document.querySelector('.topbar');
  if(header)header.append(toolbar);else editor.before(toolbar);
  editor.after(view);
  const engine=document.createElement('select');engine.setAttribute('aria-label','翻译方式');
  for(const [value,label] of [['ai','论文精译'],['offline','快速草译']]){const option=document.createElement('option');option.value=value;option.textContent=label;engine.append(option);}
  toolbar.insertBefore(engine,status);
  engine.addEventListener('change',()=>{epoch++;sourceText='';activeKey='';translations=[];if(mode!=='original')void choose(mode);});
  function collect() {
    // Paper Pal renders paragraphs as top-level sections, rather than <p>.
    return [...editor.querySelectorAll(':scope > .editor-block')].map(el => {
      const copy=el.cloneNode(true);
      copy.querySelectorAll('button,.review-link-badge,.review-number,.proposal-diff,.proposal-delete,[hidden]').forEach(node=>node.remove());
      copy.querySelectorAll('figcaption > code').forEach(node=>{if(/^(?:fig|tab|eq|sec|app):[\w:.-]+$/.test(node.textContent.trim()))node.remove();});
      const visual=[];
      for(const node of copy.querySelectorAll(':scope > .latex-figure-panels,:scope > .latex-figure-link,:scope > .latex-figure-image,:scope > .latex-table-wrap,:scope > .display-formula,:scope > .compiled-fallback')) {
        let retained=node;
        if(node.matches('.compiled-fallback')) {
          retained=node.querySelector('a');
          if(retained)retained.textContent=el.matches('.kind-table')?'查看原表 PDF ↗':'查看原图 PDF ↗';
        }
        if(retained) {
          for(const child of [retained,...retained.querySelectorAll('*')]) {
            child.removeAttribute('id');child.removeAttribute('data-review-request-id');
            if(child.hasAttribute('contenteditable'))child.setAttribute('contenteditable','false');
          }
          visual.push(retained.outerHTML);
        }
        node.remove();
      }
      copy.querySelectorAll('.katex').forEach(node=>node.replaceWith(node.querySelector('annotation')?.textContent || '［公式见原文］'));
      return {tag:el.classList.contains('kind-heading')?'H3':'P',text:copy.textContent.trim() || (visual.length?'［图表或公式］':''),visual:visual.join(''),proposal:el.classList.contains('has-proposal')};
    }).filter(b => b.text);
  }
  window.paperHubTranslationSnapshot=()=>({path:path,texts:collect().map(block=>block.text)});
  function render() {
    const scroll=pane.scrollTop;
    view.replaceChildren();
    blocks.forEach((block,index) => {
      const item = document.createElement('div'); item.className = 'hub-translation-block';
      if(block.proposal){const note=document.createElement('small');note.className='hub-translation-pending';note.textContent='待确认修改的中文预览';item.append(note);}
      if(block.visual) {
        const media=document.createElement('div');media.className='hub-translation-media';
        // Only cloned, already-rendered source visuals enter this fragment;
        // model output is always assigned through textContent below.
        const template=document.createElement('template');template.innerHTML=block.visual;
        media.append(template.content);item.append(media);
      }
      if (mode === 'bilingual') { const original = document.createElement('p'); original.className='hub-translation-original'; original.textContent=block.text; item.append(original); }
      const translated = document.createElement(/^H/.test(block.tag) ? 'h3':'p');
      translated.textContent = translations[index] || block.text;
      if(!translations[index]) {const pending=document.createElement('small');pending.className='hub-translation-pending';pending.textContent='本段翻译中，暂显示原文';item.append(pending);}
      item.append(translated); view.append(item);
    });
    pane.scrollTop=scroll;
  }
  function setVisible() {
    editor.hidden = mode !== 'original'; view.hidden = mode === 'original';
    for (const [id,button] of Object.entries(buttons)) button.setAttribute('aria-pressed',String(id===mode));
    // Structural workspace has its own visibility contract.
    if (document.querySelector('#structure-workspace')?.hidden===false) view.hidden = true;
    toolbar.hidden = false;
  }
  function revealReading() {
    if(document.querySelector('#structure-workspace')?.hidden===false)document.querySelector('#show-text-workspace')?.click();
    if(document.body.dataset.mobilePanel)document.querySelector('.hub-close-panel')?.click();
    if(document.querySelector('#paper-preview')?.hidden===false)document.querySelector('#close-paper-preview')?.click();
  }
  function showState(state) {
    if(activeKey!==state.key)return;
    if(mode==='original'){status.textContent=state.done?'译文已准备好':state.error||`正在后台准备译文 ${state.completed} / ${state.texts.length} 段`;return;}
    translations=state.translations;render();
    status.textContent=state.error || (state.done?'中文辅助阅读 · '+(state.engine==='ai'?'论文精译':'快速草译')+' · 修改请选英文原文':`正在${state.engine==='ai'?'精译':'草译'} ${state.completed} / ${state.texts.length} 段 · 可先阅读已完成部分`);
  }
  function remember(key,values) {
    completedViews.set(key,values);
    if(completedViews.size>20)completedViews.delete(completedViews.keys().next().value);
    try {
      // Per-paper/browser cache; source + live server revision invalidate edits,
      // glossary changes, model changes and translation-contract upgrades.
      const index=JSON.parse(localStorage.getItem(localPrefix+'.index')||'[]').filter(value=>value!==key);
      index.push(key);
      while(index.length>12)localStorage.removeItem(localPrefix+'.'+index.shift());
      localStorage.setItem(localPrefix+'.'+key,JSON.stringify(values));
      localStorage.setItem(localPrefix+'.index',JSON.stringify(index));
    }catch{} // Quota/privacy-mode failure retains the in-memory/server caches.
  }
  async function translate(state) {
    try {
      let response=await fetch(prefix+'/hub/translate',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Pal':'1'},body:JSON.stringify({engine:state.engine,texts:state.texts,revision:state.revision})});
      let job=await response.json();
      if(!response.ok)throw new Error(job.error||'翻译暂不可用');
      for(;;) {
        if(Array.isArray(job.translations)&&job.translations.length===state.texts.length){state.translations=job.translations;state.completed=job.completed;}
        if(job.status==='error')throw new Error(job.error||'翻译未完成，请重试。');
        if(job.status==='done') {
          if(state.translations.some(text=>typeof text!=='string'||!text.trim()))throw new Error('译文不完整，请重试。');
          state.done=true;remember(state.key,state.translations);showState(state);return;
        }
        showState(state);
        await new Promise(resolve=>setTimeout(resolve,400));
        response=await fetch(prefix+'/hub/translate/'+job.id);job=await response.json();
        if(!response.ok)throw new Error(job.error||'读取翻译失败，请重试');
      }
    }catch(error){state.error=error.message;showState(state);}
    finally{runningViews.delete(state.key);}
  }
  async function choose(next) {
    if(mode==='original'&&next!=='original')originalScroll=pane.scrollTop;
    mode=next;setVisible();
    if(next==='original'){status.textContent='';pane.scrollTop=originalScroll;return;}
    try{localStorage.setItem(preparationPreference,'1');}catch{}
    await prepareCurrent();
  }
  async function prepareCurrent() {
    const found=collect(),fingerprint=JSON.stringify(found.map(block=>block.text));
    if(!found.length){status.textContent='这一页没有可翻译的正文，请先打开一个章节。';return;}
    blocks=found;
    if(fingerprint!==sourceText){sourceText=fingerprint;activeKey='';translations=[];epoch++;}
    render();
    const current=epoch, selectedEngine=engine.value;
    try {
      const config=await configuration;
      const revision=config.revisions?.[selectedEngine];
      if(typeof revision!=='string')throw new Error('翻译配置不完整，请刷新后重试。');
      const input=new TextEncoder().encode(JSON.stringify([revision,fingerprint]));
      const hash=await crypto.subtle.digest('SHA-256',input);
      const key=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(current!==epoch||selectedEngine!==engine.value)return;
      activeKey=key;
      let cached=completedViews.get(key);
      if(!cached){try{cached=JSON.parse(localStorage.getItem(localPrefix+'.'+key)||'null');}catch{}}
      if(Array.isArray(cached)&&cached.length===blocks.length&&cached.every(text=>typeof text==='string'&&text.trim())) {
        completedViews.set(key,cached);translations=cached;render();
        if(mode!=='original')status.textContent='中文辅助阅读 · 已缓存 · 修改请选英文原文';
        return;
      }
      const existing=runningViews.get(key);
      if(existing){showState(existing);return;}
      const state={key,revision,engine:selectedEngine,texts:found.map(block=>block.text),translations:new Array(found.length).fill(null),completed:0,done:false};
      runningViews.set(key,state);showState(state);void translate(state);
    }catch(error){if(current===epoch&&mode!=='original')status.textContent=error.message;}
  }
  function schedulePreparation() {
    clearTimeout(preparationTimer);
    let enabled=false;try{enabled=localStorage.getItem(preparationPreference)==='1';}catch{}
    if(enabled&&mode==='original')preparationTimer=setTimeout(()=>{if(runningViews.size===0)void prepareCurrent();},1200);
  }
  window.addEventListener('paper-hub:document', event=> {
    const readingMode=mode;
    path=event.detail.path; epoch++; sourceText=''; activeKey=''; blocks=[]; translations=[];
    view.replaceChildren(); status.textContent=''; setVisible();
    if(readingMode!=='original')void choose(readingMode);else schedulePreparation();
  });
  window.addEventListener('paper-hub:figures-rendered',()=>{
    const found=collect(),fingerprint=JSON.stringify(found.map(block=>block.text));
    if(fingerprint===sourceText){blocks=found;if(mode!=='original')render();return;}
    epoch++;sourceText='';activeKey='';translations=[];
    if(mode!=='original')void choose(mode);
  });
  document.querySelector('#show-structure-workspace')?.addEventListener('click',()=>{view.hidden=true;});
  document.querySelector('#show-text-workspace')?.addEventListener('click',()=>{mode='original';setVisible();});
})();
