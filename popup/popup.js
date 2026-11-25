import { FEATURES, presetConfig, siteKey } from '../shared/features.js';
import { sourceUrl } from '../shared/usmeta.js';
import { safeBase } from '../shared/names.js';
import { cleanPageLink, matchesMediaFilter } from '../shared/utilities.js';
import { OFFICIAL_REPOSITORY } from '../shared/updates.js';
import { WINDOWS_UPDATER_AVAILABLE } from '../shared/native-updater-config.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const runningManifest = chrome.runtime.getManifest();
const runningVersion = runningManifest.version_name || runningManifest.version;
const versionBadge = $('#extension-version');
versionBadge.textContent = 'v' + runningVersion;
versionBadge.title = 'Running extension version ' + runningVersion;
versionBadge.setAttribute('aria-label', versionBadge.title);
versionBadge.hidden = false;

let tabId = null;
let state = null;
const cards = new Map();   // item id -> card controller
let mediaFilter = 'all', refreshing = false;

/* ---------------------------------------------------------------- helpers */
async function bg(type, extra) {
  const r = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!r) throw new Error('The extension did not respond. Reload it and reopen the toolbox.');
  // Saved-script errors describe execution warnings, not failed storage writes.
  if (r.error && !(['us:save', 'us:toggle'].includes(type) && r.id)) { const e = new Error(r.error); e.diag = r.diag; e.code = r.code; throw e; }
  return r;
}

// "Copy diagnostics" button shown under an error; the report never contains cookies or token values.
function makeDiagButton() {
  const b = el('button', 'btn', 'Copy diagnostics');
  b.hidden = true;
  b.dataset.report = '';
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.report); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy diagnostics'; }, 1800); }
    catch (error) { status('Clipboard unavailable: ' + error.message, 'err'); }
  };
  return b;
}
function setDiag(b, report) { b.dataset.report = report || ''; b.hidden = !report; }
const fmtBytes = (n) => !n ? '' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ''; } };
const fileOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (e) { return ''; } };
const cleanTitle = (t) => String(t || '').replace(/\s*[|–—-]\s*(ALLEN.*|Digital Class.*|LMS.*)$/i, '').trim();

function status(msg, cls) {
  const s = $('#status');
  if (s.textContent !== String(msg)) s.textContent = msg;
  if (s.className !== (cls || '')) s.className = cls || '';
}

async function ensureOrigins(urls) {
  const need = [...new Set(urls.map(siteKey).filter(Boolean))].map((o) => o + '/*');
  const missing = [];
  for (const o of need) if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing });
}
const hasOrigin = (url) => siteKey(url) ? chrome.permissions.contains({ origins: [siteKey(url) + '/*'] }) : Promise.resolve(false);

function wireAction(button, run) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true; button.dataset.busy = '1';
    try { await run(); } catch (error) { status(error.message || String(error), 'err'); }
    finally { delete button.dataset.busy; button.disabled = false; }
  });
}

async function saveTextFile(text, filename, mime = 'text/plain') {
  if (!text) throw new Error('There is no text to save on this page.');
  await chrome.downloads.download({ url: 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text), filename, saveAs: true });
  status('Download queued. Browser downloads shows the final result.', 'ok');
}

const pageFilename = (extension) => (safeBase(state && state.title || 'page', { strict: false }) || 'page') + extension;

/* ------------------------------------------------------------------ tabs */
function updateTabIndicator() {
  const nav = $('#tabs'), active = nav.querySelector('button[aria-selected="true"]');
  if (!active) return;
  const parent = nav.getBoundingClientRect(), button = active.getBoundingClientRect();
  nav.style.setProperty('--tab-x', (button.left - parent.left) + 'px');
  nav.style.setProperty('--tab-width', button.width + 'px');
}
function selectTab(button) {
  document.querySelectorAll('#tabs button').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    const active = panel.id === 'tab-' + button.dataset.tab;
    panel.classList.toggle('active', active); panel.hidden = !active;
  });
  updateTabIndicator();
  chrome.storage.local.set({ uiTab: button.dataset.tab }).catch(() => {});
  if (button.dataset.tab === 'plugins') renderScripts();
  if (button.dataset.tab === 'tools') refreshPerm().catch((error) => status(error.message, 'err'));
}
document.querySelectorAll('#tabs button').forEach((button) => {
  button.addEventListener('click', () => selectTab(button));
  button.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('#tabs button')], index = tabs.indexOf(button);
    let next;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (next) { event.preventDefault(); next.focus(); selectTab(next); }
  });
});
new ResizeObserver(updateTabIndicator).observe($('#tabs'));
updateTabIndicator();

/* ----------------------------------------------------------- media cards */
function makeNameInput(placeholder) {
  const i = el('input', 'name');
  i.type = 'text'; i.placeholder = placeholder; i.spellcheck = false;
  i.id = 'file-name-' + crypto.randomUUID();
  i.autocomplete = 'off';
  i.addEventListener('input', () => { i.dataset.touched = '1'; });
  return i;
}
function makeStatus() {
  const node = el('div', 'status');
  node.id = 'file-status-' + crypto.randomUUID();
  node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); node.setAttribute('aria-atomic', 'true');
  return node;
}
function labeledField(control, feedback, text = 'File name') {
  if (!control.id) control.id = 'file-field-' + crypto.randomUUID();
  const label = el('label', 'file-field'); label.htmlFor = control.id;
  control.setAttribute('aria-describedby', feedback.id);
  label.append(el('span', 'field-label', text), control);
  return label;
}
function setDefaultName(input, value, asPlaceholder) {
  if (!value) return;
  if (asPlaceholder) { input.placeholder = value; return; }
  if (input.dataset.touched === '1') return;
  if (document.activeElement !== input) input.value = value;
}

function baseCard(kind, label) {
  const root = el('div', 'card');
  const ico = el('div', 'ico ' + kind, label);
  ico.setAttribute('aria-hidden', 'true');
  const body = el('div', 'body');
  root.append(ico, body);
  return { root, body };
}

const fmtSpeed = (n) => (n ? fmtBytes(n) + '/s' : '');

