'use strict';

/* =========================================================================
 * ATML Viewer — SystemLink web app
 * Browses File Service files, then renders ATML test results or generic XML.
 * All API calls are same-origin relative paths so the SystemLink session
 * cookie authenticates them through the web ingress.
 * ========================================================================= */

const FILE_API = '/nifile/v1';
const SERVER_PAGE = 1000;   // files fetched per server request (API max)

const state = {
  files: [],            // filtered + sorted files shown in the table
  allFiles: [],         // raw files from the last fetch
  loading: false,
  view: 'search',       // 'search' | 'viewer'
  selectedId: null,
  search: '',
  workspace: '',
  timeMode: 'preset',   // 'preset' | 'custom'
  timeValue: '90d',     // preset key (see TIME_PRESETS)
  timeCustom: null,     // { start: Date, end: Date }
  sort: { key: 'created', dir: 'desc' },
  workspaceNames: {},   // id -> name
  currentFile: null,    // metadata of the file currently open
  currentDoc: null,     // parsed XML Document
  currentRawText: '',
  currentFormat: 'xml', // 'atml' | 'xml'
  currentFilterMode: 'all',
};

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, opts = {}) => {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  if (opts.html != null) n.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, v);
  return n;
};

/* ---------- API ---------- */
async function apiGet(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403
      ? 'Not authorized. Open this app from within SystemLink so your session is used.'
      : `Request failed (${res.status} ${res.statusText}).`;
    throw new Error(msg);
  }
  return res;
}

async function fetchWorkspaces() {
  try {
    const res = await apiGet('/niuser/v1/workspaces?take=1000');
    const data = await res.json();
    const list = data.workspaces || data.value || [];
    for (const w of list) state.workspaceNames[w.id] = w.name;
    return list;
  } catch {
    return [];
  }
}

function fileName(f) {
  return (f.properties && (f.properties.Name || f.properties.name)) || f.id;
}
function fileExt(f) {
  const n = fileName(f);
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
}

/* ---------- File browser ----------
 * Every workspace / search change runs a fresh query — no cached reuse:
 *  - A specific workspace is scoped via the query-files `?workspace=` param
 *    (the reliable server-side workspace scoping), then filtered to XML.
 *  - "All workspaces" uses the Elasticsearch search-files endpoint with an
 *    `extension: "xml"` filter (plus a name wildcard when searching).
 */
async function loadFiles() {
  if (state.loading) return;
  state.loading = true;
  setFileStatus(state.search ? 'Searching…' : 'Loading files…');
  try {
    let files;
    if (state.workspace) {
      files = await queryWorkspaceXml(state.workspace);
      const q = state.search.toLowerCase();
      if (q) files = files.filter((f) => fileName(f).toLowerCase().includes(q));
    } else {
      files = await elasticXmlSearch(state.search);
    }
    state.allFiles = files;
    applyAndRender();
  } catch (e) {
    setFileStatus(e.message, true);
  } finally {
    state.loading = false;
  }
}

// Apply the client-side creation-date filter and current sort, then render.
function applyAndRender() {
  let files = state.allFiles.slice();
  const range = getActiveTimeRange();
  if (range) {
    files = files.filter((f) => {
      const t = new Date(f.created || f.updated).getTime();
      return !isNaN(t) && t >= range.start.getTime() && t <= range.end.getTime();
    });
  }
  files.sort(fileComparator(state.sort));
  state.files = files;
  renderFileTable();
}

