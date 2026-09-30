// Copies only the public frontend into dist/. Functions are built by Pages from functions/.
import { mkdir, copyFile, rm } from 'node:fs/promises';

const files = ['index.html', 'style.css', 'app.js', 'core.js', '_headers', 'robots.txt'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await copyFile(file, 'dist/' + file);
console.log(`Built ${files.length} files into dist/`);