// One renderer for every download job (HLS segments or a plain file).
function renderJob(j, ui) {
  const running = !!j && ['running', 'saving'].includes(j.state);
  ui.bar.hidden = !running; ui.cancel.hidden = !running;
  ui.bar.setAttribute('role', 'progressbar'); ui.bar.setAttribute('aria-label', 'Download data progress');
  ui.bar.setAttribute('aria-valuemin', '0'); ui.bar.setAttribute('aria-valuemax', '100');
  ui.bar.setAttribute('aria-describedby', ui.st.id);
  ui.st.setAttribute('aria-live', running ? 'off' : 'polite');
  ui.lock.forEach((e) => { e.disabled = running || !!ui.busy; });
  if (ui.busy && !running) return;
  if (ui.diag) setDiag(ui.diag, j && j.state === 'error' ? j.diag : '');
  if (!j) return;
  if (running) {
    if (j.state === 'saving') {
      ui.fill.style.transform = 'scaleX(1)'; ui.bar.setAttribute('aria-valuenow', '100'); ui.st.className = 'status';
      ui.st.textContent = 'Saving ' + (j.filename || 'file') + ' in browser downloads...';
      return;
    }
    const bytes = j.unit === 'bytes';
    const progress = j.total ? Math.min(100, Math.max(0, Math.round((j.done / j.total) * 100))) : 4;
    ui.fill.style.transform = 'scaleX(' + progress / 100 + ')';
    if (j.total) ui.bar.setAttribute('aria-valuenow', String(progress)); else ui.bar.removeAttribute('aria-valuenow');
    ui.st.className = 'status';
    ui.st.textContent = j.phase + (bytes
      ? (j.total ? ' · ' + fmtBytes(j.done) + ' of ' + fmtBytes(j.total) : j.done ? ' · ' + fmtBytes(j.done) : '') + (j.speed ? ' · ' + fmtSpeed(j.speed) : '')
      : (j.total ? ' · ' + j.done + '/' + j.total + ' segments · ' + fmtBytes(j.bytes) : ''));
  } else if (j.state === 'done') {
    ui.st.className = 'status ' + (j.notice ? 'warn' : 'ok');
    const message = 'Saved ' + j.filename + (j.bytes ? ' (' + fmtBytes(j.bytes) + ')' : '') + (j.notice ? '. ' + j.notice : '');
    if (ui.st.textContent !== message) ui.st.textContent = message;
  } else {
    ui.st.className = 'status ' + (j.state === 'error' ? 'err' : 'warn');
    const message = j.state === 'error' && /Failed to fetch/.test(j.message)
      ? 'Could not reach the server. Play the recording again, check site access in Utilities, then retry. (' + j.message + ')'
      : j.message;
    if (ui.st.textContent !== message) ui.st.textContent = message;
  }
}

function pdfCard(item) {
  const { root, body } = baseCard('pdf', 'PDF');
  const title = el('h2', 'title'), meta = el('div', 'meta');
  const name = makeNameInput('File name (automatic if empty)');
  const actions = el('div', 'actions');
  const bOpen = el('button', 'btn grow', 'Open'), bSave = el('button', 'btn primary grow', 'Save'), bText = el('button', 'btn', 'Copy text');
  const bDiag = makeDiagButton();
  const st = makeStatus();
  actions.append(bOpen, bSave, bText);
  body.append(title, meta, labeledField(name, st), actions, st, bDiag);
  let running = false, nativeSave = null;
  function stopWatching() {
    chrome.downloads.onChanged.removeListener(changed);
    nativeSave = null; bSave.textContent = 'Save'; bSave.disabled = running;
  }
  function finishSave(downloadState, reason = '') {
    if (!nativeSave) return;
    const saved = nativeSave;
    stopWatching();
    if (downloadState === 'complete') {
      st.className = 'status ' + (saved.captured ? 'warn' : 'ok');
      st.textContent = 'Saved ' + saved.filename + (saved.message ? '. ' + saved.message : '');
    } else {
      st.className = 'status err';
      st.textContent = 'PDF saving was interrupted' + (reason ? ' (' + reason + ')' : '') + '. Press Save to retry, or open browser downloads for details.';
    }
  }
  const changed = (delta) => {
    if (delta.id === nativeSave?.id && ['complete', 'interrupted'].includes(delta.state?.current)) finishSave(delta.state.current, delta.error?.current);
  };
  async function watchSave(result) {
    if (!Number.isInteger(result.downloadId)) return;
    stopWatching(); nativeSave = { id: result.downloadId, filename: result.filename, captured: result.captured, message: result.message };
    chrome.downloads.onChanged.addListener(changed); bSave.textContent = 'Saving...'; bSave.disabled = true;
    try {
      const [download] = await chrome.downloads.search({ id: result.downloadId });
      if (download && ['complete', 'interrupted'].includes(download.state)) finishSave(download.state, download.error);
    } catch (error) { /* Keep watching: acceptance is not proof that the file was saved. */ }
  }

  const run = async (label, fn) => {
    if (running) return;
    running = true;
    [bOpen, bSave, bText].forEach((button) => { button.disabled = true; });
    setDiag(bDiag, '');
    st.className = 'status'; st.textContent = label + '...';
    try {
      // The worker may still have a valid captured copy if network access is declined.
      if (/^https?:/i.test(item.url)) await ensureOrigins([item.url]);
      await fn();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; setDiag(bDiag, e.diag); }
    finally { running = false; [bOpen, bText].forEach((button) => { button.disabled = false; }); bSave.disabled = !!nativeSave; }
  };
  bOpen.onclick = () => run('Opening', async () => {
    const r = await bg('pdf-open', { id: item.id, name: name.value.trim() || undefined });
    st.className = 'status ' + (r.fallback || r.captured ? 'warn' : 'ok');
    st.textContent = r.message || 'Opened PDF.';
  });
  bSave.onclick = () => run('Saving', async () => {
    const r = await bg('pdf-save', { id: item.id, name: name.value.trim() || undefined });
    st.className = 'status ' + (r.fallback || r.captured ? 'warn' : 'ok');
    st.textContent = r.fallback ? r.message : 'Download queued: ' + r.filename + (r.message ? '. ' + r.message : '') + '. Check browser downloads for completion.';
    await watchSave(r);
  });
  bText.onclick = () => run('Reading text', async () => {
    const r = await bg('pdf-text', { id: item.id });
    if (!r.text) throw new Error('No selectable text was found. This may be a scanned PDF; OCR is not included.');
    await navigator.clipboard.writeText(r.text);
    st.className = 'status ok'; st.textContent = 'Copied ' + r.text.length.toLocaleString() + ' characters';
  });

  return {
    root, dispose: stopWatching,
    update(it) {
      item = it;
      title.textContent = it.title || 'Document';
      title.title = it.url;
      meta.textContent = ['PDF', fmtBytes(it.size), it.pages ? it.pages + ' page' + (it.pages === 1 ? '' : 's') : '',
        it.titleSrc ? 'name from ' + it.titleSrc.replace('pdf-', '') : (it.uploaded ? '' : 'captured link; full PDF fetched on Open / Save')]
        .filter(Boolean).join(' · ');
      if (it.captureError && !st.textContent) { st.className = 'status warn'; st.textContent = it.captureError; }
      setDefaultName(name, it.title);
    },
  };
}