function fileComparator(sort) {
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  const val = (f) => {
    switch (key) {
      case 'name': return fileName(f).toLowerCase();
      case 'ext': return fileExt(f);
      case 'size': return Number(f.size ?? f.size64 ?? 0);
      case 'workspace': return (state.workspaceNames[f.workspace] || '').toLowerCase();
      case 'created':
      default: return new Date(f.created || f.updated).getTime() || 0;
    }
  };
  return (a, b) => {
    const va = val(a); const vb = val(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  };
}

// Global ATML/XML search/browse via Elasticsearch (all workspaces), newest
// first. ATML reports may use either an .xml or .atml extension.
async function elasticXmlSearch(text) {
  const clauses = ['(extension: "xml" OR extension: "atml")'];
  if (text) {
    const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    clauses.push(`name: "*${safe}*"`);
  }
  const body = { filter: clauses.join(' AND '), orderBy: 'created', orderByDescending: true, take: 1000 };
  const res = await apiGet(`${FILE_API}/service-groups/Default/search-files`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.availableFiles || data.files || data.value || [];
}

// All XML/ATML files in a specific workspace (scoped via the workspace query param).
async function queryWorkspaceXml(workspaceId) {
  const xml = [];
  let skip = 0;
  let total = null;
  while (total === null || skip < total) {
    const body = { take: SERVER_PAGE, skip, orderBy: 'createdTime', orderByDescending: true };
    const res = await apiGet(`${FILE_API}/service-groups/Default/query-files?workspace=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const items = data.availableFiles || data.files || data.value || [];
    total = data.totalCount != null ? data.totalCount : skip + items.length;
    if (!items.length) break;
    skip += items.length;
    for (const f of items) { const ext = fileExt(f); if (ext === 'xml' || ext === 'atml') xml.push(f); }
    if (skip >= 5000) break; // safety cap for very large workspaces
  }
  return xml;
}

// Debounced re-query as the user types in the file search box.
let searchTimer = null;
function onSearchInput(value) {
  state.search = (value || '').trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFiles(), 300);
}

/* ---------- Creation-time range filter ----------
 * Advanced time filter (adapted from the Kanban board web app): a trigger
 * button opens a popup with an absolute custom range plus quick presets.
 * Filtering is client-side over the fetched file set. */
const TIME_PRESETS = {
  all: 'Any time',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '180d': 'Last 6 months',
  '365d': 'Last year',
};
const DEFAULT_TIME = '90d';

function getRelativeDateStart(value, ref = new Date()) {
  if (!value || value === 'all') return null;
  const m = String(value).match(/^(\d+)([mhdwy])$/i);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const per = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 }[m[2].toLowerCase()];
  if (!per) return null;
  return new Date(ref.getTime() - amount * per);
}

function getActiveTimeRange() {
  if (state.timeMode === 'custom' && state.timeCustom && state.timeCustom.start && state.timeCustom.end) {
    return state.timeCustom;
  }
  const start = getRelativeDateStart(state.timeValue || DEFAULT_TIME);
  if (!start) return null;
  return { start, end: new Date() };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatDateTimeLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatDateTimeFieldValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function parseDateTimeFieldValue(value) {
  const raw = (value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}
function formatDisplayDateTime(d) {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function updateDateButton() {
  const label = $('#date-range-label');
  updateQuickRangeState();
  if (state.timeMode === 'custom' && state.timeCustom) {
    label.textContent = `${formatDisplayDateTime(state.timeCustom.start)} – ${formatDisplayDateTime(state.timeCustom.end)}`;
    $('#date-range-btn').title = `${state.timeCustom.start.toLocaleString()} to ${state.timeCustom.end.toLocaleString()}`;
    return;
  }
  label.textContent = TIME_PRESETS[state.timeValue] || TIME_PRESETS[DEFAULT_TIME];
  $('#date-range-btn').title = 'Filter by creation time';
}

function updateQuickRangeState() {
  const activeValue = state.timeMode === 'preset' ? (state.timeValue || DEFAULT_TIME) : null;
  $('#date-dialog').querySelectorAll('.date-quick-btn').forEach((btn) => {
    const isActive = activeValue != null && btn.dataset.range === activeValue;
    btn.classList.toggle('is-active', isActive);
    if (isActive) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
  });
}

function openDateDialog() {
  const dialog = $('#date-dialog');
  if (dialog.open) { closeDateDialog(); return; }
  const now = new Date();
  const fallbackStart = getRelativeDateStart(state.timeValue || DEFAULT_TIME, now) || new Date(now.getTime() - 30 * 864e5);
  const startDate = (state.timeCustom && state.timeCustom.start) || fallbackStart;
  const endDate = (state.timeCustom && state.timeCustom.end) || now;
  $('#date-start-input').value = formatDateTimeFieldValue(startDate);
  $('#date-end-input').value = formatDateTimeFieldValue(endDate);
  $('#date-start-native').value = formatDateTimeLocal(startDate);
  $('#date-end-native').value = formatDateTimeLocal(endDate);
  updateQuickRangeState();
  dialog.show();
  positionDateDialog();
  $('#date-range-btn').setAttribute('aria-expanded', 'true');
}
function closeDateDialog() {
  const dialog = $('#date-dialog');
  if (dialog.open) dialog.close();
  $('#date-range-btn').setAttribute('aria-expanded', 'false');
}
function positionDateDialog() {
  const margin = 12;
  const dialog = $('#date-dialog');
  const triggerRect = $('#date-range-btn').getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.margin = '0';
  dialog.style.maxWidth = `${Math.max(320, window.innerWidth - margin * 2)}px`;
  const rect = dialog.getBoundingClientRect();
  const left = Math.min(Math.max(triggerRect.left, margin), Math.max(margin, window.innerWidth - rect.width - margin));
  const top = Math.min(Math.max(triggerRect.bottom + 6, margin), Math.max(margin, window.innerHeight - rect.height - margin));
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
}
function onDatePointerDown(e) {
  const dialog = $('#date-dialog');
  if (!dialog.open) return;
  if (dialog.contains(e.target) || $('#date-range-btn').contains(e.target)) return;
  closeDateDialog();
}
function onDateViewportChange() { if ($('#date-dialog').open) positionDateDialog(); }
function openNativePicker(input) {
  if (!input) return;
  if (typeof input.showPicker === 'function') { input.showPicker(); return; }
  input.focus(); input.click();
}
function syncTextFromNative(nativeInput, textField) {
  const parsed = parseDateTimeFieldValue(nativeInput.value);
  if (parsed) textField.value = formatDateTimeFieldValue(parsed);
}
function syncNativeFromText(textField, nativeInput) {
  const parsed = parseDateTimeFieldValue(textField.value);
  if (!parsed) return;
  nativeInput.value = formatDateTimeLocal(parsed);
  textField.value = formatDateTimeFieldValue(parsed);
}
function applyQuickRange(value) {
  state.timeMode = 'preset';
  state.timeValue = value || DEFAULT_TIME;
  state.timeCustom = null;
  updateDateButton();
  closeDateDialog();
  applyAndRender();
}
function applyCustomRange(e) {
  e.preventDefault();
  const start = parseDateTimeFieldValue($('#date-start-input').value);
  const end = parseDateTimeFieldValue($('#date-end-input').value);
  if (!start || !end) { setFileStatus('Please enter a valid creation time range.', true); return; }
  if (end < start) { setFileStatus('The end of the range must be after the start.', true); return; }
  state.timeMode = 'custom';
  state.timeCustom = { start, end };
  updateDateButton();
  closeDateDialog();
  applyAndRender();
}

function wireDateFilter() {
  $('#date-range-btn').addEventListener('click', openDateDialog);
  $('#date-dialog-form').addEventListener('submit', applyCustomRange);
  $('#date-dialog').addEventListener('cancel', closeDateDialog);
  document.addEventListener('mousedown', onDatePointerDown);
  window.addEventListener('resize', onDateViewportChange);
  window.addEventListener('scroll', onDateViewportChange, true);
  $('#date-start-pick').addEventListener('click', () => openNativePicker($('#date-start-native')));
  $('#date-end-pick').addEventListener('click', () => openNativePicker($('#date-end-native')));
  $('#date-start-native').addEventListener('input', () => syncTextFromNative($('#date-start-native'), $('#date-start-input')));
  $('#date-end-native').addEventListener('input', () => syncTextFromNative($('#date-end-native'), $('#date-end-input')));
  $('#date-start-input').addEventListener('change', () => syncNativeFromText($('#date-start-input'), $('#date-start-native')));
  $('#date-end-input').addEventListener('change', () => syncNativeFromText($('#date-end-input'), $('#date-end-native')));
  $('#date-dialog').querySelectorAll('.date-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyQuickRange(btn.dataset.range || DEFAULT_TIME));
  });
  updateDateButton();
}

function setSortColumn(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    // Text columns default to ascending; date/size default to descending.
    state.sort.dir = (key === 'name' || key === 'ext' || key === 'workspace') ? 'asc' : 'desc';
  }
  updateSortIndicators();
  applyAndRender();
}

function updateSortIndicators() {
  document.querySelectorAll('#file-table th.sortable').forEach((th) => {
    const active = th.dataset.sort === state.sort.key;
    th.classList.toggle('sorted', active);
    th.classList.toggle('desc', active && state.sort.dir === 'desc');
    th.classList.toggle('asc', active && state.sort.dir === 'asc');
    th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function renderFileTable() {
  const tbody = $('#file-tbody');
  tbody.innerHTML = '';
  const files = state.files || [];
  const empty = $('#file-empty');
  if (files.length === 0) {
    setFileStatus(state.search ? 'No XML files match your search.' : 'No XML files found.');
    if (empty) empty.hidden = false;
  } else {
    const n = files.length;
    setFileStatus(`${n} file${n === 1 ? '' : 's'}`);
    if (empty) empty.hidden = true;
  }

  for (const f of files) {
    const tr = el('tr', { class: 'file-row' + (f.id === state.selectedId ? ' selected' : '') });
    tr.tabIndex = 0;
    const nameTd = el('td', { class: 'ft-name' });
    const nameInner = el('div', { class: 'ft-name-inner' });
    nameInner.appendChild(el('span', { class: 'file-ext xml', text: fileExt(f) || 'file' }));
    nameInner.appendChild(el('span', { class: 'ft-name-text', text: fileName(f), attrs: { title: fileName(f) } }));
    nameTd.appendChild(nameInner);
    tr.appendChild(nameTd);
    tr.appendChild(el('td', { text: fileExt(f) || '\u2014' }));
    tr.appendChild(el('td', { text: formatDate(f.created || f.updated) }));
    tr.appendChild(el('td', { class: 'ft-num', text: formatSize(f.size ?? f.size64) }));
    tr.appendChild(el('td', { text: state.workspaceNames[f.workspace] || '\u2014' }));
    tr.addEventListener('click', () => selectFile(f));
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectFile(f); } });
    tbody.appendChild(tr);
  }
}
function setFileStatus(msg, isError) {
  const s = $('#file-status');
  s.textContent = msg;
  s.style.color = isError ? 'var(--fail)' : 'var(--text-muted)';
}
function formatSize(bytes) {
  if (bytes == null) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ---------- Load & render a file ---------- */
async function selectFile(f) {
  state.selectedId = f.id;
  showViewerPage();
  showLoading(true);
  try {
    const res = await apiGet(`${FILE_API}/service-groups/Default/files/${encodeURIComponent(f.id)}/data`, {
      headers: {},
    });
    const text = await res.text();
    openXml(text, fileName(f), f.id, f);
  } catch (e) {
    showViewerError(fileName(f), e.message);
  } finally {
    showLoading(false);
  }
}

/* ---------- Page navigation ---------- */
function showSearchPage() {
  state.view = 'search';
  $('#search-page').hidden = false;
  $('#viewer-page').hidden = true;
}
function showViewerPage() {
  state.view = 'viewer';
  $('#search-page').hidden = true;
  $('#viewer-page').hidden = false;
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function openXml(text, name, id, file) {
  state.currentRawText = text;
  state.currentFile = file || null;
  $('#viewer').hidden = false;
  $('#viewer-filename').textContent = name;
  $('#download-btn').onclick = () => downloadFile(id, name);

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  state.currentDoc = doc;

  // Raw view
  $('#raw-code').innerHTML = highlightXml(text);

  const body = $('#viewer-body');
  body.innerHTML = '';

  if (parseError) {
    state.currentFormat = 'xml';
    setFormatBadge('Invalid XML', false);
    body.appendChild(el('div', {
      class: 'error-box',
      text: 'This file is not valid XML and cannot be parsed. Use the Raw XML view to inspect its contents.',
    }));
    setView('rendered');
    return;
  }

  if (isAtml(doc)) {
    state.currentFormat = 'atml';
    setFormatBadge('ATML', true);
    renderAtml(doc, body);
  } else {
    state.currentFormat = 'xml';
    setFormatBadge('XML', false);
    renderGenericXml(doc, body);
  }
  setView('rendered');
}

function setFormatBadge(label, isAtml) {
  const b = $('#format-badge');
  b.textContent = label;
  b.classList.toggle('atml', !!isAtml);
}

function showViewerError(name, msg) {
  showViewerPage();
  $('#viewer').hidden = false;
  $('#viewer-filename').textContent = name;
  setFormatBadge('Error', false);
  const body = $('#viewer-body');
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'error-box', text: msg }));
  setView('rendered');
}

async function downloadFile(id, name) {
  try {
    const res = await apiGet(`${FILE_API}/service-groups/Default/files/${encodeURIComponent(id)}/data`, { headers: {} });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href: url, download: name } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- ATML detection ---------- */
const ATML_NS_HINTS = ['ieee-1636', 'ieee-1671', 'atmltestresults'];
function isAtml(doc) {
  const root = doc.documentElement;
  if (!root) return false;
  const ln = (root.localName || '').toLowerCase();
  if (ln === 'testresultscollection' || ln === 'testresults') return true;
  const ns = (root.namespaceURI || '').toLowerCase();
  if (ATML_NS_HINTS.some((h) => ns.includes(h))) return true;
  // Fallback: look for a ResultSet anywhere.
  return !!firstByLocal(root, 'ResultSet');
}

/* ---------- namespace-agnostic traversal ---------- */
function childrenByLocal(node, ...locals) {
  const set = locals.map((l) => l.toLowerCase());
  return Array.from(node.children).filter((c) => set.includes((c.localName || '').toLowerCase()));
}
function firstChildByLocal(node, local) {
  return childrenByLocal(node, local)[0] || null;
}
function firstByLocal(node, local) {
  const l = local.toLowerCase();
  const walk = (n) => {
    for (const c of Array.from(n.children)) {
      if ((c.localName || '').toLowerCase() === l) return c;
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  return walk(node);
}
function attr(node, name) {
  if (!node) return null;
  // try direct, then namespace-agnostic
  if (node.hasAttribute && node.hasAttribute(name)) return node.getAttribute(name);
  if (node.attributes) {
    for (const a of Array.from(node.attributes)) {
      if ((a.localName || a.name) && (a.localName || a.name).toLowerCase() === name.toLowerCase()) return a.value;
    }
  }
  return null;
}

/* ---------- ATML rendering ---------- */
const STEP_LOCALS = ['Test', 'SessionAction', 'TestGroup'];

function renderAtml(doc, container) {
  const results = firstByLocal(doc, 'TestResults') || doc.documentElement;
  const resultSet = firstByLocal(results, 'ResultSet');
  if (!resultSet) {
    container.appendChild(el('div', { class: 'error-box', text: 'ATML file recognized but no ResultSet was found.' }));
    return;
  }

  // ----- summary -----
  const operator = attr(firstByLocal(results, 'SystemOperator'), 'name');
  const uut = textOf(firstByLocal(firstChildByLocal(results, 'UUT') || results, 'SerialNumber'));
  const station = textOf(firstByLocal(firstChildByLocal(results, 'TestStation') || results, 'SerialNumber'));
  const overall = outcomeOf(resultSet);
  const start = attr(resultSet, 'startDateTime');
  const end = attr(resultSet, 'endDateTime');
  const rsName = attr(resultSet, 'name') || 'Test Results';

  const nodes = [buildResultSetRootNode(resultSet)];
  const stats = { passed: 0, failed: 0, done: 0, other: 0, total: 0 };
  countStats(nodes, stats);
  state.currentFilterMode = 'all';

  // Flex-column wrapper so the steps table fills the remaining vertical space.
  const root = el('div', { class: 'atml-result' });
  container.appendChild(root);
  container = root;

  // ----- result header (SystemLink-style metadata bar) -----
  const header = el('div', { class: 'result-header' });

  // File metadata / properties first.
  const file = state.currentFile;
  if (file) {
    header.appendChild(el('div', { class: 'rh-group-title', text: 'File Details' }));
    const ff = el('div', { class: 'rh-fields' });
    addField(ff, 'Size', formatSize(file.size ?? file.size64));
    addField(ff, 'Created', formatDate(file.created) || '--');
    addField(ff, 'Updated', formatDate(file.updated) || '--');
    addField(ff, 'Workspace', state.workspaceNames[file.workspace] || file.workspace || '--');
    if (file.id) {
      addFieldLink(ff, 'File ID', file.id, `/files/file/${encodeURIComponent(file.id)}/preview`);
    } else {
      addField(ff, 'File ID', '--');
    }
    const props = file.properties || {};
    for (const k of Object.keys(props)) {
      if (k === 'Name') continue;
      if (k === 'testResultId' && props[k]) {
        addFieldLink(ff, k, String(props[k]), `/testinsights/results/result/${encodeURIComponent(props[k])}/steps`);
        continue;
      }
      addField(ff, k, String(props[k]));
    }
    header.appendChild(ff);
  }

  // ATML test-result metadata.
  header.appendChild(el('div', { class: 'rh-group-title', text: 'Test Result' }));
  const fields = el('div', { class: 'rh-fields' });
  addField(fields, 'Test program', prettySequenceName(rsName));
  const statusVal = el('span', { class: 'rh-status ' + outcomeClass(overall) });
  statusVal.appendChild(statusIcon(overall));
  statusVal.appendChild(el('span', { class: 'rh-status-text', text: overall || 'Unknown' }));
  addFieldNode(fields, 'Status', statusVal);
  addField(fields, 'Serial number', uut || '--');
  addField(fields, 'Started', formatDate(start) || '--');
  addField(fields, 'Elapsed time', durationBetween(start, end));
  addField(fields, 'System', station || '--');
  addField(fields, 'Operator', operator || '--');
  header.appendChild(fields);
  container.appendChild(header);

  // ----- summary cards (also act as step filters) -----
  const cardsWrap = el('div', { class: 'summary-cards' });
  const cardDefs = [
    { mode: 'all', label: 'Total steps', value: stats.total, cls: '' },
    { mode: 'passed', label: 'Passed', value: stats.passed, cls: 'pass' },
    { mode: 'failed', label: 'Failed', value: stats.failed, cls: 'fail' },
  ];
  const cardEls = [];
  for (const def of cardDefs) {
    const card = el('button', { class: 'summary-card-btn ' + def.cls, attrs: { type: 'button', title: `Show ${def.label.toLowerCase()}` } });
    card.dataset.mode = def.mode;
    if (def.mode === state.currentFilterMode) card.classList.add('active');
    card.appendChild(el('span', { class: 'sc-label', text: def.label }));
    card.appendChild(el('span', { class: 'sc-value', text: String(def.value) }));
    card.addEventListener('click', () => setFilterMode(def.mode));
    cardEls.push(card);
    cardsWrap.appendChild(card);
  }

  // ----- flatten step tree into aligned rows -----
  const rows = flattenRows(nodes);

  const parentOf = new Map();
  const childSteps = new Map();
  for (const row of rows) {
    parentOf.set(row.id, row.parent);
    if (row.kind === 'step' && row.parent != null) {
      if (!childSteps.has(row.parent)) childSteps.set(row.parent, []);
      childSteps.get(row.parent).push(row.id);
    }
  }
  const collapsed = new Set();

  // ----- toolbar (compact summary cards + step search) -----
  const toolbar = el('div', { class: 'steps-toolbar' });
  const tools = el('div', { class: 'steps-tools' });
  const searchInput = el('nimble-text-field', { attrs: { placeholder: 'Search steps…', 'aria-label': 'Search steps', autocomplete: 'off', spellcheck: 'false' } });
  searchInput.appendChild(el('nimble-icon-magnifying-glass', { attrs: { slot: 'start' } }));
  disableSuggestions(searchInput);
  tools.appendChild(searchInput);
  toolbar.appendChild(cardsWrap);
  toolbar.appendChild(tools);
  container.appendChild(toolbar);

  function setFilterMode(mode) {
    state.currentFilterMode = mode;
    cardEls.forEach((c) => c.classList.toggle('active', c.dataset.mode === mode));
    recompute();
  }

  // ----- steps table -----
  const tableWrap = el('div', { class: 'steps-table-wrap' });
  const table = el('table', { class: 'steps-table' });
  const thead = el('thead');
  const htr = el('tr');
  ['Steps', 'Status', 'Elapsed time', 'Measurement name', 'Value', 'Unit'].forEach((h) => htr.appendChild(el('th', { text: h })));
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  const rowEls = [];
  for (const row of rows) {
    const tr = renderStepsRow(row, row.expandable ? () => toggle(row.id) : null);
    tbody.appendChild(tr);
    rowEls.push({ row, tr });
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  const noRes = el('div', { class: 'no-results', text: 'No steps match your filter.' });
  noRes.hidden = true;
  tableWrap.appendChild(noRes);
  container.appendChild(tableWrap);
  setupResizableColumns(table);

  // ----- collapse + filter -----
  function toggle(id) { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); recompute(); }
  function ancestorsExpanded(row) {
    let p = row.parent;
    while (p != null) { if (collapsed.has(p)) return false; p = parentOf.get(p); }
    return true;
  }
  function recompute() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const mode = state.currentFilterMode;
    const filtering = q !== '' || mode !== 'all';
    const selfMatch = new Map();
    for (const { row } of rowEls) {
      if (row.kind !== 'step') continue;
      const outOk = mode === 'all' || (row.outcome || '').toLowerCase() === mode;
      const qOk = !q || row.searchText.includes(q);
      selfMatch.set(row.id, outOk && qOk);
    }
    const subtree = new Map();
    for (let i = rowEls.length - 1; i >= 0; i--) {
      const row = rowEls[i].row;
      if (row.kind !== 'step') continue;
      let m = selfMatch.get(row.id) === true;
      for (const c of (childSteps.get(row.id) || [])) if (subtree.get(c)) m = true;
      subtree.set(row.id, m);
    }
    let anyVisible = false;
    for (const { row, tr } of rowEls) {
      let show;
      if (row.kind === 'step') {
        show = subtree.get(row.id) === true;
      } else {
        show = subtree.get(row.parent) === true && (!filtering || selfMatch.get(row.parent) === true);
      }
      if (show && !filtering && !ancestorsExpanded(row)) show = false;
      if (row.kind === 'step') tr.classList.toggle('is-collapsed', collapsed.has(row.id) && !filtering);
      tr.hidden = !show;
      if (show) anyVisible = true;
    }
    noRes.hidden = anyVisible;
  }

  searchInput.addEventListener('input', recompute);

  recompute();
}

// Derive a name for the ResultSet root step (TestStand shows the top sequence
// call, e.g. "MainSequence Callback").
function resultSetStepName(rs) {
  const raw = attr(rs, 'name') || '';
  const seq = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : (raw || 'MainSequence');
  return /callback/i.test(seq) ? seq : `${seq} Callback`;
}

// The ResultSet itself is the root step of the tree (its steps are its children).
function buildResultSetRootNode(resultSet) {
  const root = buildNode(resultSet);
  root.name = resultSetStepName(resultSet);
  return root;
}

function buildStepTree(parent) {
  const out = [];
  for (const child of Array.from(parent.children)) {
    const ln = (child.localName || '');
    if (!STEP_LOCALS.map((s) => s.toLowerCase()).includes(ln.toLowerCase())) continue;
    out.push(buildNode(child));
  }
  return out;
}

// Build a single step node. Measurements come from limit/generic TestResults;
// inputs from Parameters; outputs from out-direction parameters plus custom
// (additional) TestResults.
function buildNode(child) {
  const ln = child.localName || '';
  const params = extractParameters(child);
  const results = extractResults(child);
  const oEl = firstChildByLocal(child, 'Outcome') || firstChildByLocal(child, 'ActionOutcome');
  // Report text may also arrive as a Data collection item named "ReportText".
  const details = results.details.slice();
  const data = [];
  for (const d of extractData(child)) {
    if ((d.key || '').trim().toLowerCase() === 'reporttext') {
      if (d.value != null && String(d.value) !== '') details.push(d.value);
    } else {
      data.push(d);
    }
  }
  return {
    el: child,
    kind: ln,
    name: attr(child, 'callerName') || attr(child, 'name') || ln,
    id: attr(child, 'ID'),
    start: attr(child, 'startDateTime'),
    end: attr(child, 'endDateTime'),
    outcome: oEl ? attr(oEl, 'value') : null,
    outcomeQualifier: oEl ? attr(oEl, 'qualifier') : null,
    stepType: stepType(child),
    time: stepTime(child),
    children: buildStepTree(child),
    measurements: results.measurements,
    inputs: params.inputs,
    outputs: [...params.outputs, ...results.outputs],
    details,
    data,
  };
}

function outcomeOf(node) {
  const o = firstChildByLocal(node, 'Outcome') || firstChildByLocal(node, 'ActionOutcome');
  return o ? attr(o, 'value') : null;
}
function stepType(node) {
  const st = firstByLocal(node, 'StepType');
  return st ? textOf(st) : null;
}
function stepTime(node) {
  // Prefer the step's own TotalTime (scope to its own Extension so a nested
  // child step's time isn't picked up); otherwise derive it from start/end.
  const ext = firstChildByLocal(node, 'Extension');
  const t = ext ? firstByLocal(ext, 'TotalTime') : null;
  const v = t ? attr(t, 'value') : null;
  if (v != null && !isNaN(Number(v))) return Number(v);
  const start = attr(node, 'startDateTime');
  const end = attr(node, 'endDateTime');
  if (start && end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!isNaN(s) && !isNaN(e) && e >= s) return (e - s) / 1000;
  }
  return null;
}

// Build a normalized result item {name,value,unit,type,limits,array} from a
// <tr:TestResult>.
function buildResultItem(r) {
  const name = attr(r, 'name') || 'Measurement';
  const dataEl = firstChildByLocal(r, 'TestData');
  const datum = dataEl ? firstChildByLocal(dataEl, 'Datum') : null;
  const arrEl = dataEl ? firstChildByLocal(dataEl, 'IndexedArray') : null;
  const array = arrEl ? parseIndexedArray(arrEl) : null;
  const value = datum ? datumValue(datum) : '';
  const unit = datum ? (attr(datum, 'nonStandardUnit') || attr(datum, 'unit') || '')
    : (arrEl ? (attr(arrEl, 'nonStandardUnit') || attr(arrEl, 'unit') || '') : '');
  const type = datum ? shortType(attr(datum, 'type') || datumXsiType(datum))
    : (arrEl ? shortType(attr(arrEl, 'type')) : '');
  const limits = extractLimits(r);
  return { name, value, unit, type, limits, array };
}

// A TestResult is treated as a measurement when it has test limits or uses a
// generic result-type name (Numeric/String/Boolean/…). Custom-named results
// without limits are "additional results", shown as the step's Outputs.
const MEAS_TYPE_NAMES = new Set(['numeric', 'string', 'boolean', 'number', 'measurement']);
function isMeasurementResult(r) {
  if (firstChildByLocal(r, 'TestLimits')) return true;
  const name = (attr(r, 'name') || '').trim().toLowerCase();
  return MEAS_TYPE_NAMES.has(name);
}

// Split a step's <tr:TestResult>s into measurements, (additional) outputs, and
// report-text "details". ReportText results are shown in their own Details
// section (content only), not as Outputs.
function extractResults(node) {
  const results = childrenByLocal(node, 'TestResult');
  const measurements = [];
  const outputs = [];
  const details = [];
  for (const r of results) {
    const item = buildResultItem(r);
    if ((item.name || '').trim().toLowerCase() === 'reporttext') {
      if (item.value != null && String(item.value) !== '') details.push(item.value);
    } else if (isMeasurementResult(r)) {
      measurements.push(item);
    } else {
      outputs.push({ name: item.name, value: item.value, unit: item.unit });
    }
  }
  return { measurements, outputs, details };
}

// Parse <c:IndexedArray> (TestStand waveform / multi-point arrays) into a
// dimensions descriptor plus a flat list of positioned values.
function parseIndexedArray(arrEl) {
  const dimsMatch = (attr(arrEl, 'dimensions') || '').match(/\d+/g);
  const points = childrenByLocal(arrEl, 'Element').map((e) => ({
    pos: ((attr(e, 'position') || '').match(/-?\d+/g) || []).map(Number),
    value: attr(e, 'value') != null ? attr(e, 'value') : textOf(e),
  }));
  return { dims: dimsMatch ? dimsMatch.map(Number) : [points.length], points };
}

// Parse <tr:Parameters>/<tr:Parameter> into step inputs and outputs.
function extractParameters(node) {
  const inputs = [];
  const outputs = [];
  const params = firstChildByLocal(node, 'Parameters');
  if (!params) return { inputs, outputs };
  for (const p of childrenByLocal(params, 'Parameter')) {
    const name = attr(p, 'name') || 'Parameter';
    const dataEl = firstChildByLocal(p, 'Data');
    const datum = dataEl ? firstChildByLocal(dataEl, 'Datum') : null;
    const value = datum ? datumValue(datum) : (attr(p, 'value') || '');
    const unit = datum ? (attr(datum, 'nonStandardUnit') || attr(datum, 'unit') || '') : '';
    const dir = (attr(p, 'direction') || '').toLowerCase();
    const item = { name, value, unit };
    if (dir.startsWith('out')) outputs.push(item);
    else if (dir === 'inout' || dir === 'in-out') { inputs.push(item); outputs.push(item); }
    else inputs.push(item);
  }
  return { inputs, outputs };
}

function datumXsiType(datum) {
  // xsi:type attribute
  return attr(datum, 'type');
}
function datumValue(datum) {
  const v = attr(datum, 'value');
  if (v != null) return v;
  const valEl = firstChildByLocal(datum, 'Value');
  return valEl ? textOf(valEl) : '';
}
function shortType(t) {
  if (!t) return '';
  return String(t).replace(/^.*?:/, '').replace(/^TS_/, '');
}

function extractLimits(testResult) {
  const tl = firstChildByLocal(testResult, 'TestLimits');
  if (!tl) return null;
  const limits = firstChildByLocal(tl, 'Limits');
  if (!limits) return null;
  let comparator = null, low = null, high = null;
  const single = firstChildByLocal(limits, 'SingleLimit');
  const pair = firstChildByLocal(limits, 'LimitPair');
  if (single) {
    comparator = attr(single, 'comparator');
    const v = datumValue(firstChildByLocal(single, 'Datum'));
    if (/^G/.test(comparator || '')) low = v; else if (/^L/.test(comparator || '')) high = v; else low = v;
  } else if (pair) {
    const comps = [];
    for (const lim of childrenByLocal(pair, 'Limit')) {
      const c = attr(lim, 'comparator');
      comps.push(c);
      const v = datumValue(firstChildByLocal(lim, 'Datum'));
      if (/^G/.test(c || '')) low = v; else if (/^L/.test(c || '')) high = v;
    }
    comparator = comps.join('');
  }
  // TestStand RawLimits are authoritative for low/high when present.
  const raw = firstByLocal(limits, 'RawLimits');
  if (raw) {
    const lo = firstChildByLocal(raw, 'Low');
    const hi = firstChildByLocal(raw, 'High');
    if (lo && attr(lo, 'value') != null) low = attr(lo, 'value');
    if (hi && attr(hi, 'value') != null) high = attr(hi, 'value');
  }
  const exp = firstByLocal(limits, 'Expected');
  if (!single && !pair && exp) { comparator = 'EQ'; low = high = datumValue(firstChildByLocal(exp, 'Datum') || exp); }
  let text = '';
  if (low != null && high != null) text = `${low} … ${high}`;
  else if (low != null) text = `${cmpSymbol(comparator)} ${low}`;
  else if (high != null) text = `${cmpSymbol(comparator)} ${high}`;
  return { comparator, low, high, text };
}
function cmpSymbol(c) {
  const map = { GT: '>', GE: '≥', LT: '<', LE: '≤', EQ: '=', NE: '≠', GELE: 'in', GTLT: 'in', LTGT: 'out' };
  return map[c] || c || '';
}

function extractData(node) {
  const dataEl = firstChildByLocal(node, 'Data');
  if (!dataEl) return [];
  const coll = firstByLocal(dataEl, 'Collection');
  if (!coll) return [];
  const items = childrenByLocal(coll, 'Item');
  return items.map((it) => {
    const datum = firstChildByLocal(it, 'Datum');
    return { key: attr(it, 'name') || '(item)', value: datum ? datumValue(datum) : '' };
  }).filter((d) => d.value !== '' && d.value != null);
}

/* ---------- Flat aligned steps grid (SystemLink Steps-page style) ---------- */
function flattenRows(nodes) {
  const rows = [];
  let seq = 0;
  const walk = (list, depth, parentId) => {
    for (const node of list) {
      const id = ++seq;
      const meas = node.measurements || [];
      const data = node.data || [];
      // Unify measurements and data items into one ordered detail list. The
      // first detail is shown inline on the step row; any additional details
      // are shown as their own rows just below it (SystemLink steps view).
      const details = [
        ...meas.map((m) => ({ kind: 'meas', measurement: m })),
        ...data.map((d) => ({ kind: 'data', dataItem: d })),
      ];
      const firstDetail = details.length ? details[0] : null;
      const extraDetails = details.slice(1);
      const expandable = node.children.length > 0;
      const searchText = (
        node.name + ' ' +
        meas.map((m) => `${m.name} ${m.value} ${m.unit}`).join(' ') + ' ' +
        data.map((d) => `${d.key} ${d.value}`).join(' ')
      ).toLowerCase();
      rows.push({
        id, parent: parentId, depth, kind: 'step',
        name: node.name, outcome: node.outcome, time: node.time,
        stepType: node.stepType, detail: firstDetail, expandable, searchText, node,
      });
      for (const d of extraDetails) {
        rows.push({ id: ++seq, parent: id, depth: depth + 1, kind: d.kind, measurement: d.measurement, dataItem: d.dataItem, stepName: node.name });
      }
      walk(node.children, depth + 1, id);
    }
  };
  walk(nodes, 0, null);
  return rows;
}

function renderStepsRow(row, onToggle) {
  const tr = el('tr', { class: 'st-row st-' + row.kind });
  if (row.kind === 'step') tr.dataset.outcome = (row.outcome || '').toLowerCase();

  // Steps column (name + hierarchy)
  const c1 = el('td', { class: 'st-cell st-name-cell' });
  c1.style.paddingLeft = `${10 + row.depth * 22}px`;
  const chev = el('span', { class: 'st-chev' });
  if (row.kind === 'step' && row.expandable) {
    chev.appendChild(el('nimble-icon-arrow-expander-down'));
    if (onToggle) {
      chev.classList.add('clickable');
      chev.addEventListener('click', (ev) => { ev.stopPropagation(); onToggle(); });
    }
  }
  c1.appendChild(chev);
  if (row.kind === 'step') {
    const nameEl = el('span', { class: 'st-name st-name-link', text: row.name, attrs: { title: 'View step details' } });
    nameEl.addEventListener('click', () => openStepDetails(row.node));
    c1.appendChild(nameEl);
  }
  tr.appendChild(c1);

  // Status column
  const c2 = el('td', { class: 'st-cell st-status-cell' });
  if (row.kind === 'step') c2.appendChild(statusIcon(row.outcome));
  tr.appendChild(c2);

  // Elapsed time
  const timeText = (row.kind === 'step' && row.time != null && !isNaN(row.time)) ? formatSeconds(row.time) : '';
  tr.appendChild(el('td', { class: 'st-cell st-time-cell', text: timeText }));

  // Measurement name / value / unit. A step row shows its first detail inline
  // (measurement or data); extra-detail rows carry their own measurement/data.
  let m = null;
  let isData = false;
  if (row.kind === 'step') {
    const det = row.detail;
    if (det) {
      isData = det.kind === 'data';
      m = isData ? { name: det.dataItem.key, value: det.dataItem.value, unit: '' } : det.measurement;
    }
  } else if (row.kind === 'data') {
    isData = true;
    m = { name: row.dataItem.key, value: row.dataItem.value, unit: '' };
  } else {
    m = row.measurement;
  }
  const mname = el('td', { class: 'st-cell st-mname-cell' });
  const mval = el('td', { class: 'st-cell st-mval-cell' });
  const munit = el('td', { class: 'st-cell st-munit-cell' });
  if (m) {
    const stepName = row.kind === 'step' ? row.name : row.stepName;
    mname.textContent = isData ? (m.name || '') : displayMeasName(m.name, stepName);
    renderMeasValue(mval, m);
    munit.textContent = m.unit || '';
    if (m.limits && m.limits.text) {
      mval.classList.add('has-limits');
      mval.title = `Limits: ${m.limits.text}`;
    }
  }
  tr.appendChild(mname);
  tr.appendChild(mval);
  tr.appendChild(munit);
  return tr;
}

// Generic measurement "names" that are really just datum types. When a
// TestResult carries one of these, SystemLink shows the step name instead.
const GENERIC_MEAS_NAMES = new Set([
  '', 'numeric', 'measurement', 'value', 'string', 'boolean', 'number', 'result', 'numericlimittest',
]);
function displayMeasName(measName, stepName) {
  const n = (measName == null ? '' : String(measName)).trim();
  if (!n || GENERIC_MEAS_NAMES.has(n.toLowerCase())) return stepName || n;
  return n;
}

// Make the steps table columns user-resizable by dragging the header edges.
let _colResizeCleanup = null;
function setupResizableColumns(table) {
  if (_colResizeCleanup) { _colResizeCleanup(); _colResizeCleanup = null; }
  // Fixed px columns (Status, Elapsed) + flexible fractions summing to 1.
  const specs = [
    { flex: 0.28 }, // Steps
    { px: 64 },     // Status
    { px: 118 },    // Elapsed time
    { flex: 0.30 }, // Measurement name
    { flex: 0.26 }, // Value
    { flex: 0.16 }, // Unit
  ];
  const colgroup = el('colgroup');
  const colEls = specs.map(() => { const c = el('col'); colgroup.appendChild(c); return c; });
  table.insertBefore(colgroup, table.firstChild);

  let userAdjusted = false;
  let widths = [];
  function computeWidths() {
    const total = (table.parentElement && table.parentElement.clientWidth) || 900;
    const fixed = specs.reduce((s, sp) => s + (sp.px || 0), 0);
    const flexTotal = Math.max(0, total - fixed);
    const w = specs.map((sp) => sp.px != null ? sp.px : Math.max(60, Math.round(flexTotal * sp.flex)));
    // Absorb rounding into the last flexible column so the table exactly fills
    // the container width (avoids a stray 1-2px horizontal scrollbar).
    const diff = total - w.reduce((a, b) => a + b, 0);
    if (diff !== 0) {
      for (let i = specs.length - 1; i >= 0; i--) { if (specs[i].px == null) { w[i] = Math.max(60, w[i] + diff); break; } }
    }
    return w;
  }
  function apply() {
    colEls.forEach((c, i) => { c.style.width = widths[i] + 'px'; });
    table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
  }
  widths = computeWidths();
  apply();

  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, i) => {
    if (i >= ths.length - 1) return; // last column has no right handle
    const handle = el('span', { class: 'col-resize-handle', attrs: { title: 'Drag to resize' } });
    th.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      userAdjusted = true;
      const startX = e.clientX;
      const startW = widths[i];
      handle.classList.add('active');
      document.body.classList.add('col-resizing');
      const onMove = (ev) => { widths[i] = Math.max(48, startW + (ev.clientX - startX)); apply(); };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('active');
        document.body.classList.remove('col-resizing');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  const onResize = () => { if (!userAdjusted) { widths = computeWidths(); apply(); } };
  window.addEventListener('resize', onResize);
  _colResizeCleanup = () => window.removeEventListener('resize', onResize);
}

// Render a measurement value: array measurements show a clickable preview that
// opens a dialog with the full data set; everything else uses renderValueInto.
function renderMeasValue(td, m) {
  if (m && m.array && m.array.points && m.array.points.length) {
    renderArrayPreview(td, m.array, m.name);
  } else {
    renderValueInto(td, m ? m.value : '');
  }
}

function renderArrayPreview(td, array, name) {
  const shape = (array.dims && array.dims.length) ? array.dims.join(' × ') : String(array.points.length);
  const preview = array.points.slice(0, 5).map((p) => p.value).join(', ');
  const more = array.points.length > 5 ? ', …' : '';
  const link = el('button', {
    class: 'array-link', attrs: { type: 'button', title: 'View full array' },
    text: `[${preview}${more}] (${shape})`,
  });
  link.addEventListener('click', (e) => { e.stopPropagation(); openArrayDialog(array, name); });
  td.classList.add('has-array');
  td.appendChild(link);
}

function openArrayDialog(array, name) {
  const overlay = el('div', { class: 'array-dialog-backdrop' });
  const dlg = el('div', { class: 'array-dialog' });
  const head = el('div', { class: 'array-dialog-head' });
  head.appendChild(el('h3', { text: name || 'Array data' }));
  const shape = (array.dims && array.dims.length) ? array.dims.join(' × ') : String(array.points.length);
  head.appendChild(el('span', { class: 'array-dialog-shape', text: shape }));
  const closeBtn = el('button', { class: 'array-dialog-close', attrs: { type: 'button', 'aria-label': 'Close' }, text: '×' });
  head.appendChild(closeBtn);
  dlg.appendChild(head);
  const body = el('div', { class: 'array-dialog-body' });
  body.appendChild(buildArrayTable(array));
  dlg.appendChild(body);
  overlay.appendChild(dlg);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  ($('#theme-provider') || document.body).appendChild(overlay);
}

function buildArrayTable(array) {
  const dims = array.dims || [];
  const points = array.points || [];
  const table = el('table', { class: 'array-table' });
  const thead = el('thead');
  const tbody = el('tbody');
  if (dims.length >= 2) {
    const rows = dims[0];
    const cols = dims[1];
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(''));
    for (const p of points) {
      const rI = p.pos[0]; const cI = p.pos[1];
      if (rI >= 0 && rI < rows && cI >= 0 && cI < cols) grid[rI][cI] = p.value;
    }
    const htr = el('tr');
    htr.appendChild(el('th', { text: '#' }));
    for (let c = 0; c < cols; c++) htr.appendChild(el('th', { text: `Column ${c}` }));
    thead.appendChild(htr);
    for (let rIdx = 0; rIdx < rows; rIdx++) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'array-idx', text: String(rIdx) }));
      for (let c = 0; c < cols; c++) tr.appendChild(el('td', { class: 'num', text: grid[rIdx][c] }));
      tbody.appendChild(tr);
    }
  } else {
    thead.innerHTML = '<tr><th>#</th><th>Value</th></tr>';
    points.forEach((p, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'array-idx', text: String(p.pos.length ? p.pos[0] : i) }));
      tr.appendChild(el('td', { class: 'num', text: p.value }));
      tbody.appendChild(tr);
    });
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

// Render a value into a cell; if it contains base64 image data URIs, show the
// is injected), so this is safe from script injection.
const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
function renderValueInto(td, value) {
  const s = value == null ? '' : String(value);
  const uris = s.match(DATA_URI_RE);
  if (uris && uris.length) {
    for (const u of uris) {
      const img = el('img', { class: 'data-img', attrs: { src: u, alt: 'embedded image', loading: 'lazy', title: 'Click to enlarge' } });
      img.addEventListener('click', (e) => { e.stopPropagation(); openImageLightbox(u); });
      td.appendChild(img);
    }
    td.classList.add('has-images');
  } else if (s.length > 50) {
    td.textContent = s.slice(0, 50) + '…';
    td.title = s;
    td.classList.add('truncated');
  } else {
    td.textContent = s;
  }
}

function openImageLightbox(src) {
  const box = $('#img-lightbox');
  const img = $('#img-lightbox-img');
  if (!box || !img) return;
  img.src = src;
  box.hidden = false;
}
function closeImageLightbox() {
  const box = $('#img-lightbox');
  if (box) box.hidden = true;
}

function statusIcon(outcome) {
  const v = (outcome || '').toLowerCase();
  const span = el('span', { class: 'st-status ' + outcomeClass(outcome) });
  let tag = null, severity = null;
  if (v === 'passed') { tag = 'nimble-icon-check'; severity = 'success'; }
  else if (v === 'failed') { tag = 'nimble-icon-times'; severity = 'error'; }
  else if (v === 'done') { tag = 'nimble-icon-check'; }
  else if (v === 'error' || v === 'errored' || v === 'terminated') { tag = 'nimble-icon-exclamation-mark'; severity = 'warning'; }
  if (tag) {
    const attrs = severity ? { severity } : {};
    span.appendChild(el(tag, { attrs }));
  } else {
    span.appendChild(el('span', { class: 'st-dot' }));
  }
  return span;
}

function countStats(nodes, stats) {
  for (const n of nodes) {
    stats.total++;
    const o = (n.outcome || '').toLowerCase();
    if (o === 'passed') stats.passed++;
    else if (o === 'failed') stats.failed++;
    else if (o === 'done') stats.done++;
    else stats.other++;
    countStats(n.children, stats);
  }
}

/* ---------- ATML helpers ---------- */
function outcomeClass(o) {
  const v = (o || '').toLowerCase();
  if (v === 'passed') return 'outcome-passed passed';
  if (v === 'failed') return 'outcome-failed failed';
  if (v === 'done') return 'outcome-done done';
  if (v === 'error' || v === 'errored') return 'outcome-error error';
  if (v === 'terminated') return 'outcome-terminated terminated';
  if (v === 'skipped') return 'outcome-skipped skipped';
  return 'outcome-unknown unknown';
}
function textOf(node) { return node ? (node.textContent || '').trim() : ''; }
function addField(container, label, value) {
  const item = el('div', { class: 'rh-item' });
  item.appendChild(el('span', { class: 'rh-label', text: label }));
  item.appendChild(el('span', { class: 'rh-value', text: value }));
  container.appendChild(item);
}
function addFieldNode(container, label, valueNode) {
  const item = el('div', { class: 'rh-item' });
  item.appendChild(el('span', { class: 'rh-label', text: label }));
  const val = el('span', { class: 'rh-value' });
  val.appendChild(valueNode);
  item.appendChild(val);
  container.appendChild(item);
}
function addFieldLink(container, label, text, href) {
  const link = el('a', {
    class: 'rh-link',
    text,
    attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
  });
  addFieldNode(container, label, link);
}
function addMeta(grid, label, value) {
  const item = el('div', { class: 'meta-item' });
  item.appendChild(el('span', { class: 'meta-label', text: label }));
  item.appendChild(el('span', { class: 'meta-value', text: value }));
  grid.appendChild(item);
}
function addStat(row, num, label, cls) {
  const chip = el('div', { class: 'stat-chip ' + cls });
  chip.appendChild(el('span', { class: 'num', text: String(num) }));
  chip.appendChild(el('span', { class: 'lbl', text: label }));
  row.appendChild(chip);
}
function prettySequenceName(name) {
  if (!name) return 'Test Results';
  const hashIdx = name.indexOf('#');
  const beforeHash = hashIdx >= 0 ? name.slice(0, hashIdx) : name;
  const base = (beforeHash.split(/[\\/]/).pop() || '').trim();
  if (base) return base;
  // No sequence-file part before the '#': fall back to the callback name
  // with the "MainSequence"/"Callback" wording stripped out.
  const after = hashIdx >= 0 ? name.slice(hashIdx + 1) : name;
  const cleaned = after.replace(/\bMainSequence\b/gi, '').replace(/\bCallback\b/gi, '').trim();
  return cleaned || after.trim() || 'Test Results';
}
function durationBetween(start, end) {
  if (!start || !end) return '—';
  const ms = new Date(end) - new Date(start);
  if (isNaN(ms) || ms < 0) return '—';
  return formatSeconds(ms / 1000);
}
function formatSeconds(s) {
  if (s == null || isNaN(s)) return '';
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m ${rem}s`;
}

/* ---------- Generic XML tree ---------- */
function renderGenericXml(doc, container) {
  const tree = el('div', { class: 'xml-tree' });
  // Render any leading processing instructions / comments at document level.
  for (const n of Array.from(doc.childNodes)) {
    if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      tree.appendChild(el('div', { class: 'xml-decl xml-content', text: `<?${n.target} ${n.data}?>` }));
    }
  }
  tree.appendChild(renderXmlElement(doc.documentElement, 0));
  container.appendChild(tree);
}

function renderXmlElement(node, depth) {
  const wrap = el('div', { class: 'xml-el' });

  const childElements = Array.from(node.childNodes).filter(
    (c) => c.nodeType === Node.ELEMENT_NODE ||
      (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) ||
      c.nodeType === Node.COMMENT_NODE ||
      c.nodeType === Node.CDATA_SECTION_NODE
  );
  const onlyText = childElements.length === 1 && childElements[0].nodeType !== Node.ELEMENT_NODE && childElements[0].nodeType !== Node.COMMENT_NODE;
  const hasElementChildren = childElements.some((c) => c.nodeType === Node.ELEMENT_NODE || c.nodeType === Node.COMMENT_NODE);
  const empty = childElements.length === 0;

  const line = el('div', { class: 'xml-line' });
  const toggle = el('span', { class: 'xml-toggle' + (hasElementChildren ? '' : ' placeholder'), text: hasElementChildren ? '▾' : '' });
  line.appendChild(toggle);

  const content = el('span', { class: 'xml-content' });
  const openParts = [];
  openParts.push(spanHtml('tag', `&lt;${escapeHtml(node.nodeName)}`));
  for (const a of Array.from(node.attributes || [])) {
    openParts.push(' ' + spanHtml('attr-name', escapeHtml(a.nodeName)) + spanHtml('tag', '=') + spanHtml('attr-value', `&quot;${escapeHtml(a.value)}&quot;`));
  }

  if (empty) {
    openParts.push(spanHtml('tag', '/&gt;'));
    content.innerHTML = openParts.join('');
  } else if (onlyText) {
    openParts.push(spanHtml('tag', '&gt;'));
    openParts.push(spanHtml('xml-text', escapeHtml(childElements[0].textContent.trim())));
    openParts.push(spanHtml('tag', `&lt;/${escapeHtml(node.nodeName)}&gt;`));
    content.innerHTML = openParts.join('');
  } else {
    openParts.push(spanHtml('tag', '&gt;'));
    openParts.push(`<span class="xml-collapsed-hint">…&lt;/${escapeHtml(node.nodeName)}&gt;</span>`);
    content.innerHTML = openParts.join('');
  }
  line.appendChild(content);
  wrap.appendChild(line);

  if (!empty && !onlyText) {
    const children = el('div', { class: 'xml-children' });
    for (const c of childElements) {
      if (c.nodeType === Node.ELEMENT_NODE) {
        children.appendChild(renderXmlElement(c, depth + 1));
      } else if (c.nodeType === Node.COMMENT_NODE) {
        children.appendChild(el('div', { class: 'xml-comment xml-content', text: `<!-- ${c.textContent.trim()} -->` }));
      } else {
        children.appendChild(el('div', { class: 'xml-text xml-content', text: c.textContent.trim() }));
      }
    }
    const closeLine = el('div', { class: 'xml-line' });
    closeLine.appendChild(el('span', { class: 'xml-toggle placeholder' }));
    closeLine.appendChild(el('span', { class: 'xml-content', html: spanHtml('tag', `&lt;/${escapeHtml(node.nodeName)}&gt;`) }));
    wrap.appendChild(children);
    wrap.appendChild(closeLine);

    if (hasElementChildren) {
      const doToggle = () => {
        const collapsed = wrap.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
        closeLine.style.display = collapsed ? 'none' : '';
      };
      toggle.addEventListener('click', doToggle);
      // clicking the open tag also toggles
      content.style.cursor = 'pointer';
      content.addEventListener('click', doToggle);
    }
  }
  return wrap;
}

function spanHtml(cls, inner) { return `<span class="${cls}">${inner}</span>`; }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- Raw XML syntax highlighting (IDE-like) ---------- */
function highlightXml(text) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/?[A-Za-z_][^>]*?\/?>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out += spanHtml('xml-text', esc(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('<!--')) out += spanHtml('xml-comment', esc(tok));
    else if (tok.startsWith('<?')) out += spanHtml('xml-decl', esc(tok));
    else if (tok.startsWith('<![CDATA[')) out += spanHtml('xml-text', esc(tok));
    else if (tok.startsWith('<!DOCTYPE')) out += spanHtml('xml-decl', esc(tok));
    else out += highlightXmlTag(tok, esc);
    last = m.index + tok.length;
  }
  if (last < text.length) out += spanHtml('xml-text', esc(text.slice(last)));
  return out;
}

function highlightXmlTag(tok, esc) {
  const mm = /^<(\/?)([A-Za-z_][\w:.\-]*)([\s\S]*?)(\/?)>$/.exec(tok);
  if (!mm) return spanHtml('tag', esc(tok));
  const slash = mm[1], name = mm[2], attrs = mm[3], selfClose = mm[4];
  let html = spanHtml('tag', `&lt;${slash}${esc(name)}`);
  html += esc(attrs).replace(/([\w:.\-]+)(\s*=\s*)("[^"]*"|'[^']*')/g,
    (w, an, eq, av) => `${spanHtml('attr-name', an)}${eq}${spanHtml('attr-value', av)}`);
  html += spanHtml('tag', `${selfClose ? '/' : ''}&gt;`);
  return html;
}

/* ---------- View switching ---------- */
let suppressViewToggle = false;
function setView(which) {
  const rendered = which === 'rendered';
  $('#viewer-body').hidden = !rendered;
  $('#raw-view').hidden = rendered;
  suppressViewToggle = true;
  $('#view-rendered').checked = rendered;
  $('#view-raw').checked = !rendered;
  suppressViewToggle = false;
}

function showLoading(on) { $('#loading-overlay').hidden = !on; }

// Turn off browser autofill/suggestion dropdowns on a nimble-text-field.
function disableSuggestions(tf) {
  if (!tf) return;
  const apply = () => {
    const inp = tf.shadowRoot && tf.shadowRoot.querySelector('input');
    if (inp) {
      inp.setAttribute('autocomplete', 'off');
      inp.setAttribute('autocapitalize', 'off');
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('spellcheck', 'false');
      return true;
    }
    return false;
  };
  if (!apply()) setTimeout(apply, 0);
}

/* ---------- Step details slide-out ---------- */
function openStepDetails(node) {
  if (!node) return;
  $('#drawer-step-name').textContent = node.name || '';

  const info = $('#drawer-info');
  info.innerHTML = '';
  info.appendChild(drawerSection('Measurements', renderMeasurementsTable(node)));
  const inputs = node.inputs || [];
  const outputs = node.outputs || [];
  info.appendChild(drawerSection('Inputs', inputs.length
    ? renderParamsTable(inputs) : el('div', { class: 'drawer-empty', text: 'No inputs' })));
  info.appendChild(drawerSection('Outputs', outputs.length
    ? renderParamsTable(outputs) : el('div', { class: 'drawer-empty', text: 'No outputs' })));
  if (node.details && node.details.length) {
    info.appendChild(drawerSection('Details', renderDetailsBlock(node.details)));
  }
  info.appendChild(drawerSection('Properties', renderPropertiesTable(node)));

  const data = $('#drawer-data');
  data.innerHTML = '';
  if (node.el) {
    const xml = new XMLSerializer().serializeToString(node.el);
    const pre = el('pre', { class: 'drawer-raw' });
    const code = el('code');
    code.innerHTML = highlightXml(xml);
    pre.appendChild(code);
    data.appendChild(pre);
  } else {
    data.appendChild(el('div', { class: 'drawer-empty', text: 'No data' }));
  }

  setDrawerTab('info');
  $('#step-drawer').classList.add('open');
  $('#drawer-backdrop').classList.add('open');
}
function closeStepDetails() {
  $('#step-drawer').classList.remove('open');
  $('#drawer-backdrop').classList.remove('open');
}
function setDrawerTab(which) {
  const info = which === 'info';
  $('#drawer-info').hidden = !info;
  $('#drawer-data').hidden = info;
  $('#dtab-info').classList.toggle('active', info);
  $('#dtab-data').classList.toggle('active', !info);
}
// Render report-text "details": base64 images become clickable thumbnails and
// everything else is shown as full text (no name labels).
function renderDetailsBlock(values) {
  const wrap = el('div', { class: 'drawer-details' });
  for (const v of values) {
    const s = v == null ? '' : String(v);
    const uris = s.match(DATA_URI_RE);
    if (uris && uris.length) {
      for (const u of uris) {
        const img = el('img', { class: 'data-img', attrs: { src: u, alt: 'report image', loading: 'lazy', title: 'Click to enlarge' } });
        img.addEventListener('click', (e) => { e.stopPropagation(); openImageLightbox(u); });
        wrap.appendChild(img);
      }
    } else {
      wrap.appendChild(el('pre', { class: 'detail-text', text: s }));
    }
  }
  return wrap;
}
function drawerSection(title, contentEl) {
  const sec = el('div', { class: 'drawer-section' });
  const head = el('button', { class: 'drawer-section-head', attrs: { type: 'button' } });
  head.appendChild(el('span', { class: 'ds-chev', text: '▾' }));
  head.appendChild(el('span', { class: 'ds-title', text: title }));
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  const body = el('div', { class: 'drawer-section-body' });
  body.appendChild(contentEl);
  sec.appendChild(head);
  sec.appendChild(body);
  return sec;
}
function renderMeasurementsTable(node) {
  // Every step shows at least its own pass/fail measurement (empty value).
  const meas = (node.measurements && node.measurements.length)
    ? node.measurements
    : [{ name: node.name, value: '', unit: '', limits: null }];
  const table = el('table', { class: 'drawer-table' });
  const thead = el('thead');
  thead.innerHTML = '<tr><th>Name</th><th>Value</th><th>Unit</th><th>Low Limit</th><th>High Limit</th><th>Comparison Type</th><th class="dt-status"></th></tr>';
  table.appendChild(thead);
  const tb = el('tbody');
  for (const m of meas) {
    const lim = m.limits || {};
    const tr = el('tr');
    tr.appendChild(el('td', { text: displayMeasName(m.name, node.name) }));
    const valTd = el('td', { class: 'num' });
    renderMeasValue(valTd, m);
    tr.appendChild(valTd);
    tr.appendChild(el('td', { text: m.unit || '' }));
    tr.appendChild(el('td', { class: 'num', text: lim.low != null ? String(lim.low) : '' }));
    tr.appendChild(el('td', { class: 'num', text: lim.high != null ? String(lim.high) : '' }));
    tr.appendChild(el('td', { text: lim.comparator || '' }));
    const st = el('td', { class: 'dt-status' });
    st.appendChild(statusIcon(node.outcome));
    tr.appendChild(st);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  return table;
}
function renderParamsTable(items) {
  const hasUnit = items.some((i) => i.unit);
  const table = el('table', { class: 'drawer-table' });
  const thead = el('thead');
  thead.innerHTML = hasUnit
    ? '<tr><th>Name</th><th>Value</th><th>Unit</th></tr>'
    : '<tr><th>Name</th><th>Value</th></tr>';
  table.appendChild(thead);
  const tb = el('tbody');
  for (const it of items) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: it.name || '' }));
    const valTd = el('td', { class: 'num' });
    renderValueInto(valTd, it.value);
    tr.appendChild(valTd);
    if (hasUnit) tr.appendChild(el('td', { text: it.unit || '' }));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  return table;
}
function renderPropertiesTable(node) {
  const props = [
    ['Started at', formatDate(node.start) || '—'],
    ['Ended at', formatDate(node.end) || '—'],
    ['Status type', node.outcome || '—'],
    ['Step type', node.stepType || '—'],
    ['Total time', (node.time != null && !isNaN(node.time)) ? formatSeconds(node.time) : '—'],
    ['ID', node.id || '—'],
  ];
  return keyValueTable(props);
}
function renderDataTable(data) {
  return keyValueTable(data.map((d) => [d.key, d.value != null ? String(d.value) : '']));
}
function keyValueTable(rows) {
  const table = el('table', { class: 'drawer-table' });
  const thead = el('thead');
  thead.innerHTML = '<tr><th>Name</th><th>Value</th></tr>';
  table.appendChild(thead);
  const tb = el('tbody');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: k }));
    tr.appendChild(el('td', { text: v }));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  return table;
}


