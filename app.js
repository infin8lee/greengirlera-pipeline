import { STAGES, DRAFT_FIELDS, PIPELINE_COLUMNS, OUTREACH_COLUMNS, esc, parseCSV, csv, safeURL, money, amount, stage, planImport, exportRows, composeDraft, isPortalRoute, isEmail } from './core.js';

const root = document.querySelector('#app');
const CREST = `<img class="crest" src="./assets/gge-crest.png" alt="" width="218" height="241">`;
const LOCKUP = `<img class="lockup" src="./assets/gge-lockup.png" alt="Green Girl Era crest: Live. Play. Empower." width="218" height="276">`;
const brand = (sub = 'Sponsor Studio', mark = true) => `<div class="brandmark">${mark ? CREST : ''}<span class="bm-text"><small>Est. 2026</small><b>Green Girl Era</b>${sub ? `<em>${sub}</em>` : ''}</span></div>`;

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
  signature: ['Email signature', 'Appears at the end of rewritten drafts.']
};
const DRAFT_STATUSES = ['Draft', 'Needs review', 'Ready to send', 'Sent manually'];
const LONG_FIELDS = new Set(['Decision makers', 'Decision maker notes', 'Partnership channel details', 'Sponsorship angle', 'LinkedIn notes', 'Fit explanation', 'How they sponsor', 'What they could provide', 'Verification notes', 'Verified sources', 'Outreach notes', 'Why it fits GGE', 'Suggested sponsor ask', 'Qualification / limits', 'Source evidence', 'Before sending', 'Initial outreach email', 'Follow-up email', 'Next action']);
const URL_FIELDS = ['Contact source URL', 'Name / fit source URL'];
const LETTERS = {
  request: { label: 'Sponsorship request', subject: 'Subject', body: 'Initial outreach email' },
  followup: { label: 'Follow-up', subject: 'Follow-up subject', body: 'Follow-up email' }
};

const state = {
  email: '', records: [], brief: { ...DEFAULT_BRIEF },
  view: ({ '#plan': 'plan', '#membership': 'members' })[location.hash] || 'sponsors', // sponsors | pipeline | board | brief | plan | members
  filters: { q: '', category: '', stage: '', priority: '', market: '', fit: '', sort: 'priority' },
  current: null, // { record, original, composed, letter }
  briefDirty: false,
  publicView: false, readOnly: false, catsOpen: false,
  members: [], leadsVisible: false, memberTab: 'channels', memberType: ''
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

const isDirty = () => !!state.current && JSON.stringify(state.current.record) !== state.current.original;
const unsaved = () => isDirty() || state.briefDirty;
const confirmLeave = () => !isDirty() || confirm('Discard unsaved changes to this sponsor?');
window.addEventListener('beforeunload', e => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } });

const categories = () => [...new Set(state.records.map(r => r.data.Category).filter(Boolean))].sort();
const priorities = () => [...new Set(state.records.map(r => r.data.Priority).filter(Boolean))].sort();
const isPA = r => /\b(PA|Pennsylvania|Philadelphia)\b/i.test(r.data['Market / coverage'] || '');
const isNational = r => /nationwide|\bUS\b|national/i.test(r.data['Market / coverage'] || '');
const hasName = d => d['Name / target'] && !/not publicly listed/i.test(d['Name / target']);
const contactLine = r => hasName(r.data) ? r.data['Name / target'] : (r.data['Contact role'] || 'Contact to confirm');
const initials = name => (String(name || '?').replace(/[^A-Za-z0-9 &]/g, '').split(/\s+/).filter(w => w && w !== '&').slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
const hue = text => { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const tone = r => `--mono-h:${(hue(r.data.Category || 'x') % 60) + 110}`; // stays in the green family
const FIT_ORDER = ['Strong', 'Good', 'Possible', 'Weak', 'Not a fit'];
const fitClass = f => 'fit-' + String(f || 'unrated').toLowerCase().replace(/[^a-z]+/g, '-');
const fitBadge = f => f ? `<span class="fit ${fitClass(f)}">${esc(f === 'Not a fit' ? 'Not a fit' : f + ' fit')}</span>` : '';
const unconfirmed = d => d['Contact verified'] === 'No' || !!(d['Unconfirmed email'] || '').trim();
const unconfirmedNote = d => unconfirmed(d) ? `<small class="warn">Contact not confirmed on an official page${d['Unconfirmed email'] ? ` (unconfirmed: ${esc(d['Unconfirmed email'])})` : ''}. Check before sending.</small>` : '';
// "Decision makers" holds one person per line: Name | Title | Why them | Email | LinkedIn URL | Source URL | Currency
const people = v => lines(v).map(l => { const [name, title, why, email, linkedin, source, currency] = l.split('|').map(x => x.trim()); return { name, title, why, email, linkedin, source, currency }; }).filter(x => x.name);
const liSearch = (x, company) => 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent([x.name, company].join(' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
function peopleSection(d, company) {
  const list = people(d['Decision makers']);
  const channel = (d['Partnership channel'] || '').trim();
  const channelUrl = safeURL(channel);
  const li = safeURL(d['LinkedIn page']);
  if (!list.length && !channel && !d['Sponsorship angle'] && !li) return '';
  return `<section class="people" aria-label="Decision makers">
        <h3 class="section-title">Decision makers</h3>
        ${d['Sponsorship angle'] ? `<p class="angle"><b>Pitch angle:</b> ${esc(d['Sponsorship angle'])}</p>` : ''}
        <div class="people-list">${list.map(x => {
          const src = safeURL(x.source), liUrl = safeURL(x.linkedin);
          return `<div class="person">
            <div class="person-name">${esc(x.name)}${x.title ? `<small>${esc(x.title)}</small>` : ''}</div>
            ${x.why ? `<p>${esc(x.why)}</p>` : ''}
            <div class="person-links">
              ${x.email && isEmail(x.email) ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : '<span class="muted">No published email</span>'}
              ${liUrl ? `<a class="source" href="${esc(liUrl)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>` : `<a class="source" href="${esc(liSearch(x, company))}" target="_blank" rel="noopener noreferrer">Find on LinkedIn ↗</a>`}
              ${src ? `<a class="source" href="${esc(src)}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ''}
            </div>
            ${x.currency && /confirm/i.test(x.currency) ? `<small class="warn">${esc(x.currency)}</small>` : ''}
          </div>`; }).join('') || '<p class="muted">No named decision maker is published yet. Use the partnership channel below.</p>'}</div>
        ${channel ? `<p class="channel"><b>Partnership channel:</b> ${channelUrl ? `<a class="source" href="${esc(channelUrl)}" target="_blank" rel="noopener noreferrer">${esc(new URL(channelUrl).hostname.replace(/^www\./, ''))} ↗</a>` : isEmail(channel) ? `<a href="mailto:${esc(channel)}">${esc(channel)}</a>` : esc(channel)}</p>` : ''}
        ${d['Partnership channel details'] && d['Partnership channel details'] !== channel ? `<p class="channel muted">${esc(d['Partnership channel details'])}</p>` : ''}
        ${d['Decision maker notes'] ? `<p class="channel"><b>Good to know:</b> ${esc(d['Decision maker notes'])}</p>` : ''}
        ${li ? `<p class="channel"><b>Company on LinkedIn:</b> <a class="source" href="${esc(li)}" target="_blank" rel="noopener noreferrer">linkedin.com ↗</a>${d['LinkedIn notes'] ? ` <span class="li-notes">${lines(d['LinkedIn notes']).map(l => esc(l).replace(/\(?(https:\/\/www\.linkedin\.com\/[^\s()<]+)\)?/g, (m, u) => safeURL(u) ? ` <a class="source" href="${u}" target="_blank" rel="noopener noreferrer">post ↗</a>` : m)).join('<br>')}</span>` : ''}</p>` : ''}
      </section>`;
}
const lines = v => String(v || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
const wave = p => /^1\b/.test(p || '') ? 'First wave' : /^3\b/.test(p || '') ? 'Qualify first' : /^2\b/.test(p || '') ? 'Second wave' : (p || '');

// ---------- screens ----------
function screen(title, message, actions = '') {
  root.innerHTML = `<div class="gate"><div class="gate-card">${LOCKUP}${brand('Sponsor Studio', false)}<h1>${title}</h1><p>${message}</p>${actions}</div></div>`;
}

function sessionExpired() {
  const pending = unsaved();
  state.current = null; state.briefDirty = false;
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
    state.email = session.email || '';
    state.publicView = !!session.publicView;
    state.readOnly = !!session.readOnly;
    document.body.classList.toggle('view-only', state.readOnly);
  } catch (err) {
    if (err.status === 401) return screen('Sign in required', 'This private workspace is protected by an email one-time code. Only the workspace admin can sign in.', `<a class="button primary" href="/">Sign in</a>`);
    if (err.status === 403) return screen('Access restricted', 'This workspace is restricted to its admin. You are signed in with a different email.', `<a class="button" href="/cdn-cgi/access/logout">Sign out</a>`);
    if (err.status === 503) return setupScreen(err.body?.setup);
    return screen('Workspace unavailable', esc(err.message), `<button class="primary" id="retry">Try again</button>`), document.querySelector('#retry').addEventListener('click', boot);
  }
  try {
    const [{ records }, { brief }, members] = await Promise.all([api('sponsors'), api('settings/brief'), api('members').catch(() => ({ records: [], leadsVisible: false }))]);
    state.records = records;
    state.members = members.records || [];
    state.leadsVisible = !!members.leadsVisible;
    if (brief) state.brief = { ...DEFAULT_BRIEF, ...brief };
    render();
  } catch (err) {
    if (err.status !== 401) screen('Could not load records', esc(err.message), `<button class="primary" id="retry">Try again</button>`), document.querySelector('#retry')?.addEventListener('click', boot);
  }
}

// ---------- shell ----------
function render() {
  const nav = [['plan', 'Overview Plan'], ['sponsors', 'Sponsors'], ['pipeline', 'Pipeline'], ['board', 'Stages'], ['brief', 'Pitch brief'], ['members', 'Membership']];
  root.innerHTML = `
  <a class="skip" href="#main">Skip to content</a>
  <header class="masthead">
    ${brand()}
    <nav class="tabsnav" aria-label="Workspace">${nav.map(([id, label]) => `<button class="navlink ${state.view === id ? 'active' : ''}" data-view="${id}" ${state.view === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
    <div class="mast-actions">
      ${state.readOnly ? `<span class="view-note" role="status">View only</span><a class="button small-btn" href="/admin" id="admin-link">Admin sign in</a>` : `
      <button id="new" class="primary small-btn">Add sponsor</button>
      <details class="menu"><summary aria-label="More actions">More</summary><div class="menu-pop">
        <button id="import" type="button">Import CSV</button>
        <button id="export" type="button" ${state.records.length ? '' : 'disabled'}>Export CSV</button>
        <a href="/cdn-cgi/access/logout" id="signout">Sign out</a>
        <span class="who">${esc(state.email)}</span>
      </div></details>`}
    </div>
  </header>
  <main id="main" tabindex="-1" class="view-${state.view}"><div id="content"></div></main>`;
  root.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  root.querySelector('#signout')?.addEventListener('click', e => { if (unsaved() && !confirm('You have unsaved changes. Sign out anyway?')) e.preventDefault(); else { state.briefDirty = false; state.current = null; } });
  root.querySelector('#export')?.addEventListener('click', exportCSV);
  root.querySelector('#import')?.addEventListener('click', importCSV);
  root.querySelector('#new')?.addEventListener('click', () => {
    if (!confirmLeave()) return;
    state.view = 'sponsors';
    setCurrent({ id: '', company: '', data: { Stage: 'Prospect', Owner: 'Lee', 'Draft status': 'Draft' }, version: null });
    render();
  });
  if (state.view === 'brief') return briefView();
  if (state.view === 'plan') return planView();
  if (state.view === 'members') return membersView();
  if (state.view === 'sponsors') return sponsorsView();
  pipelineView();
}

function switchView(view) {
  if (state.view === 'brief' && state.briefDirty && !confirm('Discard unsaved pitch brief changes?')) return;
  if (state.view === 'sponsors' && view !== 'sponsors' && !confirmLeave()) return;
  state.briefDirty = false;
  if (view !== 'sponsors') state.current = null;
  state.view = view;
  history.replaceState(null, '', ({ plan: '#plan', members: '#membership' })[view] || location.pathname + location.search);
  render();
}

function setCurrent(record) {
  const copy = structuredClone(record);
  state.current = { record: copy, original: JSON.stringify(copy), composed: null, letter: 'request' };
}

// ---------- sponsors lookbook ----------
function filteredRecords() {
  const f = state.filters, q = f.q.trim().toLowerCase();
  const rows = state.records.filter(r =>
    (!q || [r.company, r.id, r.data['Name / target'], r.data.Category, r.data['Contact role'], r.data['Outreach notes'], r.data['Suggested sponsor ask'], r.data['Why it fits GGE'], r.data['Market / coverage']].join(' ').toLowerCase().includes(q)) &&
    (!f.category || r.data.Category === f.category) && (!f.stage || stage(r) === f.stage) && (!f.priority || r.data.Priority === f.priority) &&
    (!f.market || (f.market === 'pa' ? isPA(r) : isNational(r))) && (!f.fit || (r.data['Fit rating'] || '') === f.fit));
  const by = { priority: r => (r.data.Priority || '9') + r.company.toLowerCase(), company: r => r.company.toLowerCase(), stage: r => STAGES.indexOf(stage(r)) + r.company.toLowerCase() };
  return rows.sort((a, b) => String(by[f.sort](a)).localeCompare(String(by[f.sort](b)), undefined, { numeric: true }));
}

function sponsorsView() {
  const f = state.filters;
  const content = document.querySelector('#content');
  if (!state.current && state.records.length && matchMedia('(min-width: 900px)').matches) setCurrent(filteredRecords()[0] || state.records[0]);
  content.innerHTML = `<div class="studio ${state.current ? 'has-current' : ''}">
    <aside class="rail" aria-label="Sponsors">
      <div class="rail-head">
        <h1 class="rail-title">Sponsors <span>${state.records.length}</span></h1>
        <label class="search"><span class="sr">Search sponsors</span><input id="q" type="search" placeholder="Search by name, category, ask…" value="${esc(f.q)}"></label>
        <div class="cats ${state.catsOpen || f.category ? 'open' : ''}">
          <div class="chips wrap" id="cat-chips" role="group" aria-label="Filter by category">
            <button class="chip ${!f.category ? 'on' : ''}" data-cat="">All <span class="n">${state.records.length}</span></button>
            ${categories().map(c => `<button class="chip ${f.category === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} <span class="n">${state.records.filter(r => r.data.Category === c).length}</span></button>`).join('')}
          </div>
          <button type="button" class="cats-more" id="cats-more" aria-controls="cat-chips" aria-expanded="${state.catsOpen || f.category ? 'true' : 'false'}">${state.catsOpen || f.category ? 'Fewer categories' : `All ${categories().length} categories`}</button>
        </div>
        ${state.records.some(r => r.data['Fit rating']) ? `<div class="chips small" role="group" aria-label="Filter by fit">
          ${[['', 'Any fit'], ...FIT_ORDER.filter(x => state.records.some(r => r.data['Fit rating'] === x)).map(x => [x, x])].map(([v, l]) => `<button class="chip ${f.fit === v ? 'on' : ''}" data-fit="${esc(v)}">${esc(l)}</button>`).join('')}
        </div>` : ''}
        <div class="chips small" role="group" aria-label="Filter by market">
          ${[['', 'Everywhere'], ['pa', 'Pennsylvania'], ['national', 'Nationwide']].map(([v, l]) => `<button class="chip ${f.market === v ? 'on' : ''}" data-market="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <ul class="rail-list" id="rail-list"></ul>
    </aside>
    <section class="dossier" id="dossier" aria-live="polite"></section>
  </div>`;
  content.querySelector('#q').addEventListener('input', e => { f.q = e.target.value; drawRail(); });
  content.querySelector('#cats-more')?.addEventListener('click', e => { const box = e.currentTarget.closest('.cats'); const open = !box.classList.contains('open'); state.catsOpen = open; box.classList.toggle('open', open); e.currentTarget.setAttribute('aria-expanded', String(open)); e.currentTarget.textContent = open ? 'Fewer categories' : `All ${categories().length} categories`; });
  content.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { f.category = b.dataset.cat; content.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('on', x === b)); drawRail(); }));
  content.querySelectorAll('[data-fit]').forEach(b => b.addEventListener('click', () => { f.fit = b.dataset.fit; content.querySelectorAll('[data-fit]').forEach(x => x.classList.toggle('on', x === b)); drawRail(); }));
  content.querySelectorAll('[data-market]').forEach(b => b.addEventListener('click', () => { f.market = b.dataset.market; content.querySelectorAll('[data-market]').forEach(x => x.classList.toggle('on', x === b)); drawRail(); }));
  const dossier = content.querySelector('#dossier');
  dossier.addEventListener('input', onEdit);
  dossier.addEventListener('change', onEdit);
  drawRail();
  drawDossier();
}

function drawRail() {
  const list = document.querySelector('#rail-list');
  if (!list) return;
  const rows = filteredRecords();
  const currentId = state.current?.record.id;
  if (!state.records.length) {
    list.innerHTML = `<li class="rail-empty">${state.readOnly ? 'No sponsors to show yet.' : 'No sponsors yet. Use <b>More → Import CSV</b> to add your pipeline.'}</li>`;
    return;
  }
  list.innerHTML = rows.length ? rows.map(r => `<li><button class="sponsor-item ${r.id === currentId ? 'on' : ''}" data-id="${esc(r.id)}" ${r.id === currentId ? 'aria-current="true"' : ''}>
      <span class="mono" style="${tone(r)}" aria-hidden="true">${esc(initials(r.company))}</span>
      <span class="si-text"><strong>${esc(r.company)}</strong><small>${esc(r.data.Category || 'Uncategorized')} · ${esc(r.data['Market / coverage'] || 'Market to confirm')}</small></span>
      <span class="si-meta">${r.data['Fit rating'] ? `<span class="si-fit ${fitClass(r.data['Fit rating'])}">${esc(r.data['Fit rating'])}</span>` : (/^1\b/.test(r.data.Priority || '') ? '<span class="dot" title="First wave"></span>' : '')}${stage(r) !== 'Prospect' ? `<span class="si-stage">${esc(stage(r))}</span>` : ''}</span>
    </button></li>`).join('') : '<li class="rail-empty">No sponsors match. Try another search or filter.</li>';
  list.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openSponsor(b.dataset.id)));
}

function openSponsor(id) {
  if (state.current?.record.id === id) { document.querySelector('.studio')?.classList.add('has-current'); return; }
  if (!confirmLeave()) return;
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;
  if (state.view !== 'sponsors') { state.view = 'sponsors'; if (location.hash) history.replaceState(null, '', location.pathname + location.search); setCurrent(rec); render(); }
  else { setCurrent(rec); drawDossier(); drawRail(); }
  document.querySelector('.studio')?.classList.add('has-current');
  document.querySelectorAll('#dossier .autogrow').forEach(grow);
  document.querySelector('#dossier')?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  document.querySelector('#dossier h2')?.focus();
}

function input(key, { label = key, long = LONG_FIELDS.has(key), rows = 3, placeholder = '', scope = 'f' } = {}) {
  const value = state.current.record.data[key] ?? '';
  const id = scope + '-' + key.replace(/[^a-z0-9]/gi, '-');
  const money = /\(USD\)$/.test(key);
  const control = long
    ? `<textarea id="${id}" data-key="${esc(key)}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input id="${id}" data-key="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${money ? 'inputmode="decimal"' : ''} ${key === 'Public email' ? 'type="email" autocomplete="off"' : ''}>`;
  return `<div class="field"><label for="${id}">${esc(label)}</label>${control}</div>`;
}

function drawDossier() {
  const box = document.querySelector('#dossier');
  if (!box) return;
  if (!state.current) {
    box.innerHTML = `<div class="dossier-empty">${LOCKUP}<p>Choose a sponsor to see who they are and your tailored sponsorship request.</p></div>`;
    return;
  }
  const c = state.current, r = c.record, d = r.data, isNew = !r.id;
  const company = d.Company || r.company || '';
  const email = (d['Public email'] || '').trim();
  const portal = isPortalRoute(d['Contact route']) || isPortalRoute(d['Outreach contact route']) || !email;
  const contactUrl = safeURL(d['Contact source URL']);
  const sources = URL_FIELDS.map(k => safeURL(d[k])).flatMap(u => u ? [u] : []).concat(
    URL_FIELDS.flatMap(k => String(d[k] || '').split(/\s+/).slice(1).map(safeURL).filter(Boolean)));
  const uniqueSources = [...new Set(sources.concat(lines(d['Verified sources']).map(safeURL).filter(Boolean)))];

  box.innerHTML = `
    <button class="back" type="button" id="back">← All sponsors</button>
    <article class="profile">
      <header class="hero">
        <span class="mono big" style="${tone(r)}" aria-hidden="true">${esc(initials(company || 'New'))}</span>
        <div class="hero-text">
          <div class="eyebrow">${isNew ? 'New sponsor' : [d.Category ? `<span class="cat-name">${esc(d.Category)}</span>` : '', esc(wave(d.Priority))].filter(Boolean).join(' · ')}</div>
          ${isNew ? `<label class="sr" for="f-Company">Company</label><input id="f-Company" class="hero-input" data-key="Company" placeholder="Company name" value="${esc(company)}">` : `<h2 tabindex="-1">${esc(company)}</h2>`}
          <p class="hero-sub">${fitBadge(d['Fit rating'])}${esc(d['Market / coverage'] || 'Market to confirm')}${d['Imported stage'] ? ` · marked “${esc(d['Imported stage'])}”` : ''}</p>
        </div>
        <div class="hero-status">
          <label class="pill-select"><span class="sr">Stage</span><select data-key="Stage">${STAGES.map(s => `<option ${stage(r) === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        </div>
      </header>

      <section class="about" aria-label="Who they are">
        <h3 class="section-title">Who they are</h3>
        <div class="facts">
          <div class="fact wide"><span class="fact-label">Why they fit Green Girl Era</span><p class="quote">${esc(d['Fit explanation'] || d['Why it fits GGE'] || 'Add why this sponsor fits.')}</p></div>
          ${d['How they sponsor'] ? `<div class="fact wide direction"><span class="fact-label">How they sponsor</span><p>${esc(d['How they sponsor'])}</p>${d['What they could provide'] ? `<p class="provide"><b>What they could provide:</b> ${esc(d['What they could provide'])}</p>` : ''}</div>` : ''}
          <div class="fact"><span class="fact-label">What to ask for</span><p>${esc(d['Suggested sponsor ask'] || 'To decide')}</p></div>
          <div class="fact"><span class="fact-label">Who to reach</span><p>${esc(hasName(d) ? d['Name / target'] : 'Name not publicly listed')}${d['Contact role'] ? `<small>${esc(d['Contact role'])}</small>` : ''}</p></div>
          <div class="fact"><span class="fact-label">How to reach them</span><p>${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : 'No public email'}${unconfirmedNote(d)}<small>${esc(d['Contact route'] || 'Route to confirm')}${d['Outreach contact route'] ? ` · ${esc(d['Outreach contact route'])}` : ''}</small>${contactUrl ? `<a class="source" href="${esc(contactUrl)}" target="_blank" rel="noopener noreferrer">Contact page ↗</a>` : ''}</p></div>
          <div class="fact"><span class="fact-label">Next step</span><p>${esc(d['Next action'] || 'Review and decide')}</p></div>
          ${d['Qualification / limits'] ? `<div class="fact wide caution"><span class="fact-label">Keep in mind</span><p>${esc(d['Qualification / limits'])}</p></div>` : ''}
          ${d['Source evidence'] || uniqueSources.length ? `<div class="fact wide"><span class="fact-label">Research${d['Verification confidence'] ? ` · verification confidence: ${esc(d['Verification confidence'])}` : ''}</span><p>${esc(d['Source evidence'] || '')}</p>${d['Verification notes'] ? `<p class="vnotes">${esc(d['Verification notes'])}</p>` : ''}${d['Fit explanation'] && d['Why it fits GGE'] ? `<p class="small muted">Original research note: ${esc(d['Why it fits GGE'])}</p>` : ''}<div class="source-list">${uniqueSources.map(u => `<a class="source" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(new URL(u).hostname.replace(/^www\./, ''))} ↗</a>`).join('')}</div></div>` : ''}
        </div>
      </section>

      ${peopleSection(d, company)}

      <section class="letter-wrap" aria-label="Sponsorship email">
        <div class="letter-head">
          <h3 class="section-title">Your sponsorship email</h3>
          <div class="seg" role="tablist" aria-label="Email">${Object.entries(LETTERS).map(([k, l]) => `<button role="tab" type="button" data-letter="${k}" aria-selected="${c.letter === k}">${l.label}</button>`).join('')}</div>
        </div>
        <div class="letter" id="letter"></div>
        <div class="rewrite">
          <div><strong>Rewrite from my data</strong><p>Builds a fresh version from this sponsor’s fit, ask and route plus your Pitch brief. It runs in your browser, uses no AI or outside service, and only replaces the email after you approve it.</p></div>
          <button type="button" id="compose" ${isNew ? 'disabled' : ''}>Suggest a rewrite</button>
        </div>
        <div id="composed"></div>
      </section>

      <details class="more" ${isNew ? 'open' : ''}>
        <summary>Tracking & notes</summary>
        <div class="grid">
          ${isNew ? '' : input('Company')}
          ${input('Name / target', { label: 'Contact name / target' })}
          ${input('Contact role')}
          ${input('Public email', { label: 'Public business email' })}
          ${input('Contact route')}
          ${input('Category')}
          ${input('Market / coverage')}
          ${input('Priority')}
          ${input('Owner')}
          <div class="field"><label for="f-proposal">Proposal status</label><select id="f-proposal" data-key="Proposal sent">${[...new Set(['No', 'In preparation', 'Yes', d['Proposal sent'] || 'No'])].map(s => `<option ${(d['Proposal sent'] || 'No') === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
          ${input('Requested cash (USD)', { label: 'Requested sponsorship (USD)', placeholder: '0' })}
          ${input('Confirmed cash (USD)', { label: 'Confirmed sponsorship (USD)', placeholder: '0' })}
          <div class="wide">${input('Next action', { rows: 2 })}</div>
          <div class="wide">${input('Outreach notes', { label: 'Notes', rows: 4 })}</div>
        </div>
      </details>

      <details class="more">
        <summary>Research details</summary>
        <div class="grid">
          <div class="field"><label for="f-fit">Fit rating</label><select id="f-fit" data-key="Fit rating">${['', ...FIT_ORDER, ...(d['Fit rating'] && !FIT_ORDER.includes(d['Fit rating']) ? [d['Fit rating']] : [])].map(v => `<option value="${esc(v)}" ${(d['Fit rating'] || '') === v ? 'selected' : ''}>${esc(v || 'Not rated')}</option>`).join('')}</select></div>
          ${input('Verification confidence')}
          <div class="wide">${input('Fit explanation', { label: 'Why they fit (explanation)', long: true, rows: 4 })}</div>
          <div class="wide">${input('How they sponsor', { long: true })}</div>
          <div class="wide">${input('What they could provide', { long: true })}</div>
          <div class="wide">${input('Verification notes', { long: true })}</div>
          <div class="wide">${input('Verified sources', { long: true, placeholder: 'One link per line' })}</div>
          <div class="wide">${input('Why it fits GGE', { label: 'Original research note' })}</div>
          <div class="wide">${input('Suggested sponsor ask', { label: 'What to ask for' })}</div>
          <div class="wide">${input('Qualification / limits', { label: 'Keep in mind' })}</div>
          <div class="wide">${input('Source evidence', { label: 'Research notes' })}</div>
          ${URL_FIELDS.map(k => `<div class="wide">${input(k)}</div>`).join('')}
        </div>
      </details>

      <details class="more">
        <summary>Every field</summary>
        <p class="small muted">Every stored column${r.id ? `, including Prospect ID ${esc(r.id)} (permanent)` : ''}.</p>
        <div class="grid">${[...new Set([...PIPELINE_COLUMNS, ...OUTREACH_COLUMNS, ...Object.keys(d)])].filter(k => !['Prospect ID', 'Stage', 'Company'].includes(k)).map(k => `<div class="${LONG_FIELDS.has(k) || String(d[k] || '').length > 80 ? 'wide' : ''}">${input(k, { scope: 'a', long: LONG_FIELDS.has(k) || String(d[k] || '').length > 80 })}</div>`).join('')}
          <div class="field wide add-field"><label for="new-key">Add a custom field</label><div class="inline"><input id="new-key" placeholder="Field name"><button type="button" id="add-key">Add</button></div></div>
        </div>
      </details>

      ${isNew ? '' : '<p class="danger-zone"><button type="button" class="ghost danger" id="delete">Remove this sponsor</button></p>'}
    </article>
    <div class="savebar" id="savebar" hidden>
      <span>Unsaved changes</span>
      <button type="button" id="discard" class="ghost">Discard</button>
      <button type="button" id="save" class="primary">${isNew ? 'Create sponsor' : 'Save'}</button>
    </div>`;

  drawLetter();
  box.querySelector('#back').addEventListener('click', () => { if (!confirmLeave()) return; if (!r.id) state.current = null; else state.current = { ...state.current, record: JSON.parse(state.current.original) }; document.querySelector('.studio').classList.remove('has-current'); if (!r.id) drawDossier(); drawRail(); });
  box.querySelectorAll('[data-letter]').forEach(b => b.addEventListener('click', () => { c.letter = b.dataset.letter; box.querySelectorAll('[data-letter]').forEach(x => x.setAttribute('aria-selected', x === b)); drawLetter(); }));
  box.querySelector('#compose').addEventListener('click', () => { c.composed = composeDraft({ ...d, Company: company }, state.brief); showComposed(); });
  box.querySelector('#save').addEventListener('click', saveRecord);
  box.querySelector('#discard').addEventListener('click', () => { if (!r.id) { state.current = null; drawDossier(); return; } setCurrent(JSON.parse(c.original)); drawDossier(); });
  box.querySelector('#delete')?.addEventListener('click', deleteRecord);
  box.querySelector('#add-key').addEventListener('click', () => {
    const k = box.querySelector('#new-key').value.trim();
    if (!k || k.length > 100) return notify('Enter a field name up to 100 characters.', 'error');
    if (k in d || k === 'Prospect ID') return notify('That field already exists.', 'error');
    d[k] = ''; const open = [...box.querySelectorAll('details.more')].map(x => x.open); drawDossier();
    document.querySelectorAll('#dossier details.more').forEach((x, i) => { x.open = open[i]; });
  });
  if (c.composed) showComposed();
  if (state.readOnly) lockFields(box);
  updateSavebar();
}

// View-only visitors can read everything but change nothing. The server enforces this;
// locking the controls just keeps the page honest.
function lockFields(scope) {
  scope.querySelectorAll('input:not([type=search]):not([type=radio]), textarea').forEach(x => { x.readOnly = true; });
  scope.querySelectorAll('select[data-key], select[data-move]').forEach(x => { x.disabled = true; });
}

document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'l-subject') e.preventDefault(); });