function mediaCard(item) {
  const isDash = item.kind === 'dash';
  const { root, body } = baseCard(isDash ? 'dash' : 'media', isDash ? 'DASH' : (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|$)/i.test(item.url) || /^audio\//.test(item.ct || '') ? 'AUD' : 'VID'));
  const title = el('h2', 'title'), meta = el('div', 'meta');
  const name = makeNameInput('File name');
  const actions = el('div', 'actions');
  const bDl = el('button', 'btn primary grow', 'Download'), bCopy = el('button', 'btn', 'Copy link');
  const bCancel = el('button', 'btn', 'Cancel'); bCancel.hidden = true;
  const bDiag = makeDiagButton();
  const bar = el('div', 'bar'), fill = el('i'); bar.append(fill); bar.hidden = true;
  const st = makeStatus();
  let currentJob = null;
  if (isDash) {
    st.className = 'status warn';
    st.textContent = 'DASH manifests are not supported yet. Look for a separate HLS or MP4 entry, or copy the link for another tool.';
    body.append(title, meta, actions, st);
    actions.append(bCopy);
  } else {
    actions.append(bDl, bCopy, bCancel);
    body.append(title, meta, labeledField(name, st), actions, bar, st, bDiag);
  }
  bCopy.onclick = async () => { try { await navigator.clipboard.writeText(item.url); st.className = 'status ok'; st.textContent = 'Link copied. Signed links can contain private access tokens.'; } catch (error) { st.className = 'status err'; st.textContent = error.message; } };
  bCancel.onclick = async () => { try { if (currentJob) await bg('job-cancel', { jobId: currentJob.id }); } catch (error) { st.className = 'status err'; st.textContent = error.message; } };
  let starting = false;
  bDl.onclick = async () => {
    if (starting) return;
    starting = true; bDl.disabled = true; setDiag(bDiag, '');
    st.className = 'status'; st.textContent = 'Starting…';
    try {
      if (!(await ensureOrigins([item.url]))) throw new Error('Access to ' + hostOf(item.url) + ' was not granted');
      await bg('job-start', { id: item.id, kind: 'http', mode: 'video', name: name.value.trim() || cleanTitle(state.title) || undefined });
      await refresh();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; setDiag(bDiag, e.diag); }
    finally { starting = false; bDl.disabled = !!currentJob && ['running', 'saving'].includes(currentJob.state); }
  };
  return {
    root,
    update(it) {
      item = it;
      const f = fileOf(it.url);
      title.textContent = cleanTitle(state.title) || f || (isDash ? 'DASH manifest' : 'Media file');
      title.title = it.url;
      meta.textContent = [isDash ? 'MPEG-DASH' : 'Direct file', f && f !== title.textContent ? f : '', fmtBytes(it.size), hostOf(it.url)].filter(Boolean).join(' · ');
      setDefaultName(name, cleanTitle(state.title) || f.replace(/\.[a-z0-9]+$/i, ''), true);
      if (isDash) return;
      currentJob = (it.jobs || [])[0] || null;
      bDl.textContent = currentJob && ['error', 'cancelled'].includes(currentJob.state) ? 'Retry download' : 'Download';
      renderJob(currentJob, { bar, fill, cancel: bCancel, st, diag: bDiag, busy: starting, lock: [bDl, name] });
    },
  };
}

function hlsCard(item) {
  const { root, body } = baseCard('hls', 'HLS');
  const title = el('h2', 'title'), meta = el('div', 'meta');
  const quality = el('select'); quality.hidden = true;
  quality.setAttribute('aria-label', 'Recording quality');
  const name = makeNameInput('File name'); name.hidden = true;
  const actions = el('div', 'actions');
  const bAnalyze = el('button', 'btn primary grow', 'Analyze stream');
  const bVideo = el('button', 'btn primary grow', 'Download video'), bAudio = el('button', 'btn grow', 'Audio only');
  bVideo.hidden = bAudio.hidden = true;
  const bCopy = el('button', 'btn', 'Copy link');
  const bar = el('div', 'bar'), fill = el('i'); bar.append(fill); bar.hidden = true;
  const bCancel = el('button', 'btn', 'Cancel'); bCancel.hidden = true;
  const bDiag = makeDiagButton();
  const st = makeStatus();
  actions.append(bAnalyze, bVideo, bAudio, bCopy, bCancel);
  body.append(title, meta, labeledField(quality, st, 'Quality'), labeledField(name, st), actions, bar, st, bDiag);

  let info = null, analysing = false, currentJob = null, starting = false, attemptedAuto = false;
  const options = () => (info ? info.options : []);
  const chosen = () => options().find((o) => o.id === quality.value) || options()[0];

  async function analyse(userGesture) {
    if (analysing || info) return;
    analysing = true; bAnalyze.disabled = true; setDiag(bDiag, ''); st.className = 'status'; st.textContent = 'Reading playlist...';
    try {
      if (!(await hasOrigin(item.url))) {
        if (!userGesture) {
          bAnalyze.hidden = false; st.className = 'status warn';
          st.textContent = hostOf(item.url) + ' needs your permission — click Analyze.';
          return;
        }
        if (!(await ensureOrigins([item.url]))) throw new Error('Access to ' + hostOf(item.url) + ' was not granted');
      }
      info = await bg('hls-info', { id: item.id });
      quality.replaceChildren(...info.options.map((o) => { const op = el('option', '', o.label); op.value = o.id; return op; }));
      quality.hidden = name.hidden = bVideo.hidden = bAudio.hidden = false;
      bAnalyze.hidden = true; st.textContent = '';
      syncButtons();
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message; bAnalyze.hidden = false;
      setDiag(bDiag, e.diag);
    }
    finally { analysing = false; bAnalyze.disabled = false; }
  }

  function syncButtons() {
    const o = chosen();
    if (!o) return;
    bVideo.hidden = o.type === 'audio';
    bAudio.textContent = o.type === 'audio' ? 'Download audio' : 'Audio only';
    bAudio.className = o.type === 'audio' ? 'btn primary grow' : 'btn grow';
    bVideo.textContent = o.audioUrl ? 'Video stream only' : 'Download video';
    if (o.audioUrl && !(currentJob && ['running', 'saving'].includes(currentJob.state))) {
      st.className = 'status warn';
      st.textContent = 'This quality has separate audio. Save the video and Audio only as two files; tracks are not merged.';
    }
  }
  quality.onchange = syncButtons;
  bAnalyze.onclick = () => analyse(true);
  bCopy.onclick = async () => { try { await navigator.clipboard.writeText(item.url); st.className = 'status ok'; st.textContent = 'Link copied. Signed links can contain private access tokens.'; } catch (error) { st.className = 'status err'; st.textContent = error.message; } };

  async function start(mode) {
    const o = chosen();
    if (!o || starting) return;
    starting = true; bVideo.disabled = bAudio.disabled = quality.disabled = true; setDiag(bDiag, '');
    st.className = 'status'; st.textContent = 'Checking playlist and server access...';
    try {
      const actualMode = o.type === 'audio' ? 'audio' : mode;
      const selectedUrl = actualMode === 'audio' && o.audioUrl ? o.audioUrl : o.url;
      if (!(await ensureOrigins([selectedUrl]))) throw new Error('Access to the selected playlist server was not granted.');
      const preview = await bg('hls-preview', { id: item.id, quality: o.id, mode: actualMode });
      if (!(await ensureOrigins(preview.hosts || []))) throw new Error('Access to the required media servers was not granted. Press download again to retry.');
      const suffix = o.type === 'audio' ? ' - audio' : (mode === 'audio' ? ' - audio' : (/(\d{3,4})p/.exec(o.label) ? ' - ' + /(\d{3,4})p/.exec(o.label)[0] : ''));
      const base = name.value.trim() || cleanTitle(state.title) || 'recording';
      await bg('job-start', { id: item.id, quality: o.id, mode: actualMode, name: base + (name.value.trim() ? '' : suffix) });
      if (preview.notice) { st.className = 'status warn'; st.textContent = preview.notice; }
      await refresh();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; setDiag(bDiag, e.diag); }
    finally { starting = false; const busy = !!currentJob && ['running', 'saving'].includes(currentJob.state); bVideo.disabled = bAudio.disabled = quality.disabled = busy; }
  }
  bVideo.onclick = () => start('video');
  bAudio.onclick = () => start('audio');
  bCancel.onclick = async () => { try { if (currentJob) await bg('job-cancel', { jobId: currentJob.id }); } catch (error) { st.className = 'status err'; st.textContent = error.message; } };

  return {
    root,
    update(it) {
      if (item.url !== it.url) { info = null; attemptedAuto = false; }
      item = it;
      title.textContent = cleanTitle(state.title) || fileOf(it.url) || 'Recording';
      title.title = it.url;
      meta.textContent = ['HLS stream', fileOf(it.url), hostOf(it.url)].filter(Boolean).join(' · ');
      setDefaultName(name, cleanTitle(state.title) || 'recording', true);
      if (!info && !analysing && !attemptedAuto) { attemptedAuto = true; analyse(false); }

      currentJob = (it.jobs || [])[0] || null;
      renderJob(currentJob, { bar, fill, cancel: bCancel, st, diag: bDiag, busy: starting, lock: [bVideo, bAudio, quality, name] });
    },
  };
}

const MAKERS = { pdf: pdfCard, hls: hlsCard, media: mediaCard, dash: mediaCard };

function renderMedia() {
  const list = $('#media-list');
  const ids = new Set(state.items.map((i) => i.id));
  for (const [id, c] of cards) if (!ids.has(id)) { c.dispose?.(); c.root.remove(); cards.delete(id); }
  for (const it of state.items) {
    let c = cards.get(it.id);
    if (!c) {
      if (!MAKERS[it.kind]) continue;
      c = MAKERS[it.kind](it);
      c.root.dataset.itemId = it.id;
      c.root.style.setProperty('--entry-delay', Math.min(cards.size * 30, 120) + 'ms');
      cards.set(it.id, c);
      list.appendChild(c.root);
    }
    c.update(it);
    c.root.hidden = !matchesMediaFilter({ ...it, title: it.title || cleanTitle(state.title) }, mediaFilter, $('#media-search').value);
  }
  // keep newest first without rebuilding cards (preserves typed names / selects)
  state.items.filter((it) => cards.has(it.id)).forEach((it, idx) => { const node = cards.get(it.id).root; if (list.children[idx] !== node) list.insertBefore(node, list.children[idx] || null); });
  const shown = [...cards.values()].filter((card) => !card.root.hidden).length;
  $('#media-empty').hidden = shown > 0;
  $('#media-empty b').textContent = state.items.length ? 'No matching files' : 'Nothing detected yet';
  $('#media-empty-text').textContent = state.items.length ? 'Try another search or file filter. Your other files are still in the library.' : 'Open a PDF or play a recording for a few seconds, then press Rescan. Downloads continue even after this panel closes.';
  $('#media-summary').textContent = shown + ' file' + (shown === 1 ? '' : 's');
  const cnt = $('#count');
  cnt.hidden = !state.items.length;
  if (cnt.dataset.count !== String(state.items.length)) {
    cnt.dataset.count = String(state.items.length);
    cnt.replaceChildren(el('span', '', state.items.length + (state.items.length === 1 ? ' file' : ' files')), el('span', 'sr-only', ' detected'));
  }
}

/* -------------------------------------------------------------- features */
function toggleRow(id, name, desc, on, onChange) {
  const row = el('button', 'row'); row.type = 'button';
  row.setAttribute('role', 'switch'); row.setAttribute('aria-checked', on ? 'true' : 'false');
  row.setAttribute('aria-label', name);
  const tx = el('div', 'tx'); tx.append(el('span', 'nm', name), el('span', 'ds', desc));
  const sw = el('span', 'sw'); sw.append(el('i'));
  row.append(tx, sw);
  row.onclick = async () => {
    const next = row.getAttribute('aria-checked') !== 'true';
    row.setAttribute('aria-checked', next ? 'true' : 'false');
    row.disabled = true;
    try { await onChange(next); }
    catch (error) { row.setAttribute('aria-checked', String(!next)); status(error.message, 'err'); }
    finally { row.disabled = false; }
  };
  return row;
}

function renderFeatures() {
  const box = $('#feature-list');
  box.replaceChildren();
  let group = null, groupBox = null;
  const query = $('#feature-search').value.trim().toLowerCase();
  for (const f of FEATURES) {
    if (query && ![f.name, f.desc, f.g].join(' ').toLowerCase().includes(query)) continue;
    if (f.g !== group) { group = f.g; groupBox = el('div', 'feature-group'); groupBox.append(el('div', 'group-title', group)); box.append(groupBox); }
    const row = toggleRow(f.id, f.name, f.desc, !!state.config[f.id], async (v) => {
      state.config = await bg('set-config', { patch: { [f.id]: v } });
      renderSiteFixes(); status('Saved. Reload for page-start hooks to fully apply.');
    });
    row.dataset.feature = f.id; groupBox.append(row);
  }
  if (!box.childElementCount) box.append(el('p', 'tiny', 'No page fixes match that search.'));
  renderSiteFixes();
}

function renderSiteFixes() {
  if (!state) return;
  const site = $('#site-toggle'), supported = !!siteKey(state.url);
  site.disabled = !supported || site.dataset.busy === '1'; site.setAttribute('aria-checked', String(!!state.siteEnabled));
  $('#site-fixes-status').textContent = !supported ? 'Browser-internal pages cannot be modified.' : state.siteEnabled ? hostOf(state.url) + ' - enabled' : hostOf(state.url) + ' - paused; detection stays available';
  for (const button of document.querySelectorAll('[data-preset]')) {
    const patch = presetConfig(button.dataset.preset);
    const selected = Object.entries(patch).every(([key, value]) => state.config[key] === value);
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  }
}

async function renderPlugins() {
  const box = $('#plugin-list');
  const list = await bg('plugins');
  box.replaceChildren();
  $('#folder-wrap').hidden = !list.length;
  if (!list.length) return;
  for (const p of list) {
    box.append(toggleRow(p.id, p.name, (p.description || '') + '  [' + p.world.toLowerCase() + ']', p.enabled, async (v) => {
      await bg('set-config', { patch: { ['plugin:' + p.id]: v } });
      status('Plugin ' + (v ? 'enabled' : 'disabled') + ' — reload the page');
    }));
  }
}

/* ----------------------------------------------------------------- tools */
async function wireTools() {
  document.querySelectorAll('[data-tool]').forEach((button) => wireAction(button, async () => {
    const result = await bg('tool', { tool: button.dataset.tool });
    if (button.dataset.tool === 'overlays') status((result.n || 0) + ' overlays hidden. Use Undo to restore.', 'ok');
    else if (button.dataset.tool === 'restore-overlays') status((result.n || 0) + ' overlays restored.', 'ok');
    else if (button.dataset.tool === 'reading') status('Reading view opened' + (result.words ? ' - about ' + Math.ceil(result.words / 200) + ' min read.' : '.'), 'ok');
    else status('Page tool applied.', 'ok');
  }));
  wireAction($('#tool-text'), async () => {
    const r = await bg('tool', { tool: 'text' });
    if (r && r.text) { await navigator.clipboard.writeText(r.text); status('Copied ' + r.text.length.toLocaleString() + ' characters', 'ok'); }
    else status('Nothing to copy on this page', 'err');
  });
  wireAction($('#tool-save-text'), async () => { const result = await bg('tool', { tool: 'text' }); await saveTextFile(result.text, pageFilename('.txt')); });
  wireAction($('#tool-links'), async () => {
    const result = await bg('tool', { tool: 'links' });
    if (!result.links || !result.links.length) throw new Error('No website links were found on this page.');
    await navigator.clipboard.writeText(result.links.map((link) => (link.title ? link.title + '\n' : '') + cleanPageLink(link.url)).join('\n\n'));
    status('Copied ' + result.links.length + ' links. Review signed links before sharing.', 'ok');
  });
  wireAction($('#tool-clean-link'), async () => {
    const tab = await chrome.tabs.get(tabId);
    await navigator.clipboard.writeText(cleanPageLink(tab.url));
    status('Copied page link without common tracking fields. Functional tokens are kept.', 'ok');
  });
  wireAction($('#tool-screenshot'), async () => {
    const result = await bg('capture-tab');
    await chrome.downloads.download({ url: result.dataUrl, filename: pageFilename(' - screenshot.png'), saveAs: true });
    status('Visible screenshot queued in browser downloads.', 'ok');
  });
  wireAction($('#tool-reload'), async () => { await chrome.tabs.reload(tabId); status('Page reloaded.'); });
  wireAction($('#tool-clear'), async () => { await bg('clear'); cards.forEach((card) => { card.dispose?.(); card.root.remove(); }); cards.clear(); await refresh(); status('Detected list cleared. Running downloads are kept.'); });
  wireAction($('#shortcuts'), () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  wireAction($('#open-downloads'), () => chrome.tabs.create({ url: 'chrome://downloads/' }));
  wireAction($('#dashboard'), async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') + '?dashboard=1&tab=' + tabId });
    window.close();
  });
  wireAction($('#media-rescan'), async () => {
    const result = await bg('tool', { tool: 'scan' });
    await refresh(); status('Page rescanned. ' + (result.n || 0) + ' media or document references found.', 'ok');
  });
  $('#media-search').addEventListener('input', () => { if (state) renderMedia(); });
  document.querySelectorAll('[data-media-filter]').forEach((button) => button.addEventListener('click', () => {
    mediaFilter = button.dataset.mediaFilter;
    document.querySelectorAll('[data-media-filter]').forEach((filter) => { const active = filter === button; filter.classList.toggle('active', active); filter.setAttribute('aria-pressed', String(active)); });
    if (state) renderMedia();
  }));
  $('#feature-search').addEventListener('input', () => { if (state) renderFeatures(); });
  wireAction($('#site-toggle'), async () => {
    const enabled = !state.siteEnabled;
    if (enabled && !(await ensureOrigins([state.url]))) throw new Error('Site access was not granted.');
    const result = await bg('set-site-fixes', { enabled });
    state.config = result.config; state.siteEnabled = result.siteEnabled;
    renderFeatures(); status(enabled ? 'Page fixes enabled. Reload for early-page hooks.' : 'Page fixes paused here. Reload to restore viewer URLs and early-page behavior.');
  });
  document.querySelectorAll('[data-preset]').forEach((button) => wireAction(button, async () => {
    state.config = await bg('set-config', { patch: presetConfig(button.dataset.preset) });
    renderFeatures(); status('Preset saved. PDF and video detection settings are unchanged.');
  }));
  $('#reload-ext').onclick = () => chrome.runtime.reload();
  wireAction($('#copy-prompt'), async () => {
    const text = await buildPluginPrompt(); await navigator.clipboard.writeText(text);
    $('#copy-prompt').textContent = 'Copied'; setTimeout(() => { $('#copy-prompt').textContent = 'Copy AI prompt'; }, 2200);
    status('Prompt copied. Describe your script to the AI, then review its code.', 'ok');
  });
  wireAction($('#save-prompt'), async () => saveTextFile(await buildPluginPrompt(), 'ALLEN-Toolbox-plugin-prompt.md', 'text/markdown'));
  let resetArmed = false;
  wireAction($('#reset'), async () => {
    if (!resetArmed) {
      resetArmed = true; $('#reset').textContent = 'Confirm reset'; status('This resets page fixes and download settings, not your scripts.');
      setTimeout(() => { resetArmed = false; $('#reset').textContent = 'Reset settings'; }, 4000); return;
    }
    resetArmed = false; $('#reset').textContent = 'Reset settings';
    state.config = await bg('reset-config'); await refresh(); renderFeatures(); setConc(); status('Settings restored to defaults. Your scripts are retained.');
  });
  wireAction($('#perm-site'), async () => {
    if (!siteKey(state.url)) throw new Error('Open a normal website before granting site access.');
    const ok = await ensureOrigins([state.url]);
    status(ok ? 'Site access granted.' : 'Site access was not granted.', ok ? 'ok' : 'err'); await refreshPerm();
  });
  wireAction($('#perm-all'), async () => {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
    status(ok ? 'Access granted for all sites' : 'Access was not granted', ok ? 'ok' : 'err');
    await refreshPerm();
  });
  wireAction($('#perm-revoke'), async () => {
    const permissions = await chrome.permissions.getAll(), required = chrome.runtime.getManifest().host_permissions || [];
    const origins = (permissions.origins || []).filter((origin) => !required.includes(origin));
    if (origins.length) await chrome.permissions.remove({ origins });
    await refreshPerm(); await renderScripts(); status('Optional access removed. Scripts and downloads on other sites may need permission again.');
  });
  $('#concurrency').onchange = async (event) => {
    try { state.config = await bg('set-config', { patch: { concurrency: +event.target.value } }); status('Download parallelism saved.'); }
    catch (error) { setConc(); status(error.message, 'err'); }
  };
  $('#playback-speed').onchange = async (event) => {
    try { const result = await bg('tool', { tool: 'speed', value: +event.target.value }); status(result.n ? 'Speed set for ' + result.n + ' media players.' : 'No accessible video or audio player was found.', result.n ? 'ok' : 'warn'); }
    catch (error) { status(error.message, 'err'); }
  };
}

// The prompt file plus live context: version, the site the user is on, and their current plugins.json
// (so the AI never reuses an id or overwrites an existing entry).
async function buildPluginPrompt() {
  const get = (path) => fetch(chrome.runtime.getURL(path)).then((r) => r.text());
  const md = await get('plugins/PLUGIN_PROMPT.md');
  let installed = '(none yet)';
  try {
    const r = await bg('us:list');
    if (r.scripts.length) installed = r.scripts.map((s) => '  - ' + s.name + (s.version ? ' v' + s.version : '') + ' — runs on ' + (s.matches.slice(0, 2).join(', ') || 'nowhere yet')).join('\n');
  } catch (e) { /* keep the default */ }
  return md
    .split('{{EXTENSION_VERSION}}').join(chrome.runtime.getManifest().version)
    .split('{{CURRENT_SITE}}').join(hostOf(state && state.url) || '(none — ask the user which site)')
    .split('{{INSTALLED_SCRIPTS}}').join(installed);
}


/* ------------------------------------------------------------ scripts (Violentmonkey / Tampermonkey-style) */
async function openEditor(id, manager = false) {
  // Capture context before activating the extension tab, not from the editor's own active tab.
  const params = new URLSearchParams();
  if (tabId != null) params.set('tab', String(tabId));
  let currentUrl = state && state.url;
  if (tabId != null) { try { currentUrl = (await chrome.tabs.get(tabId)).url || currentUrl; } catch (e) { /* keep the last known page */ } }
  const source = sourceUrl(currentUrl);
  if (source) params.set('source', source);
  if (id) params.set('id', id);
  if (manager) params.set('view', 'scripts');
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/editor.html') + '?' + params });
    window.close();
  } catch (e) { status(e.message, 'err'); }
}