/* ---------- Theme ---------- */
/* The theme is taken from the SystemLink user account setting. The SystemLink
   shell stores the active theme in localStorage under the "theme" key, and the
   web app is hosted in a same-origin iframe, so it shares that value. We simply
   mirror it onto our Nimble theme provider and follow live changes. */
const NIMBLE_THEMES = ['light', 'dark', 'color', 'legacy'];
function readSystemLinkTheme() {
  try {
    const t = (localStorage.getItem('theme') || '').toLowerCase();
    if (NIMBLE_THEMES.includes(t)) return t;
  } catch { /* localStorage may be unavailable */ }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch { /* ignore */ }
  return 'light';
}
function applyTheme(theme) {
  const provider = $('#theme-provider');
  if (provider) provider.setAttribute('theme', NIMBLE_THEMES.includes(theme) ? theme : 'light');
}
function initTheme() {
  applyTheme(readSystemLinkTheme());
  // Follow the account/shell theme if the user changes it while the app is open.
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme' || e.key === null) applyTheme(readSystemLinkTheme());
  });
}

/* ---------- File upload slide-out ---------- */
const uploadQueue = [];   // [{ file, state: 'ready'|'uploading'|'done'|'error', id, error }]

function openUploadDrawer() {
  $('#upload-drawer').classList.add('open');
  $('#upload-backdrop').classList.add('open');
}
function closeUploadDrawer() {
  $('#upload-drawer').classList.remove('open');
  $('#upload-backdrop').classList.remove('open');
}

