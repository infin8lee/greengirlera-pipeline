import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, tokenFrom, clearKeyCache } from '../server/auth.js';
import { fakeIssuer } from './helpers.mjs';

const issuer = await fakeIssuer();
const opts = (extra = {}) => ({ teamDomain: issuer.team, aud: issuer.aud, fetchImpl: issuer.fetchImpl, ...extra });

test('accepts a valid admin token', async () => {
  clearKeyCache();
  const out = await verifyAccessJwt(await issuer.sign(), opts());
  assert.equal(out.email, 'lee@virtual-lee.com');
});

test('email match is case-insensitive but exact', async () => {
  await verifyAccessJwt(await issuer.sign({ email: 'Lee@Virtual-Lee.com' }), opts());
  await assert.rejects(verifyAccessJwt(await issuer.sign({ email: 'lee@virtual-lee.com.example.com' }), opts()), /Not the admin/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ email: 'someone@example.com' }), opts()), /Not the admin/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ email: undefined }), opts()), /Not the admin/);
});

test('rejects expired, future, wrong audience and wrong issuer tokens', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ exp: now - 120 }), opts()), /expired/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ nbf: now + 600 }), opts()), /not yet/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ aud: ['other'] }), opts()), /audience/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({ iss: 'https://evil.example.com' }), opts()), /issuer/);
});

test('rejects forged signatures, unknown keys, alg none and garbage', async () => {
  const other = await fakeIssuer();
  await assert.rejects(verifyAccessJwt(await other.sign(), opts()), /Bad signature/);
  await assert.rejects(verifyAccessJwt(await issuer.sign({}, { kid: 'nope' }), opts()), /Unknown signing key/);
  const [h, p] = (await issuer.sign()).split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url') + '.' + p + '.x';
  await assert.rejects(verifyAccessJwt(none, opts()), /Unsupported/);
  await assert.rejects(verifyAccessJwt(h + '.' + p, opts()), /Malformed/);
  await assert.rejects(verifyAccessJwt('', opts()), /Malformed/);
  await assert.rejects(verifyAccessJwt(await issuer.sign(), opts({ aud: '' })), /not configured/);
});

test('token is read from the Access header, then the Access cookie', () => {
  assert.equal(tokenFrom(new Request('https://x.test', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } })), 'a.b.c');
  assert.equal(tokenFrom(new Request('https://x.test', { headers: { cookie: 'x=1; CF_Authorization=d.e.f' } })), 'd.e.f');
  assert.equal(tokenFrom(new Request('https://x.test')), '');
});