function tag(text, cls) { return el('span', 'tag' + (cls ? ' ' + cls : ''), text); }

function scriptCard(s) {
  const card = el('div', 'us');
  const top = el('div', 'us-top');
  const tx = el('div', 'tx');
  tx.append(el('div', 'us-name', s.name + (s.version ? '  v' + s.version : '')),
    el('div', 'us-meta', (s.matches[0] || 'no @match') + (s.matches.length > 1 ? '  +' + (s.matches.length - 1) : '') + (s.author ? ' · ' + s.author : '')));
  const tgl = el('button', 'row'); tgl.type = 'button'; tgl.style.padding = '3px'; tgl.setAttribute('role', 'switch'); tgl.setAttribute('aria-checked', s.enabled ? 'true' : 'false'); tgl.setAttribute('aria-label', 'Enable ' + s.name);
  const sw = el('span', 'sw'); sw.append(el('i')); tgl.append(sw);
  tgl.onclick = async () => {
    const next = tgl.getAttribute('aria-checked') !== 'true';
    tgl.setAttribute('aria-checked', String(next)); tgl.disabled = true;
    try { const result = await bg('us:toggle', { id: s.id, enabled: next }); s.enabled = result.enabled; status(result.error || 'Script ' + (next ? 'on' : 'off') + '. Reload the page.', result.error ? 'warn' : ''); }
    catch (e) { tgl.setAttribute('aria-checked', String(!next)); status(e.message, 'err'); }
    finally { tgl.disabled = false; }
  };
  top.append(tx, tgl);

  const tags = el('div', 'us-tags');
  tags.append(tag(s.noneGrant ? 'page script' : s.grants.length + ' API' + (s.grants.length === 1 ? '' : 's'), 'ok'));
  if (s.injectInto === 'sandbox') tags.append(tag('sandbox'));
  if (s.requires) tags.append(tag(s.requires + ' @require'));
  if (s.bundleId) tags.append(tag('folder script (protected)'));
  if (!s.hasMatch) tags.append(tag('no @match — will not run', 'warn'));
  if (s.error) tags.append(tag(s.error.slice(0, 60), 'err'));
  if (s.hasMatch && !s.access) {
    const t = el('button', 'tag warn', 'Needs site access - allow');
    wireAction(t, async () => { const ok = await chrome.permissions.request({ origins: s.origins || s.matches }); status(ok ? 'Access granted. Reload the page.' : 'Access not granted', ok ? 'ok' : 'err'); await renderScripts(); });
    tags.append(t);
  }

  const acts = el('div', 'us-actions');
  const bEdit = el('button', 'btn', 'Edit'), bDel = el('button', 'btn', 'Delete');
  bEdit.onclick = () => openEditor(s.id);
  bDel.disabled = !!s.bundleId;
  if (bDel.disabled) bDel.title = 'Folder scripts cannot be deleted here. Disable the script instead.';
  let armed = false;
  bDel.onclick = async () => {
    if (bDel.disabled) return;
    if (!armed) { armed = true; bDel.textContent = 'Really delete?'; setTimeout(() => { armed = false; bDel.textContent = 'Delete'; }, 3000); return; }
    try { await bg('us:delete', { id: s.id }); status('Script deleted'); await renderScripts(); } catch (error) { status(error.message, 'err'); }
  };
  acts.append(bEdit, bDel);
  card.append(top, tags, acts);
  return card;
}

