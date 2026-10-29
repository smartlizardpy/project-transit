// Low-poly bus models animated along their lines. Original geometry, baked shading.

import * as THREE from 'three';
import type { CityLayer } from './cityLayer.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { hexToRgb } from './palette.ts';
import { sim, MODELS, type Vehicle } from '../sim/sim.ts';
import { useUI } from '../state/store.ts';

export const BRAND = '#e0573e';
const VISUAL_SCALE = 1.32; // slightly enlarged for legibility, as in most transport games
type RGB = [number, number, number];

function box(mb: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces: { top?: RGB; side: RGB; front?: RGB; back?: RGB }) {
  const { top = faces.side, side, front = side, back = side } = faces;
  const q = (a: number[], b: number[], c: number[], d: number[], rgb: RGB, amb = 0.74, dif = 0.32) => {
    mb.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], rgb, amb, dif);
    mb.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], rgb, amb, dif);
  };
  // top
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], top, 0.86, 0.18);
  // sides (y0 = left, y1 = right)
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], side, 0.8, 0.28);
  q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], side, 0.66, 0.2);
  // front (x1) and back (x0)
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], front, 0.84, 0.2);
  q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], back, 0.7, 0.2);
}

const WHITE: RGB = hexToRgb('#f4f2ec');
const ROOF: RGB = hexToRgb('#fbfaf6');
const GLASS: RGB = hexToRgb('#34434c');
const TYRE: RGB = hexToRgb('#25292b');
const POD: RGB = hexToRgb('#d6d9d6');
const SIGN: RGB = hexToRgb('#f6c45a');

