import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../server/api.js';
import { fakeD1, fakeIssuer } from './helpers.mjs';

const issuer = await fakeIssuer();
const ORIGIN = 'https://crm.example.com';
const setup = () => ({ DB: fakeD1(), ACCESS_TEAM_DOMAIN: issuer.team, ACCESS_AUD: issuer.aud, __fetch: issuer.fetchImpl });

async function call(env, path, { method = 'GET', body, token, origin = ORIGIN, type = 'application/json' } = {}) {
  const headers = {};
  if (token !== null) headers['cf-access-jwt-assertion'] = token ?? await issuer.sign();
  if (body !== undefined) headers['content-type'] = type;
  if (origin && method !== 'GET') headers.origin = origin;
  const res = await handleApi(new Request(ORIGIN + '/api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('unauthenticated, unauthorized and misconfigured requests are refused before data access', async () => {
  const env = setup();
  await call(env, 'import', { method: 'POST', body: { records: [{ id: 'T-1', company: 'Secret Co', data: {} }] } });
  assert.equal((await call(env, 'sponsors', { token: null })).status, 401);
  const noAuth = await call(env, 'sponsors', { token: null });
  assert.doesNotMatch(JSON.stringify(noAuth.body), /Secret Co/);
  assert.equal((await call(env, 'sponsors', { token: 'a.b.c' })).status, 401);
  assert.equal((await call(env, 'sponsors', { token: await issuer.sign({ email: 'intruder@example.com' }) })).status, 403);
  assert.equal((await call(env, 'sponsors', { token: await issuer.sign({ exp: 1 }) })).status, 401);
  const forged = await (await fakeIssuer()).sign();
  assert.equal((await call(env, 'sponsors', { token: forged })).status, 401);
  assert.equal((await call({ ...env, ACCESS_AUD: '' }, 'sponsors')).status, 503);
  assert.equal((await call(env, 'sponsors', { method: 'PUT', body: {}, token: null })).status, 401);
  assert.equal((await call(env, 'settings/brief', { method: 'PUT', body: { brief: {} }, token: await issuer.sign({ email: 'x@example.com' }) })).status, 403);
});

test('cross-site and non-JSON writes are refused', async () => {
  const env = setup();
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: 'A', data: {} }, origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: 'A', data: {} }, origin: null })).status, 403);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: 'A', data: {} }, type: 'text/plain' })).status, 415);
});

test('create, read, update with version check, conflict and delete', async () => {
  const env = setup();
  const created = await call(env, 'sponsors', { method: 'POST', body: { company: 'Tea Co', data: { Stage: 'Prospect', Note: 'Line 1\nLine 2 “quoted”' } } });
  assert.equal(created.status, 201);
  assert.equal(created.body.record.id, 'GGE-001');
  const list = await call(env, 'sponsors');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.body.records[0].data.Note, 'Line 1\nLine 2 “quoted”');
  const upd = await call(env, 'sponsors/GGE-001', { method: 'PUT', body: { company: 'Tea Co', data: { Stage: 'Won', 'Confirmed cash (USD)': '1500' }, version: 1 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.record.version, 2);
  const stale = await call(env, 'sponsors/GGE-001', { method: 'PUT', body: { company: 'Tea Co', data: { Stage: 'Closed' }, version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.record.data.Stage, 'Won');
  assert.equal((await call(env, 'sponsors/GGE-001?version=1', { method: 'DELETE' })).status, 409);
  assert.equal((await call(env, 'sponsors/GGE-001?version=2', { method: 'DELETE' })).status, 200);
  assert.equal((await call(env, 'sponsors')).body.records.length, 0);
});

test('input validation', async () => {
  const env = setup();
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: '', data: {} } })).status, 400);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: 'A', data: { x: { nested: 1 } } } })).status, 400);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: { company: 'A', data: { x: 'y'.repeat(20001) } } })).status, 400);
  assert.equal((await call(env, 'sponsors/bad%20id', { method: 'PUT', body: { company: 'A', data: {}, version: 1 } })).status, 400);
  assert.equal((await call(env, 'nope')).status, 404);
});

