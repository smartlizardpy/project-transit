// Bundle OpenFreeMap vector tiles for an offline starting city (free, no key).
// Downloads any missing z14 tiles in an x/y range into public/tiles/14 and lists them in
// src/data/bundledTiles.json. Existing tiles are kept as they are.
// Usage: node scripts/bundle-tiles.mjs <x0> <x1> <y0> <y1>     e.g. 9508 9513 6138 6142
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [x0, x1, y0, y1] = process.argv.slice(2).map(Number);
if ([x0, x1, y0, y1].some((v) => !Number.isFinite(v))) throw new Error('usage: bundle-tiles.mjs x0 x1 y0 y1');
const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const template = tj.tiles[0];
const listFile = 'src/data/bundledTiles.json';
const list = new Set(JSON.parse(readFileSync(listFile, 'utf8')).tiles);
let added = 0, bytes = 0;
for (let x = x0; x <= x1; x++)
  for (let y = y0; y <= y1; y++) {
    const key = `14/${x}/${y}`;
    const file = `public/tiles/${key}.pbf`;
    if (!existsSync(file)) {
      const r = await fetch(template.replace('{z}', '14').replace('{x}', x).replace('{y}', y));
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      mkdirSync(`public/tiles/14/${x}`, { recursive: true });
      writeFileSync(file, buf);
      added++;
      bytes += buf.length;
      await new Promise((res) => setTimeout(res, 150)); // be gentle with the free service
    }
    list.add(key);
  }
writeFileSync(listFile, JSON.stringify({ tiles: [...list].sort() }, null, 1) + '\n');
console.log(`added ${added} tiles (${(bytes / 1e6).toFixed(1)} MB); ${list.size} bundled in total`);
