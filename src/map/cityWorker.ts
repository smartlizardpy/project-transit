/// <reference lib="webworker" />
// Turns OpenMapTiles vector tiles into stylised miniature-city geometry:
// extruded buildings with inferred heights and hipped roofs, low-poly trees
// and soft tree shadows. Runs off the main thread.

import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { classifyRings, clipRing, hash01, mercXToLng, mercYToLat, pointInRing, tileUnitMeters } from '../geo/tiles.ts';
import { MeshBuilder, LIGHT_2D } from './meshBuilder.ts';
import { BUILDING_TOPS, ROOF_COLOURS, TREE, hexToRgb, pickWeighted } from './palette.ts';

type Pt = { x: number; y: number };
type RGB = [number, number, number];

export interface TileRequest {
  id: number;
  z: number;
  x: number;
  y: number;
  urls: string[];
}

export interface TileResult {
  id: number;
  key: string;
  ok: boolean;
  error?: string;
  solid?: { positions: Float32Array; colors: Uint8Array; count: number };
  shadows?: { positions: Float32Array; uvs: Float32Array; count: number };
  stats?: { buildings: number; inferred: number; trees: number; ms: number };
  /** building centroids [lng, lat, floorArea/1000] for the demand estimate */
  demand?: Float32Array;
}

const TOPS = BUILDING_TOPS.map(([c, w]) => [hexToRgb(c), w] as [RGB, number]);
const ROOFS = ROOF_COLOURS.map(([c, w]) => [hexToRgb(c), w] as [RGB, number]);
const TRUNK = hexToRgb(TREE.trunk);
const LEAFY = TREE.leafy.map(hexToRgb);
const CONIFER = TREE.conifer.map(hexToRgb);
const CYPRESS = TREE.cypress.map(hexToRgb);

const FLOOR = 3.15;

// ---------------------------------------------------------------- heights

function inferHeight(area: number, h: number, h2: number): number {
  // Conservative storey counts for a dense Mediterranean city centre when OSM has no height.
  let lo: number, hi: number;
  if (area < 22) { lo = 1; hi = 2; }
  else if (area < 70) { lo = 2; hi = 4; }
  else if (area < 380) { lo = 3; hi = 6; }
  else if (area < 1400) { lo = 3; hi = 5; }
  else { lo = 2; hi = 4; }
  let floors = lo + Math.floor(h * (hi - lo + 1));
  if (h2 > 0.93 && area > 120 && area < 1400) floors += 2; // the occasional taller block
  return floors * FLOOR + 0.6 + h2 * 0.8;
}

// ---------------------------------------------------------------- buildings

function signedArea(r: Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j].x * r[i].y - r[i].x * r[j].y;
  return s / 2;
}

function cleanRing(r: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of r) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.05 || Math.abs(last.y - p.y) > 0.05) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05) out.pop();
  }
  // drop nearly collinear points
  const res: Pt[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[(i + out.length - 1) % out.length], c = out[i], n = out[(i + 1) % out.length];
    const cross = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x);
    const len = Math.hypot(c.x - p.x, c.y - p.y) * Math.hypot(n.x - c.x, n.y - c.y);
    if (len > 0 && Math.abs(cross) / len > 0.02) res.push(c);
  }
  return res.length >= 3 ? res : out;
}

function walls(mb: MeshBuilder, ring: Pt[], base: number, top: number, rgb: RGB, outwardSign: number) {
  const ccw = signedArea(ring) > 0 ? 1 : -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 0.01) continue;
    const s = ccw * outwardSign;
    const nx = (dy / l) * s, ny = (-dx / l) * s;
    const facing = 0.5 + 0.5 * (nx * LIGHT_2D[0] + ny * LIGHT_2D[1]);
    const shade = 0.64 + 0.27 * facing;
    const hi = shade, lo = shade * 0.9;
    const [r, g, bl] = rgb;
    mb.vertex(a.x, a.y, base, r * lo, g * lo, bl * lo);
    mb.vertex(b.x, b.y, base, r * lo, g * lo, bl * lo);
    mb.vertex(b.x, b.y, top, r * hi, g * hi, bl * hi);
    mb.vertex(a.x, a.y, base, r * lo, g * lo, bl * lo);
    mb.vertex(b.x, b.y, top, r * hi, g * hi, bl * hi);
    mb.vertex(a.x, a.y, top, r * hi, g * hi, bl * hi);
  }
}

