// Bakes the Istanbul demo area: downloads OpenFreeMap z14 tiles for offline use,
// builds a drivable road graph from the OpenMapTiles `transportation` layer,
// collects the real OSM bus stops from the `poi` layer and routes the
// demonstration bus lines along real streets.
//
// Run: node scripts/bake-istanbul.ts   (Node >= 23 strips TypeScript types natively)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipLine, mercXToLng, mercYToLat, OFM_TILEJSON } from '../src/geo/tiles.ts';
import { buildGraph, nearestNode, routeThrough, distanceM, type RoadGraph, CLASS_INDEX } from '../src/sim/roadGraph.ts';
import { DEMO_LINES } from '../src/sim/demoLines.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Z = 14;
const TX = [9509, 9512];
const TY = [6140, 6142];
// The routing graph only needs the playable core.
const BBOX = { w: 28.952, s: 41.006, e: 29.002, n: 41.042 };

const tilejson = (await (await fetch(OFM_TILEJSON)).json()) as { tiles: string[] };
const template = tilejson.tiles[0];
console.log('tiles from', template);

type Seg = { coords: [number, number][]; cls: string; oneway: number; bridge: boolean; name?: string };
const segs: Seg[] = [];
const bundled: string[] = [];
const rawStops: { name: string; at: [number, number] }[] = [];
const inBox = ([lng, lat]: [number, number]) => lng > BBOX.w && lng < BBOX.e && lat > BBOX.s && lat < BBOX.n;

for (let x = TX[0]; x <= TX[1]; x++) {
  for (let y = TY[0]; y <= TY[1]; y++) {
    const file = join(root, 'public', 'tiles', String(Z), String(x), `${y}.pbf`);
    let buf: Uint8Array;
    if (existsSync(file)) {
      buf = new Uint8Array(readFileSync(file));
    } else {
      const url = template.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y));
      buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
    }
    bundled.push(`${Z}/${x}/${y}`);
    const vt = new VectorTile(new PbfReader(buf));
    const P = vt.layers.poi;
    for (let i = 0; P && i < P.length; i++) {
      const f = P.feature(i);
      const p = f.properties as Record<string, string | number>;
      if (p.subclass !== 'bus_stop' || !p.name) continue;
      const pt = f.loadGeometry()[0][0];
      const at: [number, number] = [mercXToLng((x + pt.x / P.extent) / 2 ** Z), mercYToLat((y + pt.y / P.extent) / 2 ** Z)];
      if (inBox(at)) rawStops.push({ name: String(p['name:latin'] ?? p.name), at });
    }
    const L = vt.layers.transportation;
    if (!L) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      if (f.type !== 2) continue;
      const p = f.properties as Record<string, string | number | boolean>;
      const cls = String(p.class);
      if (!(cls in CLASS_INDEX)) continue;
      if (p.brunnel === 'tunnel') continue;
      if (p.service === 'parking_aisle' || p.service === 'driveway') continue;
      if (p.access === 'no') continue;
      for (const line of f.loadGeometry()) {
        for (const piece of clipLine(line, 0, L.extent)) {
          const coords = piece.map((pt) => {
            const lng = mercXToLng((x + pt.x / L.extent) / 2 ** Z);
            const lat = mercYToLat((y + pt.y / L.extent) / 2 ** Z);
            return [lng, lat] as [number, number];
          });
          if (!coords.some(([lng, lat]) => lng > BBOX.w && lng < BBOX.e && lat > BBOX.s && lat < BBOX.n)) continue;
          segs.push({ coords, cls, oneway: Number(p.oneway ?? 0), bridge: p.brunnel === 'bridge' });
        }
      }
    }
  }
}
console.log('segments', segs.length);