function onEdit(e) {
  const key = e.target.dataset?.key;
  if (!key || !state.current || state.readOnly) return;
  if (e.target.id === 'l-subject' && /[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/[\r\n]+/g, ' ');
  state.current.record.data[key] = e.target.value;
  // keep duplicate controls for the same field in sync
  document.querySelectorAll(`#dossier [data-key="${CSS.escape(key)}"]`).forEach(el => { if (el !== e.target && el.value !== e.target.value) el.value = e.target.value; });
  if (e.target.classList.contains('autogrow')) grow(e.target);
  updateSavebar();
}

function updateSavebar() {
  const bar = document.querySelector('#savebar');
  if (bar) bar.hidden = state.readOnly || (!isDirty() && !!state.current?.record.id);
}

const grow = el => { if (!el.offsetParent) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; };
window.addEventListener('resize', () => document.querySelectorAll('#dossier .autogrow').forEach(grow));

function drawLetter() {
  const c = state.current, d = c.record.data, l = LETTERS[c.letter];
  const email = (d['Public email'] || '').trim();
  const portal = !email || isPortalRoute(d['Contact route']) || isPortalRoute(d['Outreach contact route']);
  const contactUrl = safeURL(d['Contact source URL']);
  const box = document.querySelector('#letter');
  const status = d['Draft status'] || 'Draft';
  box.innerHTML = `
    <div class="letter-meta">
      <div class="lm-row"><span>To</span><b>${email ? esc(email) : 'No public email'}</b>${unconfirmedNote(d)}${portal ? `<em>${contactUrl ? `Send through their <a href="${esc(contactUrl)}" target="_blank" rel="noopener noreferrer">form or portal ↗</a>` : 'Use their form or portal'}</em>` : ''}</div>
      <div class="lm-row subject"><label for="l-subject">Subject</label><textarea id="l-subject" class="autogrow subject-input" rows="1" data-key="${esc(l.subject)}" placeholder="Subject line">${esc(d[l.subject] || '')}</textarea></div>
    </div>
    <label class="sr" for="l-body">${esc(l.label)} body</label>
    <textarea id="l-body" class="letter-body autogrow" data-key="${esc(l.body)}" placeholder="Write your ${c.letter === 'request' ? 'sponsorship request' : 'follow-up'} here…">${esc(d[l.body] || '')}</textarea>
    <div class="letter-actions">
      <button type="button" class="primary" data-copy="all">Copy email</button>
      <button type="button" data-copy="subject">Copy subject</button>
      <button type="button" data-copy="body">Copy body</button>
      ${email ? '<button type="button" id="mailto">Open in my email app</button>' : ''}
      <label class="status-select">Status <select data-key="Draft status">${[...new Set([...DRAFT_STATUSES, status])].map(s => `<option ${s === status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
    </div>
    ${d['Before sending'] ? `<details class="checklist"><summary>Before you send</summary><p>${esc(d['Before sending'])}</p></details>` : ''}
    <p class="fineprint">${state.readOnly ? 'View only. ' : ''}Nothing is sent from this workspace. Copy the email, or open it in your own email app to review and send.</p>`;
  if (state.readOnly) lockFields(box);
  grow(box.querySelector('#l-body')); grow(box.querySelector('#l-subject'));
  box.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    const subject = d[l.subject] || '', body = d[l.body] || '';
    const text = { all: `Subject: ${subject}\n\n${body}`, subject, body }[b.dataset.copy];
    try { await navigator.clipboard.writeText(text); notify(b.dataset.copy === 'all' ? 'Email copied.' : `${b.dataset.copy === 'subject' ? 'Subject' : 'Body'} copied.`); }
    catch { notify('Clipboard unavailable. Select the text and copy it manually.', 'error'); }
  }));
  box.querySelector('#mailto')?.addEventListener('click', () => {
    const href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(d[l.subject] || '')}&body=${encodeURIComponent(d[l.body] || '')}`;
    window.location.href = href.length > 1900 ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(d[l.subject] || '')}` : href;
    if (href.length > 1900) notify('The email is long, so only the subject was added. Paste the body with Copy body.');
  });
}

function showComposed() {
  const c = state.current, s = c.composed, box = document.querySelector('#composed');
  if (!s) { box.innerHTML = ''; return; }
  box.innerHTML = `<section class="suggestion" aria-label="Suggested rewrite"><header><h4>Suggested rewrite</h4><span class="small muted">Not saved · from saved facts only</span></header>
    <div class="sugg-cols">
      <div><span class="fact-label">Sponsorship request</span><p class="sugg-subject">${esc(s.subject)}</p><p class="pre">${esc(s.body)}</p></div>
      <div><span class="fact-label">Follow-up</span><p class="sugg-subject">${esc(s.followupSubject)}</p><p class="pre">${esc(s.followupBody)}</p></div>
    </div>
    ${s.checks.length ? `<ul class="checks">${s.checks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><button type="button" class="primary" id="use-composed">Use this version</button><button type="button" id="discard-composed">Keep my current email</button></div></section>`;
  box.querySelector('#use-composed').addEventListener('click', () => {
    const d = c.record.data;
    const had = DRAFT_FIELDS.some(k => (d[k] || '').trim());
    if (had && !confirm('Replace both the request and follow-up with this version? Nothing is saved until you click Save.')) return;
    Object.assign(d, { Subject: s.subject, 'Initial outreach email': s.body, 'Follow-up subject': s.followupSubject, 'Follow-up email': s.followupBody, 'Draft status': 'Needs review' });
    c.composed = null; box.innerHTML = ''; drawLetter(); updateSavebar();
    notify('New version placed in the email. Review it, then save.');
  });
  box.querySelector('#discard-composed').addEventListener('click', () => { c.composed = null; box.innerHTML = ''; });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveRecord() {
  const c = state.current, r = c.record;
  const company = String(r.data.Company ?? r.company ?? '').trim();
  if (!company) { notify('Company is required.', 'error'); document.querySelector('#dossier [data-key="Company"]')?.focus(); return; }
  for (const k of ['Requested cash (USD)', 'Confirmed cash (USD)']) {
    const v = String(r.data[k] ?? '').trim();
    if (v && !/^\$?\d[\d,]*(\.\d{1,2})?$/.test(v)) { notify(`${k.replace('cash', 'sponsorship')} must be a dollar amount, like 1500.`, 'error'); return; }
  }
  if (r.data['Public email'] && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.data['Public email'].trim())) { notify('Public business email does not look like an email address.', 'error'); return; }
  const btn = document.querySelector('#save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const payload = { company, data: { ...r.data, Company: company }, version: r.version };
    const { record } = r.id
      ? await api('sponsors/' + encodeURIComponent(r.id), { method: 'PUT', body: payload })
      : await api('sponsors', { method: 'POST', body: payload });
    const i = state.records.findIndex(x => x.id === record.id);
    if (i < 0) state.records.push(record); else state.records[i] = record;
    const letter = c.letter;
    const open = [...document.querySelectorAll('#dossier details.more')].map(x => x.open);
    setCurrent(record); state.current.letter = letter;
    drawDossier(); drawRail();
    document.querySelectorAll('#dossier details.more').forEach((x, n) => { x.open = open[n] ?? x.open; });
    notify(r.id ? 'Saved.' : `${company} added.`, 'success');
  } catch (err) {
    notify(err.message, 'error');
    if (btn.isConnected) { btn.disabled = false; btn.textContent = r.id ? 'Save' : 'Create sponsor'; }
  }
}

async function deleteRecord() {
  const r = state.current.record;
  if (!confirm(`Remove ${r.company} (${r.id})? This cannot be undone. Export a CSV first if you may need it.`)) return;
  try {
    await api(`sponsors/${encodeURIComponent(r.id)}?version=${r.version}`, { method: 'DELETE' });
    state.records = state.records.filter(x => x.id !== r.id);
    state.current = null; render(); notify(`${r.company} removed.`);
  } catch (err) { notify(err.message, 'error'); }
}

// ---------- pipeline overview (secondary) ----------
function stats() {
  const r = state.records;
  const count = s => r.filter(x => stage(x) === s).length;
  const requested = r.reduce((n, x) => n + amount(x.data['Requested cash (USD)']), 0);
  const confirmed = r.reduce((n, x) => n + amount(x.data['Confirmed cash (USD)']), 0);
  const tiles = [
    ['Sponsors', r.length, `${r.filter(isPA).length} Pennsylvania · ${r.filter(x => !isPA(x) && isNational(x)).length} national`],
    ['First wave', r.filter(x => /^1\b/.test(x.data.Priority || '')).length, 'Priority 1'],
    ['In conversation', count('In conversation') + count('Proposal sent'), `${count('Outreach sent')} outreach sent`],
    ['Won', count('Won'), `${money(requested)} requested`],
    ['Confirmed support', money(confirmed), 'From confirmed amounts']
  ];
  return `<section class="stats" aria-label="Summary">${tiles.map(([k, v, s]) => `<div class="stat"><small>${k}</small><strong>${v}</strong><span>${s}</span></div>`).join('')}</section>`;
}

function pipelineView() {
  const f = state.filters;
  const opt = (values, current, all) => `<option value="">${all}</option>` + values.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
  document.querySelector('#content').innerHTML = `<div class="overview">
  <header class="ov-head"><h1>${state.view === 'board' ? 'Stages' : 'Pipeline at a glance'}</h1><p class="muted">Golf and non-golf partners across Pennsylvania and nationwide. Open any sponsor to see their profile and email.</p></header>
  ${stats()}
  <section class="toolbar" aria-label="Search and filters">
    <label class="search"><span class="sr">Search</span><input id="f-q" type="search" placeholder="Search" value="${esc(f.q)}"></label>
    <label><span class="sr">Category</span><select id="f-category">${opt(categories(), f.category, 'All categories')}</select></label>
    <label><span class="sr">Stage</span><select id="f-stage">${opt(STAGES, f.stage, 'All stages')}</select></label>
    <label><span class="sr">Priority</span><select id="f-priority">${opt(priorities(), f.priority, 'All priorities')}</select></label>
    <label><span class="sr">Market</span><select id="f-market"><option value="">All markets</option><option value="pa" ${f.market === 'pa' ? 'selected' : ''}>Pennsylvania</option><option value="national" ${f.market === 'national' ? 'selected' : ''}>Nationwide US</option></select></label>
  </section>
  <p class="count" id="count" role="status"></p>
  <div id="results"></div></div>`;
  for (const key of ['q', 'category', 'stage', 'priority', 'market']) {
    const el = document.querySelector('#f-' + key);
    el?.addEventListener('input', () => { f[key] = el.value; results(); });
  }
  results();
}

function results() {
  const rows = filteredRecords();
  const box = document.querySelector('#results');
  document.querySelector('#count').textContent = `${rows.length} of ${state.records.length} sponsors`;
  if (!rows.length) { box.innerHTML = '<div class="empty"><h2>No matches</h2><p>Try a different search or clear the filters.</p></div>'; return; }
  if (state.view === 'board') {
    box.innerHTML = `<div class="board">${STAGES.map(st => {
      const list = rows.filter(r => stage(r) === st);
      return `<section class="column" aria-label="${st}"><h3>${st}<span>${list.length}</span></h3>${list.map(r => `
        <article class="card"><button class="card-open" data-id="${esc(r.id)}"><span class="mono" style="${tone(r)}" aria-hidden="true">${esc(initials(r.company))}</span><span><strong>${esc(r.company)}</strong><small>${esc(r.data.Category || '')}</small></span></button>
        <label class="move"><span class="sr">Move ${esc(r.company)} to stage</span><select data-move="${esc(r.id)}" ${state.readOnly ? 'disabled' : ''}>${STAGES.map(s => `<option ${s === st ? 'selected' : ''}>${s}</option>`).join('')}</select></label></article>`).join('') || '<p class="muted small">None yet</p>'}</section>`;
    }).join('')}</div>`;
    box.querySelectorAll('[data-move]').forEach(sel => sel.addEventListener('change', () => moveStage(sel.dataset.move, sel.value, sel)));
  } else {
    box.innerHTML = `<div class="tablewrap"><table><thead><tr><th scope="col">Sponsor</th><th scope="col">Category</th><th scope="col">Priority</th><th scope="col">Stage</th><th scope="col">Next step</th></tr></thead><tbody>${rows.map(r => `
      <tr><td><button class="row-open" data-id="${esc(r.id)}"><span class="mono" style="${tone(r)}" aria-hidden="true">${esc(initials(r.company))}</span><span><strong>${esc(r.company)}</strong><small>${esc(contactLine(r))}</small></span></button></td>
      <td>${esc(r.data.Category || 'Uncategorized')}<small>${esc(r.data['Market / coverage'] || '')}</small></td>
      <td>${esc(wave(r.data.Priority) || 'Unranked')}</td><td><span class="pill stage-${STAGES.indexOf(stage(r))}">${stage(r)}</span></td>
      <td class="next">${esc(r.data['Next action'] || 'Review')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  box.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openSponsor(b.dataset.id)));
}

async function moveStage(id, value, control) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;
  control.disabled = true;
  try {
    const { record } = await api('sponsors/' + encodeURIComponent(id), { method: 'PUT', body: { ...rec, data: { ...rec.data, Stage: value } } });
    Object.assign(rec, record);
    notify(`${rec.company} moved to ${value}.`);
  } catch (err) {
    notify(err.message, 'error');
    if (err.status === 409 && err.body?.record) Object.assign(rec, err.body.record);
  }
  results();
}

// ---------- overview plan ----------
// Everything on this page is computed from the live records, so the public repo holds no CRM data.
const PLACEHOLDER = /\[[^\]]+\]/g;
const blanks = d => [...new Set((d['Initial outreach email'] || '').match(PLACEHOLDER) || [])].filter(x => x !== '[Your name]');
const BLANK_LABELS = [
  [/nonprofit partner/i, 'A 501(c)(3) nonprofit partner', 'Many programs only give to a registered nonprofit, so the partner applies or is named in the request.'],
  [/date/i, 'Event date', 'Most programs ask for the date and need weeks or months of lead time.'],
  [/venue|location|city|county/i, 'Venue or location', 'Local programs check that the event is in their area.'],
  [/number|participant|attend/i, 'Confirmed attendance', 'Only numbers we can stand behind.'],
  [/event name|program name/i, 'Event name', 'The event or program the sponsor would support.'],
  [/amount/i, 'Ask amount', 'A specific dollar or product ask.']
];