function flatRoof(mb: MeshBuilder, rings: Pt[][], z: number, rgb: RGB) {
  const flat: number[] = [];
  const holes: number[] = [];
  for (let k = 0; k < rings.length; k++) {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of rings[k]) flat.push(p.x, p.y);
  }
  const idx = earcut(flat, holes, 2);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 2, b = idx[i + 1] * 2, c = idx[i + 2] * 2;
    mb.flatTri(flat[a], flat[a + 1], z, flat[b], flat[b + 1], z, flat[c], flat[c + 1], z, rgb, 1);
  }
}

function isConvex(r: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], c = r[(i + 2) % r.length];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Hipped roof over a convex quad footprint. Returns false if not applicable. */
function hipRoof(mb: MeshBuilder, ring: Pt[], z: number, rgb: RGB): boolean {
  if (ring.length !== 4 || !isConvex(ring)) return false;
  // principal axis = longest edge direction
  let best = 0, ux = 1, uy = 0;
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > best) { best = l; ux = (b.x - a.x) / l; uy = (b.y - a.y) / l; }
  }
  const vx = -uy, vy = ux;
  const cx = (ring[0].x + ring[1].x + ring[2].x + ring[3].x) / 4;
  const cy = (ring[0].y + ring[1].y + ring[2].y + ring[3].y) / 4;
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const p of ring) {
    const u = (p.x - cx) * ux + (p.y - cy) * uy;
    const v = (p.x - cx) * vx + (p.y - cy) * vy;
    umin = Math.min(umin, u); umax = Math.max(umax, u);
    vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const w = vmax - vmin;
  const L = umax - umin;
  if (w < 3) return false;
  const vm = (vmin + vmax) / 2;
  const half = Math.max(0, L / 2 - w / 2);
  const um = (umin + umax) / 2;
  const rh = Math.min(w * 0.36, 4.2);
  const r1 = { x: cx + ux * (um - half) + vx * vm, y: cy + uy * (um - half) + vy * vm };
  const r2 = { x: cx + ux * (um + half) + vx * vm, y: cy + uy * (um + half) + vy * vm };
  const top = z + rh;
  const near = (p: Pt) => ((p.x - r1.x) ** 2 + (p.y - r1.y) ** 2 <= (p.x - r2.x) ** 2 + (p.y - r2.y) ** 2 ? r1 : r2);
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    const pa = near(a), pb = near(b);
    if (pa === pb || half < 0.05) {
      mb.tri(a.x, a.y, z, b.x, b.y, z, pa.x, pa.y, top, rgb, 0.8, 0.26);
    } else {
      mb.tri(a.x, a.y, z, b.x, b.y, z, pb.x, pb.y, top, rgb, 0.8, 0.26);
      mb.tri(a.x, a.y, z, pb.x, pb.y, top, pa.x, pa.y, top, rgb, 0.8, 0.26);
    }
  }
  return true;
}

// ---------------------------------------------------------------- trees

type Tri = number[]; // 9 numbers

function icosahedron(): Tri[] {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; });
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  // rotate so a vertex points up-ish but faces stay irregular
  return f.map(([a, b, c]) => [...v[a], ...v[b], ...v[c]].map((n, i) => (i % 3 === 2 ? n : n)));
}

function cone(segments: number, r: number, h: number, z0: number): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    out.push([Math.cos(a0) * r, Math.sin(a0) * r, z0, Math.cos(a1) * r, Math.sin(a1) * r, z0, 0, 0, z0 + h]);
  }
  return out;
}

function prism(segments: number, r: number, h: number, z0: number): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r, x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
    out.push([x0, y0, z0, x1, y1, z0, x1, y1, z0 + h]);
    out.push([x0, y0, z0, x1, y1, z0 + h, x0, y0, z0 + h]);
  }
  return out;
}

