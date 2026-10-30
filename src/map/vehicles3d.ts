// Buses on the map. Close up: low-poly 3D models in the company livery, positioned from the
// simulation (interpolated between ticks). Zoomed out: clickable line-coloured markers with a
// direction notch, cross-fading with the 3D models. Original geometry, baked shading.

import * as THREE from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import type { CityLayer } from './cityLayer.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { hexToRgb } from './palette.ts';
import { session } from '../app/session.ts';
import { MODEL, MODELS, type VehicleModel } from '../game/content.ts';
import type { Game } from '../game/engine.ts';
import type { Vehicle } from '../game/types.ts';
import { useUI } from '../state/store.ts';
import { drivesOnLeft } from '../game/world/locale.ts';

export const BRAND = '#e0573e';
const VISUAL_SCALE = 1.32; // slightly enlarged for legibility, as in most transport games
/** zoom range over which 3D buses hand over to flat markers */
const FADE_HI = 15.3;
const FADE_LO = 14.5;
type RGB = [number, number, number];

function box(mb: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces: { top?: RGB; side: RGB; front?: RGB; back?: RGB }) {
  const { top = faces.side, side, front = side, back = side } = faces;
  const q = (a: number[], b: number[], c: number[], d: number[], rgb: RGB, amb = 0.74, dif = 0.32) => {
    mb.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], rgb, amb, dif);
    mb.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], rgb, amb, dif);
  };
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], top, 0.86, 0.18);
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], side, 0.8, 0.28);
  q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], side, 0.66, 0.2);
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], front, 0.84, 0.2);
  q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], back, 0.7, 0.2);
}

const WHITE: RGB = hexToRgb('#f4f2ec');
const ROOF: RGB = hexToRgb('#fbfaf6');
const GLASS: RGB = hexToRgb('#34434c');
const TYRE: RGB = hexToRgb('#25292b');
const POD: RGB = hexToRgb('#d6d9d6');
const POD_TOP: RGB = hexToRgb('#e7e9e6');
const SIGN: RGB = hexToRgb('#f6c45a');
const BATTERY: RGB = hexToRgb('#cfe3d8');

function busGeometry(m: VehicleModel, livery: string): THREE.BufferGeometry {
  const mb = new MeshBuilder(4096);
  const brand = hexToRgb(livery);
  const L = m.length, W = m.body === 'mini' ? 2.2 : 2.55;
  const dd = m.body === 'dd';
  const H = dd ? 4.3 : m.body === 'mini' ? 2.75 : 3.05;
  const x0 = -L / 2, x1 = L / 2, y0 = -W / 2, y1 = W / 2;
  const artic = m.body === 'artic';
  const wheels = artic ? [x0 + 2.2, x0 + 8.4, x1 - 2.6] : m.body === 'mini' ? [x0 + 1.5, x1 - 1.9] : [x0 + 2.4, x1 - 2.8];
  for (const wx of wheels) box(mb, wx - 0.55, wx + 0.55, y0 - 0.02, y1 + 0.02, 0.05, 0.95, { side: TYRE });
  box(mb, x0, x1, y0, y1, 0.32, 1.05, { side: brand, front: brand, back: brand });
  box(mb, x0, x1, y0, y1, 1.05, 1.3, { side: WHITE });
  box(mb, x0 + 0.02, x1 - 0.02, y0 - 0.02, y1 + 0.02, 1.3, 2.42, { side: GLASS, front: GLASS, back: GLASS });
  if (dd) {
    box(mb, x0, x1, y0, y1, 2.42, 2.75, { side: brand, front: brand, back: brand });
    box(mb, x0 + 0.02, x1 - 0.02, y0 - 0.02, y1 + 0.02, 2.75, 3.75, { side: GLASS, front: GLASS, back: GLASS });
    box(mb, x0, x1, y0, y1, 3.75, H, { side: WHITE, top: ROOF, front: WHITE });
  } else {
    box(mb, x0, x1, y0, y1, 2.42, H, { side: WHITE, top: ROOF, front: WHITE });
  }
  const signZ = dd ? [3.8, 4.1] : [Math.min(2.5, H - 0.5), Math.min(2.82, H - 0.18)];
  box(mb, x1 - 0.04, x1 + 0.02, y0 + 0.35, y1 - 0.35, signZ[0], signZ[1], { side: SIGN, front: SIGN });
  if (!dd) box(mb, x0 + L * 0.18, x0 + L * 0.42, y0 + 0.35, y1 - 0.35, H, H + 0.34, { side: POD, top: m.electric ? BATTERY : POD_TOP });
  if (m.electric) box(mb, x0 + L * 0.5, x0 + L * 0.72, y0 + 0.35, y1 - 0.35, H, H + 0.3, { side: POD, top: BATTERY });
  if (artic) {
    box(mb, -1.0, 1.0, y0 + 0.05, y1 - 0.05, 0.3, H - 0.05, { side: TYRE });
    box(mb, x1 - L * 0.4, x1 - L * 0.25, y0 + 0.35, y1 - 0.35, H, H + 0.3, { side: POD, top: POD_TOP });
  }
  const r = mb.result();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(r.colors, 3, true));
  return g;
}

