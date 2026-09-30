// Guards the public repository and build output against private data and secrets.
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const problems = [];
let tracked = [];
try { tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* not a git checkout */ }
const dist = (await readdir('dist')).map(f => join('dist', f));
const allowedEmails = new Set(['lee@virtual-lee.com']);
const testFiles = /^tests\//;

for (const file of [...new Set([...tracked, ...dist])]) {
  if (/\.csv$/i.test(file) || /private-import|\.dev\.vars|(^|\/)\.env/.test(file)) problems.push(`${file}: private file type must not be published`);
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !testFiles.test(file)) problems.push(`${file}: contains a private key`);
  if (/\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/.test(text)) problems.push(`${file}: contains an API key`);
  if (/\bGGE-0\d\d\b/.test(text) && !/^(core\.js|tests\/|README\.md)/.test(file)) problems.push(`${file}: contains a real Prospect ID`);
  for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
    if (!allowedEmails.has(email.toLowerCase()) && !/[@.]example\.(com|org)$/i.test(email) && !/noreply@anthropic\.com/.test(email)) problems.push(`${file}: contains email ${email}`);
  }
}
if (problems.length) { console.error('Public safety check failed:\n' + problems.join('\n')); process.exit(1); }
console.log(`Public safety check passed (${tracked.length} tracked files, ${dist.length} build files).`);