const ICO = icosahedron();
const TRUNK_TALL = prism(4, 0.26, 2.6, 0);
const TRUNK_SHORT = prism(4, 0.24, 1.4, 0);
const CONE_A = cone(7, 2.1, 4.4, 1.2);
const CONE_B = cone(7, 1.55, 3.6, 3.5);
const SPINDLE = [...cone(6, 0.95, 7.8, 1.2), ...cone(6, 0.95, -0.6, 1.2)];

type TreeKind = 0 | 1 | 2; // leafy, conifer, cypress

function emitTree(mb: MeshBuilder, sb: ShadowBuilder, x: number, y: number, kind: TreeKind, r1: number, r2: number) {
  const scale = 0.78 + r1 * 0.55;
  const rot = r2 * Math.PI * 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const put = (tris: Tri[], sx: number, sz: number, dz: number, rgb: RGB, amb: number, dif: number, jitter = 0) => {
    for (const t of tris) {
      const p: number[] = [];
      for (let k = 0; k < 9; k += 3) {
        let px = t[k] * sx, py = t[k + 1] * sx;
        const pz = t[k + 2] * sz + dz;
        if (jitter) {
          const j = 1 + (hash01(Math.round(t[k] * 97), Math.round(t[k + 1] * 89), Math.round(r1 * 1000)) - 0.5) * jitter;
          px *= j; py *= j;
        }
        p.push(x + px * cs - py * sn, y + px * sn + py * cs, pz);
      }
      mb.tri(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], rgb, amb, dif);
    }
  };
  let shadowR: number;
  if (kind === 0) {
    const cr = 2.3 * scale;
    const leaf = LEAFY[Math.floor(r2 * 997) % LEAFY.length];
    put(TRUNK_TALL, scale, scale, 0, TRUNK, 0.8, 0.3);
    put(ICO, cr, cr * 0.86, 2.4 * scale + cr * 0.62, leaf, 0.7, 0.42, 0.28);
    if (r1 > 0.55) put(ICO, cr * 0.62, cr * 0.55, 2.4 * scale + cr * 1.25, leaf, 0.74, 0.4, 0.3);
    shadowR = cr * 1.15;
  } else if (kind === 1) {
    const leaf = CONIFER[Math.floor(r2 * 991) % CONIFER.length];
    put(TRUNK_SHORT, scale, scale, 0, TRUNK, 0.8, 0.3);
    put(CONE_A, scale, scale, 0, leaf, 0.72, 0.4);
    put(CONE_B, scale, scale, 0, leaf, 0.76, 0.38);
    shadowR = 2.2 * scale;
  } else {
    const leaf = CYPRESS[Math.floor(r2 * 983) % CYPRESS.length];
    put(TRUNK_SHORT, scale * 0.8, scale * 0.8, 0, TRUNK, 0.8, 0.3);
    put(SPINDLE, scale, scale * 1.1, 0, leaf, 0.72, 0.4);
    shadowR = 1.3 * scale;
  }
  sb.quad(x + shadowR * 0.35, y - shadowR * 0.22, shadowR);
}

class ShadowBuilder {
  pos: number[] = [];
  uv: number[] = [];
  quad(x: number, y: number, r: number) {
    const z = 0.04;
    const v = [
      [x - r, y - r, 0, 0], [x + r, y - r, 1, 0], [x + r, y + r, 1, 1],
      [x - r, y - r, 0, 0], [x + r, y + r, 1, 1], [x - r, y + r, 0, 1],
    ];
    for (const [px, py, u, w] of v) { this.pos.push(px, py, z); this.uv.push(u, w); }
  }
}

// ---------------------------------------------------------------- spatial index for buildings