function planView() {
  const npReq = r => r.data['Nonprofit requirement'] || '';
  const onHold = state.records.filter(r => /^Needs a 501/.test(npReq(r)));
  const askFirst = state.records.filter(r => /^Ask if/.test(npReq(r)));
  const n = state.records.length;
  const recs = state.records.filter(r => !onHold.includes(r)); // the active plan
  const count = fn => recs.filter(fn).length;
  const byWave = w => recs.filter(r => wave(r.data.Priority) === w);
  const emailRoute = r => isEmail(r.data['Public email']);
  const withPeople = count(r => people(r.data['Decision makers']).length);
  const withRoute = count(r => (r.data['Partnership channel'] || r.data['Public email'] || '').trim());
  const withLI = count(r => (r.data['LinkedIn page'] || '').trim());
  const ready = count(r => !blanks(r.data).length);
  const stageCount = st => count(r => stage(r) === st);
  const reached = ['Outreach sent', 'In conversation', 'Proposal sent', 'Won', 'Closed'].reduce((t, st) => t + stageCount(st), 0);
  const replied = ['In conversation', 'Proposal sent', 'Won'].reduce((t, st) => t + stageCount(st), 0);
  const draftCount = st => count(r => (r.data['Draft status'] || 'Draft') === st);
  const blankRows = BLANK_LABELS.slice(1).map(([re, label, why]) => [label, why, count(r => blanks(r.data).some(b => re.test(b)))]).filter(x => x[2]);
  const briefMissing = [['audience', 'Confirmed audience details'], ['offer', 'Sponsor benefits & opportunities']].filter(([k]) => !(state.brief[k] || '').trim());
  const firstDate = t => { const m = String(t).match(/(January|February|March|April|May|June|July|August|September|October|November|December)(?: (\d{1,2}),)? (\d{4})/); return m ? Date.parse(`${m[1]} ${m[2] || 1}, ${m[3]}`) : Infinity; };
  const timing = recs.filter(r => (r.data.Timing || '').trim()).sort((a, b) => firstDate(a.data.Timing) - firstDate(b.data.Timing));
  const phases = [
    ['First wave', byWave('First wave'), 'Strongest fit and simplest route. Mostly direct inboxes, so these go out first and show us what resonates.'],
    ['Second wave', byWave('Second wave'), 'Good fit. Email routes go next; forms and portals follow in batches because each takes longer to complete.'],
    ['Qualify first', byWave('Qualify first'), 'Programs with a question to settle first, such as whether a women\'s club event qualifies, a set lead time or a funding cycle. Contact once the answer is clear.']
  ];
  const chip = r => `<button type="button" class="plan-co" data-id="${esc(r.id)}">${esc(r.company)}</button>`;
  const step = (num, title, body) => `<section class="plan-step"><div class="plan-num" aria-hidden="true">${num}</div><div class="plan-body"><h2>${title}</h2>${body}</div></section>`;

  document.querySelector('#content').innerHTML = `<div class="overview plan">
  <header class="ov-head"><div class="eyebrow">Overview plan</div><h1>From ${n} prospects to real conversations</h1>
    <p class="muted">How Green Girl Era turns the sponsor pipeline into outreach: who we contact first, how we reach the right person, what we ask for, how each email is personalized, how follow-ups are tracked, and the weekly goal we measure against. All numbers update from the live pipeline.</p></header>
  <section class="stats" aria-label="Pipeline readiness">
    <div class="stat"><small>Active prospects</small><strong>${recs.length}</strong><span>of ${n} · ${onHold.length} on hold (nonprofit only)</span></div>
    <div class="stat"><small>Official route</small><strong>${withRoute}</strong><span>${count(emailRoute)} by email · ${recs.length - count(emailRoute)} by form, portal or in person</span></div>
    <div class="stat"><small>Named decision makers</small><strong>${withPeople}</strong><span>${withLI} with a LinkedIn company page</span></div>
    <div class="stat"><small>Drafts written</small><strong>${count(r => (r.data['Initial outreach email'] || '').trim())}</strong><span>${ready} with no blanks left to fill</span></div>
    <div class="stat"><small>Reached so far</small><strong>${reached}</strong><span>${replied} replied or in talks</span></div>
  </section>

  ${step(1, 'The next step: event details, then send', `
    <p>Every prospect already has an official contact route, a suggested ask and a drafted email plus follow-up. Before the first email goes out, we fill in the few details the drafts leave blank, because sponsors decide on specifics.</p>
    ${onHold.length || askFirst.length ? `<p class="plan-note"><b>Nonprofit-only programs.</b> ${onHold.length} programs only give through a registered 501(c)(3), so they are on hold and left out of the plan below until GGE works with a fiscal sponsor or nonprofit. ${askFirst.length} more expect a charity beneficiary without saying it must be a 501(c)(3), so we ask first whether a women's club event qualifies. Everyone else can support GGE directly.</p>` : ''}
    ${blankRows.length ? `<ul class="plan-list">${blankRows.map(([label, why, c]) => `<li><b>${label}</b> <span class="pill">${c} draft${c === 1 ? '' : 's'}</span><br><span class="muted small">${why}</span></li>`).join('')}</ul>` : '<p class="muted">No drafts have blanks left to fill.</p>'}
    ${briefMissing.length ? `<p class="plan-note">Also add to the <button type="button" class="linkish" data-view-go="brief">Pitch brief</button>: ${briefMissing.map(x => x[1]).join(' and ')}. Drafts use only confirmed facts, so these stay as placeholders until they are added.</p>` : ''}
    <ol class="flow" aria-label="Pipeline stages">${STAGES.map(st => `<li><span>${st}</span><b>${stageCount(st)}</b></li>`).join('')}</ol>`)}

  ${step(2, 'Who we contact first', `
    <p>Priority comes from three things on every profile: how well the company fits GGE, how simple the route is, and whether we meet the program's rules today.</p>
    <div class="phases">${phases.map(([t, list, why], i) => `<div class="phase"><div class="phase-head"><span class="eyebrow">Phase ${i + 1}</span><strong>${t}</strong><span class="pill">${list.length} · ${list.filter(emailRoute).length} email</span></div><p class="muted small">${why}</p>${i === 0 ? `<div class="plan-cos">${list.map(chip).join('')}</div>` : ''}</div>`).join('')}</div>
    ${timing.length ? `<div class="plan-timing"><h3>Time-sensitive, regardless of phase</h3><ul>${timing.map(r => `<li>${chip(r)}<span>${esc(r.data.Timing)}</span></li>`).join('')}</ul></div>` : ''}`)}

  ${step(3, 'Reaching the right person', `
    <p>Contacts come only from official sources: the company's own sponsorship, giving or contact pages, and public LinkedIn company pages. No email address is guessed.</p>
    <ul class="plan-list">
      <li><b>Official route first.</b> ${withRoute} of ${recs.length} active prospects have a published sponsorship portal, form or inbox. When a company says requests must go through its form, we use the form.</li>
      <li><b>Named decision makers.</b> ${withPeople} profiles list the people most likely to own sponsorship (partnerships, brand marketing, community relations), with why each one matters and the source. Anyone whose current role still needs checking is marked to confirm.</li>
      <li><b>LinkedIn for a warm touch.</b> ${withLI} have the company page linked, plus a "Find on LinkedIn" search for each person, to follow the company and connect before or after the email.</li>
    </ul>`)}

  ${step(4, 'Deciding the ask', `
    <p>Each profile has a <b>Suggested sponsor ask</b> built from how that company actually gives, so we request what they already offer instead of a generic sponsorship package:</p>
    <ul class="plan-list">
      <li><b>Grants and cash sponsorship</b> for banks, foundations and corporate programs, sized to their published limits, where GGE can apply directly.</li>
      <li><b>Product or in-kind support</b> for beverage, food, beauty and apparel brands: drinks, samples, gift cards, raffle items or member offers.</li>
      <li><b>Hosted experiences</b> for studios, venues and golf: a co-hosted class, bay or course time, or a private event space.</li>
      <li><b>Give-back events</b> where a share of sales or class proceeds goes to the cause.</li>
      <li><b>Volunteer speakers</b> from organizations that provide free presenters and mentors, for member sessions on leadership, finance, wellness and careers.</li>
    </ul>
    <p class="muted small">Each profile's <b>Qualification / limits</b> lists the program's rules (nonprofit status, lead time, one request per year), checked before anything is sent.</p>`)}

  ${step(5, 'Personalizing every email', `
    <ul class="plan-list">
      <li><b>Pitch angle.</b> Each profile has a sponsorship angle tying that company's own program or audience to GGE's women in golf, wellness and professional community.</li>
      <li><b>Why it fits GGE.</b> The fit explanation and recent company news give a specific opening line, not a template.</li>
      <li><b>Right greeting and route.</b> Drafts address the named contact where one is confirmed and follow the company's required format (form fields, letterhead, portal).</li>
      <li><b>Human review.</b> Every draft is read and edited before sending, and sent by hand. Nothing sends automatically.</li>
    </ul>`)}

  ${step(6, 'Tracking responses and follow-ups', `
    <ul class="plan-list">
      <li><b>Move the stage the same day.</b> Outreach sent after the first email, In conversation when they reply, Proposal sent once terms are shared, then Won or Closed.</li>
      <li><b>One follow-up, already drafted.</b> If there is no reply after about a week (or the response time the program states), send the follow-up draft once. If there is still no reply, mark it Closed and revisit next season.</li>
      <li><b>Log every touch.</b> Replies, names and next steps go in Outreach notes, and Next action always says what happens next.</li>
      <li><b>Draft status.</b> Draft ${draftCount('Draft')} · Needs review ${draftCount('Needs review')} · Ready to send ${draftCount('Ready to send')} · Sent manually ${draftCount('Sent manually')}.</li>
    </ul>`)}

  ${step(7, 'Weekly goal and how we measure it', `
    <div class="goals">
      <div class="goal"><strong>25</strong><span>new first contacts a week, starting with the first wave and email routes</span></div>
      <div class="goal"><strong>100%</strong><span>of follow-ups sent when due, and every reply logged within a day</span></div>
      <div class="goal"><strong>Every Friday</strong><span>a quick review of the numbers below to adjust the next week</span></div>
    </div>
    <p class="muted small">Email routes take minutes each; portals and forms that ask for documents take longer, so the weekly mix shifts toward them once the email routes are done. At this pace the ${recs.length} active prospects are all contacted in about ${Math.max(1, Math.ceil(recs.length / 25))} weeks.</p>
    <table class="plan-score"><caption class="sr">Pipeline scoreboard</caption><tbody>
      <tr><th scope="row">Contacted</th><td>${reached} of ${recs.length}</td></tr>
      <tr><th scope="row">Response rate</th><td>${reached ? Math.round(replied / reached * 100) + '%' : 'Starts after the first sends'}</td></tr>
      <tr><th scope="row">In conversation</th><td>${stageCount('In conversation')}</td></tr>
      <tr><th scope="row">Proposals sent</th><td>${stageCount('Proposal sent')}</td></tr>
      <tr><th scope="row">Won</th><td>${stageCount('Won')}</td></tr>
    </tbody></table>`)}
  </div>`;
  const content = document.querySelector('#content');
  content.querySelectorAll('.plan-co').forEach(b => b.addEventListener('click', () => openSponsor(b.dataset.id)));
  content.querySelectorAll('[data-view-go]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.viewGo)));
}

// ---------- membership pipeline ----------
// Separate from sponsors. Channels are organizations (public in view mode); leads are people and the
// API only returns them to the signed-in admin.
const CHANNEL_TYPES = ["Women's Professional Network", 'Golf & Pickleball', 'Alumnae Network', 'Chamber & Business Association', 'Wellness & Social', 'Corporate Network', 'Community & Events'];
const CHANNEL_STAGES = ['To contact', 'Contacted', 'In conversation', 'Partnered', 'Not a fit'];
const LEAD_STAGES = ['New', 'Contacted', 'Invited to event', 'Attended event', 'Applied', 'Member', 'Not now'];
const LEAD_SOURCES = ['Referral', 'Event guest', 'Applied on website', 'Instagram', 'LinkedIn connection', 'Recruitment channel', 'Other'];
const MEMBER_FIELDS = {
  channel: [['Name', 'Organization'], ['Channel type', 'Type', CHANNEL_TYPES], ['Area'], ['Stage', 'Stage', CHANNEL_STAGES], ['Fit rating', 'Fit', ['Strong', 'Good', 'Possible']], ['Who they reach', '', null, true], ['Why they fit GGE', '', null, true], ['How to reach their members', '', null, true], ['Suggested first step', '', null, true], ['Public email'], ['Contact route'], ['Contact URL'], ['Source URL'], ['Outreach message', '', null, true], ['Notes', '', null, true]],
  lead: [['Name'], ['How we met', '', LEAD_SOURCES], ['Referred by or channel'], ['Stage', 'Stage', LEAD_STAGES], ['Email'], ['Phone'], ['Instagram or LinkedIn'], ['Interests', 'Interests (golf, wellness, networking...)'], ['Okay to contact', 'Okay to contact?', ['Yes', 'Not yet asked']], ['Next step', '', null, true], ['Notes', '', null, true]]
};
const mStage = r => r.data.Stage || (r.kind === 'lead' ? 'New' : 'To contact');

function membersView() {
  const channels = state.members.filter(r => r.kind === 'channel');
  const leads = state.members.filter(r => r.kind === 'lead');
  const tab = state.memberTab === 'leads' ? 'leads' : 'channels';
  const count = (list, st) => list.filter(r => mStage(r) === st).length;
  const shown = channels.filter(r => !state.memberType || r.data['Channel type'] === state.memberType);
  const types = CHANNEL_TYPES.filter(t => channels.some(r => r.data['Channel type'] === t));
  const link = u => safeURL(u) ? `<a href="${esc(safeURL(u))}" target="_blank" rel="noopener">${esc(new URL(safeURL(u)).hostname.replace(/^www\./, ''))} ↗</a>` : '';
  const card = r => { const d = r.data; return `<article class="mcard">
      <header><div><h3>${esc(r.name)}</h3><small>${esc(d['Channel type'] || '')}${d.Area ? ' · ' + esc(d.Area) : ''}</small></div>${fitBadge(d['Fit rating'])}</header>
      ${d['Who they reach'] ? `<p><b>Who they reach.</b> ${esc(d['Who they reach'])}</p>` : ''}
      ${d['Why they fit GGE'] ? `<p><b>Why they fit.</b> ${esc(d['Why they fit GGE'])}</p>` : ''}
      ${d['How to reach their members'] ? `<p><b>How to reach members.</b> ${esc(d['How to reach their members'])}</p>` : ''}
      ${d['Suggested first step'] ? `<p class="mnext"><b>First step.</b> ${esc(d['Suggested first step'])}</p>` : ''}
      <div class="mlinks">${isEmail(d['Public email']) ? `<a href="mailto:${esc(d['Public email'])}">${esc(d['Public email'])}</a>` : ''}${link(d['Contact URL'])}${d['Contact route'] ? `<span class="pill">${esc(d['Contact route'])}</span>` : ''}${d['Source URL'] && d['Source URL'] !== d['Contact URL'] ? `<span class="muted small">Source: ${link(d['Source URL'])}</span>` : ''}</div>
      ${d['Outreach message'] ? `<details><summary>Outreach message</summary><pre class="mmsg">${esc(d['Outreach message'])}</pre><button type="button" class="small-btn" data-mcopy="${esc(r.id)}">Copy message</button></details>` : ''}
      <footer>${state.readOnly ? `<span class="pill">${esc(mStage(r))}</span>` : `<label><span class="sr">Stage for ${esc(r.name)}</span><select data-mstage="${esc(r.id)}">${CHANNEL_STAGES.map(s => `<option ${s === mStage(r) ? 'selected' : ''}>${s}</option>`).join('')}</select></label><button type="button" class="small-btn" data-medit="${esc(r.id)}">Edit</button>`}</footer>
    </article>`; };

  document.querySelector('#content').innerHTML = `<div class="overview members">
  <header class="ov-head"><div class="eyebrow">Membership</div><h1>Finding our next members</h1>
    <p class="muted">A separate pipeline from sponsors. <b>Recruitment channels</b> are organizations where women likely to join Green Girl Era already gather, each with a verified way to reach their members. <b>Member leads</b> are individual people, added by hand from referrals, events and applications, and kept private to the admin.</p></header>
  <section class="stats" aria-label="Membership summary">
    <div class="stat"><small>Channels</small><strong>${channels.length}</strong><span>${count(channels, 'Partnered')} partnered · ${count(channels, 'In conversation')} in conversation</span></div>
    <div class="stat"><small>Channels contacted</small><strong>${channels.length - count(channels, 'To contact')}</strong><span>of ${channels.length}</span></div>
    <div class="stat"><small>Member leads</small><strong>${state.leadsVisible ? leads.length : '—'}</strong><span>${state.leadsVisible ? `${count(leads, 'Applied')} applied` : 'Private to the admin'}</span></div>
    <div class="stat"><small>New members</small><strong>${state.leadsVisible ? count(leads, 'Member') : '—'}</strong><span>${state.leadsVisible ? `${count(leads, 'Attended event')} attended an event` : 'Private to the admin'}</span></div>
  </section>
  <div class="mtabs" role="tablist"><button role="tab" type="button" data-mtab="channels" aria-selected="${tab === 'channels'}" class="${tab === 'channels' ? 'on' : ''}">Recruitment channels <span class="n">${channels.length}</span></button><button role="tab" type="button" data-mtab="leads" aria-selected="${tab === 'leads'}" class="${tab === 'leads' ? 'on' : ''}">Member leads ${state.leadsVisible ? `<span class="n">${leads.length}</span>` : '🔒'}</button>
    ${state.readOnly ? '' : `<button type="button" class="primary small-btn" id="m-add">${tab === 'leads' ? 'Add lead' : 'Add channel'}</button>`}</div>
  ${tab === 'channels' ? `
    ${types.length > 1 ? `<div class="chips wrap" role="group" aria-label="Channel type"><button type="button" class="chip ${state.memberType ? '' : 'on'}" data-mtype="">All <span class="n">${channels.length}</span></button>${types.map(t => `<button type="button" class="chip ${state.memberType === t ? 'on' : ''}" data-mtype="${esc(t)}">${esc(t)} <span class="n">${channels.filter(r => r.data['Channel type'] === t).length}</span></button>`).join('')}</div>` : ''}
    ${shown.length ? `<div class="mgrid">${shown.map(card).join('')}</div>` : '<div class="empty"><h2>No channels yet</h2><p>Recruitment channels will appear here once they are verified.</p></div>'}`
  : !state.leadsVisible ? `<div class="empty"><h2>Member leads are private</h2><p>Leads are individual people, so they are only shown to the admin after signing in. The server never sends them to public visitors.</p>${state.readOnly ? '<a class="button small-btn" href="/admin">Admin sign in</a>' : ''}</div>`
  : leads.length ? `<div class="tablewrap"><table><thead><tr><th scope="col">Name</th><th scope="col">How we met</th><th scope="col">Stage</th><th scope="col">Next step</th></tr></thead><tbody>${leads.map(r => `<tr><td><button type="button" class="row-open" data-medit="${esc(r.id)}"><span><strong>${esc(r.name)}</strong><small>${esc(r.data.Interests || '')}</small></span></button></td><td>${esc(r.data['How we met'] || '')}<small>${esc(r.data['Referred by or channel'] || '')}</small></td><td><select data-mstage="${esc(r.id)}" aria-label="Stage for ${esc(r.name)}">${LEAD_STAGES.map(s => `<option ${s === mStage(r) ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td class="next">${esc(r.data['Next step'] || '')}</td></tr>`).join('')}</tbody></table></div>`
  : '<div class="empty"><h2>No leads yet</h2><p>Add people who were referred, came to an event or applied, and track them from first hello to member. Only add people who shared their details with you.</p></div>'}
  </div>`;
  const c = document.querySelector('#content');
  c.querySelectorAll('[data-mtab]').forEach(b => b.addEventListener('click', () => { state.memberTab = b.dataset.mtab; membersView(); }));
  c.querySelectorAll('[data-mtype]').forEach(b => b.addEventListener('click', () => { state.memberType = b.dataset.mtype; membersView(); }));
  c.querySelectorAll('[data-medit]').forEach(b => b.addEventListener('click', () => editMember(state.members.find(r => r.id === b.dataset.medit))));
  c.querySelectorAll('[data-mstage]').forEach(sel => sel.addEventListener('change', () => { const r = state.members.find(x => x.id === sel.dataset.mstage); if (r) saveMember({ ...r, data: { ...r.data, Stage: sel.value } }, sel); }));
  c.querySelectorAll('[data-mcopy]').forEach(b => b.addEventListener('click', async () => { const r = state.members.find(x => x.id === b.dataset.mcopy); try { await navigator.clipboard.writeText(r.data['Outreach message']); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; } }));
  c.querySelector('#m-add')?.addEventListener('click', () => editMember({ id: '', kind: tab === 'leads' ? 'lead' : 'channel', name: '', data: {}, version: null }));
}

async function saveMember(rec, control) {
  if (control) control.disabled = true;
  try {
    const body = { kind: rec.kind, name: rec.name, data: rec.data, version: rec.version };
    const { record } = rec.id ? await api('members/' + encodeURIComponent(rec.id), { method: 'PUT', body }) : await api('members', { method: 'POST', body });
    const i = state.members.findIndex(r => r.id === record.id);
    if (i >= 0) state.members[i] = record; else state.members.push(record);
    state.members.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    notify(`${record.name} saved.`, 'success');
    return true;
  } catch (err) {
    notify(err.message, 'error');
    if (err.status === 409 && err.body?.record) { const i = state.members.findIndex(r => r.id === err.body.record.id); if (i >= 0) state.members[i] = err.body.record; }
    return false;
  } finally { if (state.view === 'members' && !document.querySelector('.modal')) membersView(); }
}

function editMember(rec) {
  if (!rec || state.readOnly) return;
  const opener = document.activeElement;
  const fields = MEMBER_FIELDS[rec.kind];
  const el = document.createElement('div');
  el.className = 'modal';
  const field = ([key, label = key, options, long]) => `<div class="field"><label for="mf-${esc(key)}">${esc(label || key)}</label>${options
    ? `<select id="mf-${esc(key)}" name="${esc(key)}"><option value=""></option>${options.map(o => `<option ${o === (rec.data[key] || (key === 'Stage' ? mStage(rec) : '')) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : long ? `<textarea id="mf-${esc(key)}" name="${esc(key)}" rows="3">${esc(key === 'Name' ? rec.name : rec.data[key] || '')}</textarea>`
    : `<input id="mf-${esc(key)}" name="${esc(key)}" value="${esc(key === 'Name' ? rec.name : rec.data[key] || '')}" ${key === 'Name' ? 'required' : ''}>`}</div>`;
  el.innerHTML = `<form class="panel" role="dialog" aria-modal="true" aria-labelledby="mf-title">
    <header class="panel-head"><div><div class="eyebrow">${rec.kind === 'lead' ? 'Member lead · private' : 'Recruitment channel'}</div><h2 id="mf-title">${rec.id ? esc(rec.name) : rec.kind === 'lead' ? 'New lead' : 'New channel'}</h2>${rec.kind === 'lead' ? '<small>Only add people who shared their details with you or were referred with their permission.</small>' : ''}</div><button type="button" class="icon" id="mf-x" aria-label="Close">✕</button></header>
    <div class="imp-body mform">${fields.map(field).join('')}</div>
    <footer class="panel-foot">${rec.id ? '<button type="button" class="danger" id="mf-del">Delete</button>' : ''}<button type="button" id="mf-cancel">Cancel</button><button class="primary" id="mf-save">Save</button></footer></form>`;
  document.body.append(el);
  document.body.classList.add('locked');
  const close = () => { el.remove(); document.body.classList.remove('locked'); membersView(); opener?.focus?.(); };
  el.querySelector('#mf-x').addEventListener('click', close);
  el.querySelector('#mf-cancel').addEventListener('click', close);
  el.querySelector('#mf-del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${rec.name}? This cannot be undone.`)) return;
    try { await api('members/' + encodeURIComponent(rec.id) + '?version=' + rec.version, { method: 'DELETE' }); state.members = state.members.filter(r => r.id !== rec.id); notify(`${rec.name} deleted.`); close(); } catch (err) { notify(err.message, 'error'); }
  });
  el.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    const name = String(values.Name || '').trim();
    if (!name) return;
    delete values.Name;
    const btn = el.querySelector('#mf-save'); btn.disabled = true;
    if (await saveMember({ ...rec, name, data: { ...rec.data, ...values } })) close(); else btn.disabled = false;
  });
  el.querySelector('input, textarea, select')?.focus();
}