test('import is atomic and refuses stale reviews', async () => {
  const env = setup();
  const ok = await call(env, 'import', { method: 'POST', body: { records: [{ id: 'T-1', company: 'One', data: { A: '1' }, version: null }, { id: 'T-2', company: 'Two', data: {}, version: null }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.records.length, 2);
  const again = await call(env, 'import', { method: 'POST', body: { records: [{ id: 'T-3', company: 'Three', data: {}, version: null }, { id: 'T-1', company: 'One', data: {}, version: null }] } });
  assert.equal(again.status, 409);
  assert.equal((await call(env, 'sponsors')).body.records.length, 2, 'nothing from the refused batch was written');
  const stale = await call(env, 'import', { method: 'POST', body: { records: [{ id: 'T-1', company: 'One', data: { A: '2' }, version: 7 }] } });
  assert.equal(stale.status, 409);
  const good = await call(env, 'import', { method: 'POST', body: { records: [{ id: 'T-1', company: 'One', data: { A: '2' }, version: 1 }] } });
  assert.equal(good.body.records.find(r => r.id === 'T-1').data.A, '2');
});

test('pitch brief saves only known fields', async () => {
  const env = setup();
  assert.equal((await call(env, 'settings/brief')).body.brief, null);
  const saved = await call(env, 'settings/brief', { method: 'PUT', body: { brief: { audience: 'Members', injected: 'x' } } });
  assert.equal(saved.body.brief.audience, 'Members');
  assert.ok(!('injected' in saved.body.brief));
  assert.equal((await call(env, 'settings/brief')).body.brief.audience, 'Members');
});

test('session endpoint confirms the admin identity', async () => {
  const out = await call(setup(), 'session');
  assert.equal(out.body.email, 'lee@virtual-lee.com');
});

test('unconfigured backend shows only the setup hint from a real Access token shape', async () => {
  const env = { DB: fakeD1() };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = b64({ alg: 'RS256' }) + '.' + b64({ iss: 'https://myteam.cloudflareaccess.com', aud: ['a'.repeat(64)], email: 'lee@virtual-lee.com' }) + '.sig';
  const out = await call(env, 'session', { token: tok });
  assert.equal(out.status, 503);
  assert.deepEqual(out.body.setup, { ACCESS_TEAM_DOMAIN: 'https://myteam.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) });
  const junk = await call(env, 'session', { token: b64({}) + '.' + b64({ iss: 'javascript:x', aud: '<b>' }) + '.s' });
  assert.equal(junk.body.setup, null);
  assert.equal((await call(env, 'sponsors', { token: null })).body.setup, null);
});

const body1 = { company: 'A', data: {} };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

test('public view mode: everyone can read, only a verified admin can change anything', async () => {
  const env = { ...setup(), AUTH_MODE: 'view' };
  const admin = await issuer.sign();
  const seed = await call(env, 'sponsors', { method: 'POST', body: { company: 'Seed Co', data: {} }, token: admin });
  assert.equal(seed.status, 201);
  const id = seed.body.record.id;

  // Public visitors can read.
  const list = await call(env, 'sponsors', { token: null });
  assert.equal(list.status, 200);
  assert.equal(list.body.records.length, 1);
  assert.equal((await call(env, 'settings/brief', { token: null })).status, 200);
  const anon = await call(env, 'session', { token: null });
  assert.deepEqual([anon.body.email, anon.body.publicView, anon.body.readOnly], [null, true, true]);

  // ...but every kind of change is refused, and nothing is altered.
  for (const [path, method, body] of [
    ['sponsors', 'POST', body1],
    ['sponsors/' + id, 'PUT', { company: 'Hacked', data: {}, version: 1 }],
    ['sponsors/' + id + '?version=1', 'DELETE', undefined],
    ['import', 'POST', { records: [{ id: 'T-9', company: 'X', data: {} }] }],
    ['settings/brief', 'PUT', { brief: { organization: 'x' } }]
  ]) {
    const res = await call(env, path, { method, body, token: null });
    assert.equal(res.status, 403, method + ' ' + path);
    assert.match(res.body.error, /view-only/);
  }
  const after = await call(env, 'sponsors', { token: null });
  assert.equal(after.body.records.length, 1);
  assert.equal(after.body.records[0].company, 'Seed Co');

  // Stale, forged and non-admin logins never grant edit rights.
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: await issuer.sign({ exp: 1 }) })).status, 401);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: await issuer.sign({ email: 'intruder@example.com' }) })).status, 403);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: await (await fakeIssuer()).sign() })).status, 401);
  // A bad token on a read just means "public visitor".
  const stale = await call(env, 'session', { token: await issuer.sign({ exp: 1 }) });
  assert.equal(stale.status, 200);
  assert.deepEqual([stale.body.email, stale.body.readOnly], [null, true]);

  // The verified admin can manage everything.
  const me = await call(env, 'session', { token: admin });
  assert.deepEqual([me.body.email, me.body.readOnly], ['lee@virtual-lee.com', false]);
  assert.equal((await call(env, 'sponsors/' + id, { method: 'PUT', body: { company: 'Seed Co 2', data: {}, version: 1 }, token: admin })).status, 200);
  assert.equal((await call(env, 'settings/brief', { method: 'PUT', body: { brief: { organization: 'Org' } }, token: admin })).status, 200);
  assert.equal((await call(env, 'sponsors/' + id + '?version=2', { method: 'DELETE', token: admin })).status, 200);
  // The same-origin rule still applies to the admin.
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: admin, origin: 'https://evil.example.com' })).status, 403);
});

