/* Translation is a separate reading view, never contenteditable or serialized as source. */
(() => {
  const editor = document.querySelector('#editor');
  const pane = document.querySelector('.editor-pane');
  if (!editor || !pane) return;
  const prefix = location.pathname.replace(/\/$/, '');
  const toolbar = document.createElement('div'); toolbar.className = 'hub-reading-toolbar';
  toolbar.setAttribute('aria-label','阅读语言');
  const view = document.createElement('section'); view.id = 'hub-translation-view'; view.hidden = true;
  view.setAttribute('aria-label','中文辅助阅读');
  const status = document.createElement('span'); status.className = 'hub-translation-status'; status.setAttribute('role','status');
  let mode = 'original', epoch = 0, path = '', sourceText = '', blocks = [], translations = [], originalScroll = 0;
  const buttons = {};
  const completedViews=new Map();
  for (const [id, label] of [['original','英文原文'],['chinese','中文阅读'],['bilingual','中英对照']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.readingMode = id; button.setAttribute('aria-pressed',String(id===mode));
    button.addEventListener('click', () => choose(id)); buttons[id] = button; toolbar.append(button);
  }
  toolbar.append(status); editor.before(toolbar); editor.after(view);
  const engine=document.createElement('select');engine.setAttribute('aria-label','翻译方式');
  for(const [value,label] of [['offline','机器速译 · CPU'],['ai','AI 精译']]){const option=document.createElement('option');option.value=value;option.textContent=label;engine.append(option);}
  toolbar.insertBefore(engine,status);
  engine.addEventListener('change',()=>{epoch++;sourceText='';translations=[];if(mode!=='original')choose(mode);});
  function collect() {
    // Paper Pal renders paragraphs as top-level sections, rather than <p>.
    return [...editor.querySelectorAll(':scope > .editor-block')].map(el => {
      const copy=el.cloneNode(true);
      copy.querySelectorAll('button,.review-link-badge,.proposal-diff').forEach(node=>node.remove());
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
      return {tag:el.classList.contains('kind-heading')?'H3':'P',text:copy.textContent.trim() || (visual.length?'［图表或公式］':''),visual:visual.join('')};
    }).filter(b => b.text);
  }
  function render() {
    const scroll=pane.scrollTop;
    view.replaceChildren();
    blocks.forEach((block,index) => {
      const item = document.createElement('div'); item.className = 'hub-translation-block';
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
    if (!document.querySelector('#structure-workspace')?.hidden) { view.hidden = true; toolbar.hidden = true; }
    else toolbar.hidden = false;
  }
  async function choose(next) {
    if (mode === 'original' && next !== 'original') originalScroll = pane.scrollTop;
    mode = next; setVisible();
    if (next === 'original') { status.textContent = ''; pane.scrollTop = originalScroll; return; }
    const found = collect(), fingerprint = JSON.stringify(found);
    if (!found.length) { status.textContent='这一页没有可翻译的正文，请先打开一个章节。'; return; }
    if (fingerprint !== sourceText) { blocks=found; sourceText=fingerprint; translations=[]; epoch++; }
    const viewKey=engine.value+':'+sourceText;
    if(completedViews.has(viewKey))translations=completedViews.get(viewKey);
    render();
    if (translations.length === blocks.length && translations.every(t=>typeof t==='string')) { status.textContent='中文辅助阅读 · 修改请选英文原文'; return; }
    if (toolbar.dataset.running === String(epoch)) return;
    const current = epoch, activePath = path;
    toolbar.dataset.running = String(current); status.textContent='正在准备中文译文…';
    try {
      let response = await fetch(prefix+'/hub/translate', {method:'POST',headers:{'Content-Type':'application/json','X-Paper-Pal':'1'},body:JSON.stringify({engine:engine.value,texts:blocks.map(b=>b.text)})});
      let job = await response.json();
      if (!response.ok) throw new Error(job.error || '翻译暂不可用');
      const progress=()=>{
        if(current!==epoch||activePath!==path)return;
        if(Array.isArray(job.translations)&&job.translations.length===blocks.length){
          translations=job.translations;
          if(mode!=='original')render();
        }
        if(mode!=='original')status.textContent=job.status==='queued'?'正在排队翻译…':`已翻译 ${job.completed} / ${job.total} 段 · 可先阅读已完成部分`;
      };
      progress();
      while (current === epoch && activePath === path && !['done','error'].includes(job.status)) {
        await new Promise(resolve=>setTimeout(resolve,400));
        response = await fetch(prefix+'/hub/translate/'+job.id); job=await response.json();
        if (!response.ok) throw new Error(job.error || '读取翻译失败，请重试');
        progress();
      }
      if (current !== epoch || activePath !== path) return;
      if (JSON.stringify(collect()) !== sourceText) throw new Error('原文已更新，请重新选择中文阅读。');
      if (job.status === 'error') throw new Error(job.error);
      translations=job.translations;
      completedViews.set(viewKey,translations);
      if(completedViews.size>20)completedViews.delete(completedViews.keys().next().value);
      if (mode !== 'original') { render(); status.textContent='中文辅助阅读 · 修改请选英文原文'; }
    } catch(error) {
      if (current === epoch && mode !== 'original') status.textContent=error.message;
    } finally { if (toolbar.dataset.running === String(current)) delete toolbar.dataset.running; }
  }
  window.addEventListener('paper-hub:document', event=> {
    const readingMode=mode;
    path=event.detail.path; epoch++; sourceText=''; blocks=[]; translations=[];
    view.replaceChildren(); status.textContent=''; setVisible();
    if(readingMode!=='original')void choose(readingMode);
  });
  window.addEventListener('paper-hub:figures-rendered',()=>{
    epoch++;sourceText='';translations=[];
    if(mode!=='original')void choose(mode);
  });
  document.querySelector('#show-structure-workspace')?.addEventListener('click',()=>{toolbar.hidden=true;view.hidden=true;});
  document.querySelector('#show-text-workspace')?.addEventListener('click',()=>{mode='original';setVisible();});
})();
