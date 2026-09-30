// Test helpers: a D1-compatible wrapper over node:sqlite and a fake Access issuer.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => db.prepare(sql).run(...params)
  });
  // D1 numbered params (?1) are supported by SQLite directly.
  return {
    raw: db,
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec('BEGIN');
      try { const out = list.map(s => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}

const b64u = buf => Buffer.from(buf).toString('base64url');

export async function fakeIssuer(team = 'https://team.example.com') {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256' };
  const certs = { keys: [jwk] };
  const fetchImpl = async url => {
    if (url !== team + '/cdn-cgi/access/certs') return new Response('no', { status: 404 });
    return new Response(JSON.stringify(certs), { headers: { 'content-type': 'application/json' } });
  };
  async function sign(claims = {}, { kid = 'k1', alg = 'RS256', key = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: team, aud: ['aud-123'], email: 'lee@virtual-lee.com', sub: 'user-1', iat: now, nbf: now, exp: now + 3600, type: 'app', ...claims };
    const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
    return head + '.' + b64u(sig);
  }
  return { team, aud: 'aud-123', fetchImpl, sign, certs };
}