function busGeometry(length: number, articulated: boolean): THREE.BufferGeometry {
  const mb = new MeshBuilder(4096);
  const brand = hexToRgb(BRAND);
  const L = length, W = 2.55, H = 3.05;
  const x0 = -L / 2, x1 = L / 2, y0 = -W / 2, y1 = W / 2;
  // wheels
  for (const wx of articulated ? [x0 + 2.2, x0 + 8.4, x1 - 2.6] : [x0 + 2.4, x1 - 2.8]) {
    box(mb, wx - 0.55, wx + 0.55, y0 - 0.02, y1 + 0.02, 0.05, 0.95, { side: TYRE });
  }
  // body: skirt, white mid, glass band, roof
  box(mb, x0, x1, y0, y1, 0.32, 1.05, { side: brand, front: brand, back: brand });
  box(mb, x0, x1, y0, y1, 1.05, 1.3, { side: WHITE });
  box(mb, x0 + 0.02, x1 - 0.02, y0 - 0.02, y1 + 0.02, 1.3, 2.42, { side: GLASS, front: GLASS, back: GLASS });
  box(mb, x0, x1, y0, y1, 2.42, H, { side: WHITE, top: ROOF, front: WHITE });
  // destination sign + brand stripe over the windscreen
  box(mb, x1 - 0.04, x1 + 0.02, y0 + 0.35, y1 - 0.35, 2.5, 2.82, { side: SIGN, front: SIGN });
  // roof units
  box(mb, x0 + L * 0.18, x0 + L * 0.42, y0 + 0.35, y1 - 0.35, H, H + 0.34, { side: POD, top: hexToRgb('#e7e9e6') });
  if (articulated) {
    box(mb, -1.0, 1.0, y0 + 0.05, y1 - 0.05, 0.3, H - 0.05, { side: TYRE });
    box(mb, x1 - L * 0.4, x1 - L * 0.25, y0 + 0.35, y1 - 0.35, H, H + 0.3, { side: POD, top: hexToRgb('#e7e9e6') });
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

export class VehicleLayer {
  private meshes = new Map<string, THREE.Mesh>();
  private ring: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private hoverMat: THREE.ShaderMaterial;
  private screen = new Map<string, { x: number; y: number }>();
  private headings = new Map<string, number>();
  private tag: HTMLDivElement;
  private tagKey = '';

  private geos: Record<string, THREE.BufferGeometry>;
  private solid: THREE.ShaderMaterial;
  /** Ghosted silhouette of the selected bus, drawn only where buildings hide it. */
  private xray: THREE.Mesh;
  /** The selected bus itself, drawn after the x-ray so it never ghosts over itself. */
  private hero: THREE.Mesh;

  constructor(private city: CityLayer, container: HTMLElement) {
    this.solid = city.makeDynamicMaterial();
    this.geos = {
      'Urban 12': busGeometry(MODELS['Urban 12'].length, false),
      'Midi 9': busGeometry(MODELS['Midi 9'].length, false),
      'Artic 18': busGeometry(MODELS['Artic 18'].length, true),
    };
    this.sync();
    sim.onNetwork(() => this.sync());
    const xrayMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.78 });
    xrayMat.depthFunc = THREE.GreaterDepth;
    xrayMat.uniforms.uTint.value = 0.72;
    (xrayMat.uniforms.uTintColor.value as THREE.Color).set('#ffffff');
    this.xray = new THREE.Mesh(this.geos['Urban 12'], xrayMat);
    this.xray.frustumCulled = false;
    this.xray.matrixAutoUpdate = false;
    this.xray.visible = false;
    this.hero = new THREE.Mesh(this.geos['Urban 12'], this.solid);
    this.hero.frustumCulled = false;
    this.hero.matrixAutoUpdate = false;
    this.hero.visible = false;
    const xrayScene = new THREE.Scene();
    xrayScene.add(this.xray);
    const heroScene = new THREE.Scene();
    heroScene.add(this.hero);
    city.postScenes.push(xrayScene, heroScene);
    this.ringMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.9 });
    this.hoverMat = city.makeDynamicMaterial({ transparent: true, opacity: 0.55 });
    this.ring = new THREE.Mesh(ringGeometry(7.2, 9.4, [255, 255, 255]), this.ringMat);
    this.hoverRing = new THREE.Mesh(ringGeometry(7.2, 8.4, [255, 255, 255]), this.hoverMat);
    for (const r of [this.ring, this.hoverRing]) { r.frustumCulled = false; r.visible = false; r.matrixAutoUpdate = false; city.dynamicRoot.add(r); }
    this.tag = document.createElement('div');
    this.tag.className = 'vehicle-tag';
    container.appendChild(this.tag);
    city.addFrameHook((now) => this.update(now));
  }

  /** Create meshes for vehicles that entered service; drop those sent to the depot. */
  sync() {
    for (const v of sim.vehicles) {
      const has = this.meshes.get(v.id);
      if (v.status === 'depot') {
        if (has) { this.city.dynamicRoot.remove(has); this.meshes.delete(v.id); }
        continue;
      }
      if (has) continue;
      const m = new THREE.Mesh(this.geos[v.model], this.solid);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.scale.setScalar(VISUAL_SCALE);
      this.city.dynamicRoot.add(m);
      this.meshes.set(v.id, m);
    }
  }

  /** Screen-space hit test (pixels). */
  pick(x: number, y: number, radius = 20): string | null {
    let best: string | null = null, bestD = radius;
    for (const [id, p] of this.screen) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  screenPos(id: string) {
    return this.screen.get(id);
  }

  private update(now: number) {
    const map = this.city['map'] as import('maplibre-gl').Map;
    if (!map) return;
    const ui = useUI.getState();
    const sel = ui.selection?.kind === 'vehicle' ? ui.selection.id : null;
    const hov = ui.hover?.kind === 'vehicle' ? ui.hover.id : null;
    this.screen.clear();
    // Game-style legibility: below z17 buses shrink slower than the city.
    const zoomBoost = Math.min(2.6, Math.max(1, Math.pow(2, (17.2 - map.getZoom()) * 0.72)));
    const scale = VISUAL_SCALE * zoomBoost;
    for (const v of sim.vehicles) {
      const mesh = this.meshes.get(v.id);
      if (!mesh) continue;
      const pose = sim.pose(v);
      if (!pose) { mesh.visible = false; continue; }
      const [ax, ay] = this.city.lngLatToLocal(...pose.ahead);
      const [bx, by] = this.city.lngLatToLocal(...pose.behind);
      const [cx, cy] = this.city.lngLatToLocal(...pose.at);
      let heading = Math.atan2(ay - by, ax - bx);
      // smooth turning
      const prev = this.headings.get(v.id);
      if (prev !== undefined) {
        let d = heading - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        heading = prev + d * 0.35;
      }
      this.headings.set(v.id, heading);
      // drive on the right: offset from the centreline
      const off = 2.3;
      const px = cx - Math.sin(heading) * off;
      const py = cy + Math.cos(heading) * off;
      mesh.position.set(px, py, 0);
      mesh.rotation.set(0, 0, heading);
      mesh.scale.setScalar(scale);
      mesh.updateMatrix();
      const ll = this.city.localToLngLat(px, py);
      const sp = map.project(ll);
      this.screen.set(v.id, { x: sp.x, y: sp.y });
      mesh.visible = v.id !== sel;
      if (v.id === sel) {
        this.hero.geometry = this.geos[v.model];
        this.hero.matrix.copy(mesh.matrix);
        this.xray.geometry = this.geos[v.model];
        const lc = sim.line(v.lineId)?.colour ?? BRAND;
        ((this.xray.material as THREE.ShaderMaterial).uniforms.uTintColor.value as THREE.Color).set(lc);
        this.ringMat.uniforms.uTint.value = 1;
        (this.ringMat.uniforms.uTintColor.value as THREE.Color).set(lc);
        this.xray.matrix.copy(mesh.matrix);
        this.ring.position.set(px, py, 0);
        const pulse = 1 + Math.sin(now / 320) * 0.06;
        this.ring.scale.setScalar(pulse * zoomBoost);
        this.ring.updateMatrix();
      }
      if (v.id === hov && v.id !== sel) {
        this.hoverRing.position.set(px, py, 0);
        this.hoverRing.scale.setScalar(zoomBoost);
        this.hoverRing.updateMatrix();
      }
    }
    this.ring.visible = !!sel;
    this.xray.visible = !!sel && this.meshes.has(sel);
    this.hero.visible = this.xray.visible;
    this.hoverRing.visible = !!hov && hov !== sel;
    this.ringMat.uniforms.uOpacity.value = 0.85;
    // floating tag for the hovered / selected vehicle
    const tagId = hov ?? sel;
    const p = tagId ? this.screen.get(tagId) : null;
    const v = tagId ? sim.vehicle(tagId) : null;
    if (p && v && map.getZoom() > 14.8) {
      const line = sim.line(v.lineId);
      const key = `${v.id}|${v.occupancy}|${line?.number}`;
      if (key !== this.tagKey) {
        this.tagKey = key;
        this.tag.innerHTML = `<span class="vt-line" style="--c:${line?.colour}">${line?.number ?? '–'}</span><span class="vt-load">${v.occupancy}<i>/${MODELS[v.model].capacity}</i></span>`;
      }
      this.tag.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - 30)}px) translate(-50%, -100%)`;
      this.tag.classList.add('show');
    } else {
      this.tag.classList.remove('show');
    }
  }

  dispose() {
    this.tag.remove();
  }
}

export function vehicleIsVisible(v: Vehicle) {
  return v.status !== 'depot';
}