async function renderMenu() {
  try {
    const list = await bg('us:menu', { tabId });
    const box = $('#menu-list'); box.replaceChildren();
    $('#menu-wrap').hidden = !list.length;
    for (const c of list) {
      const b = el('button', 'btn cmd'); b.append(el('span', '', c.name), el('small', '', c.script));
      b.onclick = async () => { try { await bg('us:menu-run', { tabId, scriptId: c.scriptId, frameId: c.frameId, cmdId: c.cmdId }); status('Ran “' + c.name + '”', 'ok'); } catch (e) { status(e.message, 'err'); } };
      box.append(b);
    }
  } catch (e) { $('#menu-wrap').hidden = true; }
}

let scriptRenderVersion = 0;
async function renderScripts() {
  const version = ++scriptRenderVersion;
  try {
    const r = await bg('us:list');
    if (version !== scriptRenderVersion) return;
    $('#us-banner').hidden = r.available;
    const box = $('#us-list'); box.replaceChildren();
    $('#us-empty').hidden = r.scripts.length > 0;
    for (const s of r.scripts) box.append(scriptCard(s));
    const errors = (r.bundles && r.bundles.errors || []).filter((error) => r.available || !String(error).includes('Allow User Scripts is unavailable'));
    $('#bundle-status').textContent = errors.length ? 'Folder script errors: ' + errors.map((error) => typeof error === 'string' ? error : error.message || error.error || JSON.stringify(error)).join('; ') : 'Folder scripts are protected; rescanning restores missing imports and preserves edits. ZIPs exclude local values; review code for embedded secrets.';
  } catch (e) { status(e.message, 'err'); }
  await Promise.all([renderMenu(), renderPlugins().catch((error) => status(error.message, 'err'))]);
}

