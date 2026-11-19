const SERVER = 'http://127.0.0.1:47821';
const $ = (s) => document.querySelector(s);
const body = $('#body');

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
}

async function serverGet(path) {
  const r = await fetch(SERVER + path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function main() {
  // 1. Is the local library server up?
  let library = null;
  try {
    await serverGet('/api/health');
    library = (await serverGet('/api/library')).courses;
    $('#server').textContent = 'server online';
    $('#server').className = 'pill ok';
  } catch {
    $('#server').textContent = 'server offline';
    $('#server').className = 'pill bad';
  }

  // 2. Are we on a Canvas course page?
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let probe = null;
  try {
    probe = await chrome.tabs.sendMessage(tab.id, { type: 'cl:probe' });
  } catch {
    /* no content script on this page */
  }

  if (!probe?.canvas) {
    body.replaceChildren(
      el('p', { className: 'msg' }, 'Open a Canvas course page (any page under ', el('code', { textContent: '/courses/…' }), ') and click this icon again. If you already have one open, reload it once so the extension can attach.'),
    );
    if (!library) showOffline();
    return;
  }
  if (!library) showOffline(true);

  const { course, modules } = probe;
  const inLibrary = new Map(((library || []).find((c) => c.id === course.id)?.modules || []).map((m) => [m.id, m]));
  const { withFiles = true } = await chrome.storage.local.get('withFiles');

  const list = el('div', { className: 'list' });
  const boxes = [];
  for (const m of modules) {
    const box = el('input', { type: 'checkbox', value: m.id });
    box.checked = !inLibrary.has(m.id);
    boxes.push(box);
    const have = inLibrary.get(m.id);
    list.append(
      el('label', { className: 'mod' }, box, el('span', { className: 'n', textContent: m.name, title: m.name }),
        have ? el('span', { className: 'tag', textContent: 'in library' }) : el('span', { className: 'cnt', textContent: m.itemsCount != null ? `${m.itemsCount} items` : '' })),
    );
  }

  const filesBox = el('input', { type: 'checkbox' });
  filesBox.checked = withFiles;
  filesBox.addEventListener('change', () => chrome.storage.local.set({ withFiles: filesBox.checked }));

  const addBtn = el('button', { className: 'primary' });
  const status = el('div', { className: 'status', hidden: true });
  const refreshBtn = () => {
    const n = boxes.filter((b) => b.checked).length;
    addBtn.textContent = n ? `Add ${n} module${n === 1 ? '' : 's'} to library` : 'Select modules to add';
    addBtn.disabled = !n || !library || status.dataset.running === '1';
  };
  boxes.forEach((b) => b.addEventListener('change', refreshBtn));

  const setAll = (v) => { boxes.forEach((b) => (b.checked = v)); refreshBtn(); };
  const tools = el('div', { className: 'tools' }, el('span', { textContent: `${modules.length} modules` }),
    el('span', {}, Object.assign(el('button', { textContent: 'All' }), { onclick: () => setAll(true) }), ' · ',
      Object.assign(el('button', { textContent: 'None' }), { onclick: () => setAll(false) })));

  addBtn.onclick = async () => {
    const moduleIds = boxes.filter((b) => b.checked).map((b) => b.value);
    status.dataset.running = '1';
    renderJob({ status: 'running', message: 'Starting…' });
    await chrome.tabs.sendMessage(tab.id, { type: 'cl:import', moduleIds, withFiles: filesBox.checked });
  };

  function renderJob(job) {
    if (!job || job.courseId && job.courseId !== course.id) return;
    status.hidden = false;
    status.className = `status ${job.status}`;
    status.textContent = job.message;
    status.dataset.running = job.status === 'running' ? '1' : '0';
    if (job.status === 'done') {
      for (const b of boxes) if (b.checked) b.parentElement.querySelector('.cnt, .tag')?.replaceWith(el('span', { className: 'tag', textContent: 'in library' }));
      if (job.summary?.notDownloaded?.length) status.textContent += ` — ${job.summary.notDownloaded.length} file(s) could not be downloaded`;
    }
    refreshBtn();
  }

  body.replaceChildren(
    el('div', { className: 'course' }, course.name, el('small', { textContent: [course.code, course.term].filter(Boolean).join(' · ') })),
    tools,
    list,
    el('label', { className: 'opt' }, filesBox, 'Also download files (PDFs, slides, documents)'),
    addBtn,
    status,
  );
  refreshBtn();

  const { job } = await chrome.storage.local.get('job');
  if (job && Date.now() - job.updatedAt < 10 * 60 * 1000) renderJob(job);
  if (probe.running) status.dataset.running = '1', refreshBtn();
  chrome.storage.onChanged.addListener((changes) => changes.job && renderJob(changes.job.newValue));
}

function showOffline(append) {
  const msg = el('p', { className: 'msg' }, 'The library server is not running. Start it with ', el('code', { textContent: 'npm run server' }),
    ' in the canvas-library folder, or open Claude with the canvas-library MCP server enabled.');
  if (append) body.append(msg);
  else body.replaceChildren(msg);
}

main().catch((e) => body.replaceChildren(el('p', { className: 'msg', textContent: String(e.message || e) })));
