// Builds a playable region off the main thread: fetches the vector tiles (bundled copy, local
// cache, then OpenFreeMap) and turns them into the road graph, demand grid and zones.

import { buildRegion, type TileInput } from '../game/world/regionBuilder.ts';
import type { RegionSpec } from '../game/world/region.ts';
import { tileUrls } from '../map/tileSource.ts';

const CACHE = 'pt-tiles-v1';

async function cached(url: string): Promise<ArrayBuffer | null> {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(url);
    return r ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function store(url: string, buf: ArrayBuffer) {
  try {
    const c = await caches.open(CACHE);
    await c.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/x-protobuf' } }));
  } catch {
    /* cache unavailable (private mode, non-secure context): fine */
  }
}

async function fetchTile(x: number, y: number): Promise<ArrayBuffer | null> {
  const urls = await tileUrls(14, x, y);
  for (const url of urls) {
    const hit = url.startsWith('http') && !url.includes(self.location.host) ? await cached(url) : null;
    if (hit) return hit;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 404 || r.status === 204) break;
        if (!r.ok) throw new Error(String(r.status));
        const buf = await r.arrayBuffer();
        if (url.startsWith('http') && !url.includes(self.location.host)) void store(url, buf);
        return buf;
      } catch {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
    }
  }
  return null;
}

export type RegionWorkerMessage =
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'done'; data: ReturnType<typeof buildRegion>; missing: number }
  | { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<{ spec: RegionSpec }>) => {
  const { spec } = e.data;
  const post = (m: RegionWorkerMessage) => (self as unknown as Worker).postMessage(m);
  try {
    const total = spec.tiles.length;
    let done = 0;
    post({ type: 'progress', stage: 'Downloading map data', done, total });
    const tiles: TileInput[] = await Promise.all(
      spec.tiles.map(async ([x, y]) => {
        const data = await fetchTile(x, y);
        post({ type: 'progress', stage: 'Downloading map data', done: ++done, total });
        return { x, y, data };
      }),
    );
    const missing = tiles.filter((t) => !t.data).length;
    if (missing === tiles.length) throw new Error('No map data could be downloaded. Check your internet connection, or start in İstanbul, which works offline.');
    const data = buildRegion(spec, tiles, (stage, d, t) => post({ type: 'progress', stage, done: d, total: t }));
    if (data.graph.n < 200) throw new Error('This area has too few drivable streets to run a bus company. Try somewhere more urban.');
    post({ type: 'done', data, missing });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
