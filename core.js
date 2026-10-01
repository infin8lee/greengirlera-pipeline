// Shared, dependency-free logic used by the browser app, the API and the tests.
// Nothing in this file may contain private CRM data.

export const ADMIN = 'lee@virtual-lee.com';
export const STAGES = ['Prospect', 'Qualified', 'Outreach sent', 'In conversation', 'Proposal sent', 'Won', 'Closed'];

// Columns of the two private source CSVs. Every column is preserved, including any
// extra column found in a future file.
export const PIPELINE_COLUMNS = ['Priority', 'Company', 'Name / target', 'Public email', 'Category', 'Stage', 'Next action', 'Owner', 'Proposal sent', 'Requested cash (USD)', 'Confirmed cash (USD)', 'Outreach notes', 'Market / coverage', 'Prospect ID', 'Contact role', 'Contact route', 'Suggested sponsor ask', 'Why it fits GGE', 'Qualification / limits', 'Contact source URL', 'Name / fit source URL', 'Source evidence'];
export const OUTREACH_COLUMNS = ['Company', 'Public email', 'Subject', 'Initial outreach email', 'Follow-up email', 'Before sending', 'Draft status', 'Prospect ID', 'Contact route', 'Follow-up subject', 'Greeting'];
export const DRAFT_FIELDS = ['Subject', 'Initial outreach email', 'Follow-up subject', 'Follow-up email'];

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false, fieldStarted = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      if (fieldStarted && field !== '') throw Error('The CSV has a stray quote inside an unquoted field.');
      quoted = true; fieldStarted = true;
    } else if (c === ',') {
      row.push(field); field = ''; fieldStarted = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) rows.push(row);
      row = []; field = ''; fieldStarted = false;
    } else { field += c; fieldStarted = true; }
  }
  if (quoted) throw Error('The CSV contains an unfinished quoted field.');
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  const headers = (rows.shift() || []).map(h => h.trim());
  if (!headers.length || headers.every(h => !h)) throw Error('The CSV has no header row.');
  if (headers.some(h => !h)) throw Error('The CSV has an empty column name.');
  if (new Set(headers).size !== headers.length) throw Error('Duplicate CSV column names.');
  return rows.map((r, n) => {
    if (r.length > headers.length && r.slice(headers.length).some(v => v !== '')) throw Error(`Row ${n + 2} has more values than columns.`);
    return Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']));
  });
}

export function csv(rows, preferredOrder = []) {
  if (!rows.length) return '';
  const seen = new Set(rows.flatMap(Object.keys));
  const headers = [...preferredOrder.filter(h => seen.has(h)), ...[...seen].filter(h => !preferredOrder.includes(h))];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '﻿' + [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(q).join(',')).join('\r\n');
}

export function safeURL(value) {
  try { const u = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

export const isEmail = value => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i.test(String(value || '').trim());

export const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0);

export const amount = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

export function stage(r) { const value = r.data?.Stage || 'Prospect'; return STAGES.includes(value) ? value : 'Prospect'; }

export const isPortalRoute = route => /form|portal|application|program route/i.test(String(route || ''));

// Detect which private CSV a file is.
export function csvKind(rows) {
  const cols = new Set(Object.keys(rows[0] || {}));
  if (cols.has('Initial outreach email') || cols.has('Follow-up email')) return 'outreach';
  return 'pipeline';
}

// Map a pipeline CSV row to record data. Unknown stage labels (for example
// "Qualify first") are kept in "Imported stage" so nothing is lost.
export function pipelineData(row) {
  const data = { ...row };
  const raw = String(row.Stage || '').trim();
  if (raw && !STAGES.includes(raw)) { data['Imported stage'] = raw; data.Stage = 'Prospect'; }
  if (!data.Stage) data.Stage = 'Prospect';
  return data;
}

// Map an outreach CSV row onto an existing pipeline record without damaging
// pipeline facts: the pipeline's contact route and email win, and a differing
// outreach value is preserved in its own column.
export function outreachData(row, existing) {
  const data = {};
  const warnings = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === 'Prospect ID' || key === 'Company') continue;
    if (key === 'Public email') {
      if (!value || value === existing['Public email']) continue;
      if (!isEmail(value)) { warnings.push(`ignored non-email value "${value}" in Public email`); continue; }
      if (!existing['Public email']) data['Public email'] = value;
      else data['Outreach public email'] = value;
      continue;
    }
    if (key === 'Contact route') {
      if (value && value !== existing['Contact route']) data['Outreach contact route'] = value;
      continue;
    }
    data[key] = value;
  }
  return { data, warnings };
}

