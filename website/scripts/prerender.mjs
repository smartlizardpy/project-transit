// Writes the rendered page into dist/index.html so it shows (and is indexable) before any
// script runs. GitHub Pages then serves plain static files.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { render } = await import(pathToFileURL(join(root, 'dist-ssr/entry-server.js')).href);
const file = join(root, 'dist/index.html');
const html = readFileSync(file, 'utf8');
if (!html.includes('<!--app-->')) throw new Error('dist/index.html has no <!--app--> placeholder');
writeFileSync(file, html.replace('<!--app-->', render()));
rmSync(join(root, 'dist-ssr'), { recursive: true, force: true });
console.log('prerendered dist/index.html');
