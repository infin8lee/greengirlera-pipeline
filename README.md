# Green Girl Era · Sponsor Studio

A private sponsor CRM for [Green Girl Era](https://greengirlera.com): searchable pipeline, stage board, editable sponsor profiles, personalized initial and follow-up drafts, a data-based draft composer, pitch brief, and CSV import/export. There are no pipeline date or time fields.

This repository is public **source code only**. Sponsor records and drafts live in a private Cloudflare D1 database behind Cloudflare Access. The original CSVs are never committed (`*.csv` is ignored and `npm run check` fails if one is tracked).

## How it fits together

| Piece | Where |
| --- | --- |
| Frontend (`index.html`, `app.js`, `core.js`, `style.css`) | Cloudflare Pages, built to `dist/` |
| API (`functions/api/[[path]].js` → `server/api.js`) | Pages Functions, same origin at `/api/*` |
| Data | Cloudflare D1 database `greengirlera-crm` (binding `DB`, see `wrangler.toml`) |
| Login | Cloudflare Access, **One-time PIN** sent by email, policy allows only `lee@virtual-lee.com` |

Security layers:

1. Cloudflare Access sits in front of the whole site. Entering an email sends a real one-time code to that inbox, and the code must be entered before anything loads. Access only sends codes to emails allowed by the policy.
2. Every `/api/*` request is independently verified in `server/auth.js`: the Access JWT's RS256 signature (against your team's published keys), issuer, audience (`ACCESS_AUD`), expiry, and the exact admin email. The API fails closed (503) if configuration is missing, and returns 401/403 for missing, expired, forged or non-admin tokens.
3. Writes also require a same-origin `Origin` header and a JSON body. Edits carry a version number, so a stale tab cannot silently overwrite newer changes. Imports run as one transaction.
4. No secrets exist in this codebase. Session length is set in Access (for example 24 hours); after it expires the app asks you to sign in again.

## Cloudflare setup (one time)

1. **Pages project.** In Workers & Pages, choose Create, then Pages, then Connect to Git, and pick `infin8lee/greengirlera-pipeline`. Set the build command to `npm run build` and the output directory to `dist`, with no framework preset. The D1 binding comes from `wrangler.toml`.
2. **Access application.** In Zero Trust, go to Access, then Applications, and add a Self-hosted app:
   - Domains: `greengirlera.virtual-lee.com`, plus `greengirlera-pipeline.pages.dev` and `*.greengirlera-pipeline.pages.dev`.
   - Policy: Allow, Include, Emails, `lee@virtual-lee.com`.
   - Login method: One-time PIN.
   - Session duration: your choice (24h recommended).
   - Copy the application's **Audience (AUD) tag**, and note your team domain, `https://<team>.cloudflareaccess.com`.
3. **Pages variables.** In the Pages project, under Settings, Variables and Secrets, add both of these for Production and Preview, then redeploy:
   - `ACCESS_TEAM_DOMAIN` = `https://<team>.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag
4. **Custom domain.** In the Pages project, under Custom domains, add `greengirlera.virtual-lee.com`. The DNS record is created automatically because the zone is on the same account.
5. **Database schema.** Run `npx wrangler d1 migrations apply greengirlera-crm --remote`. This is already applied to the current database.

## Admin guide

1. Open https://greengirlera.virtual-lee.com, enter `lee@virtual-lee.com`, and type the code from your inbox.
2. **First load only:** click Import CSV and choose `Green_Girl_Era_Sponsor_Pipeline.csv`, review, and confirm. Then import `Green_Girl_Era_Personalized_Outreach.csv`, which joins on Prospect ID.
   - *Fill empty fields only* (the default) never overwrites values you already have.
   - *Replace with CSV values* is an explicit choice.
3. Click a prospect to edit Overview, Pitch studio, Research & sources, or All fields (every column). You're warned before closing with unsaved changes.
4. **Pitch studio:** edit and copy the subject, body, follow-up subject and follow-up body. *Compose suggestion* builds a new draft from the prospect's saved facts and your Pitch brief, in your browser, with no AI service or outside API. It shows placeholders for anything unconfirmed. It only replaces your draft after you choose *Use in editor*, and only saves when you click Save. **Nothing is ever emailed from the app.**
5. **Export CSV** downloads every record and column, including drafts. Treat the file as private.

## Development

Node 22+. No runtime dependencies.

```sh
npm run check     # syntax, unit + API tests, build, public-data guard
npm run build     # dist/
npx wrangler pages dev --binding ACCESS_TEAM_DOMAIN=... --binding ACCESS_AUD=...   # local, with local D1
```

`scripts/seed-sql.mjs` can build a private seed SQL file from the two CSVs (it refuses to write inside the repo), for `wrangler d1 execute greengirlera-crm --remote --file <outside-repo.sql>`.

Brand colors and fonts are CSS variables at the top of `style.css`.
