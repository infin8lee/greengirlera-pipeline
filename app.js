import { STAGES, DRAFT_FIELDS, PIPELINE_COLUMNS, OUTREACH_COLUMNS, esc, parseCSV, csv, safeURL, money, amount, stage, planImport, exportRows, composeDraft, isPortalRoute } from './core.js';

const root = document.querySelector('#app');
const DEFAULT_BRIEF = {
  organization: 'Green Girl Era',
  description: 'Green Girl Era is a private social and lifestyle community for professional women, with a Philadelphia founding chapter and experiences across golf, wellness, networking and curated lifestyle events.',
  audience: '',
  offer: '',
  signature: '[Your name]\nGreen Girl Era\ngreengirlera.com'
};
const BRIEF_LABELS = {
  organization: ['Organization', 'How Green Girl Era is named in emails.'],
  description: ['Community & experience', 'One or two confirmed sentences about the community.'],
  audience: ['Confirmed audience details', 'Only facts you can stand behind, such as member profile or expected event size. Left blank, drafts show a placeholder.'],
  offer: ['Sponsor benefits & opportunities', 'What a sponsor receives, for example on-site activation or recognition. Left blank, drafts show a placeholder.'],
  signature: ['Email signature', 'Appears at the end of composed drafts.']
};
const DRAFT_STATUSES = ['Draft', 'Needs review', 'Ready to send', 'Sent manually'];
const SECTIONS = {
  overview: ['Company', 'Name / target', 'Contact role', 'Public email', 'Contact route', 'Category', 'Market / coverage', 'Priority', 'Owner', 'Next action', 'Proposal sent', 'Requested cash (USD)', 'Confirmed cash (USD)'],
  research: ['Why it fits GGE', 'Suggested sponsor ask', 'Qualification / limits', 'Source evidence', 'Before sending']
};
const LONG_FIELDS = new Set(['Outreach notes', 'Why it fits GGE', 'Suggested sponsor ask', 'Qualification / limits', 'Source evidence', 'Before sending', 'Initial outreach email', 'Follow-up email', 'Next action']);
const URL_FIELDS = ['Contact source URL', 'Name / fit source URL'];

const state = {
  email: '', records: [], brief: { ...DEFAULT_BRIEF }, view: 'pipeline',
  filters: { q: '', category: '', stage: '', priority: '', market: '', sort: 'priority' },
  drawer: null, // { record, original, tab, opener, composed }
  briefDirty: false
};

// ---------- utilities ----------
function notify(message, tone = 'info') {
  const el = document.querySelector('#notice');
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { el.hidden = true; }, tone === 'error' ? 9000 : 5000);
}

class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'Could not reach the workspace. Check your connection, or reload the page to sign in again if your session ended.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== 'session') { sessionExpired(); throw new ApiError(401, 'Your session expired. Sign in again to continue.'); }
  if (!res.ok || !data) throw new ApiError(res.status, data?.error || 'Request failed. Please try again.', data);
  return data;
}

const isDirty = () => !!state.drawer && JSON.stringify(state.drawer.record) !== state.drawer.original;
const unsaved = () => isDirty() || state.briefDirty;
window.addEventListener('beforeunload', e => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } });

const categories = () => [...new Set(state.records.map(r => r.data.Category).filter(Boolean))].sort();
const priorities = () => [...new Set(state.records.map(r => r.data.Priority).filter(Boolean))].sort();
const isPA = r => /\b(PA|Pennsylvania|Philadelphia)\b/i.test(r.data['Market / coverage'] || '');
const isNational = r => /nationwide|\bUS\b|national/i.test(r.data['Market / coverage'] || '');
const contactLine = r => r.data['Name / target'] && !/not publicly listed/i.test(r.data['Name / target']) ? r.data['Name / target'] : (r.data['Contact role'] || 'Contact to confirm');

// ---------- screens ----------
function screen(title, message, actions = '') {
  root.innerHTML = `<div class="gate"><div class="gate-card"><div class="brandmark">green girl era<span>Sponsor Studio</span></div><h1>${title}</h1><p>${message}</p>${actions}</div></div>`;
}

function sessionExpired() {
  const pending = unsaved();
  state.drawer = null; state.briefDirty = false;
  screen('Please sign in again', `Your secure session has ended.${pending ? ' Unsaved edits could not be kept.' : ''} Sign in with a one-time code sent to the admin inbox.`, `<a class="button primary" href="${state.publicView ? '/admin' : '/'}">Continue to sign in</a>`);
}

