import { OFM_TILEJSON } from '../geo/tiles.ts';
import bundled from '../data/bundledTiles.json';

let template: Promise<string> | null = null;

/** Resolve the versioned OpenFreeMap tile URL template once per session. */
export function tileTemplate(): Promise<string> {
  if (!template) {
    template = fetch(OFM_TILEJSON)
      .then((r) => r.json())
      .then((j: { tiles: string[] }) => j.tiles[0])
      .catch(() => 'https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf');
  }
  return template;
}

const bundledSet = new Set<string>((bundled as { tiles: string[] }).tiles);

/** Candidate URLs for a tile: a bundled offline copy first (demo area), then the network. */
export async function tileUrls(z: number, x: number, y: number): Promise<string[]> {
  const remote = (await tileTemplate()).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const key = `${z}/${x}/${y}`;
  const base = new URL(import.meta.env.BASE_URL, self.location.href);
  return bundledSet.has(key) ? [new URL(`tiles/${key}.pbf`, base).href, remote] : [remote];
}

export function isBundled(z: number, x: number, y: number): boolean {
  return bundledSet.has(`${z}/${x}/${y}`);
}
