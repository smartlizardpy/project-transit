// Web-mercator tile maths shared by the renderer, the tile worker and the bake script.

export const EARTH_CIRCUMFERENCE = 40075016.686;
export const TILE_ZOOM = 14; // OpenFreeMap / OpenMapTiles max zoom with full building data

export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';

export function lngToMercX(lng: number): number {
  return (180 + lng) / 360;
}

export function latToMercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
}

export function mercXToLng(x: number): number {
  return x * 360 - 180;
}

export function mercYToLat(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

/** Mercator units per metre at a latitude (MapLibre's meterInMercatorCoordinateUnits). */
export function mercPerMeter(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180));
}

export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  return [Math.floor(lngToMercX(lng) * n), Math.floor(latToMercY(lat) * n)];
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Centre latitude of a tile. */
export function tileCenterLat(z: number, y: number): number {
  return mercYToLat((y + 0.5) / 2 ** z);
}

/** Metres per tile-extent unit, measured at the tile's centre latitude. */
export function tileUnitMeters(z: number, y: number, extent: number): number {
  return 1 / 2 ** z / extent / mercPerMeter(tileCenterLat(z, y));
}

/** Simple deterministic hash -> [0, 1). */
export function hash01(a: number, b: number, seed = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + seed * 374761393, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/** Signed area of a ring in tile/screen coordinates (y down). */
export function ringArea(ring: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return a / 2;
}

/** Split vector-tile rings into polygons (outer ring + holes), following the MVT winding rules. */
export function classifyRings<T extends { x: number; y: number }>(rings: T[][]): T[][][] {
  const polygons: T[][][] = [];
  let current: T[][] | undefined;
  let ccw: boolean | undefined;
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area === 0) continue;
    if (ccw === undefined) ccw = area < 0;
    if (ccw === area < 0) {
      current = [ring];
      polygons.push(current);
    } else if (current) {
      current.push(ring);
    }
  }
  return polygons;
}

/** Sutherland–Hodgman clip of a closed ring to an axis-aligned box. */
export function clipRing(ring: { x: number; y: number }[], min: number, max: number): { x: number; y: number }[] {
  type P = { x: number; y: number };
  let out: P[] = ring.slice();
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= min, (a, b) => ({ x: min, y: a.y + ((b.y - a.y) * (min - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= max, (a, b) => ({ x: max, y: a.y + ((b.y - a.y) * (max - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= min, (a, b) => ({ x: a.x + ((b.x - a.x) * (min - a.y)) / (b.y - a.y), y: min })],
    [(p) => p.y <= max, (a, b) => ({ x: a.x + ((b.x - a.x) * (max - a.y)) / (b.y - a.y), y: max })],
  ];
  for (const [inside, cut] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cut(prev, cur));
      }
    }
  }
  return out;
}

/** Liang–Barsky clip of a polyline to a box; returns zero or more pieces. */
export function clipLine<T extends { x: number; y: number }>(line: T[], min: number, max: number): { x: number; y: number }[][] {
  const pieces: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - min, max - a.x, a.y - min, max - a.y];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) ok = false;
      } else {
        const r = q[k] / p[k];
        if (p[k] < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
      continue;
    }
    const s = { x: a.x + t0 * dx, y: a.y + t0 * dy };
    const e = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    if (cur.length === 0) cur.push(s);
    cur.push(e);
    if (t1 < 1) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

export function pointInRing(x: number, y: number, ring: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
