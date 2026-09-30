// Builds a private D1 seed file from the two private CSVs, using the same import
// rules as the app (pipeline first, outreach second, joined by Prospect ID).
// Usage: node scripts/seed-sql.mjs <pipeline.csv> <outreach.csv> <output.sql>
// The output path must be outside this repository. Never commit it.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parseCSV, planImport } from '../core.js';

const [pipelinePath, outreachPath, outPath] = process.argv.slice(2);
if (!pipelinePath || !outreachPath || !outPath) {
  console.error('Usage: node scripts/seed-sql.mjs <pipeline.csv> <outreach.csv> <output.sql>');
  process.exit(1);
}
const repo = resolve(import.meta.dirname, '..');
if (!relative(repo, resolve(outPath)).startsWith('..')) {
  console.error('Refusing to write private seed data inside the repository.');
  process.exit(1);
}

const pipeline = parseCSV(await readFile(pipelinePath, 'utf8'));
const outreach = parseCSV(await readFile(outreachPath, 'utf8'));
const first = planImport([], pipeline, { mode: 'fill' });
if (first.kind !== 'pipeline') throw Error('First file must be the sponsor pipeline CSV.');
const records = first.creates.map(r => ({ ...r, version: 1 }));
const second = planImport(records, outreach, { mode: 'fill' });
if (second.kind !== 'outreach') throw Error('Second file must be the personalized outreach CSV.');
for (const u of second.updates) Object.assign(records.find(r => r.id === u.id), { data: u.data });

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const sql = records.map(r => `INSERT INTO sponsors (id, company, data, version) VALUES (${q(r.id)}, ${q(r.company)}, ${q(JSON.stringify(r.data))}, 1) ON CONFLICT(id) DO NOTHING;`).join('\n') + '\n';
await writeFile(outPath, sql, { mode: 0o600 });
console.log(`Wrote ${records.length} records (${second.updates.length} with drafts) to ${outPath}`);
for (const w of [...first.warnings, ...second.warnings]) console.log('note:', w);
