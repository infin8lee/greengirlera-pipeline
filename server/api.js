// JSON API for the CRM, served by the Worker at /api/*.
// By default every route requires a verified Cloudflare Access session for the admin.
// Public view mode (Worker variable AUTH_MODE = "view", set in wrangler.toml): anyone with
// the URL can READ. Every change (POST/PUT/DELETE) still requires the verified admin login,
// so with no admin login configured the site is simply read-only. Any other AUTH_MODE value,
// or none, keeps the whole API behind the login (it fails closed).

import { tokenFrom, verifyAccessJwt } from './auth.js';
import { nextProspectId } from '../core.js';

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const LIMITS = { keys: 120, key: 120, value: 20000, company: 200, body: 256 * 1024, importBody: 6 * 1024 * 1024, importRecords: 1000 };
const BRIEF_KEYS = ['organization', 'description', 'audience', 'offer', 'signature'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

function cleanData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Record data must be an object.');
  const entries = Object.entries(data);
  if (entries.length > LIMITS.keys) throw new HttpError(400, 'Too many fields.');
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || !k.trim() || k.length > LIMITS.key) throw new HttpError(400, 'Invalid field name.');
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new HttpError(400, `Field "${k}" must be text.`);
    const s = v === null ? '' : String(v);
    if (s.length > LIMITS.value) throw new HttpError(400, `Field "${k}" is too long.`);
    out[k] = s;
  }
  return out;
}

function cleanRecord(input, { requireId = true } = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid record.');
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (requireId && !ID.test(id)) throw new HttpError(400, 'Invalid Prospect ID.');
  const data = cleanData(input.data);
  const company = String(input.company ?? data.Company ?? '').trim();
  if (!company || company.length > LIMITS.company) throw new HttpError(400, 'Company is required (200 characters max).');
  data.Company = company;
  if (id) data['Prospect ID'] = id;
  const version = input.version === null || input.version === undefined ? null : Number(input.version);
  if (version !== null && !Number.isInteger(version)) throw new HttpError(400, 'Invalid version.');
  return { id, company, data, version };
}

async function readJSON(request, limit) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw new HttpError(413, 'Request too large.');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request too large.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

const row = r => ({ id: r.id, company: r.company, data: JSON.parse(r.data), version: r.version });

const MEMBER_KINDS = { channel: 'MC', lead: 'ML' };
// Contact tracking is the one change anyone may make in public view mode. The route writes only
// the "Contact status" field (one of these values) and the matching stage, nothing else.
export const CONTACT_LEVELS = ['', '1st Contact', '2nd Contact', '3rd Contact'];
const CONTACT_ROUTE = /^\/api\/(sponsors|members)\/[^/]+\/contact$/;
const CONTACT_STAGES = { sponsors: { open: ['Prospect', 'Qualified'], from: 'Prospect', to: 'Outreach sent' }, members: { open: ['To contact'], from: 'To contact', to: 'Contacted' } };

// Team passcode for contact tagging. Only a salted SHA-256 hash is stored (settings row 'team').
const PASSCODE_MIN = 10, PASSCODE_MAX = 100;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const hashPasscode = async (salt, passcode) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + passcode)));
function sameText(a, b) { // constant time for equal-length strings
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function teamSetting(db) {
  const r = await db.prepare("SELECT data FROM settings WHERE id = 'team'").first();
  const t = r ? JSON.parse(r.data) : null;
  return t && t.salt && t.hash ? t : null;
}
async function checkTeamPasscode(db, request) {
  const team = await teamSetting(db);
  if (!team) throw new HttpError(403, 'Contact tagging needs the team passcode, and the admin has not set one yet.');
  const given = request.headers.get('x-team-passcode') || '';
  if (!given) throw new HttpError(403, 'Enter the team passcode to tag contacts.');
  if (given.length > PASSCODE_MAX || !sameText(await hashPasscode(team.salt, given), team.hash)) throw new HttpError(403, 'That team passcode is not right.');
}

async function setContact(db, table, id, status) {
  const sql = table === 'sponsors'
    ? 'SELECT id, company, data, version FROM sponsors WHERE id = ?1'
    : "SELECT id, kind, name, data, version FROM members WHERE id = ?1 AND kind = 'channel'"; // leads are never reachable here
  const rules = CONTACT_STAGES[table];
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.prepare(sql).bind(id).first();
    if (!current) throw new HttpError(404, 'Not found.');
    const data = JSON.parse(current.data);
    data['Contact status'] = status;
    const stageNow = data.Stage || rules.from;
    if (status && rules.open.includes(stageNow)) data.Stage = rules.to;
    if (!status && stageNow === rules.to) data.Stage = rules.from;
    const res = await db.prepare(`UPDATE ${table} SET data = ?1, version = version + 1 WHERE id = ?2 AND version = ?3`).bind(JSON.stringify(data), id, current.version).run();
    if (res.meta.changes) return table === 'sponsors' ? { ...row(current), data, version: current.version + 1 } : { ...memberRow(current), data, version: current.version + 1 };
  }
  throw new HttpError(409, 'This record is changing right now. Try again.');
}
const memberRow = r => ({ id: r.id, kind: r.kind, name: r.name, data: JSON.parse(r.data), version: r.version });