function ringGeometry(rIn: number, rOut: number, rgb: RGB): THREE.BufferGeometry {
  const seg = 48;
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = [
      [Math.cos(a0) * rIn, Math.sin(a0) * rIn], [Math.cos(a0) * rOut, Math.sin(a0) * rOut], [Math.cos(a1) * rOut, Math.sin(a1) * rOut],
      [Math.cos(a0) * rIn, Math.sin(a0) * rIn], [Math.cos(a1) * rOut, Math.sin(a1) * rOut], [Math.cos(a1) * rIn, Math.sin(a1) * rIn],
    ];
    for (const [x, y] of p) { pos.push(x, y, 0.15); col.push(rgb[0], rgb[1], rgb[2]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  return g;
}

export const STATUS_COLOUR: Record<Vehicle['status'], string> = {
  parked: '#738078',
  preparing: '#8cc6ef',
  to_route: '#8cc6ef',
  in_service: '#8fdcae',
  at_stop: '#8fdcae',
  layover: '#a9b4ac',
  to_depot: '#a9b4ac',
  maintenance: '#f0c169',
  broken: '#ef8f7d',
};

export class VehicleLayer {
  private meshes = new Map<string, THREE.Mesh>();
  private ring: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private hoverMat: THREE.ShaderMaterial;
  private screen = new Map<string, { x: number; y: number; r: number }>();
  private headings = new Map<string, number>();
  private tag: HTMLDivElement;
  private tagKey = '';
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private geos = new Map<string, THREE.BufferGeometry>();
  private livery = '';
  private solid: THREE.ShaderMaterial;
  private xray: THREE.Mesh;
  private hero: THREE.Mesh;
  private game: Game | null = null;

  constructor(private city: CityLayer, private container: HTMLElement) {
    this.solid = city.makeDynamicMaterial();
    const xrayMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.78 });
    xrayMat.depthFunc = THREE.GreaterDepth;
    xrayMat.uniforms.uTint.value = 0.72;
    (xrayMat.uniforms.uTintColor.value as THREE.Color).set('#ffffff');
    this.setLivery(BRAND);
    const anyGeo = this.geos.get('city12')!;
    this.xray = new THREE.Mesh(anyGeo, xrayMat);
    this.hero = new THREE.Mesh(anyGeo, this.solid);
    for (const m of [this.xray, this.hero]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.visible = false;
    }
    const xrayScene = new THREE.Scene();
    xrayScene.add(this.xray);
    const heroScene = new THREE.Scene();
    heroScene.add(this.hero);
    city.postScenes.push(xrayScene, heroScene);
    this.ringMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.9 });
    this.hoverMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.55 });
    this.ring = new THREE.Mesh(ringGeometry(7.2, 9.4, [255, 255, 255]), this.ringMat);
    this.hoverRing = new THREE.Mesh(ringGeometry(7.2, 8.4, [255, 255, 255]), this.hoverMat);
    for (const r of [this.ring, this.hoverRing]) {
      r.frustumCulled = false;
      r.visible = false;
      r.matrixAutoUpdate = false;
      city.dynamicRoot.add(r);
    }
    this.tag = document.createElement('div');
    this.tag.className = 'vehicle-tag';
    container.appendChild(this.tag);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vehicle-markers';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    city.addFrameHook((now) => this.update(now));
    session.onGame((g) => this.attach(g));
    this.attach(session.game);
  }

  /** Draw another game's buses (the start-menu showcase) while nothing is being played. */
  show(g: Game) {
    if (!session.game) this.attach(g);
  }

  /** Stop drawing `g` if it is the game being drawn. */
  release(g: Game) {
    if (this.game === g) this.attach(session.game);
  }

  private attach(g: Game | null) {
    this.game = g;
    for (const m of this.meshes.values()) this.city.dynamicRoot.remove(m);
    this.meshes.clear();
    this.headings.clear();
    this.screen.clear();
    if (g) this.setLivery(g.state.company.colour);
  }

  private setLivery(colour: string) {
    if (colour === this.livery) return;
    this.livery = colour;
    for (const g of this.geos.values()) g.dispose();
    this.geos.clear();
    for (const m of MODELS) this.geos.set(m.id, busGeometry(m, colour));
    for (const [id, mesh] of this.meshes) {
      const v = this.game?.state.vehicles[id];
      if (v) mesh.geometry = this.geos.get(v.model)!;
    }
  }

  /** Screen-space hit test (pixels). */
  pick(x: number, y: number, radius = 20): string | null {
    let best: string | null = null, bestD = radius;
    for (const [id, p] of this.screen) {
      const d = Math.hypot(p.x - x, p.y - y) - p.r * 0.5;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  screenPos(id: string) {
    return this.screen.get(id);
  }

  private resizeCanvas() {
    const w = this.container.clientWidth, h = this.container.clientHeight, dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
  }

  private update(now: number) {
    const map = (this.city as unknown as { map: MlMap }).map;
    const game = this.game;
    this.resizeCanvas();
    if (!map || !game) {
      this.ring.visible = this.hoverRing.visible = this.xray.visible = this.hero.visible = false;
      this.tag.classList.remove('show');
      return;
    }
    if (game.state.company.colour !== this.livery) this.setLivery(game.state.company.colour);
    const ui = useUI.getState();
    const sel = ui.selection?.kind === 'vehicle' ? ui.selection.id : null;
    const hov = ui.hover?.kind === 'vehicle' ? ui.hover.id : null;
    this.screen.clear();
    const zoom = map.getZoom();
    const zoomBoost = Math.min(2.6, Math.max(1, Math.pow(2, (17.2 - zoom) * 0.72)));
    const scale = VISUAL_SCALE * zoomBoost;
    const flat = Math.max(0, Math.min(1, (FADE_HI - zoom) / (FADE_HI - FADE_LO)));
    const show3d = flat < 0.98;
    // keep to the driving side of the centreline (left in the UK, Japan, ...)
    const off = drivesOnLeft(game.region.spec.country) ? -1.9 : 1.9;
    const seen = new Set<string>();
    const ctx = this.ctx;
    for (const v of game.vehicleList()) {
      const pose = game.pose(v);
      if (!pose) continue;
      seen.add(v.id);
      let mesh = this.meshes.get(v.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geos.get(v.model) ?? this.geos.get('city12')!, this.solid);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.city.dynamicRoot.add(mesh);
        this.meshes.set(v.id, mesh);
      }
      const ll = game.geo.P.toLngLat(pose.x, pose.y);
      const [cx, cy] = this.city.lngLatToLocal(ll[0], ll[1]);
      // region frame has y north, the city layer y south
      let heading = -pose.heading;
      const prev = this.headings.get(v.id);
      if (prev !== undefined) {
        let d = heading - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        heading = Math.abs(d) > 2.6 ? heading : prev + d * 0.35;
      }
      this.headings.set(v.id, heading);
      const px = cx - Math.sin(heading) * off;
      const py = cy + Math.cos(heading) * off;
      mesh.position.set(px, py, 0);
      mesh.rotation.set(0, 0, heading);
      mesh.scale.setScalar(scale);
      mesh.updateMatrix();
      mesh.visible = show3d && v.id !== sel;
      const sp = map.project(this.city.localToLngLat(px, py));
      const len = MODEL[v.model]?.length ?? 12;
      this.screen.set(v.id, { x: sp.x, y: sp.y, r: flat > 0.5 ? 9 : Math.min(30, len * 0.9) });
      if (flat > 0) this.drawMarker(ctx, game, v, sp.x, sp.y, heading - (map.getBearing() * Math.PI) / 180, flat, v.id === sel, v.id === hov);
      if (v.id === sel) {
        const geo = this.geos.get(v.model)!;
        this.hero.geometry = geo;
        this.hero.matrix.copy(mesh.matrix);
        this.xray.geometry = geo;
        const lc = (v.route && game.state.routes[v.route]?.colour) || game.state.company.colour;
        ((this.xray.material as THREE.ShaderMaterial).uniforms.uTintColor.value as THREE.Color).set(lc);
        this.ringMat.uniforms.uTint.value = 1;
        (this.ringMat.uniforms.uTintColor.value as THREE.Color).set(lc);
        this.xray.matrix.copy(mesh.matrix);
        this.ring.position.set(px, py, 0);
        this.ring.scale.setScalar((1 + Math.sin(now / 320) * 0.06) * zoomBoost);
        this.ring.updateMatrix();
      }
      if (v.id === hov && v.id !== sel) {
        this.hoverRing.position.set(px, py, 0);
        this.hoverRing.scale.setScalar(zoomBoost);
        this.hoverRing.updateMatrix();
      }
    }
    for (const [id, m] of this.meshes)
      if (!seen.has(id)) {
        this.city.dynamicRoot.remove(m);
        this.meshes.delete(id);
        this.headings.delete(id);
      }
    const selShown = !!sel && seen.has(sel) && show3d;
    this.ring.visible = selShown;
    this.xray.visible = selShown;
    this.hero.visible = selShown;
    this.hoverRing.visible = show3d && !!hov && hov !== sel && seen.has(hov);
    this.ringMat.uniforms.uOpacity.value = 0.85;
    this.updateTag(game, map, hov ?? sel);
  }

  private drawMarker(ctx: CanvasRenderingContext2D, game: Game, v: Vehicle, x: number, y: number, heading: number, alpha: number, selected: boolean, hovered: boolean) {
    const r = v.route ? game.state.routes[v.route] : undefined;
    const colour = r?.colour ?? '#8b958f';
    const inService = v.status === 'in_service' || v.status === 'at_stop';
    const R = selected ? 8.5 : hovered ? 7.5 : inService ? 6.5 : 5.2;
    ctx.save();
    ctx.globalAlpha = alpha * (inService || selected ? 1 : 0.75);
    ctx.translate(x, y);
    // direction notch
    ctx.save();
    ctx.rotate(heading);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(R + 4.5, 0);
    ctx.lineTo(R - 0.5, -3.6);
    ctx.lineTo(R - 0.5, 3.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.shadowColor = 'rgba(10,14,12,0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R + 1.8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    // driving to or from the depot, off the line: a hollow ring, so it is not taken for a bus on the route
    if (v.pos.kind === 'path') ctx.arc(0, 0, R - 2.6, 0, Math.PI * 2, true);
    ctx.fillStyle = colour;
    ctx.fill('evenodd');
    if (v.status === 'broken' || v.delay > 300) {
      ctx.beginPath();
      ctx.arc(R * 0.75, -R * 0.75, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = v.status === 'broken' ? '#ef8f7d' : '#f0c169';
      ctx.fill();
    }
    if (selected) {
      ctx.beginPath();
      ctx.arc(0, 0, R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  private updateTag(game: Game, map: MlMap, id: string | null) {
    const p = id ? this.screen.get(id) : null;
    const v = id ? game.state.vehicles[id] : null;
    if (p && v && map.getZoom() > 13.5) {
      const line = v.route ? game.state.routes[v.route] : undefined;
      const cap = MODEL[v.model].capacity;
      const key = `${v.id}|${v.load}|${line?.number}|${line?.colour}`;
      if (key !== this.tagKey) {
        this.tagKey = key;
        this.tag.innerHTML = `<span class="vt-line" style="--c:${line?.colour ?? '#5b6660'}">${line?.number ?? '–'}</span><span class="vt-load">${v.load}<i>/${cap}</i></span>`;
      }
      this.tag.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - Math.max(18, p.r + 10))}px) translate(-50%, -100%)`;
      this.tag.classList.add('show');
    } else this.tag.classList.remove('show');
  }

  dispose() {
    this.tag.remove();
    this.canvas.remove();
  }
}