function wireScripts() {
  $('#us-add').onclick = () => openEditor();
  $('#us-manager').onclick = () => openEditor(null, true);
  $('#us-open-settings').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  $('#us-recheck').onclick = renderScripts;
  wireAction($('#bundle-export'), async () => {
    await openEditor(null, true);
  });
  wireAction($('#bundle-reload'), async () => {
    const result = await bg('us:scan-bundles');
    await renderScripts();
    status('Folder scan: ' + result.imported + ' added, ' + result.skipped + ' preserved' + (result.errors.length ? ', ' + result.errors.length + ' errors.' : '.'), result.errors.length ? 'warn' : 'ok');
  });
}

function setConc() { $('#concurrency').value = String(state.config.concurrency || 8); }
async function refreshPerm() {
  const all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('#perm-all').hidden = all;
  const origin = siteKey(state && state.url);
  $('#perm-site').hidden = !origin || await hasOrigin(origin);
  const permissions = await chrome.permissions.getAll(), required = chrome.runtime.getManifest().host_permissions || [];
  $('#perm-revoke').hidden = !(permissions.origins || []).some((permission) => !required.includes(permission));
  $('#perm-text').textContent = all
    ? 'Broad site access is granted. Downloads still depend on your authorization and the stream format. You can remove optional access below.'
    : 'Downloads request only the servers they need. Allow this site for persistent tools, or grant broader access if you need cross-site media detection.';
}

