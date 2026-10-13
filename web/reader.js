/* Keep navigation metadata only; manuscript content stays in Paper Pal. */
(() => {
  const slug = location.pathname.match(/^\/papers\/([a-z0-9-]+)\//)?.[1];
  if (!slug) return;
  const key = `paper-hub.reading.${slug}`;
  const documentKey = `paper-pal.${slug}.openDocument`;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(key));
    if (typeof saved?.path === 'string' && !sessionStorage.getItem(documentKey)) {
      sessionStorage.setItem(documentKey, saved.path);
    }
  } catch { /* Storage is optional, including in private browsing. */ }
  const pane = document.querySelector('.editor-pane');
  const editor = document.querySelector('#editor');
  if (!pane || !editor) return;
  let currentPath = '', firstLoad = true, pending = null, timer, waitingForFonts = false;
  const blocks = () => [...editor.querySelectorAll('[id^="block-"]')];
  function save() {
    if (!currentPath || pending || editor.hidden) return;
    const top = pane.getBoundingClientRect().top;
    const block = blocks().find(el => el.getBoundingClientRect().bottom > top + 4);
    if (!block) return;
    const record = {
      path: currentPath, blockId: block.id,
      offset: block.getBoundingClientRect().top - top, scrollTop: pane.scrollTop,
      heading: (document.querySelector('#document-title')?.textContent || currentPath).slice(0, 120),
      visitedAt: Date.now()
    };
    try { localStorage.setItem(key, JSON.stringify(record)); } catch { /* Optional. */ }
  }
  function restore() {
    if (pending) {
      if (!blocks().length) return;
      if (waitingForFonts) return;
      // Layout starts font requests; restoring before they settle moves the
      // paragraph again when fallback fonts are replaced.
      pane.getBoundingClientRect();
      waitingForFonts = true;
      (document.fonts?.ready || Promise.resolve()).then(() => {
        waitingForFonts = false;
        finishRestore();
        save();
      });
      return;
    }
    save();
  }
  function finishRestore() {
    if (pending) {
      const block = blocks().find(el => el.id === pending.blockId);
      if (block && Number.isFinite(pending.offset)) {
        pane.scrollTop += block.getBoundingClientRect().top - pane.getBoundingClientRect().top - pending.offset;
      } else if (Number.isFinite(pending.scrollTop)) pane.scrollTop = pending.scrollTop;
      pending = null;
    }
  }
  window.addEventListener('paper-hub:document', event => {
    currentPath = event.detail.path;
    pending = firstLoad && saved?.path === currentPath ? saved : null;
    firstLoad = false;
    requestAnimationFrame(restore);
  });
  new MutationObserver(() => requestAnimationFrame(restore)).observe(editor, {childList: true});
  pane.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(save, 250); }, {passive: true});
  // Explicit navigation wins over delayed initial rendering.
  for (const type of ['pointerdown', 'keydown']) pane.addEventListener(type, () => { pending = null; }, true);
  window.addEventListener('pagehide', save);
})();