test('public view mode before the admin login is configured: readable, changes refused, setup hint only for a token holder', async () => {
  const env = { DB: fakeD1(), AUTH_MODE: 'view' };
  assert.equal((await call(env, 'sponsors', { token: null })).status, 200);
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: null })).status, 403);
  const tok = b64({ alg: 'RS256' }) + '.' + b64({ iss: 'https://myteam.cloudflareaccess.com', aud: ['a'.repeat(64)], email: 'lee@virtual-lee.com' }) + '.sig';
  assert.equal((await call(env, 'sponsors', { method: 'POST', body: body1, token: tok })).status, 403);
  assert.deepEqual((await call(env, 'session', { token: tok })).body.setup, { ACCESS_TEAM_DOMAIN: 'https://myteam.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) });
  assert.equal((await call(env, 'session', { token: null })).body.setup, null);
  assert.equal((await call(env, 'session', { token: b64({}) + '.' + b64({ iss: 'javascript:x', aud: '<b>' }) + '.s' })).body.setup, null);
});

test('without AUTH_MODE=view the API still fails closed, and "open" is not a mode', async () => {
  assert.equal((await call({ DB: fakeD1() }, 'sponsors', { token: null })).status, 503);
  assert.equal((await call({ DB: fakeD1(), AUTH_MODE: 'open' }, 'sponsors', { token: null })).status, 503);
  assert.equal((await call({ DB: fakeD1(), AUTH_MODE: 'View' }, 'sponsors', { token: null })).status, 503);
  assert.equal((await call({ ...setup(), AUTH_MODE: 'open' }, 'sponsors', { token: null })).status, 401);
  assert.equal((await call(setup(), 'sponsors', { token: null })).status, 401);
  assert.equal((await call({ AUTH_MODE: 'view' }, 'sponsors', { token: null })).status, 503);
});

test('/admin only redirects to the app; the worker still routes /api to the API', async () => {
  const { default: worker } = await import('../src/worker.js');
  const env = { DB: fakeD1(), AUTH_MODE: 'view', ASSETS: { fetch: async () => new Response('asset') } };
  for (const path of ['/admin', '/admin/x']) {
    const res = await worker.fetch(new Request(ORIGIN + path), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  }
  assert.equal((await worker.fetch(new Request(ORIGIN + '/api/sponsors'), env)).status, 200);
  assert.equal(await (await worker.fetch(new Request(ORIGIN + '/'), env)).text(), 'asset');
});

test('membership: public visitors see channels only; leads are admin-only in every mode', async () => {
  const env = { ...setup(), AUTH_MODE: 'view' };
  const admin = await issuer.sign();
  const ch = await call(env, 'members', { method: 'POST', body: { kind: 'channel', name: 'Golf League', data: { Area: 'Philadelphia' } }, token: admin });
  assert.equal(ch.status, 201);
  assert.equal(ch.body.record.id, 'MC-001');
  const lead = await call(env, 'members', { method: 'POST', body: { kind: 'lead', name: 'Jane Private', data: { Email: 'jane@example.com' } }, token: admin });
  assert.equal(lead.body.record.id, 'ML-001');
  assert.equal((await call(env, 'members', { method: 'POST', body: { kind: 'lead', name: 'Second', data: {} }, token: admin })).body.record.id, 'ML-002');

  // Public, stale, forged and non-admin readers never receive a lead.
  for (const token of [null, await issuer.sign({ exp: 1 }), await issuer.sign({ email: 'intruder@example.com' }), await (await fakeIssuer()).sign()]) {
    const res = await call(env, 'members', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.records.map(r => r.kind), ['channel']);
    assert.equal(res.body.leadsVisible, false);
    assert.doesNotMatch(JSON.stringify(res.body), /Jane|jane@/);
  }
  // Sponsors never include membership records.
  assert.equal((await call(env, 'sponsors', { token: null })).body.records.length, 0);

  // The admin sees everything and can edit with version checks.
  const all = await call(env, 'members', { token: admin });
  assert.equal(all.body.records.length, 3);
  assert.equal(all.body.leadsVisible, true);
  assert.equal((await call(env, 'members/ML-001', { method: 'PUT', body: { kind: 'lead', name: 'Jane P', data: {}, version: 1 }, token: admin })).status, 200);
  assert.equal((await call(env, 'members/ML-001', { method: 'PUT', body: { kind: 'lead', name: 'Old', data: {}, version: 1 }, token: admin })).status, 409);

  // Changes are refused for anyone but the admin, and bad input is rejected.
  for (const [path, method, body] of [
    ['members', 'POST', { kind: 'lead', name: 'X', data: {} }],
    ['members/ML-001', 'PUT', { kind: 'lead', name: 'X', data: {}, version: 2 }],
    ['members/ML-001?version=2', 'DELETE', undefined]
  ]) assert.equal((await call(env, path, { method, body, token: null })).status, 403, method + ' ' + path);
  assert.equal((await call(env, 'members', { method: 'POST', body: { kind: 'sponsor', name: 'X', data: {} }, token: admin })).status, 400);
  assert.equal((await call(env, 'members', { method: 'POST', body: { kind: 'lead', name: '', data: {} }, token: admin })).status, 400);
  assert.equal((await call(env, 'members/ML-001?version=2', { method: 'DELETE', token: admin })).status, 200);

  // Outside public view mode, the whole membership API needs the admin login.
  const closed = { ...setup() };
  assert.equal((await call(closed, 'members', { token: null })).status, 401);
});