function isXmlFile(file) {
  return /\.(xml|atml)$/i.test(file.name) || file.type === 'text/xml' || file.type === 'application/xml';
}

function addUploadFiles(fileList) {
  let added = 0;
  for (const file of Array.from(fileList)) {
    if (!isXmlFile(file)) continue;
    if (uploadQueue.some((q) => q.file.name === file.name && q.file.size === file.size)) continue;
    uploadQueue.push({ file, state: 'ready', detail: '', fileId: null, resultId: null });
    added++;
  }
  renderUploadRows();
  return added;
}

const UL_STATE_LABEL = {
  ready: 'Ready', working: 'Working…', created: 'Created', replaced: 'Replaced',
  skipped: 'Skipped', uploaded: 'Uploaded', error: 'Error',
};

function renderUploadRows() {
  const tbody = $('#upload-rows');
  tbody.innerHTML = '';
  for (const q of uploadQueue) {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'ul-name', text: q.file.name, attrs: { title: q.file.name } }));
    tr.appendChild(el('td', { class: 'ft-num', text: formatSize(q.file.size) }));
    const stateTd = el('td', { class: 'ul-state ' + q.state, text: UL_STATE_LABEL[q.state] || q.state });
    if (q.detail) stateTd.title = q.detail;
    tr.appendChild(stateTd);
    tbody.appendChild(tr);
  }
  const pending = uploadQueue.filter((q) => q.state === 'ready').length;
  $('#upload-ok').disabled = pending === 0;
}