// Leads are people, so they are only ever read for the verified admin. Public visitors get channels only.
async function allMembers(db, admin) {
  const sql = 'SELECT id, kind, name, data, version FROM members' + (admin ? '' : " WHERE kind = 'channel'") + ' ORDER BY kind, name COLLATE NOCASE, id';
  const { results } = await db.prepare(sql).all();
  return results.map(memberRow);
}

function cleanMember(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid record.');
  if (!Object.hasOwn(MEMBER_KINDS, input.kind)) throw new HttpError(400, 'Kind must be channel or lead.');
  const data = cleanData(input.data);
  const name = String(input.name ?? data.Name ?? '').trim();
  if (!name || name.length > LIMITS.company) throw new HttpError(400, 'Name is required (200 characters max).');
  data.Name = name;
  const version = input.version === null || input.version === undefined ? null : Number(input.version);
  if (version !== null && !Number.isInteger(version)) throw new HttpError(400, 'Invalid version.');
  return { kind: input.kind, name, data, version };
}

async function nextMemberId(db, kind) {
  const prefix = MEMBER_KINDS[kind];
  const { results } = await db.prepare('SELECT id FROM members WHERE kind = ?1').bind(kind).all();
  const max = results.reduce((m, r) => { const n = Number((r.id.match(new RegExp('^' + prefix + '-(\\d+)$')) || [])[1]); return Number.isFinite(n) && n > m ? n : m; }, 0);
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

async function allSponsors(db) {
  const { results } = await db.prepare('SELECT id, company, data, version FROM sponsors ORDER BY company COLLATE NOCASE, id').all();
  return results.map(row);
}

// While unconfigured, show the admin the (non-secret) team domain and audience
// from the Access token they already hold. These values are never trusted here:
// once configured, every token is verified against them.
function setupHint(request) {
  try {
    const payload = JSON.parse(atob(tokenFrom(request).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (typeof payload.iss !== 'string' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(payload.iss) || typeof aud !== 'string' || !/^[a-f0-9]{32,128}$/.test(aud)) return null;
    return { ACCESS_TEAM_DOMAIN: payload.iss, ACCESS_AUD: aud };
  } catch { return null; }
}

async function authenticate(request, env) {
  const token = tokenFrom(request);
  if (!token) throw new HttpError(401, 'Sign-in required.');
  try {
    return await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl: typeof env.__fetch === 'function' ? env.__fetch : fetch });
  } catch (err) {
    if (err.message === 'Not the admin') throw new HttpError(403, 'This workspace is restricted to its admin.');
    throw new HttpError(401, 'Your session is not valid or has expired. Reload to sign in again.');
  }
}

function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-site request refused.');
}

