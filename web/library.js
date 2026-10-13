let papers = [];
const grid = document.querySelector('#paper-grid');
function reading(id) {
  try { return JSON.parse(localStorage.getItem(`paper-hub.reading.${id}`)) || {}; }
  catch { return {}; }
}
function render() {
  const query = document.querySelector('#search').value.trim().toLocaleLowerCase();
  const visible = papers.filter(p => [p.title, p.description, ...(p.tags || [])].join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => (Number(reading(b.id).visitedAt) || 0) - (Number(reading(a.id).visitedAt) || 0));
  grid.replaceChildren();
  for (const [index, p] of visible.entries()) {
    const card = document.createElement('article'); card.className = 'paper-card';
    const head = document.createElement('div'); head.className = 'card-top';
    const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
    const status = document.createElement('span'); status.className = p.ready ? 'ready' : 'offline'; status.textContent = p.ready ? '可审阅' : '暂时离线'; head.append(number, status);
    const title = document.createElement('h3'); title.textContent = p.title;
    const description = document.createElement('p'); description.textContent = p.description || '打开论文，继续你的审阅。';
    const tags = document.createElement('div'); tags.className = 'tags';
    for (const tag of p.tags || []) { const item = document.createElement('span'); item.textContent = tag; tags.append(item); }
    const last = reading(p.id);
    const resume = document.createElement('p'); resume.className = 'resume-note'; resume.hidden = !last.path;
    resume.textContent = `上次阅读：${last.heading || last.path}`;
    const link = document.createElement('a'); link.href = p.url; link.className = 'open-paper'; link.textContent = p.ready ? (last.path ? '继续审阅 →' : '进入论文 →') : '论文暂时离线 →';
    card.append(head, title, description, tags, resume, link); grid.append(card);
  }
  if (!visible.length) { const message = document.createElement('p'); message.textContent = papers.length ? '没有匹配的论文。' : '还没有接入论文。'; grid.append(message); }
}
document.querySelector('#search').addEventListener('input', render);
fetch('/api/papers').then(async response => {
  if (!response.ok) throw new Error('暂时无法读取论文库，请刷新重试。');
  papers = (await response.json()).papers;
  document.querySelector('#paper-count').textContent = String(papers.length);
  render();
}).catch(error => { grid.replaceChildren(); const el = document.querySelector('#library-error'); el.hidden = false; el.textContent = error.message; });