function setupScreen(setup) {
  if (!setup) return screen('Almost ready', 'The private backend is not configured yet. Add ACCESS_TEAM_DOMAIN and ACCESS_AUD to the Worker variables (see the README).');
  const rows = Object.entries(setup).map(([k, v]) => `<div class="setup-row"><span>${esc(k)}</span><code>${esc(v)}</code><button type="button" class="small-btn" data-copy="${esc(v)}">Copy</button></div>`).join('');
  screen('Almost ready', 'One last step. In Cloudflare, open the Worker <b>greengirlera-pipeline</b>, go to <b>Settings → Variables and Secrets</b>, add these two text variables, then deploy.', `<div class="setup-vars">${rows}</div><p class="small muted">These identify your Cloudflare Access login and are not secret.</p><a class="button" href="/">Reload after saving</a>`);
  root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  }));
}

async function boot() {
  screen('Opening your workspace…', 'Checking your secure session.');
  try {
    const session = await api('session');
    state.email = session.email;
    state.publicView = !!session.publicView;
    state.readOnly = !!session.readOnly;
    document.body.classList.toggle('view-only', state.readOnly);
    if (session.setup) return setupScreen(session.setup);
  } catch (err) {
    if (err.status === 401) return screen('Sign in required', 'This private workspace is protected by an email one-time code. Only the workspace admin can sign in.', `<a class="button primary" href="/">Sign in</a>`);
    if (err.status === 403) return screen('Access restricted', 'This workspace is restricted to its admin. You are signed in with a different email.', `<a class="button" href="/cdn-cgi/access/logout">Sign out</a>`);
    if (err.status === 503) return setupScreen(err.body?.setup);
    return screen('Workspace unavailable', esc(err.message), `<button class="primary" id="retry">Try again</button>`), document.querySelector('#retry').addEventListener('click', boot);
  }
  try {
    const [{ records }, { brief }] = await Promise.all([api('sponsors'), api('settings/brief')]);
    state.records = records;
    if (brief) state.brief = { ...DEFAULT_BRIEF, ...brief };
    render();
  } catch (err) {
    if (err.status !== 401) screen('Could not load records', esc(err.message), `<button class="primary" id="retry">Try again</button>`), document.querySelector('#retry')?.addEventListener('click', boot);
  }
}