/* ----------------------------------------------------------- GitHub updates */
let updateState = null;
function renderUpdates(next) {
  if (!next) return;
  updateState = { ...updateState, ...next };
  next = updateState;
  $('#updates-panel').setAttribute('aria-busy', String(next.checking));
  $('#update-auto').setAttribute('aria-checked', String(next.automatic));
  for (const id of ['update-github', 'update-auto', 'update-check']) $('#' + id).disabled = next.checking || !!$('#' + id).dataset.busy;
  $('#update-release').hidden = !next.available;
  $('#update-download').hidden = !next.available || !next.latest?.downloadUrl;
  const native = next.native;
  const folderMode = next.channel === 'beta';
  $('#folder-updater-setup').hidden = !folderMode;
  $('#update-install').textContent = folderMode ? 'Install verified beta update' : 'Check Windows updater';
  $('#update-install').hidden = !(folderMode || WINDOWS_UPDATER_AVAILABLE) || !native?.installed || (!next.available && !native.requiresReload);
  $('#update-install').disabled = !!native?.applying || next.checking || !!$('#update-install').dataset.busy;
  const nativeFeedback = $('#native-updater-status');
  const nativeError = native?.error === 'browser-running' ? 'Automatic installation waits until all supported browsers are closed.' : native?.error;
  const nativeMessage = folderMode ? native?.uncertain ? 'BETA folder update needs recovery. Open the updater setup or Recovery page before continuing.' : native?.connected ?
    'BETA folder updater: ' + (native.permission === 'granted' ? native.autoInstall ? 'automatic installation opted in.' : 'connected; automatic installation is off.' : 'folder permission needs approval again.') :
    'BETA experiment: grant access to the original extension folder in updater setup. No external installer is used.' : !WINDOWS_UPDATER_AVAILABLE ? 'Automatic Windows installation is unavailable in this build. No executable installer is bundled; manual extension updates remain available.' : native?.uncertain ? 'Windows updater status is unresolved. Downloads wait for a safe status recheck.' : native?.installed ? nativeError ? 'Windows updater: ' + nativeError : native.applying ? 'Windows updater is verifying the signed release...' :
    'Signed Windows updater installed. Folder version: ' + native.installedVersion + (native.requiresReload ? '. Extension reload is pending.' : '. Installation waits until supported browsers are closed.') :
    'Windows updater is not installed. Run the bundled installer once and approve its setup to enable automatic installation.';
  if (nativeFeedback.textContent !== nativeMessage) nativeFeedback.textContent = nativeMessage;
  const feedback = $('#update-status');
  feedback.className = 'status' + (next.checking ? '' : next.error ? ' err' : next.available ? ' warn' : '');
  let message = next.checking ? 'Checking GitHub for updates...' : next.error ? next.error : next.available ?
    'Version ' + next.latest.version + ' is available. Installed: ' + next.installedVersion + '.' : next.latest ?
    'Installed: ' + next.installedVersion + '. No newer release is available.' : 'Installed: ' + next.installedVersion + '. No release has been checked yet.';
  if (next.checkedAt && !next.checking) message += ' Last checked: ' + new Date(next.checkedAt).toLocaleString() + '.';
  if (feedback.textContent !== message) feedback.textContent = message;
}