async function uploadFileToService(file, workspaceId) {
  const form = new FormData();
  form.append('file', file, file.name);
  let url = `${FILE_API}/service-groups/Default/upload-files`;
  if (workspaceId) url += `?workspace=${encodeURIComponent(workspaceId)}`;
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: form });
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403
      ? 'Not authorized to upload to this workspace.'
      : `Upload failed (${res.status} ${res.statusText}).`;
    throw new Error(msg);
  }
  const data = await res.json().catch(() => ({}));
  const uri = data.uri || '';
  const id = uri.split('/').filter(Boolean).pop();
  return id;
}

/* ---------- Create result data (ATML → SystemLink Test Monitor) ---------- */
const TM_API = '/nitestmonitor/v2';

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tmPost(path, body, expectJson = true) {
  const res = await fetch(`${TM_API}/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Test Monitor request '${path}' failed (${res.status}).`);
  if (!expectJson || res.status === 204) return {};
  return res.json().catch(() => ({}));
}
async function tmCreateResult(resultRequest) {
  const data = await tmPost('results', { results: [resultRequest] });
  const r = (data.results && data.results[0]) || null;
  if (!r || !r.id) throw new Error('Failed to create test result.');
  return r.id;
}
async function tmCreateSteps(steps) {
  return tmPost('steps', { steps, updateResultTotalTime: true });
}
async function findResultsByChecksum(checksum) {
  const data = await tmPost('query-results', {
    filter: 'properties["ATML Checksum"] == @0', substitutions: [checksum], take: 100, returnCount: true,
  });
  return data.results || [];
}
async function tmDeleteResults(ids) {
  if (!ids.length) return;
  await tmPost('delete-results', { ids }, false);
}
// Files can't be reliably queried by a custom property on the file service, so
// existing files are located via their linked result's fileIds instead.
async function findFilesByChecksum() {
  return [];
}
async function deleteFiles(ids) {
  if (!ids.length) return;
  await apiGet(`${FILE_API}/service-groups/Default/delete-files`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}
async function updateFileMetadata(fileId, properties) {
  await apiGet(`${FILE_API}/service-groups/Default/files/${encodeURIComponent(fileId)}/update-metadata`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ replaceExisting: false, properties }),
  });
}