const cleanId = v => String(v ?? '').trim();

/**
 * Plan an import without changing anything. Returns what would be created,
 * updated or skipped so the user can review before confirming.
 * mode "fill": only empty fields are filled (protects edits, the default).
 * mode "overwrite": CSV values replace existing values for the columns it contains.
 */
export function planImport(records, rows, { mode = 'fill' } = {}) {
  if (!['fill', 'overwrite'].includes(mode)) throw Error('Unknown import mode.');
  if (!rows.length) throw Error('The CSV has no records.');
  const kind = csvKind(rows);
  const byId = new Map(records.map(r => [r.id, r]));
  const ids = rows.map(r => cleanId(r['Prospect ID']));
  const missing = rows.findIndex((r, i) => !ids[i] || !String(r.Company || '').trim());
  if (missing >= 0) throw Error(`Row ${missing + 2} needs both Company and Prospect ID.`);
  const bad = ids.find(id => !/^[A-Za-z0-9._-]{1,64}$/.test(id));
  if (bad) throw Error(`Prospect ID "${bad}" may only use letters, numbers, dot, dash and underscore.`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw Error(`The CSV repeats Prospect ID ${dup}.`);

  const creates = [], updates = [], warnings = [];
  let unchanged = 0;
  rows.forEach((row, i) => {
    const id = ids[i];
    const existing = byId.get(id);
    if (kind === 'outreach') {
      if (!existing) throw Error(`Import the sponsor pipeline first. Prospect ${id} (${row.Company}) is not in the CRM yet.`);
      if (existing.company.trim().toLowerCase() !== String(row.Company).trim().toLowerCase()) warnings.push(`${id}: company name differs ("${row.Company}" vs "${existing.company}"); the CRM name is kept.`);
    }
    let incoming;
    if (kind === 'outreach') {
      const mapped = outreachData(row, existing.data);
      mapped.warnings.forEach(w => warnings.push(`${id}: ${w}`));
      incoming = mapped.data;
    } else incoming = pipelineData({ ...row, 'Prospect ID': id });
    if (!existing) {
      creates.push({ id, company: String(row.Company).trim(), data: incoming, version: null });
      return;
    }
    const next = { ...existing.data };
    const changes = [];
    for (const [key, value] of Object.entries(incoming)) {
      const before = existing.data[key] ?? '';
      if (String(value) === String(before)) continue;
      if (mode === 'fill' && String(before).trim() !== '') continue;
      if (value === '' && before === '') continue;
      next[key] = value;
      changes.push({ key, from: before, to: value });
    }
    const protectedCount = Object.entries(incoming).filter(([k, v]) => mode === 'fill' && String(existing.data[k] ?? '').trim() !== '' && String(v) !== String(existing.data[k])).length;
    if (!changes.length) { unchanged++; if (protectedCount) warnings.push(`${id}: ${protectedCount} edited field(s) kept.`); return; }
    const company = kind === 'pipeline' && next.Company?.trim() && mode === 'overwrite' ? next.Company.trim() : existing.company;
    updates.push({ id, company, data: { ...next, Company: company }, version: existing.version, changes, protectedCount });
  });
  return { kind, mode, creates, updates, unchanged, warnings };
}

// Records flattened for export: every stored column plus stable identifiers.
export function exportRows(records) {
  return records.map(r => ({ ...r.data, Company: r.company, 'Prospect ID': r.id }));
}

export function nextProspectId(records) {
  const max = records.reduce((n, r) => { const m = /^GGE-(\d+)$/.exec(r.id); return m ? Math.max(n, Number(m[1])) : n; }, 0);
  return 'GGE-' + String(max + 1).padStart(3, '0');
}

// ----- Data-based draft composer (no AI, no external calls) -----------------
// Builds a draft only from the prospect's saved facts and the saved pitch brief.
// Missing facts become visible [placeholders]; nothing is invented.

const trimEnd = s => String(s || '').trim().replace(/[.\s]+$/, '');
const lowerFirst = s => { s = trimEnd(s); return s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; };
const noDash = s => String(s).replace(/\s*[—–]\s*/g, ', ');

export function greetingFor(data, company) {
  if (data.Greeting?.trim()) return data.Greeting.trim();
  const name = String(data['Name / target'] || '').trim();
  const personal = name && !/not publicly|unknown|team|n\/a|^none/i.test(name) && /^[A-Z][\w'’.-]+(\s[A-Z][\w'’.-]+)+$/.test(name);
  return personal ? `Hi ${name.split(/\s+/)[0]},` : `Hi ${company} team,`;
}