function wireUpdates() {
  wireAction($('#update-auto'), async () => {
    renderUpdates(await bg('updates:configure', { automatic: !updateState.automatic }));
  });
  wireAction($('#update-check'), async () => {
    $('#updates-panel').setAttribute('aria-busy', 'true'); $('#update-status').textContent = 'Checking GitHub for updates...';
    try { renderUpdates(await bg('updates:check')); }
    finally { $('#updates-panel').setAttribute('aria-busy', 'false'); }
  });
  wireAction($('#update-github'), () => chrome.tabs.create({ url: OFFICIAL_REPOSITORY }));
  wireAction($('#folder-updater-setup'), () => chrome.tabs.create({ url: chrome.runtime.getURL('popup/updater.html') }));
  wireAction($('#update-release'), () => chrome.tabs.create({ url: updateState.latest.url }));
  wireAction($('#update-download'), async () => {
    const result = await bg('updates:download');
    status(result.filename + (WINDOWS_UPDATER_AVAILABLE ? ' queued. The ZIP includes the optional signed installer; approve its setup explicitly.' : ' queued. Extract to the original extension folder and reload it at chrome://extensions.'), 'ok');
  });
  wireAction($('#update-install'), async () => {
    $('#native-updater-status').textContent = 'Windows updater is verifying and installing the signed release...';
    const result = await bg('updates:install');
    renderUpdates({ ...updateState, native: result });
    if (result.state === 'error' || !result.installed) throw new Error(result.error || 'Windows updater is unavailable');
    status(result.state === 'deferred' ? result.error === 'browser-running' ? 'Close all supported browsers; the signed scheduled updater can install when idle.' : result.error : result.requiresReload ? 'Update installed; the extension is reloading.' : 'Windows updater check complete.', result.state === 'deferred' ? 'warn' : 'ok');
  });
}

/* ------------------------------------------------------------------ boot */
async function refresh() {
  if (refreshing || (state && document.hidden)) return;
  refreshing = true;
  try {
    const first = !state;
    const previousConfig = state && JSON.stringify(state.config);
    state = await bg('state');
    $('#site').textContent = hostOf(state.url) || 'This tab';
    $('#site').title = state.title || '';
    renderMedia();
    if (first) renderFeatures();
    else if (previousConfig !== JSON.stringify(state.config)) {
      for (const row of document.querySelectorAll('[data-feature]')) if (!row.disabled) row.setAttribute('aria-checked', String(!!state.config[row.dataset.feature]));
    }
    renderSiteFixes(); setConc(); renderUpdates(state.updates);
  } catch (e) { status(e.message, 'err'); }
  finally { refreshing = false; }
}

(async function init() {
  const p = new URLSearchParams(location.search);
  if (p.get('dashboard') === '1') { document.body.classList.add('dashboard'); $('#dashboard').hidden = true; }
  tabId = +p.get('tab') || null;
  if (!tabId) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; }
  await wireTools();
  wireScripts();
  wireUpdates();
  await refresh();
  await refreshPerm();
  const saved = await chrome.storage.local.get('uiTab');
  const requested = p.get('view') || saved.uiTab || 'media';
  selectTab($('#tabs button[data-tab="' + (['media', 'features', 'plugins', 'tools'].includes(requested) ? requested : 'media') + '"]'));
  setInterval(refresh, 1000);
})().catch((error) => status('Could not start the toolbox: ' + error.message, 'err'));