// ---------- shell ----------
function render() {
  const nav = [['pipeline', 'Pipeline'], ['board', 'Stage board'], ['brief', 'Pitch brief']];
  root.innerHTML = `
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    <aside class="sidebar">
      <div class="brandmark">green girl era<span>Sponsor Studio</span></div>
      <nav aria-label="Workspace">${nav.map(([id, label]) => `<button class="nav ${state.view === id ? 'active' : ''}" data-view="${id}" ${state.view === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
      ${state.email ? `<div class="who"><span>Signed in as</span>${esc(state.email)}</div>
      <a class="nav signout" href="/cdn-cgi/access/logout" id="signout">Sign out</a>` : `<a class="nav" href="/admin" id="admin-link">Admin sign in</a>`}
    </aside>
    <main id="main" tabindex="-1">
      <header class="top">
        <div><div class="eyebrow">Partnerships with purpose</div><h1>${state.view === 'brief' ? 'The story behind every pitch' : 'Your sponsor pipeline'}</h1>
        <p class="muted">${state.view === 'brief' ? 'Confirmed details the draft composer can use. Nothing here is invented or sent.' : 'Golf and non-golf partners across Pennsylvania and nationwide.'}</p></div>
        <div class="actions">
          ${state.readOnly ? '<span class="view-note" role="status">View only</span>' : ''}
          <button id="export" ${state.records.length ? '' : 'disabled'}>Export CSV</button>
          <button id="import">Import CSV</button>
          <button id="new" class="primary">Add prospect</button>
        </div>
      </header>
      <div id="content"></div>
    </main>
  </div>`;
  root.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    if (state.view === 'brief' && state.briefDirty && !confirm('Discard unsaved pitch brief changes?')) return;
    state.briefDirty = false; state.view = b.dataset.view; render();
  }));
  root.querySelector('#signout')?.addEventListener('click', e => { if (unsaved() && !confirm('You have unsaved changes. Sign out anyway?')) e.preventDefault(); else state.briefDirty = false; });
  root.querySelector('#export').addEventListener('click', exportCSV);
  root.querySelector('#import').addEventListener('click', importCSV);
  root.querySelector('#new').addEventListener('click', e => openDrawer({ id: '', company: '', data: { Stage: 'Prospect', Owner: 'Lee', 'Draft status': 'Draft' }, version: null }, e.currentTarget));
  if (state.view === 'brief') return briefView();
  pipelineView();
}

function stats() {
  const r = state.records;
  const count = s => r.filter(x => stage(x) === s).length;
  const requested = r.reduce((n, x) => n + amount(x.data['Requested cash (USD)']), 0);
  const confirmed = r.reduce((n, x) => n + amount(x.data['Confirmed cash (USD)']), 0);
  const tiles = [
    ['Prospects', r.length, `${r.filter(isPA).length} Pennsylvania · ${r.filter(x => !isPA(x) && isNational(x)).length} national`],
    ['First wave', r.filter(x => /^1\b/.test(x.data.Priority || '')).length, 'Priority 1 prospects'],
    ['In conversation', count('In conversation') + count('Proposal sent'), `${count('Outreach sent')} outreach sent`],
    ['Partners won', count('Won'), `${money(requested)} requested`],
    ['Confirmed support', money(confirmed), 'From confirmed cash amounts']
  ];
  return `<section class="stats" aria-label="Pipeline summary">${tiles.map(([k, v, s]) => `<div class="stat"><small>${k}</small><strong>${v}</strong><span>${s}</span></div>`).join('')}</section>`;
}

function pipelineView() {
  const f = state.filters;
  const opt = (values, current, all) => `<option value="">${all}</option>` + values.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
  document.querySelector('#content').innerHTML = `${stats()}
  <section class="toolbar" aria-label="Search and filters">
    <label class="search"><span class="sr">Search prospects</span><input id="f-q" type="search" placeholder="Search company, contact, category or notes" value="${esc(f.q)}"></label>
    <label><span class="sr">Category</span><select id="f-category">${opt(categories(), f.category, 'All categories')}</select></label>
    <label><span class="sr">Stage</span><select id="f-stage">${opt(STAGES, f.stage, 'All stages')}</select></label>
    <label><span class="sr">Priority</span><select id="f-priority">${opt(priorities(), f.priority, 'All priorities')}</select></label>
    <label><span class="sr">Market</span><select id="f-market"><option value="">All markets</option><option value="pa" ${f.market === 'pa' ? 'selected' : ''}>Pennsylvania</option><option value="national" ${f.market === 'national' ? 'selected' : ''}>Nationwide US</option></select></label>
    ${state.view === 'pipeline' ? `<label><span class="sr">Sort</span><select id="f-sort"><option value="priority" ${f.sort === 'priority' ? 'selected' : ''}>Sort: priority</option><option value="company" ${f.sort === 'company' ? 'selected' : ''}>Sort: company</option><option value="stage" ${f.sort === 'stage' ? 'selected' : ''}>Sort: stage</option></select></label>` : ''}
  </section>
  <p class="count" id="count" role="status"></p>
  <div id="results"></div>`;
  for (const key of ['q', 'category', 'stage', 'priority', 'market', 'sort']) {
    const el = document.querySelector('#f-' + key);
    el?.addEventListener('input', () => { f[key] = el.value; results(); });
  }
  results();
}

function filtered() {
  const f = state.filters, q = f.q.trim().toLowerCase();
  const rows = state.records.filter(r =>
    (!q || [r.company, r.id, r.data['Name / target'], r.data.Category, r.data['Contact role'], r.data['Outreach notes'], r.data['Suggested sponsor ask'], r.data['Market / coverage']].join(' ').toLowerCase().includes(q)) &&
    (!f.category || r.data.Category === f.category) && (!f.stage || stage(r) === f.stage) && (!f.priority || r.data.Priority === f.priority) &&
    (!f.market || (f.market === 'pa' ? isPA(r) : isNational(r))));
  const by = { priority: r => (r.data.Priority || '9') + r.company.toLowerCase(), company: r => r.company.toLowerCase(), stage: r => STAGES.indexOf(stage(r)) + r.company.toLowerCase() };
  return rows.sort((a, b) => String(by[f.sort](a)).localeCompare(String(by[f.sort](b)), undefined, { numeric: true }));
}

function results() {
  const rows = filtered();
  const box = document.querySelector('#results');
  document.querySelector('#count').textContent = `${rows.length} of ${state.records.length} prospects`;
  if (!state.records.length) {
    box.innerHTML = `<div class="empty"><h2>No prospects yet</h2><p>Import <strong>Green_Girl_Era_Sponsor_Pipeline.csv</strong> first, then <strong>Green_Girl_Era_Personalized_Outreach.csv</strong>. Both join on Prospect ID and you review every change before it is saved.</p><button class="primary" data-empty-import>Import CSV</button></div>`;
    box.querySelector('[data-empty-import]').addEventListener('click', importCSV);
    return;
  }
  if (!rows.length) { box.innerHTML = '<div class="empty"><h2>No matches</h2><p>Try a different search or clear the filters.</p></div>'; return; }
  if (state.view === 'board') {
    box.innerHTML = `<div class="board">${STAGES.map(st => {
      const list = rows.filter(r => stage(r) === st);
      return `<section class="column" aria-label="${st}"><h3>${st}<span>${list.length}</span></h3>${list.map(r => `
        <article class="card"><button class="card-open" data-id="${esc(r.id)}"><strong>${esc(r.company)}</strong><small>${esc(contactLine(r))}</small></button>
        <div class="card-meta"><span class="pill">${esc(r.data.Category || 'Uncategorized')}</span>${r.data.Priority ? `<span class="pill soft">${esc(r.data.Priority)}</span>` : ''}</div>
        <p>${esc(r.data['Next action'] || 'Review fit and contact route')}</p>
        <label class="move"><span class="sr">Move ${esc(r.company)} to stage</span><select data-move="${esc(r.id)}" ${state.readOnly ? 'disabled' : ''}>${STAGES.map(s => `<option ${s === st ? 'selected' : ''}>${s}</option>`).join('')}</select></label></article>`).join('') || '<p class="muted small">No prospects</p>'}</section>`;
    }).join('')}</div>`;
    box.querySelectorAll('[data-move]').forEach(sel => sel.addEventListener('change', () => moveStage(sel.dataset.move, sel.value, sel)));
  } else {
    box.innerHTML = `<div class="tablewrap"><table><thead><tr><th scope="col">Company & contact</th><th scope="col">Category</th><th scope="col">Priority</th><th scope="col">Stage</th><th scope="col">Contact route</th><th scope="col">Next action</th></tr></thead><tbody>${rows.map(r => `
      <tr><td><button class="row-open" data-id="${esc(r.id)}"><strong>${esc(r.company)}</strong><small>${esc(contactLine(r))}</small></button></td>
      <td>${esc(r.data.Category || 'Uncategorized')}<small>${esc(r.data['Market / coverage'] || '')}</small></td>
      <td>${esc(r.data.Priority || 'Unranked')}</td><td><span class="pill stage-${STAGES.indexOf(stage(r))}">${stage(r)}</span></td>
      <td>${esc(r.data['Contact route'] || 'To confirm')}${isPortalRoute(r.data['Contact route']) ? '<small>Form or portal</small>' : ''}</td>
      <td class="next">${esc(r.data['Next action'] || 'Review prospect')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  box.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openDrawer(state.records.find(r => r.id === b.dataset.id), b)));
}

async function moveStage(id, value, control) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;
  control.disabled = true;
  try {
    const { record } = await api('sponsors/' + encodeURIComponent(id), { method: 'PUT', body: { ...rec, data: { ...rec.data, Stage: value } } });
    Object.assign(rec, record);
    notify(`${rec.company} moved to ${value}.`);
    results();
  } catch (err) {
    notify(err.message, 'error');
    if (err.status === 409 && err.body?.record) Object.assign(rec, err.body.record);
    results();
  }
}

// ---------- sponsor profile drawer ----------
function openDrawer(record, opener) {
  if (!record) return;
  const copy = structuredClone(record);
  state.drawer = { record: copy, original: JSON.stringify(copy), tab: 'overview', opener, composed: null };
  drawDrawer(true);
}

function closeDrawer(force = false) {
  if (!state.drawer) return;
  if (!force && isDirty() && !confirm('Discard unsaved changes to this prospect?')) return;
  const opener = state.drawer.opener;
  state.drawer = null;
  document.querySelector('.drawer')?.remove();
  document.body.classList.remove('locked');
  if (opener?.isConnected) opener.focus();
}

function field(key, { long = LONG_FIELDS.has(key), label = key, hint = '' } = {}) {
  const value = state.drawer.record.data[key] ?? '';
  const id = 'fld-' + key.replace(/[^a-z0-9]/gi, '-');
  const isMoney = /\(USD\)$/.test(key);
  const control = long
    ? `<textarea id="${id}" data-key="${esc(key)}" rows="${/email/i.test(key) ? 12 : 3}">${esc(value)}</textarea>`
    : `<input id="${id}" data-key="${esc(key)}" value="${esc(value)}" ${isMoney ? 'inputmode="decimal" placeholder="0"' : ''} ${key === 'Public email' ? 'type="email" autocomplete="off"' : ''}>`;
  return `<div class="field ${long ? 'wide' : ''}"><label for="${id}">${esc(label)}</label>${hint ? `<small>${hint}</small>` : ''}${control}</div>`;
}

// View-only mode: keep text selectable and copyable, but not editable.
function lockFields(scope) {
  scope.querySelectorAll('input, textarea').forEach(x => { x.readOnly = true; });
  scope.querySelectorAll('select').forEach(x => { x.disabled = true; });
}

function drawDrawer(initial = false) {
  const d = state.drawer, r = d.record, isNew = !r.id;
  document.querySelector('.drawer')?.remove();
  const el = document.createElement('div');
  el.className = 'drawer';
  const tabs = [['overview', 'Overview'], ['pitch', 'Pitch studio'], ['research', 'Research & sources'], ['all', 'All fields']];
  el.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
    <header class="panel-head"><div><div class="eyebrow">${isNew ? 'New prospect' : esc(r.id)}</div><h2 id="drawer-title">${esc(r.data.Company || r.company || 'New prospect')}</h2>
      <small>${esc([r.data.Category, r.data['Market / coverage']].filter(Boolean).join(' · ') || 'Add company details to begin')}</small></div>
      <button class="icon" id="d-close" aria-label="Close profile">✕</button></header>
    <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-selected="${d.tab === id}" aria-controls="d-body" data-tab="${id}" ${isNew && id === 'pitch' ? 'disabled title="Save the prospect first"' : ''}>${label}</button>`).join('')}</div>
    <form id="d-form" novalidate><div id="d-body" role="tabpanel" aria-labelledby="tab-${d.tab}"></div>
      <footer class="panel-foot"><span id="d-dirty" class="dirty" aria-live="polite"></span>
        ${!isNew ? '<button type="button" id="d-delete" class="ghost danger">Delete</button>' : ''}
        <button type="button" id="d-cancel">Close</button><button class="primary" id="d-save">${isNew ? 'Create prospect' : 'Save changes'}</button></footer></form></section>`;
  document.body.append(el);
  document.body.classList.add('locked');
  el.addEventListener('mousedown', e => { if (e.target === el) closeDrawer(); });
  el.querySelector('#d-close').addEventListener('click', () => closeDrawer());
  el.querySelector('#d-cancel').addEventListener('click', () => closeDrawer());
  el.querySelector('#d-delete')?.addEventListener('click', deleteRecord);
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { d.tab = b.dataset.tab; drawDrawer(); document.querySelector(`#tab-${d.tab}`)?.focus(); }));
  el.querySelector('#d-form').addEventListener('submit', e => { e.preventDefault(); saveRecord(); });
  el.querySelector('#d-form').addEventListener('input', e => {
    const key = e.target.dataset?.key;
    if (key) { r.data[key] = e.target.value; if (key === 'Company') el.querySelector('#drawer-title').textContent = e.target.value || 'New prospect'; updateDirty(); }
  });
  drawTab();
  if (state.readOnly) lockFields(el);
  updateDirty();
  if (initial) (el.querySelector('#fld-Company') && isNew ? el.querySelector('#fld-Company') : el.querySelector('#d-close')).focus();
}

function updateDirty() {
  const note = document.querySelector('#d-dirty');
  if (note) note.textContent = isDirty() ? 'Unsaved changes' : '';
}

function drawTab() {
  const d = state.drawer, r = d.record, body = document.querySelector('#d-body');
  if (d.tab === 'overview') {
    body.innerHTML = `<div class="grid">${SECTIONS.overview.map(k => k === 'Proposal sent'
      ? `<div class="field"><label for="fld-proposal">Proposal status</label><select id="fld-proposal" data-key="Proposal sent">${['No', 'In preparation', 'Yes'].concat(['No', 'In preparation', 'Yes'].includes(r.data['Proposal sent'] || 'No') ? [] : [r.data['Proposal sent']]).map(s => `<option ${(r.data['Proposal sent'] || 'No') === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>`
      : field(k, { label: k === 'Name / target' ? 'Sponsor contact name / target' : k === 'Public email' ? 'Public business email' : k === 'Requested cash (USD)' ? 'Requested sponsorship (USD)' : k === 'Confirmed cash (USD)' ? 'Confirmed sponsorship (USD)' : k, long: k === 'Next action' })).join('')}
      <div class="field"><label for="fld-stage">Stage</label><select id="fld-stage" data-key="Stage">${STAGES.map(s => `<option ${stage(r) === s ? 'selected' : ''}>${s}</option>`).join('')}</select>${r.data['Imported stage'] ? `<small>Imported as “${esc(r.data['Imported stage'])}”</small>` : ''}</div>
      ${field('Outreach notes', { long: true, label: 'Notes' })}</div>
      ${r.data['Public email'] ? `<p class="small muted">Public business email and route are from research. Deliverability and interest are not confirmed.</p>` : ''}`;
  } else if (d.tab === 'research') {
    body.innerHTML = `<div class="grid">${SECTIONS.research.map(k => field(k, { long: true, label: k === 'Why it fits GGE' ? 'Sponsor fit' : k === 'Qualification / limits' ? 'Qualification limits' : k })).join('')}
      ${URL_FIELDS.map(k => { const u = safeURL(r.data[k]); return `<div class="wide">${field(k)}${u ? `<a class="source" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Open ${esc(new URL(u).hostname)} ↗</a>` : '<small class="muted">No source link saved.</small>'}</div>`; }).join('')}</div>`;
  } else if (d.tab === 'all') {
    const keys = [...new Set([...PIPELINE_COLUMNS, ...OUTREACH_COLUMNS, ...Object.keys(r.data)])].filter(k => k !== 'Prospect ID');
    body.innerHTML = `<p class="small muted">Every stored column, including ones without a dedicated editor. Prospect ID is permanent.</p>
      <div class="grid"><div class="field"><label for="fld-id">Prospect ID</label><input id="fld-id" value="${esc(r.id || 'Assigned on save')}" readonly></div>
      ${keys.map(k => field(k, { long: LONG_FIELDS.has(k) || String(r.data[k] || '').length > 80 })).join('')}
      <div class="field wide add-field"><label for="new-key">Add a custom field</label><div class="inline"><input id="new-key" placeholder="Field name"><button type="button" id="add-key">Add field</button></div></div></div>`;
    body.querySelector('#add-key').addEventListener('click', () => {
      const k = body.querySelector('#new-key').value.trim();
      if (!k || k.length > 100) return notify('Enter a field name up to 100 characters.', 'error');
      if (k in r.data || k === 'Prospect ID') return notify('That field already exists.', 'error');
      r.data[k] = ''; drawTab(); updateDirty(); document.querySelector(`#fld-${k.replace(/[^a-z0-9]/gi, '-')}`)?.focus();
    });
  } else pitchTab(body);
}

