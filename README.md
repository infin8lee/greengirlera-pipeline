# Green Girl Era · Sponsor Studio

A private sponsor CRM for [Green Girl Era](https://greengirlera.com): searchable pipeline, stage board, editable sponsor profiles, personalized initial and follow-up drafts, a data-based draft composer, pitch brief, and CSV import/export. There are no pipeline date or time fields.

This repository is public **source code only**. Sponsor records and drafts live in a private Cloudflare D1 database behind Cloudflare Access. The original CSVs are never committed (`*.csv` is ignored and `npm run check` fails if one is tracked).

## How it fits together

| Piece | Where |
| --- | --- |
| Frontend (`index.html`, `app.js`, `core.js`, `style.css`) | Cloudflare Worker static assets, built to `dist/` |
| API (`src/worker.js` → `server/api.js`) | Same Worker, same origin at `/api/*` |
| Data | Cloudflare D1 database `greengirlera-crm` (binding `DB`, see `wrangler.toml`) |
| Login | Cloudflare Access, **One-time PIN** sent by email, policy allows only `lee@virtual-lee.com` |

Security layers:

1. Cloudflare Access sits in front of the whole site. Entering an email sends a real one-time code to that inbox, and the code must be entered before anything loads. Access only sends codes to emails allowed by the policy.
2. Every `/api/*` request is independently verified in `server/auth.js`: the Access JWT's RS256 signature (against your team's published keys), issuer, audience (`ACCESS_AUD`), expiry, and the exact admin email. The API fails closed (503) if configuration is missing, and returns 401/403 for missing, expired, forged or non-admin tokens.
3. Writes also require a same-origin `Origin` header and a JSON body. Edits carry a version number, so a stale tab cannot silently overwrite newer changes. Imports run as one transaction.
4. No secrets exist in this codebase. Session length is set in Access (for example 24 hours); after it expires the app asks you to sign in again.

## Cloudflare setup (one time)

The project is the Worker **greengirlera-pipeline** connected to this repository with Workers Builds.

1. **Build settings** (Worker, then Settings, then Builds): build command `npm run build`, deploy command `npx wrangler deploy`, branch `main`. The D1 binding and static assets come from `wrangler.toml`.
2. **Access policy** (Worker, then Access tab, then Manage Cloudflare Access, or Zero Trust, then Access, then Applications):
   - Policy: Allow, Include, Emails, `lee@virtual-lee.com`. Codes are only emailed to addresses the policy allows.
   - Login method: One-time PIN.
   - Protect both `greengirlera-pipeline.<subdomain>.workers.dev` and `greengirlera.virtual-lee.com`.
   - Copy the application's **Audience (AUD) tag** and note your team domain, `https://<team>.cloudflareaccess.com`.
3. **Worker variables** (Settings, then Variables and Secrets): add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. `keep_vars = true` keeps them across deploys.
4. **Custom domain** (Worker, then Domains): add `greengirlera.virtual-lee.com`. DNS and HTTPS are set up automatically.
5. **Database schema:** run `npx wrangler d1 migrations apply greengirlera-crm --remote`. This is already applied.

## Admin guide

1. Open https://greengirlera.virtual-lee.com, enter `lee@virtual-lee.com`, and type the code from your inbox.
2. **First load only:** click Import CSV and choose `Green_Girl_Era_Sponsor_Pipeline.csv`, review, and confirm. Then import `Green_Girl_Era_Personalized_Outreach.csv`, which joins on Prospect ID.
   - *Fill empty fields only* (the default) never overwrites values you already have.
   - *Replace with CSV values* is an explicit choice.
3. **Sponsors** (the home screen) is a lookbook. Pick a sponsor on the left, filtering by category or market chips or by search, to see:
   - **Who they are:** why they fit, what to ask for, who to reach, how to reach them, the next step, cautions and research links.
   - **Your sponsorship email:** the tailored request and follow-up. They're editable in place, with Copy email, Copy subject, Copy body and Open in my email app buttons, plus a draft status. Sponsors that only accept forms or portals link straight to their form.
   - **Suggest a rewrite:** builds a fresh version from the sponsor's saved facts and your Pitch brief, in your browser, with no AI or outside service. It only replaces the email after you choose *Use this version*.
   - **Tracking & notes, Research details, Every field:** edit any stored column. A save bar appears whenever something changes (Ctrl/Cmd+S also saves), and you're warned before leaving with unsaved edits.
4. **Pipeline** and **Stages** give the at-a-glance table, totals and stage board. Any row opens that sponsor. **Nothing is ever emailed from the app.**
5. **Export CSV** downloads every record and column, including drafts. Treat the file as private.

## Development

Node 22+. No runtime dependencies.

```sh
npm run check     # syntax, unit + API tests, build, public-data guard
npm run build     # dist/
npx wrangler dev --var ACCESS_TEAM_DOMAIN:... --var ACCESS_AUD:...   # local, with local D1
```

`scripts/seed-sql.mjs` can build a private seed SQL file from the two CSVs (it refuses to write inside the repo), for `wrangler d1 execute greengirlera-crm --remote --file <outside-repo.sql>`.

Brand colors and fonts are CSS variables at the top of `style.css`.