// ---- real bus stops (OSM). Merge the pair on either side of a street and numbered
// platforms ("Şişhane 1…6") into one stop, then pin each stop onto the nearest bus
// road by adding a vertex there, so buses halt right beside it.
const baseName = (n: string) => n.replace(/\s+\d+$/, '');
const norm = (n: string) => baseName(n).toLocaleLowerCase('tr').replace(/ı/g, 'i');
const clusters: { key: string; name: string; sum: [number, number]; n: number; at: [number, number] }[] = [];
for (const r of rawStops) {
  const key = norm(r.name);
  const c = clusters.find((c) => (c.key === key && distanceM(c.at, r.at) < 130) || distanceM(c.at, r.at) < 12);
  if (c) {
    c.sum[0] += r.at[0]; c.sum[1] += r.at[1]; c.n++;
    c.at = [c.sum[0] / c.n, c.sum[1] / c.n];
  } else clusters.push({ key, name: baseName(r.name), sum: [...r.at], n: 1, at: r.at });
}
const BUS_ROADS = new Set(Object.keys(CLASS_INDEX).filter((c) => c !== 'service' && c !== 'motorway'));
const kx = Math.cos((41.02 * Math.PI) / 180);
const pinned: { name: string; at: [number, number]; on: [number, number] }[] = [];
for (const c of clusters) {
  let best: { sg: Seg; i: number; t: number } | null = null;
  let bestD = 45;
  for (const sg of segs) {
    if (!BUS_ROADS.has(sg.cls)) continue;
    for (let i = 1; i < sg.coords.length; i++) {
      const a = sg.coords[i - 1], b = sg.coords[i];
      const ax = (a[0] - c.at[0]) * kx, ay = a[1] - c.at[1], dx = (b[0] - a[0]) * kx, dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-18)));
      const d = Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
      if (d < bestD) { bestD = d; best = { sg, i, t }; }
    }
  }
  if (!best) continue;
  const { sg, i, t } = best;
  const a = sg.coords[i - 1], b = sg.coords[i];
  const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let on = p;
  if (distanceM(p, a) < 5) on = a;
  else if (distanceM(p, b) < 5) on = b;
  else sg.coords.splice(i, 0, p);
  pinned.push({ name: c.name, at: c.at, on });
}
console.log('bus stops', rawStops.length, 'raw →', clusters.length, 'merged →', pinned.length, 'on a bus road');

const graph: RoadGraph = buildGraph(segs);
console.log('graph nodes', graph.nodes.length / 2, 'edges', graph.edges.length / 4);
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const stops = pinned
  .map((s) => ({ name: s.name, lngLat: [r6(s.at[0]), r6(s.at[1])] as [number, number], node: nearestNode(graph, s.on) }))
  .sort((a, b) => a.lngLat[0] - b.lngLat[0] || a.lngLat[1] - b.lngLat[1])
  .map((s, i) => ({ id: `O${i + 1}`, ...s }));

// ---- route the demonstration lines
const lines = DEMO_LINES.map((line) => {
  const stopNodes = line.stops.map((s) => nearestNode(graph, s.at, ['primary', 'secondary', 'tertiary', 'trunk', 'minor']));
  const viaNodes = new Map<number, number[]>();
  line.stops.forEach((s, i) => {
    if (s.via) viaNodes.set(i, s.via.map((v) => nearestNode(graph, v, ['primary', 'secondary', 'tertiary', 'trunk', 'minor'])));
  });
  const sequence: { node: number; stopIndex: number | null }[] = [];
  line.stops.forEach((_, i) => {
    sequence.push({ node: stopNodes[i], stopIndex: i });
    for (const v of viaNodes.get(i) ?? []) sequence.push({ node: v, stopIndex: null });
  });
  const routed = routeThrough(graph, sequence, true);
  if (!routed) throw new Error(`could not route ${line.id}`);
  const lengthM = routed.cumulative[routed.cumulative.length - 1];
  console.log(`${line.id}: ${routed.path.length} pts, ${(lengthM / 1000).toFixed(2)} km`);
  return {
    id: line.id,
    stops: line.stops.map((s, i) => ({
      name: s.name,
      lngLat: [graph.nodes[stopNodes[i] * 2], graph.nodes[stopNodes[i] * 2 + 1]],
      distance: Math.round(routed.stopDistances[i] * 10) / 10,
    })),
    path: routed.path.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]),
    length: Math.round(lengthM),
  };
});

const outDir = join(root, 'src', 'data', 'istanbul');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'lines.json'), JSON.stringify(lines));
writeFileSync(join(outDir, 'stops.json'), JSON.stringify(stops));
writeFileSync(
  join(outDir, 'graph.json'),
  JSON.stringify({
    nodes: Array.from(graph.nodes, (v) => Math.round(v * 1e6) / 1e6),
    edges: Array.from(graph.edges),
  }),
);
writeFileSync(join(root, 'src', 'data', 'bundledTiles.json'), JSON.stringify({ tiles: bundled }, null, 1));
console.log('wrote', outDir);
