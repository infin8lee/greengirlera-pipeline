// Cloudflare Worker entry: /api/* goes to the CRM API, everything else is served
// from the static frontend in dist/ (Workers Static Assets).
import { handleApi } from '../server/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env);
    // The admin door. A Cloudflare Access application protects this path; once the admin has
    // signed in, Access has set its login cookie, so send them back to the app. The route itself
    // grants nothing: the API verifies the login on every change.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
    return env.ASSETS.fetch(request);
  }
};