function toIso(dt) {
  if (dt) { const d = new Date(dt); if (!isNaN(d)) return d.toISOString(); }
  return new Date().toISOString();
}
function strOrEmpty(v) { return v == null ? '' : String(v); }

// Map an ATML outcome (+qualifier) to a Test Monitor status object.
const ATML_STATUS = {
  passed: { statusType: 'PASSED', statusName: 'Passed' },
  failed: { statusType: 'FAILED', statusName: 'Failed' },
  done: { statusType: 'DONE', statusName: 'Done' },
  errored: { statusType: 'ERRORED', statusName: 'Errored' },
  error: { statusType: 'ERRORED', statusName: 'Errored' },
  terminated: { statusType: 'TERMINATED', statusName: 'Terminated' },
  skipped: { statusType: 'SKIPPED', statusName: 'Skipped' },
  notstarted: { statusType: 'SKIPPED', statusName: 'Skipped' },
  running: { statusType: 'RUNNING', statusName: 'Running' },
  'timed out': { statusType: 'TIMED_OUT', statusName: 'Timed Out' },
};
function statusObjectFor(node) {
  let s = (node.outcome || '').trim().toLowerCase();
  if (s === 'aborted' || s === 'userdefined') s = (node.outcomeQualifier || '').trim().toLowerCase();
  return ATML_STATUS[s] || { statusType: 'DONE', statusName: node.outcome || 'Done' };
}