function copyButton(label, getText) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'small-btn'; b.textContent = label;
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); notify(`${label.replace(/^Copy /, '')} copied.`); }
    catch { notify('Clipboard unavailable. Select the text and copy it manually.', 'error'); }
  });
  return b;
}

function pitchTab(body) {
  const d = state.drawer, r = d.record;
  const portal = isPortalRoute(r.data['Contact route']) || isPortalRoute(r.data['Outreach contact route']);
  const status = r.data['Draft status'] || 'Draft';
  body.innerHTML = `
    <div class="callout"><strong>Nothing is sent from this workspace.</strong> Review, edit and save drafts, then copy them into your email${portal ? ' or the sponsor’s form/portal' : ''}. Confirm eligibility, audience details and your offer before sending.</div>
    <div class="route"><span><b>Route:</b> ${esc(r.data['Contact route'] || 'To confirm')}${r.data['Outreach contact route'] ? ` · outreach file: ${esc(r.data['Outreach contact route'])}` : ''}</span><span><b>To:</b> ${esc(r.data['Public email'] || (portal ? 'Use the official form/portal' : 'Email to confirm'))}</span></div>
    <div class="compose"><div><h3>Compose from your data</h3><p class="small muted">Builds a new suggestion from this prospect’s saved fit, ask, route and your Pitch brief. It runs in your browser. No AI service or outside API is called, and your current draft is untouched until you choose to use it.</p></div><button type="button" id="compose">Compose suggestion</button></div>
    <div id="composed"></div>
    <div class="grid">
      <div class="field"><label for="fld-status">Draft status</label><select id="fld-status" data-key="Draft status">${[...new Set([...DRAFT_STATUSES, status])].map(s => `<option ${s === status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      ${field('Greeting')}
    </div>
    <div class="draft" data-draft="initial"><div class="draft-head"><h3>Initial email</h3><span class="draft-copy"></span></div>${field('Subject')}${field('Initial outreach email', { label: 'Body' })}</div>
    <div class="draft" data-draft="followup"><div class="draft-head"><h3>Follow-up</h3><span class="draft-copy"></span></div>${field('Follow-up subject')}${field('Follow-up email', { label: 'Body' })}</div>
    ${field('Before sending', { long: true, label: 'Before sending checklist' })}`;
  const [ic, fc] = body.querySelectorAll('.draft-copy');
  ic.append(copyButton('Copy subject', () => r.data.Subject || ''), copyButton('Copy body', () => r.data['Initial outreach email'] || ''), copyButton('Copy email', () => `Subject: ${r.data.Subject || ''}\n\n${r.data['Initial outreach email'] || ''}`));
  fc.append(copyButton('Copy follow-up subject', () => r.data['Follow-up subject'] || ''), copyButton('Copy follow-up body', () => r.data['Follow-up email'] || ''), copyButton('Copy follow-up', () => `Subject: ${r.data['Follow-up subject'] || ''}\n\n${r.data['Follow-up email'] || ''}`));
  body.querySelector('#compose').addEventListener('click', () => { d.composed = composeDraft({ ...r.data, Company: r.data.Company || r.company }, state.brief); showComposed(); });
  if (d.composed) showComposed();
}

function showComposed() {
  const d = state.drawer, c = d.composed, box = document.querySelector('#composed');
  if (!c) { box.innerHTML = ''; return; }
  box.innerHTML = `<section class="suggestion" aria-label="Composed suggestion"><header><h3>Suggestion</h3><span class="small muted">Not saved · built from saved facts only</span></header>
    <dl><dt>Subject</dt><dd>${esc(c.subject)}</dd><dt>Body</dt><dd class="pre">${esc(c.body)}</dd><dt>Follow-up subject</dt><dd>${esc(c.followupSubject)}</dd><dt>Follow-up body</dt><dd class="pre">${esc(c.followupBody)}</dd></dl>
    ${c.checks.length ? `<ul class="checks">${c.checks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><button type="button" class="primary" id="use-composed">Use in editor</button><button type="button" id="discard-composed">Discard</button></div></section>`;
  box.querySelector('#use-composed').addEventListener('click', () => {
    const had = DRAFT_FIELDS.some(k => (d.record.data[k] || '').trim());
    if (had && !confirm('Replace the current subject, body, follow-up subject and follow-up body in the editor? Your saved version stays unchanged until you click Save.')) return;
    Object.assign(d.record.data, { Subject: c.subject, 'Initial outreach email': c.body, 'Follow-up subject': c.followupSubject, 'Follow-up email': c.followupBody, 'Draft status': 'Needs review' });
    d.composed = null; drawTab(); updateDirty();
    notify('Suggestion placed in the editor. Review it, then save.');
  });
  box.querySelector('#discard-composed').addEventListener('click', () => { d.composed = null; showComposed(); });
}

async function saveRecord() {
  const d = state.drawer, r = d.record;
  const company = String(r.data.Company ?? r.company ?? '').trim();
  if (!company) { notify('Company is required.', 'error'); document.querySelector('#d-body [data-key="Company"]')?.focus(); return; }
  for (const k of ['Requested cash (USD)', 'Confirmed cash (USD)']) {
    const v = String(r.data[k] ?? '').trim();
    if (v && !/^\$?\d[\d,]*(\.\d{1,2})?$/.test(v)) { notify(`${k.replace('cash', 'sponsorship')} must be a dollar amount, like 1500.`, 'error'); return; }
  }
  if (r.data['Public email'] && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.data['Public email'].trim())) { notify('Public business email does not look like an email address.', 'error'); return; }
  const btn = document.querySelector('#d-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const payload = { company, data: { ...r.data, Company: company }, version: r.version };
    const { record } = r.id
      ? await api('sponsors/' + encodeURIComponent(r.id), { method: 'PUT', body: payload })
      : await api('sponsors', { method: 'POST', body: payload });
    const i = state.records.findIndex(x => x.id === record.id);
    if (i < 0) state.records.push(record); else state.records[i] = record;
    const opener = d.opener, tab = d.tab;
    state.drawer = { record: structuredClone(record), original: JSON.stringify(record), tab, opener, composed: null };
    if (state.view !== 'brief') pipelineView();
    drawDrawer();
    document.querySelector('#d-save')?.focus();
    notify(r.id ? 'Changes saved.' : `Prospect ${record.id} created.`, 'success');
  } catch (err) {
    notify(err.message, 'error');
    if (btn.isConnected) { btn.disabled = false; btn.textContent = r.id ? 'Save changes' : 'Create prospect'; }
  }
}

async function deleteRecord() {
  const r = state.drawer.record;
  if (!confirm(`Delete ${r.company} (${r.id}) from the CRM? This cannot be undone. Export a CSV first if you may need it.`)) return;
  try {
    await api(`sponsors/${encodeURIComponent(r.id)}?version=${r.version}`, { method: 'DELETE' });
    state.records = state.records.filter(x => x.id !== r.id);
    closeDrawer(true); pipelineView(); notify(`${r.company} deleted.`);
  } catch (err) { notify(err.message, 'error'); }
}

// ---------- pitch brief ----------
function briefView() {
  const content = document.querySelector('#content');
  content.innerHTML = `<form id="brief" class="brief"><h2>Make every pitch specific.</h2>
    <p class="muted">Add only confirmed details. The draft composer uses these words exactly and shows placeholders where information is missing. No attendance numbers, demographics or benefits are assumed.</p>
    ${Object.keys(DEFAULT_BRIEF).map(k => `<div class="field"><label for="brief-${k}">${BRIEF_LABELS[k][0]}</label><small>${BRIEF_LABELS[k][1]}</small><textarea id="brief-${k}" name="${k}" rows="${k === 'organization' ? 1 : 4}">${esc(state.brief[k] || '')}</textarea></div>`).join('')}
    <div class="actions"><button class="primary" id="brief-save">Save pitch brief</button><span id="brief-dirty" class="dirty" aria-live="polite"></span></div></form>`;
  const form = content.querySelector('#brief');
  if (state.readOnly) lockFields(form);
  form.addEventListener('input', () => { state.briefDirty = true; content.querySelector('#brief-dirty').textContent = 'Unsaved changes'; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('#brief-save'); btn.disabled = true;
    try {
      const { brief } = await api('settings/brief', { method: 'PUT', body: { brief: Object.fromEntries(new FormData(form)) } });
      state.brief = { ...DEFAULT_BRIEF, ...brief }; state.briefDirty = false;
      content.querySelector('#brief-dirty').textContent = '';
      notify('Pitch brief saved.', 'success');
    } catch (err) { notify(err.message, 'error'); }
    btn.disabled = false;
  });
}

// ---------- CSV import / export ----------
function exportCSV() {
  const text = csv(exportRows(state.records), [...PIPELINE_COLUMNS, ...OUTREACH_COLUMNS.filter(c => !PIPELINE_COLUMNS.includes(c))]);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'Green_Girl_Era_Sponsor_CRM.csv' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Exported ${state.records.length} prospects with all columns and drafts.`);
}

function importCSV() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,text/csv' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw Error('Please use a CSV smaller than 5 MB.');
      const rows = parseCSV(await file.text());
      reviewImport(file.name, rows);
    } catch (err) { notify(err.message, 'error'); }
  });
  input.click();
}

function reviewImport(name, rows, mode = 'fill') {
  let plan;
  try { plan = planImport(state.records, rows, { mode }); } catch (err) { notify(err.message, 'error'); return; }
  const opener = document.activeElement;
  document.querySelector('.modal')?.remove();
  const el = document.createElement('div');
  el.className = 'modal drawer';
  const total = plan.creates.length + plan.updates.length;
  el.innerHTML = `<section class="panel narrow" role="dialog" aria-modal="true" aria-labelledby="imp-title">
    <header class="panel-head"><div><div class="eyebrow">Review import</div><h2 id="imp-title">${esc(name)}</h2><small>${plan.kind === 'outreach' ? 'Personalized outreach drafts, joined by Prospect ID' : 'Sponsor pipeline records'} · ${rows.length} rows</small></div><button class="icon" id="imp-x" aria-label="Cancel import">✕</button></header>
    <div class="imp-body">
      <fieldset class="modes"><legend>How should matching prospects be updated?</legend>
        <label><input type="radio" name="mode" value="fill" ${mode === 'fill' ? 'checked' : ''}> Fill empty fields only <small>Recommended. Keeps every value you already have or edited.</small></label>
        <label><input type="radio" name="mode" value="overwrite" ${mode === 'overwrite' ? 'checked' : ''}> Replace with CSV values <small>CSV values overwrite matching columns. Columns not in the CSV are kept.</small></label>
      </fieldset>
      <div class="imp-stats"><div><strong>${plan.creates.length}</strong><span>new</span></div><div><strong>${plan.updates.length}</strong><span>updated</span></div><div><strong>${plan.unchanged}</strong><span>unchanged</span></div></div>
      ${plan.warnings.length ? `<details class="warn"><summary>${plan.warnings.length} note${plan.warnings.length > 1 ? 's' : ''}</summary><ul>${plan.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${plan.updates.length ? `<details><summary>Changes to existing prospects</summary><ul class="changes">${plan.updates.map(u => `<li><b>${esc(u.id)} ${esc(u.company)}</b>: ${u.changes.map(c => esc(c.key)).join(', ')}</li>`).join('')}</ul></details>` : ''}
      ${plan.creates.length ? `<details><summary>New prospects</summary><ul class="changes">${plan.creates.map(c => `<li><b>${esc(c.id)}</b> ${esc(c.company)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <footer class="panel-foot"><button type="button" id="imp-cancel">Cancel</button><button type="button" class="primary" id="imp-go" ${total ? '' : 'disabled'}>${total ? `Import ${total} change${total > 1 ? 's' : ''}` : 'Nothing to import'}</button></footer></section>`;
  document.body.append(el);
  document.body.classList.add('locked');
  const close = () => { el.remove(); if (!state.drawer) document.body.classList.remove('locked'); opener?.focus?.(); };
  el.querySelector('#imp-x').addEventListener('click', close);
  el.querySelector('#imp-cancel').addEventListener('click', close);
  el.querySelectorAll('[name=mode]').forEach(radio => radio.addEventListener('change', () => { el.remove(); reviewImport(name, rows, radio.value); document.querySelector(`.modal [value=${radio.value}]`)?.focus(); }));
  el.querySelector('#imp-go').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Importing…';
    try {
      const out = await api('import', { method: 'POST', body: { records: [...plan.creates, ...plan.updates.map(({ id, company, data, version }) => ({ id, company, data, version }))] } });
      state.records = out.records;
      close(); render();
      notify(`${out.imported} prospect${out.imported > 1 ? 's' : ''} ${plan.kind === 'outreach' ? 'updated with personalized drafts' : 'imported'}.`, 'success');
    } catch (err) { notify(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'Try again'; }
  });
  el.querySelector('#imp-go').focus();
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const layer = document.querySelector('.modal') || document.querySelector('.drawer');
  if (!layer) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (layer.classList.contains('modal')) layer.querySelector('#imp-cancel').click(); else closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = [...layer.querySelectorAll('button:not(:disabled), input:not([type=hidden]), select:not(:disabled), textarea, a[href], summary')].filter(x => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items.at(-1);
  if (!layer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

boot();
