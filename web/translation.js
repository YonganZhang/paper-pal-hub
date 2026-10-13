/* Per-paragraph, read-only translations. No model runs until an explicit click. */
(() => {
  const editor=document.querySelector('#editor'),pane=document.querySelector('.editor-pane');
  if(!editor||!pane)return;
  const prefix=location.pathname.replace(/\/$/,'');
  const localPrefix='paper-hub.translation-paragraph-v1.'+prefix;
  const preference='paper-hub.translation-engine.'+prefix;
  const states=new Map(),queue=[];
  let records=[],path='',mode='original',generation=0,active=0,originalScroll=0,configuration;
  const toolbar=document.createElement('div');toolbar.className='hub-reading-toolbar';toolbar.setAttribute('aria-label','翻译与阅读');
  const buttons={};
  for(const [id,label] of [['original','英文原文'],['chinese','中文阅读'],['bilingual','中英对照']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.readingMode=id;
    button.addEventListener('click',()=>{revealReading();choose(id);});toolbar.append(button);buttons[id]=button;
  }
  const engine=document.createElement('select');engine.setAttribute('aria-label','翻译方式');
  for(const [value,label] of [['ai','精翻'],['offline','机翻（阅读草稿）']]){const option=document.createElement('option');option.value=value;option.textContent=label;engine.append(option);}
  try{const selected=localStorage.getItem(preference);if(['ai','offline'].includes(selected))engine.value=selected;}catch{}
  toolbar.append(engine);
  const status=document.createElement('span');status.className='hub-translation-status';status.setAttribute('role','status');toolbar.append(status);
  const header=document.querySelector('.topbar');if(header)header.append(toolbar);else editor.before(toolbar);
  const view=document.createElement('section');view.id='hub-translation-view';view.hidden=true;view.setAttribute('aria-label','中文辅助阅读');editor.after(view);
  function config(reload=false){
    if(!configuration||reload)configuration=fetch(prefix+'/hub/translation-config').then(async r=>{if(!r.ok)throw new Error('翻译配置读取失败，请重试。');return r.json();}).catch(error=>{configuration=null;throw error;});
    return configuration;
  }
  config().catch(error=>{status.textContent=error.message;configuration=null;});
  function collect(){
    return [...editor.querySelectorAll(':scope > .paper-front > .paper-title,:scope > .editor-block')].filter(el=>!el.hidden&&!el.reviewBlock?.hidden).map(el=>{
      const copy=el.cloneNode(true);
      copy.querySelectorAll('button,.review-link-badge,.review-number,.proposal-diff,.proposal-delete,[hidden]').forEach(n=>n.remove());
      copy.querySelectorAll('figcaption > code').forEach(n=>{if(/^(?:fig|tab|eq|sec|app):[\w:.-]+$/.test(n.textContent.trim()))n.remove();});
      const visual=[];
      for(const node of copy.querySelectorAll(':scope > .latex-figure-panels,:scope > .latex-figure-link,:scope > .latex-figure-image,:scope > .latex-table-wrap,:scope > .display-formula,:scope > .compiled-fallback')){
        let retained=node;
        if(node.matches('.compiled-fallback')){retained=node.querySelector('a');if(retained)retained.textContent=el.matches('.kind-table')?'查看原表 PDF ↗':'查看原图 PDF ↗';}
        if(retained){
          for(const child of [retained,...retained.querySelectorAll('*')]){child.removeAttribute('id');child.removeAttribute('data-review-request-id');if(child.hasAttribute('contenteditable'))child.setAttribute('contenteditable','false');}
          visual.push(retained.outerHTML);
        }
        node.remove();
      }
      for(const child of [copy,...copy.querySelectorAll('*')]){child.removeAttribute('id');if(child.hasAttribute('contenteditable'))child.setAttribute('contenteditable','false');}
      const prose=copy.cloneNode(true),math=[];
      copy.querySelectorAll('.katex').forEach(n=>{
        const latex=n.querySelector('annotation')?.textContent;
        const token=latex?'\\('+latex+'\\)':'［公式见原文］';
        math.push({token,node:n.cloneNode(true)});n.replaceWith(token);
      });
      return {element:el,tag:el.matches('.kind-heading,.paper-title')?'H3':'P',text:copy.textContent.trim(),prose,math,visual:visual.join(''),proposal:el.classList.contains('has-proposal')};
    }).filter(b=>b.text||b.visual);
  }
  window.paperHubTranslationSnapshot=()=>({path,texts:collect().filter(b=>b.text).map(b=>b.text)});
  async function stateFor(text,selected=engine.value){
    const currentConfig=await config(),revision=currentConfig.revisions?.[selected];
    if(typeof revision!=='string')throw new Error('翻译配置不完整，请刷新重试。');
    const bytes=new TextEncoder().encode(JSON.stringify([revision,text]));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const key=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(states.has(key))return states.get(key);
    const state={key,text,engine:selected,revision,value:'',pending:false,error:'',phase:'',started:0};
    try{const saved=JSON.parse(localStorage.getItem(localPrefix+'.'+key)||'null');if(typeof saved?.text==='string'&&saved.text.trim()){state.value=saved.text;state.savedAt=saved.savedAt;}}catch{}
    states.set(key,state);return state;
  }
  function remember(state){
    try{
      const index=JSON.parse(localStorage.getItem(localPrefix+'.index')||'[]').filter(k=>k!==state.key);index.push(state.key);
      while(index.length>250)localStorage.removeItem(localPrefix+'.'+index.shift());
      localStorage.setItem(localPrefix+'.'+state.key,JSON.stringify({text:state.value,savedAt:state.savedAt}));
      localStorage.setItem(localPrefix+'.index',JSON.stringify(index));
    }catch{} // Memory/server caches remain available when storage is disabled/full.
    // Retain live work and current records, limit completed historical entries.
    if(states.size>300)for(const [key,item] of states){if(!item.pending&&!records.some(r=>r.state===item)){states.delete(key);if(states.size<=250)break;}}
  }
  function summary(){
    const label=engine.value==='ai'?'精翻':'机翻';
    const ready=records.filter(r=>r.state?.value).length,total=records.filter(r=>r.text).length;
    status.textContent=(mode==='original'?'逐段翻译':'中文辅助阅读')+' · 当前'+label+' · '+ready+'/'+total+'段已有译文 · 点击段落旁“翻译本段”';
  }
  function panel(record,inView){
    const root=document.createElement('aside');root.className='hub-paragraph-tools';root.contentEditable='false';root.setAttribute('aria-label','第'+(record.index+1)+'段翻译');
    const bar=document.createElement('div');bar.className='hub-paragraph-actions';
    const translate=document.createElement('button');translate.type='button';translate.className='hub-paragraph-translate';
    const refresh=document.createElement('button');refresh.type='button';refresh.className='hub-paragraph-refresh';refresh.textContent='重新翻译';refresh.title='仅重新生成本段译文，绕过旧缓存';
    const collapse=document.createElement('button');collapse.type='button';collapse.className='hub-paragraph-collapse';collapse.textContent='收起译文';
    const note=document.createElement('small');note.className='hub-paragraph-status';note.setAttribute('role','status');
    const result=document.createElement('div');result.className='hub-paragraph-value';result.hidden=true;
    if(record.proposal){const proposalNote=document.createElement('small');proposalNote.className='hub-translation-pending';proposalNote.textContent='待确认修改的中文预览';root.append(proposalNote);}
    bar.append(translate,refresh,collapse);root.append(bar,note,result);
    for(const button of [translate,refresh,collapse]){button.addEventListener('pointerdown',event=>event.stopPropagation());button.addEventListener('click',event=>event.stopPropagation());}
    translate.addEventListener('click',()=>{record.open=true;void request(record,record.changed);});
    refresh.addEventListener('click',()=>{record.open=true;void request(record,true);});
    collapse.addEventListener('click',()=>{record.open=false;paint();});
    return {root,translate,refresh,collapse,note,result,inView};
  }
  function paintPanel(record,ui){
    if(!ui)return;
    const state=record.state,value=state?.value||'',pending=!!state?.pending,shown=(ui.inView||record.open)&&!!value;
    ui.translate.disabled=pending;
    ui.translate.textContent=pending?'翻译中…':value?'查看译文':record.changed?'重新翻译':'翻译本段';
    ui.translate.hidden=shown&&!pending;
    ui.refresh.hidden=!value;ui.refresh.disabled=pending;
    ui.collapse.hidden=ui.inView||!shown;
    ui.result.hidden=!shown;
    if(ui.value!==value){
      ui.value=value;ui.result.replaceChildren();
      for(const part of value.split(/(\\\([\s\S]*?\\\))/g)){
        const formula=record.math.find(item=>item.token===part);
        ui.result.append(formula?formula.node.cloneNode(true):document.createTextNode(part));
      }
    }
    const parts=[];
    if(pending){parts.push((state.phase==='queued'?'排队等待':state.engine==='ai'?'精翻生成中':'机翻处理中')+' · 已等'+Math.floor((Date.now()-state.started)/1000)+'秒');if(value)parts.push('暂显示上次译文');}
    else if(state?.error)parts.push(state.error);
    else if(record.error)parts.push(record.error);
    else if(record.changed&&!value)parts.push('原文已修改，请重新翻译');
    else if(value)parts.push((state.engine==='ai'?'精翻':'机翻')+' · 已保存'+(Number.isFinite(state.elapsed)?' · 本次等待'+(state.elapsed/1000).toFixed(1)+'秒':''));
    ui.note.textContent=parts.join(' · ');ui.note.hidden=parts.length===0;
  }
  function paint(){for(const record of records){paintPanel(record,record.inline);if(record.reader)paintPanel(record,record.reader);}summary();}
  function buildView(){
    const scroll=pane.scrollTop;view.replaceChildren();
    for(const record of records){
      const block=document.createElement('div');block.className='hub-translation-block';
      if(record.visual){const media=document.createElement('div');media.className='hub-translation-media';const template=document.createElement('template');template.innerHTML=record.visual;media.append(template.content);block.append(media);}
      // Never hide an untranslated paragraph while its translation is pending.
      if(record.text){
        const original=document.createElement(record.tag==='H3'?'h3':'p');original.className='hub-translation-original';
        original.append(...[...record.prose.childNodes].map(node=>node.cloneNode(true)));block.append(original);
        record.original=original;record.reader=panel(record,true);block.append(record.reader.root);
      }
      view.append(block);
    }
    paint();pane.scrollTop=scroll;
  }
  function updateOriginalVisibility(){for(const record of records)if(record.original)record.original.hidden=mode==='chinese'&&!!record.state?.value;}
  function sync(){
    const current=++generation,found=collect(),previous=new Map(records.map(r=>[r.element,r]));
    for(const record of records)record.inline?.root.remove();
    records=found.map((block,index)=>{
      const old=previous.get(block.element),same=old?.text===block.text;
      const record={...block,index,state:same&&old?.state?.engine===engine.value?old.state:null,open:same?old.open:false,changed:old?(!same||old.changed):false};
      if(record.text){record.inline=panel(record,false);block.element.after(record.inline.root);}return record;
    });
    if(mode!=='original')buildView();else paint();
    for(const record of records.filter(r=>r.text))void stateFor(record.text).then(state=>{if(current!==generation)return;record.state=state;record.error='';paintPanel(record,record.inline);if(record.reader)paintPanel(record,record.reader);updateOriginalVisibility();summary();}).catch(error=>{if(current===generation){record.error=error.message;paint();}});
  }
  async function request(record,refresh=false){
    const selected=engine.value;
    try{
      record.error='';
      const state=record.state?.engine===selected?record.state:await stateFor(record.text,selected);
      const currentRecord=records.find(r=>r.element===record.element&&r.text===record.text);
      if(currentRecord&&selected===engine.value){currentRecord.state=state;currentRecord.open=true;}
      if(state.pending){paint();return;}
      if(state.value&&!refresh){paint();updateOriginalVisibility();return;}
      state.pending=true;state.error='';state.phase='queued';state.started=Date.now();
      if(refresh)try{localStorage.removeItem(localPrefix+'.'+state.key);}catch{}
      queue.push({state,refresh});paint();drain();
    }catch(error){record.error=error.message;paint();}
  }
  function drain(){while(active<2&&queue.length){active++;const work=queue.shift();void translate(work).finally(()=>{active--;drain();});}}
  async function translate({state,refresh}){
    try{
      state.phase='running';paint();
      let response=await fetch(prefix+'/hub/translate',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Pal':'1'},body:JSON.stringify({engine:state.engine,texts:[state.text],revision:state.revision,refresh})});
      let job=await response.json();
      if(!response.ok){if(response.status===409){configuration=null;void config().then(()=>sync()).catch(()=>{});}throw new Error(job.error||'翻译暂不可用，请重试本段。');}
      for(;;){
        if(job.status==='error')throw new Error(job.error||'本段翻译未完成，请重试。');
        if(job.status==='done'){
          if(!Array.isArray(job.translations)||job.translations.length!==1||typeof job.translations[0]!=='string'||!job.translations[0].trim())throw new Error('本段译文不完整，请重试。');
          state.value=job.translations[0];state.savedAt=new Date().toISOString();state.elapsed=Date.now()-state.started;remember(state);return;
        }
        state.phase=job.status==='queued'?'queued':'running';paint();
        await new Promise(resolve=>setTimeout(resolve,250));response=await fetch(prefix+'/hub/translate/'+job.id);job=await response.json();
        if(!response.ok)throw new Error(job.error||'读取本段翻译失败，请重试。');
      }
    }catch(error){state.error=error.message;}
    finally{state.pending=false;paint();updateOriginalVisibility();}
  }
  function revealReading(){
    if(document.querySelector('#structure-workspace')?.hidden===false)document.querySelector('#show-text-workspace')?.click();
    if(document.body.dataset.mobilePanel)document.querySelector('.hub-close-panel')?.click();
    if(document.querySelector('#paper-preview')?.hidden===false)document.querySelector('#close-paper-preview')?.click();
  }
  function choose(next){
    if(mode==='original'&&next!=='original')originalScroll=pane.scrollTop;
    mode=next;editor.hidden=next!=='original';view.hidden=next==='original';
    for(const [id,button] of Object.entries(buttons))button.setAttribute('aria-pressed',String(id===mode));
    if(mode==='original'){for(const record of records)record.open=false;paint();pane.scrollTop=originalScroll;}
    else{buildView();updateOriginalVisibility();}
    if(document.querySelector('#structure-workspace')?.hidden===false)view.hidden=true;
  }
  engine.addEventListener('change',()=>{try{localStorage.setItem(preference,engine.value);}catch{}sync();});
  window.addEventListener('paper-hub:document',event=>{path=event.detail.path;sync();choose(mode);});
  window.addEventListener('paper-hub:figures-rendered',sync);
  document.querySelector('#show-structure-workspace')?.addEventListener('click',()=>{view.hidden=true;});
  document.querySelector('#show-text-workspace')?.addEventListener('click',()=>choose('original'));
  let timer;
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(sync,80);};
  new MutationObserver(changes=>{
    if(changes.some(change=>{
      const target=change.target.nodeType===1?change.target:change.target.parentElement;
      return target?.closest('.editor-block,.paper-title')||[...change.addedNodes,...change.removedNodes].some(node=>node.nodeType===1&&node.matches('.editor-block,.paper-front'));
    }))schedule();
  }).observe(editor,{subtree:true,childList:true,characterData:true});
  editor.addEventListener('input',event=>{if(event.target.closest('.editor-block'))sync();});
  setInterval(()=>{if(records.some(r=>r.state?.pending))paint();},500);
  sync();choose('original');
})();
