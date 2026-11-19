// Runs on Canvas course pages. Lets the popup (or the "+ Library" buttons on the Modules page) import
// modules using the user's existing Canvas session.
(() => {
  if (window.__canvasLibraryLoaded) return;
  window.__canvasLibraryLoaded = true;

  const { createApi, runImport } = window.CanvasLibraryCrawler;
  const courseIdFromUrl = () => location.pathname.match(/^\/courses\/(\d+)/)?.[1] || null;
  let running = false;

  async function post(path, body) {
    const r = await chrome.runtime.sendMessage({ type: 'server', method: 'POST', path, body });
    if (!r?.ok) throw new Error(r?.error || `server error ${r?.status}`);
    return r.data;
  }

  function setJob(job) {
    const full = { ...job, updatedAt: Date.now() };
    try {
      chrome.storage.local.set({ job: full });
    } catch {
      /* extension reloaded while the page was open */
    }
    showToast(full);
  }

  async function startImport({ moduleIds, withFiles }) {
    const courseId = courseIdFromUrl();
    if (running) throw new Error('An import is already running in this tab.');
    if (!courseId) throw new Error('Open a course page first.');
    running = true;
    const base = { courseId, startedAt: Date.now() };
    setJob({ ...base, status: 'running', message: 'Starting…' });
    try {
      const summary = await runImport({
        api: createApi({ origin: location.origin }),
        origin: location.origin,
        courseId,
        moduleIds,
        withFiles,
        post,
        onProgress: (message) => setJob({ ...base, status: 'running', message }),
      });
      const parts = [`Added ${summary.modules} module${summary.modules === 1 ? '' : 's'} (${summary.items} items)`];
      if (withFiles) parts.push(`${summary.downloaded} file${summary.downloaded === 1 ? '' : 's'} downloaded`);
      setJob({ ...base, status: 'done', message: parts.join(', '), summary });
    } catch (e) {
      setJob({ ...base, status: 'error', message: String(e.message || e) });
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cl:probe') {
      (async () => {
        const courseId = courseIdFromUrl();
        if (!courseId) return sendResponse({ canvas: false });
        try {
          const api = createApi({ origin: location.origin });
          const [course, modules] = await Promise.all([api.getCourse(courseId), api.listModules(courseId)]);
          sendResponse({ canvas: true, origin: location.origin, course, modules, running });
        } catch (e) {
          sendResponse({ canvas: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg?.type === 'cl:import') {
      startImport(msg).catch(() => {});
      sendResponse({ started: true });
    }
    return false;
  });

  /* ---------- toast shown on the page while an import runs ---------- */
  let toastEl;
  let hideTimer;
  function showToast(job) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'cl-toast';
      document.body.appendChild(toastEl);
    }
    clearTimeout(hideTimer);
    toastEl.className = `cl-${job.status}`;
    toastEl.textContent = `Canvas Library: ${job.message}`;
    toastEl.style.display = 'block';
    if (job.status !== 'running') hideTimer = setTimeout(() => (toastEl.style.display = 'none'), 7000);
  }

  /* ---------- "+ Library" button on each module of the Modules page ---------- */
  function injectButtons() {
    document.querySelectorAll('.context_module').forEach((el) => {
      if (el.querySelector('.cl-add')) return;
      const moduleId = el.id?.match(/context_module_(\d+)/)?.[1] || el.dataset.moduleId;
      const header = el.querySelector('.ig-header, .header');
      if (!moduleId || !header) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cl-add';
      btn.textContent = '+ Library';
      btn.title = 'Add this module to your Canvas Library';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const { withFiles = true } = await chrome.storage.local.get('withFiles').catch(() => ({}));
        startImport({ moduleIds: [moduleId], withFiles }).catch((e) => showToast({ status: 'error', message: e.message }));
      });
      (header.querySelector('.header-bar-right') || header).appendChild(btn);
    });
  }

  if (/^\/courses\/\d+\/modules/.test(location.pathname)) {
    let timer;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(injectButtons, 300);
    }).observe(document.body, { childList: true, subtree: true });
    injectButtons();
  }
})();
