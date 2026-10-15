(() => {
  const input = document.querySelector('#codex-chat-input');
  const chat = document.querySelector('#codex-chat');
  if (!input || !chat) return;
  const slug = location.pathname.split('/')[2];
  let session = null;
  let syncConsultation = () => {};
  const memory = new Map();
  const contexts = new Map();
  const key = id => `paper-hub.draft.${slug}.${id || 'opening'}`;
  function read(id) { try { return localStorage.getItem(key(id)) || ''; } catch { return memory.get(id) || ''; } }
  function write(id, value) {
    memory.set(id, value);
    try { if (value) localStorage.setItem(key(id), value); else localStorage.removeItem(key(id)); } catch { /* In-memory drafts still survive panel closing. */ }
  }
  function contextFor(id) {
    try { return JSON.parse(localStorage.getItem(key(id)+'.context') || 'null') || contexts.get(id) || {}; }
    catch { return contexts.get(id) || {}; }
  }
  function storeContext(id, value) {
    if (value) contexts.set(id,value); else contexts.delete(id);
    try { if(value) localStorage.setItem(key(id)+'.context',JSON.stringify(value)); else localStorage.removeItem(key(id)+'.context'); } catch { /* Same-page fallback. */ }
  }
  window.paperHubChatContext = contextFor;
  window.addEventListener('paper-hub:stage-message', event => {
    const payload=event.detail,id=payload.sessionId;
    write(session,input.value); session=id; input.dataset.chatSessionId=id;
    input.value = [read(id),payload.message].filter(Boolean).join('\n\n');
    write(id,input.value);
    const {selectionContext,structureContext,newSessionIfBusy,newSessionForNewSelection}=payload;
    storeContext(id,{...contextFor(id),selectionContext,structureContext,newSessionIfBusy,newSessionForNewSelection});
    syncConsultation();
  });
  input.addEventListener('input', () => write(session, input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.stopImmediatePropagation(); // Keep the browser's newline, suppress upstream send.
  }, true);
  window.addEventListener('paper-hub:chat', event => {
    const id = event.detail.id;
    if (id && id !== session) {
      const openingContext = !session ? contextFor(null) : null;
      const opening = !session ? input.value : '';
      write(session, input.value);
      session = id;
      input.value = read(id) || opening;
      if (opening) write(id, input.value);
      if(openingContext?.webConsultation)storeContext(id,{...contextFor(id),...openingContext});
      if(openingContext)storeContext(null,null);
    }
    if (id) input.dataset.chatSessionId = id;
    syncConsultation();
  });
  window.addEventListener('paper-hub:chat-sent', event => {
    const {id,fromId,draft,context}=event.detail;
    const active=session===fromId || session===id;
    const current=active ? input.value : read(fromId);
    const remaining=current===draft ? '' : current;
    write(fromId,remaining);
    if(active) {input.value=remaining;write(id,remaining);}
    // Acknowledgement owns only the submitted snapshot. Later typing or a
    // different session/selection must survive a slow network response.
    const latest=contextFor(fromId);
    if(JSON.stringify(latest)===JSON.stringify(context || {}))storeContext(fromId,null);
    else if(active && id!==fromId)storeContext(id,latest);
    syncConsultation();
  });
  window.addEventListener('pagehide', () => write(session, input.value));
  // Move, rather than duplicate, the upstream model control and state.
  const model = document.querySelector('#agent-model-picker');
  if (model) chat.querySelector('.codex-chat-header').append(model);
  const provider=document.querySelector('#agent-picker');
  if(provider) chat.querySelector('.codex-chat-header').insertBefore(provider,model || null);
  const help = document.createElement('p'); help.className = 'hub-ai-help';
  help.textContent = '回车换行 · 点击发送才提交 · 草稿自动保留';
  chat.querySelector('.codex-chat-composer').prepend(help);
  const consultLabel=document.createElement('label');consultLabel.className='hub-ai-consultation text-button';
  const consult=document.createElement('input');consult.type='checkbox';consult.id='hub-web-consultation';
  consultLabel.append(consult,document.createTextNode(' 请 ChatGPT 网页咨询'));
  consultLabel.title='选中后点击发送才咨询；使用独立标签页，保留已有草稿。';
  chat.querySelector('.codex-chat-composer-actions').prepend(consultLabel);
  syncConsultation=()=>{consult.checked=contextFor(session).webConsultation===true;updateConsultationBadge();};
  consult.addEventListener('change',()=>{storeContext(session,{...contextFor(session),webConsultation:consult.checked,consultationRevision:Date.now()+Math.random()});});
  syncConsultation();
  input.placeholder = '告诉论文 AI 你想讨论或修改什么…';
  const details = document.createElement('details'); details.className = 'hub-ai-workspace';
  const summary = document.createElement('summary'); summary.textContent = '论文 AI 的工作区与技能';
  const body = document.createElement('p');
  body.textContent = 'Codex / Claude 使用服务器当前客户端登录的订阅；切换客户端账号后，下次请求跟随新账号。网站登录只用于进入论文库。每篇论文有自己的目录、项目技能和记录，共享全局规则与技能按任务读取最新文件。选中原文讨论后可生成候选，点击“接受修改”写入。';
  details.append(summary, body); chat.querySelector('.codex-chat-context').after(details);

  // Reuse every live upstream control; the focused phone view only changes layout.
  const mobile=matchMedia('(max-width: 1100px)'),header=chat.querySelector('.codex-chat-header');
  const actions=chat.querySelector('.codex-chat-header-actions'),composer=chat.querySelector('.codex-chat-composer');
  const messages=chat.querySelector('#codex-chat-messages');
  if(!header||!actions||!composer||!messages)return;
  const more=document.createElement('button');more.type='button';more.id='hub-ai-options-toggle';more.className='text-button';more.textContent='更多';more.setAttribute('aria-controls','hub-ai-options');
  actions.insertBefore(more,document.querySelector('#close-codex-chat'));
  const options=document.createElement('section');options.id='hub-ai-options';options.className='hub-ai-options';options.setAttribute('aria-label','论文 AI 设置');
  const optionsHeading=document.createElement('div');optionsHeading.className='hub-ai-options-heading';
  const label=document.createElement('strong');label.textContent='对话设置';optionsHeading.append(label);
  const newChat=document.querySelector('#new-codex-chat');if(newChat)optionsHeading.append(newChat);
  const models=document.createElement('div');models.className='hub-ai-options-models';
  if(provider)models.append(provider);if(model)models.append(model);
  options.append(optionsHeading,models,chat.querySelector('.codex-chat-context'),details,consultLabel,help);
  header.after(options);
  const badge=document.createElement('small');badge.className='hub-ai-consultation-badge';badge.textContent='网页咨询已开启';badge.hidden=true;header.firstElementChild.append(badge);
  function updateConsultationBadge(){const node=chat.querySelector('.hub-ai-consultation-badge');if(node)node.hidden=!consult.checked;}
  consult.addEventListener('change',updateConsultationBadge);updateConsultationBadge();
  function setOptions(open){
    const expanded=mobile.matches&&open;options.hidden=mobile.matches&&!expanded;
    more.setAttribute('aria-expanded',String(expanded));more.textContent=expanded?'收起':'更多';
    if(expanded&&document.querySelector('#toggle-chat-list')?.getAttribute('aria-expanded')==='true')document.querySelector('#toggle-chat-list').click();
  }
  more.addEventListener('click',()=>setOptions(options.hidden));
  document.querySelector('#toggle-chat-list')?.addEventListener('click',()=>setOptions(false));
  newChat?.addEventListener('click',()=>setOptions(false));
  const resume=document.createElement('button');resume.type='button';resume.id='hub-ai-resume-input';resume.className='hub-ai-resume-input';resume.textContent='继续输入…';
  composer.prepend(resume);
  function collapseComposer(){
    if(!mobile.matches||document.body.dataset.mobilePanel!=='ai')return;
    chat.classList.add('hub-ai-composer-collapsed');
    resume.textContent=input.value.trim()?'继续编辑草稿…':'继续输入…';
    if(document.activeElement===input)input.blur();
  }
  function expandComposer(focus=false){chat.classList.remove('hub-ai-composer-collapsed');if(focus)input.focus({preventScroll:true});}
  resume.addEventListener('click',()=>expandComposer(true));
  input.addEventListener('focus',()=>expandComposer());
  const activity=chat.querySelector('#codex-chat-status');
  if(activity){
    const update=()=>activity.classList.toggle('hub-ai-idle',/^(?:Ready|就绪)?$/.test(activity.textContent.trim()));
    new MutationObserver(update).observe(activity,{childList:true,characterData:true,subtree:true});update();
  }
  messages.addEventListener('wheel',event=>{if(Math.abs(event.deltaY)>3)collapseComposer();},{passive:true});
  let touchY;
  messages.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY;},{passive:true});
  messages.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(Number.isFinite(touchY)&&Number.isFinite(y)&&Math.abs(y-touchY)>12)collapseComposer();},{passive:true});
  messages.addEventListener('touchend',()=>{touchY=undefined;},{passive:true});
  messages.addEventListener('touchcancel',()=>{touchY=undefined;},{passive:true});
  let wasAI=false;
  function viewport(){
    const active=mobile.matches&&document.body.dataset.mobilePanel==='ai';
    const close=chat.querySelector('#close-codex-chat');
    if(close){close.setAttribute('aria-label',mobile.matches?'返回正文':'返回批注');close.title=mobile.matches?'返回正文':'返回批注';}
    if(active){
      const visual=window.visualViewport;
      document.documentElement.style.setProperty('--hub-ai-viewport-height',(visual?.height||innerHeight)+'px');
      document.documentElement.style.setProperty('--hub-ai-viewport-top',(visual?.offsetTop||0)+'px');
    }else{
      document.documentElement.style.removeProperty('--hub-ai-viewport-height');
      document.documentElement.style.removeProperty('--hub-ai-viewport-top');
    }
    if(active!==wasAI){setOptions(false);expandComposer();wasAI=active;}
  }
  mobile.addEventListener('change',()=>{setOptions(false);expandComposer();viewport();});
  new MutationObserver(viewport).observe(document.body,{attributes:true,attributeFilter:['data-mobile-panel']});
  window.addEventListener('resize',viewport,{passive:true});
  window.visualViewport?.addEventListener('resize',viewport,{passive:true});
  window.visualViewport?.addEventListener('scroll',viewport,{passive:true});
  setOptions(false);viewport();
})();
