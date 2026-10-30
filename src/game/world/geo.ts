// Geographic lookups over a loaded region: zones, street names, real stop names, places.

import { buildIndex, projector, type LngLat } from './graph.ts';
import type { Poi, Region, RegionData, Zone } from './region.ts';
import { tileAt, zoneTile } from './zoneTiles.ts';

export class Geo {
  readonly P: ReturnType<typeof projector>;
  private zoneSeeds: { z: Zone; x: number; y: number }[];
  private zoneByTile = new Map<string, Zone>();
  private streetGrid = new Map<number, number[]>();
  private stopXY: { name: string; x: number; y: number }[];
  private poiXY: { p: Poi; x: number; y: number }[];

  readonly region: Region;

  constructor(region: Region) {
    this.region = region;
    this.P = projector(region.spec.centre);
    for (const z of region.zones) {
      const t = zoneTile(z.id);
      if (t) this.zoneByTile.set(`${t[0]},${t[1]}`, z);
    }
    this.zoneSeeds = region.zones.map((z) => {
      const [x, y] = this.P.toXY(z.seed[0], z.seed[1]);
      return { z, x, y };
    });
    region.streets.forEach((st, i) => {
      for (let k = 0; k + 1 < st.pts.length; k += 2) {
        const key = this.cell(st.pts[k], st.pts[k + 1]);
        const l = this.streetGrid.get(key);
        if (l) {
          if (l[l.length - 1] !== i) l.push(i);
        } else this.streetGrid.set(key, [i]);
      }
    });
    this.stopXY = region.osmStops.map((s) => {
      const [x, y] = this.P.toXY(s.lngLat[0], s.lngLat[1]);
      return { name: s.name, x, y };
    });
    this.poiXY = region.pois.map((p) => {
      const [x, y] = this.P.toXY(p.lngLat[0], p.lngLat[1]);
      return { p, x, y };
    });
  }

  private cell(x: number, y: number) {
    return Math.floor(x / 80) * 73856093 + Math.floor(y / 80) * 19349663;
  }

  xy(ll: LngLat): [number, number] {
    return this.P.toXY(ll[0], ll[1]);
  }

  /** Operating area containing a point (its map tile; the nearest area outside the map). */
  zoneAt(ll: LngLat): Zone {
    const [tx, ty] = tileAt(ll);
    const hit = this.zoneByTile.get(`${tx},${ty}`);
    if (hit) return hit;
    const [x, y] = this.xy(ll);
    let best = this.zoneSeeds[0], bd = Infinity;
    for (const s of this.zoneSeeds) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best.z;
  }

  zone(id: string): Zone | undefined {
    return this.region.zones.find((z) => z.id === id);
  }

  inBounds(ll: LngLat, marginM = 0): boolean {
    const b = this.region.bounds;
    const m = marginM / 111000;
    return ll[0] > b.w + m && ll[0] < b.e - m && ll[1] > b.s + m && ll[1] < b.n - m;
  }

  streetNear(ll: LngLat, maxM = 45): string | null {
    const [x, y] = this.xy(ll);
    let best: string | null = null, bd = maxM;
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of this.streetGrid.get(this.cell(x + dx * 80, y + dy * 80)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const pts = this.region.streets[i].pts;
          for (let k = 0; k + 3 < pts.length; k += 2) {
            const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
            const ex = bx - ax, ey = by - ay;
            const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
            const d = Math.hypot(ax + t * ex - x, ay + t * ey - y);
            if (d < bd) {
              bd = d;
              best = this.region.streets[i].name;
            }
          }
        }
    return best;
  }

  osmStopNear(ll: LngLat, maxM = 70): string | null {
    const [x, y] = this.xy(ll);
    let best: string | null = null, bd = maxM;
    for (const s of this.stopXY) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = s.name;
      }
    }
    return best;
  }

  poisNear(ll: LngLat, maxM: number): { p: Poi; d: number }[] {
    const [x, y] = this.xy(ll);
    const out: { p: Poi; d: number }[] = [];
    for (const q of this.poiXY) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d <= maxM) out.push({ p: q.p, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }
}

/** Attach runtime indexes to freshly built or transferred region data. */
export function prepareRegion(data: RegionData): Region {
  return { ...data, index: buildIndex(data.graph) };
}