export function composeDraft(data, brief = {}) {
  const company = String(data.Company || '').trim() || '[Company]';
  const org = String(brief.organization || '').trim() || 'Green Girl Era';
  const ask = lowerFirst(data['Suggested sponsor ask']);
  // A sponsor-facing reason, written for the email. Research notes are never pasted into emails.
  const fit = lowerFirst(data['Pitch angle']);
  const portal = isPortalRoute(data['Contact route']) || isPortalRoute(data['Outreach contact route']);
  const signature = String(brief.signature || '').trim() || `[Your name]\n${org}`;
  const greeting = greetingFor(data, company);
  const topic = ask || 'a sponsorship partnership';
  const subject = noDash(`${company} x ${org}: ${ask || 'partnership inquiry'}`);

  const about = String(brief.description || '').trim() || '[Add a one-sentence description of Green Girl Era]';
  const audience = String(brief.audience || '').trim();
  const offer = String(brief.offer || '').trim();
  const paragraphs = [
    greeting,
    `I'm reaching out on behalf of ${org}. ${about}`,
    fit ? `We think ${company} could be a natural fit because ${fit}.` : `[Add one sentence on why ${company} fits ${org}. See “Why they fit” on this sponsor's page.]`,
    `As we plan our upcoming gatherings, we would love to explore whether ${company} could support one of them, starting with ${topic}.` + (audience ? ` ${audience}` : ' [Add confirmed audience details, such as member profile and expected event size.]'),
    `We'd also love to explore a longer collaboration, for example:\n- co-hosting a member experience together\n- an exclusive offer for our members\n- featuring ${company} in our member communications and at our events`,
    offer ? `In return, we can offer ${lowerFirst(offer)}.` : '[Add the sponsor benefits you can confirm.]',
    (portal ? `I'm also submitting this through your official request channel, as your guidelines ask. ` : '') + `Would you be open to a short call to explore what might work? I'm happy to share our upcoming calendar and shape ideas around your team's goals.`,
    `Best,\n${signature}`
  ];
  const followupParagraphs = [
    greeting,
    `I'm following up on my note about ${company} supporting an upcoming ${org} gathering, starting with ${topic}, and the collaboration ideas I shared, such as co-hosting a member experience.`,
    `If someone else handles partnerships, a referral would be appreciated. If it isn't a fit right now, just let me know and we'll close the loop.`,
    `Best,\n${signature}`
  ];
  const checks = [];
  if (!audience) checks.push('Add confirmed audience details in the Pitch brief.');
  if (!offer) checks.push('Add confirmed sponsor benefits in the Pitch brief.');
  if (/\[Your name\]/.test(signature)) checks.push('Replace [Your name] in the signature.');
  if (data['Qualification / limits']) checks.push('Respect: ' + trimEnd(data['Qualification / limits']) + '.');
  if (portal) checks.push('This prospect uses a form or portal. Paste the draft into that channel instead of emailing.');
  return {
    subject,
    body: noDash(paragraphs.join('\n\n')),
    followupSubject: 'Re: ' + subject,
    followupBody: noDash(followupParagraphs.join('\n\n')),
    checks
  };
}