// ---------- pitch brief ----------
function briefView() {
  const content = document.querySelector('#content');
  content.innerHTML = `<form id="brief" class="brief"><div class="eyebrow">Pitch brief</div><h1>The story behind every email</h1>
    <p class="muted">Add only confirmed details. “Suggest a rewrite” uses these words exactly and shows placeholders where information is missing. No attendance numbers, demographics or benefits are assumed.</p>
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
  document.querySelector('details.menu')?.removeAttribute('open');
  const text = csv(exportRows(state.records), [...PIPELINE_COLUMNS, ...OUTREACH_COLUMNS.filter(c => !PIPELINE_COLUMNS.includes(c))]);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'Green_Girl_Era_Sponsor_CRM.csv' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Exported ${state.records.length} sponsors with all columns and emails.`);
}

function importCSV() {
  document.querySelector('details.menu')?.removeAttribute('open');
  if (!confirmLeave()) return;
  const picker = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,text/csv' });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw Error('Please use a CSV smaller than 5 MB.');
      const rows = parseCSV(await file.text());
      reviewImport(file.name, rows);
    } catch (err) { notify(err.message, 'error'); }
  });
  picker.click();
}

function reviewImport(name, rows, mode = 'fill') {
  let plan;
  try { plan = planImport(state.records, rows, { mode }); } catch (err) { notify(err.message, 'error'); return; }
  const opener = document.activeElement;
  document.querySelector('.modal')?.remove();
  const el = document.createElement('div');
  el.className = 'modal';
  const total = plan.creates.length + plan.updates.length;
  el.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-labelledby="imp-title">
    <header class="panel-head"><div><div class="eyebrow">Review import</div><h2 id="imp-title">${esc(name)}</h2><small>${plan.kind === 'outreach' ? 'Personalized emails, joined by Prospect ID' : 'Sponsor records'} · ${rows.length} rows</small></div><button class="icon" id="imp-x" aria-label="Cancel import">✕</button></header>
    <div class="imp-body">
      <fieldset class="modes"><legend>How should matching sponsors be updated?</legend>
        <label><input type="radio" name="mode" value="fill" ${mode === 'fill' ? 'checked' : ''}> Fill empty fields only <small>Recommended. Keeps every value you already have or edited.</small></label>
        <label><input type="radio" name="mode" value="overwrite" ${mode === 'overwrite' ? 'checked' : ''}> Replace with CSV values <small>CSV values overwrite matching columns. Columns not in the CSV are kept.</small></label>
      </fieldset>
      <div class="imp-stats"><div><strong>${plan.creates.length}</strong><span>new</span></div><div><strong>${plan.updates.length}</strong><span>updated</span></div><div><strong>${plan.unchanged}</strong><span>unchanged</span></div></div>
      ${plan.warnings.length ? `<details class="warn"><summary>${plan.warnings.length} note${plan.warnings.length > 1 ? 's' : ''}</summary><ul>${plan.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${plan.updates.length ? `<details><summary>Changes to existing sponsors</summary><ul class="changes">${plan.updates.map(u => `<li><b>${esc(u.id)} ${esc(u.company)}</b>: ${u.changes.map(ch => esc(ch.key)).join(', ')}</li>`).join('')}</ul></details>` : ''}
      ${plan.creates.length ? `<details><summary>New sponsors</summary><ul class="changes">${plan.creates.map(n => `<li><b>${esc(n.id)}</b> ${esc(n.company)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <footer class="panel-foot"><button type="button" id="imp-cancel">Cancel</button><button type="button" class="primary" id="imp-go" ${total ? '' : 'disabled'}>${total ? `Import ${total} change${total > 1 ? 's' : ''}` : 'Nothing to import'}</button></footer></section>`;
  document.body.append(el);
  document.body.classList.add('locked');
  const close = () => { el.remove(); document.body.classList.remove('locked'); opener?.focus?.(); };
  el.querySelector('#imp-x').addEventListener('click', close);
  el.querySelector('#imp-cancel').addEventListener('click', close);
  el.querySelectorAll('[name=mode]').forEach(radio => radio.addEventListener('change', () => { el.remove(); reviewImport(name, rows, radio.value); document.querySelector(`.modal [value=${radio.value}]`)?.focus(); }));
  el.querySelector('#imp-go').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Importing…';
    try {
      const out = await api('import', { method: 'POST', body: { records: [...plan.creates, ...plan.updates.map(({ id, company, data, version }) => ({ id, company, data, version }))] } });
      state.records = out.records;
      state.current = null;
      close(); render();
      notify(`${out.imported} sponsor${out.imported > 1 ? 's' : ''} ${plan.kind === 'outreach' ? 'updated with personalized emails' : 'imported'}.`, 'success');
    } catch (err) { notify(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'Try again'; }
  });
  el.querySelector('#imp-go').focus();
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.current && isDirty() && !state.readOnly) { e.preventDefault(); saveRecord(); return; }
  const layer = document.querySelector('.modal');
  if (!layer) { if (e.key === 'Escape') document.querySelector('details.menu[open]')?.removeAttribute('open'); return; }
  if (e.key === 'Escape') { e.preventDefault(); layer.querySelector('#imp-cancel').click(); return; }
  if (e.key !== 'Tab') return;
  const items = [...layer.querySelectorAll('button:not(:disabled), input:not([type=hidden]), select:not(:disabled), textarea, a[href], summary')].filter(x => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items.at(-1);
  if (!layer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener('click', e => { const m = document.querySelector('details.menu[open]'); if (m && !m.contains(e.target)) m.removeAttribute('open'); });

boot();
