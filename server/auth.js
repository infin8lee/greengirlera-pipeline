// Cloudflare Access JWT verification for Pages Functions (WebCrypto only).
// Access performs the email one-time-PIN login; every API request is still
// verified here: signature, issuer, audience, expiry and the exact admin email.

import { ADMIN } from '../core.js';

const b64urlBytes = s => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJSON = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

const cache = new Map(); // certsUrl -> { keys, fetchedAt }
const CACHE_MS = 10 * 60 * 1000;

async function loadKeys(certsUrl, fetchImpl, force = false) {
  const hit = cache.get(certsUrl);
  if (hit && !force && Date.now() - hit.fetchedAt < CACHE_MS) return hit.keys;
  const res = await fetchImpl(certsUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw Error('Unable to load Access signing keys');
  const { keys } = await res.json();
  if (!Array.isArray(keys)) throw Error('Invalid Access signing keys');
  cache.set(certsUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

export function clearKeyCache() { cache.clear(); }

export function tokenFrom(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Verify an Access application token. Throws on any failure.
 * @returns {Promise<{email:string, sub:string, exp:number}>}
 */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  if (!teamDomain || !aud) throw Error('Access is not configured');
  const issuer = teamDomain.replace(/\/+$/, '');
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw Error('Malformed token');
  const header = b64urlJSON(parts[0]);
  const payload = b64urlJSON(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('Unsupported token');

  const certsUrl = issuer + '/cdn-cgi/access/certs';
  let keys = await loadKeys(certsUrl, fetchImpl);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await loadKeys(certsUrl, fetchImpl, true); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk || jwk.kty !== 'RSA') throw Error('Unknown signing key');

  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!valid) throw Error('Bad signature');

  const seconds = Math.floor(now / 1000), skew = 60;
  if (payload.iss !== issuer) throw Error('Wrong issuer');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) throw Error('Wrong audience');
  if (typeof payload.exp !== 'number' || payload.exp < seconds - skew) throw Error('Session expired');
  if (typeof payload.nbf === 'number' && payload.nbf > seconds + skew) throw Error('Token not yet valid');
  if (typeof payload.email !== 'string' || payload.email.trim().toLowerCase() !== ADMIN) throw Error('Not the admin');
  return { email: ADMIN, sub: String(payload.sub || ''), exp: payload.exp };
}
