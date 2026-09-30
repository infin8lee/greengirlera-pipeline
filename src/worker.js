// Cloudflare Worker entry: /api/* goes to the CRM API, everything else is served
// from the static frontend in dist/ (Workers Static Assets).
import { handleApi } from '../server/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
};