function extractPartNumber(results) {
  const idn = firstByLocal(results, 'IdentificationNumber');
  const num = idn ? attr(idn, 'number') : null;
  return num || null;
}

// Build a Test Monitor result request + step-builder from a parsed ATML doc,
// reusing the same node tree the viewer renders.
function buildResultAndSteps(doc, opts) {
  const results = firstByLocal(doc, 'TestResults') || doc.documentElement;
  const resultSet = firstByLocal(results, 'ResultSet');
  const rootNode = buildResultSetRootNode(resultSet);

  const operator = attr(firstByLocal(results, 'SystemOperator'), 'name') || null;
  const uutEl = firstChildByLocal(results, 'UUT');
  const serial = textOf(firstByLocal(uutEl || results, 'SerialNumber')) || null;
  const stationSerial = textOf(firstByLocal(firstChildByLocal(results, 'TestStation') || results, 'SerialNumber')) || null;
  const partNumber = extractPartNumber(results);
  const rootStatus = statusObjectFor(rootNode);

  const resultRequest = {
    programName: prettySequenceName(attr(resultSet, 'name')) || 'ATML Result',
    status: rootStatus,
    systemId: stationSerial || undefined,
    hostName: stationSerial || undefined,
    properties: { 'ATML Checksum': opts.checksum },
    keywords: ['ATML File Manager'],
    serialNumber: serial || undefined,
    operator: operator || undefined,
    partNumber: partNumber || undefined,
    startedAt: toIso(rootNode.start),
    totalTimeInSeconds: (rootNode.time != null && !isNaN(rootNode.time)) ? rootNode.time : 0,
    workspace: opts.workspaceId || undefined,
    fileIds: opts.fileId ? [opts.fileId] : undefined,
  };

  function buildStepRequest(node, resultId, parentId, stepId) {
    const status = statusObjectFor(node);
    const params = [];
    for (const m of (node.measurements || [])) {
      const p = { name: displayMeasName(m.name, node.name), status: status.statusName };
      if (m.value != null && m.value !== '') p.measurement = String(m.value);
      if (m.unit) p.units = m.unit;
      const lim = m.limits || {};
      if (lim.low != null) p.lowLimit = String(lim.low);
      if (lim.high != null) p.highLimit = String(lim.high);
      if (lim.comparator) p.comparisonType = lim.comparator === 'CIEQ' ? 'IgnoreCase' : lim.comparator;
      params.push(p);
    }
    if (!params.length) params.push({ name: node.name, status: status.statusName });
    const inputs = (node.inputs || []).map((i) => ({ name: i.name, value: strOrEmpty(i.value) }));
    const outputs = (node.outputs || []).map((o) => ({ name: o.name, value: strOrEmpty(o.value) }));
    const reportText = (node.details || []).map(String).join('\n');
    return {
      stepId, parentId, resultId,
      name: node.name,
      stepType: node.stepType || node.kind || 'Test',
      status,
      startedAt: toIso(node.start),
      totalTimeInSeconds: (node.time != null && !isNaN(node.time)) ? node.time : 0,
      dataModel: 'TestStand',
      data: { text: reportText, parameters: params },
      inputs: inputs.length ? inputs : undefined,
      outputs: outputs.length ? outputs : undefined,
    };
  }

  function buildSteps(resultId) {
    const steps = [];
    let seq = 0;
    const walk = (node, parentStepId) => {
      const stepId = `s${++seq}`;
      steps.push(buildStepRequest(node, resultId, parentStepId, stepId));
      for (const child of (node.children || [])) walk(child, stepId);
    };
    walk(rootNode, 'root');
    return steps;
  }

  return { resultRequest, buildSteps };
}