export async function handleApi(request, env) {
  try {
    const publicView = env.AUTH_MODE === 'view';
    const accessConfigured = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    if (!env.DB || (!publicView && !accessConfigured)) return json({ error: 'The CRM backend is not configured yet.', setup: setupHint(request) }, 503);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let user = null; // the verified admin, or null for a public visitor
    const contactWrite = publicView && request.method === 'POST' && CONTACT_ROUTE.test(new URL(request.url).pathname);
    if (!publicView) user = await authenticate(request, env);
    else if (contactWrite) {
      // Open to every viewer; a valid admin login is simply recorded as such.
      if (accessConfigured && tokenFrom(request)) { try { user = await authenticate(request, env); } catch { user = null; } }
    } else if (!isRead) {
      if (!tokenFrom(request)) throw new HttpError(403, 'This site is view-only. Only the admin can make changes: sign in at /admin.');
      if (!accessConfigured) throw new HttpError(403, 'Admin sign-in is not set up yet, so changes are switched off.');
      user = await authenticate(request, env);
    } else if (accessConfigured && tokenFrom(request)) {
      try { user = await authenticate(request, env); } catch { user = null; } // a stale or foreign token just means "public visitor"
    }
    checkOrigin(request);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const db = env.DB;
    const method = request.method;

    if (parts[0] === 'session' && parts.length === 1 && method === 'GET') return json({ email: user?.email ?? null, expires: user?.exp ?? null, publicView, readOnly: publicView && !user, teamTagging: !!(await teamSetting(db)), setup: publicView && !accessConfigured ? setupHint(request) : null });

    // Admin only (every non-read outside the contact route requires the verified admin).
    if (parts[0] === 'settings' && parts[1] === 'team-passcode' && parts.length === 2 && method === 'PUT') {
      const passcode = String((await readJSON(request, 1024)).passcode ?? '');
      if (!passcode) {
        await db.prepare("DELETE FROM settings WHERE id = 'team'").run();
        return json({ teamTagging: false });
      }
      if (passcode.length < PASSCODE_MIN || passcode.length > PASSCODE_MAX) throw new HttpError(400, `The team passcode must be ${PASSCODE_MIN} to ${PASSCODE_MAX} characters.`);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await db.prepare("INSERT INTO settings (id, data) VALUES ('team', ?1) ON CONFLICT(id) DO UPDATE SET data = excluded.data").bind(JSON.stringify({ salt, hash: await hashPasscode(salt, passcode) })).run();
      return json({ teamTagging: true });
    }

    if (parts[0] === 'sponsors' && parts.length === 1) {
      if (method === 'GET') return json({ records: await allSponsors(db) });
      if (method === 'POST') {
        const input = cleanRecord(await readJSON(request, LIMITS.body), { requireId: false });
        const existing = await allSponsors(db);
        const id = input.id || nextProspectId(existing);
        if (!ID.test(id)) throw new HttpError(400, 'Invalid Prospect ID.');
        if (existing.some(r => r.id === id)) throw new HttpError(409, 'That Prospect ID already exists.');
        input.data['Prospect ID'] = id;
        await db.prepare('INSERT INTO sponsors (id, company, data, version) VALUES (?1, ?2, ?3, 1)').bind(id, input.company, JSON.stringify(input.data)).run();
        return json({ record: { id, company: input.company, data: input.data, version: 1 } }, 201);
      }
    }

    if (parts[0] === 'sponsors' && parts.length === 2) {
      const id = parts[1];
      if (!ID.test(id)) throw new HttpError(400, 'Invalid Prospect ID.');
      if (method === 'PUT') {
        const input = cleanRecord({ ...(await readJSON(request, LIMITS.body)), id });
        if (input.version === null) throw new HttpError(400, 'Version is required.');
        const res = await db.prepare('UPDATE sponsors SET company = ?1, data = ?2, version = version + 1 WHERE id = ?3 AND version = ?4')
          .bind(input.company, JSON.stringify(input.data), id, input.version).run();
        if (!res.meta.changes) {
          const current = await db.prepare('SELECT id, company, data, version FROM sponsors WHERE id = ?1').bind(id).first();
          if (!current) throw new HttpError(404, 'Prospect not found.');
          return json({ error: 'This prospect changed elsewhere. Reload it before saving.', record: row(current) }, 409);
        }
        return json({ record: { id, company: input.company, data: input.data, version: input.version + 1 } });
      }
      if (method === 'DELETE') {
        const version = Number(url.searchParams.get('version'));
        const res = await db.prepare('DELETE FROM sponsors WHERE id = ?1 AND version = ?2').bind(id, version).run();
        if (!res.meta.changes) throw new HttpError(409, 'Prospect not found or changed elsewhere. Reload and try again.');
        return json({ ok: true });
      }
    }

    if ((parts[0] === 'sponsors' || parts[0] === 'members') && parts.length === 3 && parts[2] === 'contact' && method === 'POST') {
      if (!ID.test(parts[1])) throw new HttpError(400, 'Invalid ID.');
      if (!user) await checkTeamPasscode(db, request);
      const body = await readJSON(request, 1024);
      const status = typeof body?.status === 'string' ? body.status.trim() : null;
      if (status === null || !CONTACT_LEVELS.includes(status)) throw new HttpError(400, 'Contact status must be 1st Contact, 2nd Contact, 3rd Contact or empty.');
      return json({ record: await setContact(db, parts[0], parts[1], status) });
    }

    if (parts[0] === 'members' && parts.length === 1) {
      if (method === 'GET') return json({ records: await allMembers(db, !!user), leadsVisible: !!user });
      if (method === 'POST') {
        const input = cleanMember(await readJSON(request, LIMITS.body));
        const id = await nextMemberId(db, input.kind);
        input.data.ID = id;
        await db.prepare('INSERT INTO members (id, kind, name, data, version) VALUES (?1, ?2, ?3, ?4, 1)').bind(id, input.kind, input.name, JSON.stringify(input.data)).run();
        return json({ record: { id, kind: input.kind, name: input.name, data: input.data, version: 1 } }, 201);
      }
    }

    if (parts[0] === 'members' && parts.length === 2) {
      const id = parts[1];
      if (!ID.test(id)) throw new HttpError(400, 'Invalid ID.');
      if (method === 'PUT') {
        const input = cleanMember(await readJSON(request, LIMITS.body));
        if (input.version === null) throw new HttpError(400, 'Version is required.');
        input.data.ID = id;
        const res = await db.prepare('UPDATE members SET kind = ?1, name = ?2, data = ?3, version = version + 1 WHERE id = ?4 AND version = ?5')
          .bind(input.kind, input.name, JSON.stringify(input.data), id, input.version).run();
        if (!res.meta.changes) {
          const current = await db.prepare('SELECT id, kind, name, data, version FROM members WHERE id = ?1').bind(id).first();
          if (!current) throw new HttpError(404, 'Record not found.');
          return json({ error: 'This record changed elsewhere. Reload it before saving.', record: memberRow(current) }, 409);
        }
        return json({ record: { id, kind: input.kind, name: input.name, data: input.data, version: input.version + 1 } });
      }
      if (method === 'DELETE') {
        const version = Number(url.searchParams.get('version'));
        const res = await db.prepare('DELETE FROM members WHERE id = ?1 AND version = ?2').bind(id, version).run();
        if (!res.meta.changes) throw new HttpError(409, 'Record not found or changed elsewhere. Reload and try again.');
        return json({ ok: true });
      }
    }

    if (parts[0] === 'import' && parts.length === 1 && method === 'POST') {
      const body = await readJSON(request, LIMITS.importBody);
      if (!Array.isArray(body.records) || !body.records.length || body.records.length > LIMITS.importRecords) throw new HttpError(400, 'Nothing to import.');
      const records = body.records.map(r => cleanRecord(r));
      if (new Set(records.map(r => r.id)).size !== records.length) throw new HttpError(400, 'Duplicate Prospect IDs in import.');
      const current = new Map((await allSponsors(db)).map(r => [r.id, r]));
      for (const r of records) {
        const have = current.get(r.id);
        if (r.version === null && have) throw new HttpError(409, `Prospect ${r.id} already exists. Review the import again.`);
        if (r.version !== null && (!have || have.version !== r.version)) throw new HttpError(409, `Prospect ${r.id} changed since the import was reviewed. Review the import again.`);
      }
      // D1 batches run as a single transaction: all rows apply, or none do.
      await db.batch(records.map(r => r.version === null
        ? db.prepare('INSERT INTO sponsors (id, company, data, version) VALUES (?1, ?2, ?3, 1)').bind(r.id, r.company, JSON.stringify(r.data))
        : db.prepare('UPDATE sponsors SET company = ?1, data = ?2, version = version + 1 WHERE id = ?3 AND version = ?4').bind(r.company, JSON.stringify(r.data), r.id, r.version)));
      return json({ records: await allSponsors(db), imported: records.length });
    }

    if (parts[0] === 'settings' && parts[1] === 'brief' && parts.length === 2) {
      if (method === 'GET') {
        const r = await db.prepare("SELECT data FROM settings WHERE id = 'brief'").first();
        return json({ brief: r ? JSON.parse(r.data) : null });
      }
      if (method === 'PUT') {
        const input = cleanData((await readJSON(request, LIMITS.body)).brief);
        const brief = Object.fromEntries(BRIEF_KEYS.map(k => [k, input[k] || '']));
        await db.prepare("INSERT INTO settings (id, data) VALUES ('brief', ?1) ON CONFLICT(id) DO UPDATE SET data = excluded.data").bind(JSON.stringify(brief)).run();
        return json({ brief });
      }
    }

    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('api error', err?.message);
    return json({ error: 'Something went wrong. Your changes were not saved.' }, 500);
  }
}
