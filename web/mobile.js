/* Mobile panes reuse the original controls and Paper Pal state, never copies. */
(() => {
  const mobile = matchMedia('(max-width: 1100px)');
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  const header = document.querySelector('.topbar');
  const editor = document.querySelector('.editor-pane');
  const outline = document.querySelector('.outline-rail');
  const comments = document.querySelector('.comments-pane');
  const home = document.createElement('a'); home.className = 'hub-home'; home.href = '/'; home.textContent = '← 论文库';
  document.querySelector('.brand').append(home);
  const nav = document.createElement('nav'); nav.className = 'hub-mobile-nav'; nav.setAttribute('aria-label', '手机审阅导航');
  const back = document.createElement('a'); back.href = '/'; back.textContent = '论文库'; nav.append(back);
  for (const [panel, label] of [['outline', '章节'], ['comments', '批注'], ['ai', '论文 AI'], ['settings', '设置']]) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.panel = panel; button.textContent = label; button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => setPanel(document.body.dataset.mobilePanel === panel ? '' : panel)); nav.append(button);
  }
  shell.append(nav);
  const close = document.createElement('button'); close.className = 'hub-close-panel'; close.type = 'button'; close.textContent = '返回正文 ×'; close.addEventListener('click', () => setPanel('')); shell.append(close);
  const saveLabels = { 'preview-button': 'PDF', 'compile-button': '编译', 'reload-button': '刷新', 'undo-button': '撤销' };
  for (const [id, label] of Object.entries(saveLabels)) document.getElementById(id).textContent = label;
  let previousFocus;
  function setPanel(panel) {
    if (!mobile.matches) panel = '';
    if (panel) {
      const pdf = document.querySelector('#paper-preview');
      if (pdf && !pdf.hidden) document.querySelector('#close-paper-preview')?.click();
    }
    const wasOpen = document.body.dataset.mobilePanel;
    document.body.dataset.mobilePanel = panel;
    editor.inert = mobile.matches && ['outline', 'comments', 'ai'].includes(panel);
    outline.inert = mobile.matches && panel !== 'outline';
    comments.inert = mobile.matches && !['comments', 'ai'].includes(panel);
    for (const button of nav.querySelectorAll('button')) button.setAttribute('aria-expanded', String(button.dataset.panel === panel));
    close.hidden = !['outline', 'comments', 'ai'].includes(panel);
    close.textContent = panel === 'ai' ? '收起论文 AI ×' : '返回正文 ×';
    if (panel && !wasOpen) previousFocus = document.activeElement;
    if (!panel && wasOpen && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    requestAnimationFrame(measure);
  }
  function measure() { document.documentElement.style.setProperty('--hub-header-height', `${header.getBoundingClientRect().height}px`); }
  new ResizeObserver(measure).observe(header);
  mobile.addEventListener('change', () => setPanel(''));
  setPanel('');
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobile.matches && document.body.dataset.mobilePanel) { event.preventDefault(); setPanel(''); }
    if (event.key === 'Tab' && mobile.matches && ['outline', 'comments', 'ai'].includes(document.body.dataset.mobilePanel)) {
      // AI intentionally reuses the original .codex-chat inside comments-pane.
      // The locked index.html and browser workflow cover this upstream structure.
      const pane = document.body.dataset.mobilePanel === 'outline' ? outline : comments;
      const controls = [...pane.querySelectorAll('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]'), close, ...nav.querySelectorAll('a,button')].filter(el => el.getClientRects().length);
      if (!controls.length) return;
      const index = controls.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0].focus(); }
    }
  });
  document.querySelector('#outline-list').addEventListener('click', event => {
    if (mobile.matches && event.target.closest('button,a')) setPanel('');
  });
  document.querySelector('#document-select').addEventListener('change', () => setPanel(''));
  comments.addEventListener('click', event => {
    if (mobile.matches && event.target.closest('button.request-location')) setPanel('');
  }, true);
  nav.querySelector('[data-panel="comments"]').addEventListener('click', () => {
    if (document.body.dataset.mobilePanel === 'comments') document.querySelector('#show-comments-pane')?.click();
  });
  nav.querySelector('[data-panel="ai"]').addEventListener('click', () => {
    if (document.body.dataset.mobilePanel === 'ai') document.querySelector('#open-codex-chat')?.click();
  });
  document.querySelector('#open-codex-chat')?.addEventListener('click', () => {
    if (mobile.matches) setPanel('ai');
  });
  document.querySelector('#close-codex-chat')?.addEventListener('click', () => {
    if (mobile.matches) setPanel('');
  });
  new MutationObserver(() => {
    if (mobile.matches && !document.querySelector('#codex-chat').hidden) setPanel('ai');
  }).observe(document.querySelector('#codex-chat'), {attributes:true,attributeFilter:['hidden']});
  const composer = document.querySelector('#comment-composer');
  new MutationObserver(() => {
    if (mobile.matches && !composer.hidden) setPanel('comments');
  }).observe(composer, { attributes: true, attributeFilter: ['hidden'] });
  document.querySelector('#review-section').addEventListener('click', () => { if (mobile.matches) setPanel('comments'); });
  editor.addEventListener('click', event => {
    if (mobile.matches && event.target.closest('[data-review-request-id]')) setPanel('comments');
  }, true);
  document.querySelector('#preview-button').addEventListener('click', () => { if (mobile.matches) setPanel(''); });
  const preview = document.querySelector('#paper-preview');
  // Upstream nests the PDF inside the sidebar, which is hidden on phones.
  // Fixed positioning is unchanged on desktop; outside the pane it stays usable.
  document.body.append(preview);
  const pdfLink = document.createElement('a'); pdfLink.className = 'hub-pdf-link'; pdfLink.href = location.pathname.replace(/\/$/, '') + '/api/pdf'; pdfLink.target = '_blank'; pdfLink.rel = 'noopener'; pdfLink.textContent = '新窗口查看 PDF ↗';
  preview.querySelector('.paper-preview-header')?.append(pdfLink);
})();
