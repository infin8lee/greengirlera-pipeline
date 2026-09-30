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