// Import a single queued file. Returns { state, detail, fileId, resultId }.
async function importOneFile(q, opts) {
  const text = await q.file.text();
  const checksum = await sha256Hex(text);
  q.checksum = checksum;

  if (!opts.createResults) {
    const id = await uploadFileToService(q.file, opts.workspaceId);
    await updateFileMetadata(id, { 'ATML Checksum': checksum }).catch(() => {});
    return { state: 'uploaded', detail: `File uploaded (checksum ${checksum.slice(0, 12)}…). No result created.`, fileId: id };
  }

  const existingResults = await findResultsByChecksum(checksum);
  const fileIdsFromResults = [...new Set(existingResults.flatMap((r) => r.fileIds || []))];
  const orphanFiles = await findFilesByChecksum(checksum);
  const existingFileIds = [...new Set([...fileIdsFromResults, ...orphanFiles])];
  const hasExisting = existingResults.length > 0 || existingFileIds.length > 0;

  if (hasExisting && !opts.replace) {
    return { state: 'skipped', detail: `Skipped — a file/result with this checksum already exists (${existingResults.length} result(s), ${existingFileIds.length} file(s)). Enable "Replace existing files/results?" to overwrite.` };
  }

  let replaced = false;
  if (hasExisting && opts.replace) {
    if (existingResults.length) await tmDeleteResults(existingResults.map((r) => r.id));
    if (existingFileIds.length) await deleteFiles(existingFileIds);
    replaced = true;
  }

  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('File is not valid XML.');
  if (!isAtml(doc)) throw new Error('File is not recognized as ATML.');

  const fileId = await uploadFileToService(q.file, opts.workspaceId);
  const { resultRequest, buildSteps } = buildResultAndSteps(doc, { checksum, workspaceId: opts.workspaceId, fileId });
  const resultId = await tmCreateResult(resultRequest);
  const steps = buildSteps(resultId);
  if (steps.length) await tmCreateSteps(steps);
  await updateFileMetadata(fileId, { 'ATML Checksum': checksum, testResultId: resultId }).catch(() => {});

  return {
    state: replaced ? 'replaced' : 'created',
    detail: `${replaced ? 'Replaced existing file/result. ' : ''}Created result ${resultId} with ${steps.length} step(s).`,
    fileId, resultId,
  };
}

async function runUpload() {
  const wsId = $('#upload-workspace').value;
  const createResults = $('#opt-create-results').checked;
  const replace = $('#opt-replace-existing').checked;
  $('#upload-ok').disabled = true;
  const DONE_STATES = ['created', 'replaced', 'skipped', 'uploaded'];
  for (const q of uploadQueue) {
    if (DONE_STATES.includes(q.state)) continue;
    q.state = 'working';
    q.detail = '';
    renderUploadRows();
    try {
      const r = await importOneFile(q, { workspaceId: wsId, createResults, replace });
      q.state = r.state;
      q.detail = r.detail;
      q.fileId = r.fileId;
      q.resultId = r.resultId;
    } catch (e) {
      q.state = 'error';
      q.detail = e.message;
    }
    renderUploadRows();
  }

  // Keep the drawer open so users can review each file's status.
  // Refresh the search list so imported files appear there. The file-service
  // search index lags a moment behind upload, so poll until they show up.
  const importedIds = uploadQueue
    .filter((q) => ['created', 'replaced', 'uploaded'].includes(q.state) && q.fileId)
    .map((q) => q.fileId);
  await refreshAfterImport(importedIds);
  renderUploadRows();
}

// Refresh the file list after an import, retrying briefly to let the
// file-service search index catch up with the freshly uploaded files.
async function refreshAfterImport(importedIds) {
  const wanted = new Set((importedIds || []).filter(Boolean));
  for (let attempt = 0; attempt < 6; attempt++) {
    state.loading = false; // ensure the refresh isn't skipped by the in-flight guard
    await loadFiles();
    if (!wanted.size) return;
    const present = state.allFiles.some((f) => wanted.has(f.id));
    if (present) return;
    if (attempt < 5) await new Promise((r) => setTimeout(r, 1000));
  }
}

function wireUploadDrawer() {
  $('#nav-import').addEventListener('click', openUploadDrawer);
  $('#upload-close').addEventListener('click', closeUploadDrawer);
  $('#upload-backdrop').addEventListener('click', closeUploadDrawer);
  $('#upload-ok').addEventListener('click', () => runUpload());
  $('#upload-workspace').addEventListener('change', renderUploadRows);

  const input = $('#file-input');
  $('#dz-browse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addUploadFiles(input.files); input.value = ''; });

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev !== 'dragleave' || e.target === dz) dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addUploadFiles(e.dataTransfer.files); });
}

function init() {
  initTheme();
  $('#file-search').addEventListener('input', (e) => onSearchInput(e.target.value));
  disableSuggestions($('#file-search'));
  $('#refresh-btn').addEventListener('click', () => loadFiles());
  $('#workspace-select').addEventListener('change', (e) => { state.workspace = e.target.value; loadFiles(); });
  wireDateFilter();

  $('#nav-search').addEventListener('click', showSearchPage);
  $('#back-to-files').addEventListener('click', showSearchPage);

  document.querySelectorAll('#file-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => setSortColumn(th.dataset.sort));
  });
  updateSortIndicators();

  $('#view-rendered').addEventListener('change', (e) => { if (suppressViewToggle) return; if (e.target.checked) setView('rendered'); else { suppressViewToggle = true; e.target.checked = true; suppressViewToggle = false; } });
  $('#view-raw').addEventListener('change', (e) => { if (suppressViewToggle) return; if (e.target.checked) setView('raw'); else { suppressViewToggle = true; e.target.checked = true; suppressViewToggle = false; } });

  $('#drawer-close').addEventListener('click', closeStepDetails);
  $('#drawer-backdrop').addEventListener('click', closeStepDetails);
  $('#dtab-info').addEventListener('click', () => setDrawerTab('info'));
  $('#dtab-data').addEventListener('click', () => setDrawerTab('data'));
  $('#img-lightbox').addEventListener('click', closeImageLightbox);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDateDialog(); closeImageLightbox(); closeStepDetails(); closeUploadDrawer(); } });

  wireUploadDrawer();

  fetchWorkspaces().then((list) => {
    const sorted = list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const sel = $('#workspace-select');
    const upSel = $('#upload-workspace');
    for (const w of sorted) {
      sel.appendChild(el('nimble-list-option', { text: w.name || w.id, attrs: { value: w.id } }));
      const opt = el('nimble-list-option', { text: w.name || w.id, attrs: { value: w.id } });
      upSel.appendChild(opt);
    }
    // Default the upload workspace to the first available workspace.
    if (sorted.length && upSel.value === '') upSel.value = sorted[0].id;
    renderUploadRows();
    applyAndRender();
  });

  loadFiles();
}

document.addEventListener('DOMContentLoaded', init);
