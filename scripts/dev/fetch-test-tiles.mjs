// Download a few OpenFreeMap z14 vector tiles for route-diagnostics tests (free, no key).
// They go to a test-only folder, never to public/ (the game does not ship them).
//
//   node scripts/dev/fetch-test-tiles.mjs            Barcelona, El Born (the default)
//   node scripts/dev/fetch-test-tiles.mjs <lng> <lat> [cols] [rows]
//
// Tests that need them (src/game/test/diagnostics.test.ts) are skipped when they are absent.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'game', 'test', 'tiles');
const args = process.argv.slice(2).map(Number);
// El Born, Barcelona: Passeig de Picasso, Parc de la Ciutadella and the narrow one-way old town
const [lng, lat, cols, rows] = [args[0] || 2.181, args[1] || 41.386, args[2] || 3, args[3] || 3];

/** z14 tiles covering a box of cols × rows tiles around a point (same maths as tilesAround()) */
function tilesAround(c, cols, rows) {
  const n = 2 ** 14;
  const fx = ((c[0] + 180) / 360) * n;
  const s = Math.sin((c[1] * Math.PI) / 180);
  const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const x0 = Math.round(fx - cols / 2), y0 = Math.round(fy - rows / 2);
  const out = [];
  for (let y = y0; y < y0 + rows; y++) for (let x = x0; x < x0 + cols; x++) out.push([x, y]);
  return out;
}

const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const template = tj.tiles[0];
let added = 0, bytes = 0;
for (const [x, y] of tilesAround([lng, lat], cols, rows)) {
  const file = join(root, '14', String(x), `${y}.pbf`);
  if (existsSync(file)) continue;
  const r = await fetch(template.replace('{z}', '14').replace('{x}', x).replace('{y}', y));
  if (!r.ok) throw new Error(`14/${x}/${y}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  added++;
  bytes += buf.length;
  await new Promise((res) => setTimeout(res, 150)); // be gentle with the free service
}
console.log(`fetched ${added} tiles (${(bytes / 1e6).toFixed(1)} MB) into ${root}`);