class Grid {
  cells = new Map<number, number[]>();
  rings: Pt[][] = [];
  boxes: number[][] = [];
  constructor(public size = 24) {}
  add(ring: Pt[]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const id = this.rings.length;
    this.rings.push(ring);
    this.boxes.push([x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5]);
    for (let gx = Math.floor(x0 / this.size); gx <= Math.floor(x1 / this.size); gx++)
      for (let gy = Math.floor(y0 / this.size); gy <= Math.floor(y1 / this.size); gy++) {
        const k = gx * 100000 + gy;
        let c = this.cells.get(k);
        if (!c) this.cells.set(k, (c = []));
        c.push(id);
      }
  }
  blocked(x: number, y: number, pad = 1.6): boolean {
    const c = this.cells.get(Math.floor(x / this.size) * 100000 + Math.floor(y / this.size));
    if (!c) return false;
    for (const id of c) {
      const b = this.boxes[id];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRing(x, y, this.rings[id])) return true;
      // keep crowns off walls
      const r = this.rings[id];
      for (let i = 0; i < r.length; i++) {
        const a = r[i], q = r[(i + 1) % r.length];
        const dx = q.x - a.x, dy = q.y - a.y;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) < pad) return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------- main

async function fetchTile(urls: string[]): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.arrayBuffer();
      lastErr = new Error(`${res.status} ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no tile urls');
}

function build(req: TileRequest, buf: ArrayBuffer): TileResult {
  const t0 = performance.now();
  const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const mb = new MeshBuilder(1 << 17);
  const sb = new ShadowBuilder();
  const grid = new Grid();
  let buildings = 0, inferred = 0, trees = 0;
  const demand: number[] = [];

  const bl = vt.layers.building;
  const extent = bl?.extent ?? 4096;
  const unit = tileUnitMeters(req.z, req.y, extent);
  const tileOff = [req.x * extent, req.y * extent];
  const toM = (r: Pt[]) => r.map((p) => ({ x: p.x * unit, y: p.y * unit }));

  if (bl) {
    for (let i = 0; i < bl.length; i++) {
      const f: VectorTileFeature = bl.feature(i);
      const props = f.properties as Record<string, unknown>;
      if (props.hide_3d === true || props.hide_3d === 'true') continue;
      const rh = Number(props.render_height ?? 5);
      const rmin = Number(props.render_min_height ?? 0);
      const polys = classifyRings(f.loadGeometry() as Pt[][]);
      for (const poly of polys) {
        const outer0 = clipRing(poly[0], 0, extent);
        if (outer0.length < 3) continue;
        const outer = cleanRing(toM(outer0));
        if (outer.length < 3) continue;
        const area = Math.abs(signedArea(outer));
        if (area < 5) continue;
        const holes = poly.slice(1).map((h) => clipRing(h, 0, extent)).filter((h) => h.length >= 3).map((h) => cleanRing(toM(h))).filter((h) => h.length >= 3);
        let cx = 0, cy = 0;
        for (const p of outer) { cx += p.x; cy += p.y; }
        cx /= outer.length; cy /= outer.length;
        const gx = Math.round(tileOff[0] + cx / unit), gy = Math.round(tileOff[1] + cy / unit);
        const h1 = hash01(gx, gy, 1), h2 = hash01(gx, gy, 2), h3 = hash01(gx, gy, 3), h4 = hash01(gx, gy, 4);
        const known = rh !== 5 && rh > 0;
        let height = known ? rh : inferHeight(area, h1, h2);
        if (!known) inferred++;
        height = Math.min(height, 260);
        const base = Math.min(rmin, height - 0.5);
        let rgb = pickWeighted(TOPS, h3);
        if (area > 2500) rgb = TOPS[0][0];
        buildings++;
        grid.add(outer);
        if (area > 40) {
          const n = 2 ** req.z;
          demand.push(mercXToLng((req.x + cx / unit / extent) / n), mercYToLat((req.y + cy / unit / extent) / n), Math.min(4, (area * height) / 4000));
        }
        walls(mb, outer, base, height, rgb, 1);
        for (const h of holes) walls(mb, h, base, height, rgb, -1);
        const wantsHip = !known && holes.length === 0 && area > 28 && area < 340 && h4 < 0.55;
        if (!(wantsHip && hipRoof(mb, outer, height, pickWeighted(ROOFS, (h4 * 7.31) % 1)))) {
          flatRoof(mb, [outer, ...holes], height, rgb);
        }
      }
    }
  }

  // ---- vegetation
  const green: { ring: Pt[]; holes: Pt[][]; kind: 'wood' | 'park' | 'grass' | 'cemetery' }[] = [];
  const collect = (layerName: string, classify: (p: Record<string, unknown>) => 'wood' | 'park' | 'grass' | 'cemetery' | null) => {
    const L = vt.layers[layerName];
    if (!L) return;
    const u = tileUnitMeters(req.z, req.y, L.extent);
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      if (f.type !== 3) continue;
      const kind = classify(f.properties as Record<string, unknown>);
      if (!kind) continue;
      for (const poly of classifyRings(f.loadGeometry() as Pt[][])) {
        const o = clipRing(poly[0], 0, L.extent);
        if (o.length < 3) continue;
        green.push({ ring: o.map((p) => ({ x: p.x * u, y: p.y * u })), holes: poly.slice(1).map((h) => h.map((p) => ({ x: p.x * u, y: p.y * u }))), kind });
      }
    }
  };
  collect('landcover', (p) => {
    if (p.class === 'wood') return 'wood';
    if (p.class === 'grass') return p.subclass === 'park' || p.subclass === 'garden' ? 'park' : 'grass';
    return null;
  });
  collect('landuse', (p) => (p.class === 'cemetery' ? 'cemetery' : null));

  const spacing = { wood: 6.5, park: 9.5, grass: 15, cemetery: 8 } as const;
  const accept = { wood: 0.8, park: 0.62, grass: 0.32, cemetery: 0.55 } as const;
  const MAX_TREES = 9000;
  for (const g of green) {
    if (trees >= MAX_TREES) break;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g.ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const s = spacing[g.kind];
    for (let yy = Math.ceil(y0 / s) * s; yy < y1; yy += s) {
      for (let xx = Math.ceil(x0 / s) * s; xx < x1; xx += s) {
        const gx = Math.round(tileOff[0] + xx / unit), gy = Math.round(tileOff[1] + yy / unit);
        const r1 = hash01(gx, gy, 11), r2 = hash01(gx, gy, 12), r3 = hash01(gx, gy, 13), r4 = hash01(gx, gy, 14);
        // low-frequency clumping so parks get groves and clearings
        const clump = hash01(Math.floor(gx / 60), Math.floor(gy / 60), 15);
        if (r1 > accept[g.kind] * (0.45 + clump)) continue;
        const px = xx + (r2 - 0.5) * s * 0.9, py = yy + (r3 - 0.5) * s * 0.9;
        if (!pointInRing(px, py, g.ring)) continue;
        if (g.holes.some((h) => pointInRing(px, py, h))) continue;
        if (grid.blocked(px, py)) continue;
        let kind: TreeKind = 0;
        if (g.kind === 'cemetery') kind = r4 < 0.7 ? 2 : 0;
        else if (g.kind === 'wood') kind = r4 < 0.4 ? 1 : 0;
        else kind = r4 < 0.2 ? 1 : r4 < 0.26 ? 2 : 0;
        emitTree(mb, sb, px, py, kind, r4, r2);
        trees++;
      }
    }
  }

  const solid = mb.result();
  const shadows = { positions: new Float32Array(sb.pos), uvs: new Float32Array(sb.uv), count: sb.pos.length / 3 };
  return {
    id: req.id,
    key: `${req.z}/${req.x}/${req.y}`,
    ok: true,
    solid,
    shadows,
    demand: new Float32Array(demand),
    stats: { buildings, inferred, trees, ms: Math.round(performance.now() - t0) },
  };
}

self.onmessage = async (e: MessageEvent<TileRequest>) => {
  const req = e.data;
  try {
    const buf = await fetchTile(req.urls);
    const res = build(req, buf);
    const transfer: Transferable[] = [];
    if (res.solid) transfer.push(res.solid.positions.buffer, res.solid.colors.buffer);
    if (res.shadows) transfer.push(res.shadows.positions.buffer, res.shadows.uvs.buffer);
    if (res.demand) transfer.push(res.demand.buffer);
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err) {
    const res: TileResult = { id: req.id, key: `${req.z}/${req.x}/${req.y}`, ok: false, error: String(err) };
    (self as unknown as Worker).postMessage(res);
  }
};
