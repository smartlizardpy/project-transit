// MapLibre custom layer that draws the miniature city (buildings, trees, tree
// shadows) and the animated vehicles with Three.js, sharing MapLibre's depth buffer.

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { latToMercY, lngToMercX, mercPerMeter, tileCenterLat, TILE_ZOOM, mercXToLng, mercYToLat } from '../geo/tiles.ts';
import type { TileRequest, TileResult } from './cityWorker.ts';
import { tileUrls } from './tileSource.ts';
import type { TerritoryMask } from './overlays.ts';
import { PAPER } from './palette.ts';

const SOLID_VERT = /* glsl */ `
  uniform mat4 uMatrix;
  uniform float uHeight;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 p = modelMatrix * vec4(position, 1.0);
    p.z *= uHeight;
    gl_Position = uMatrix * p;
  }
`;
const SOLID_FRAG = /* glsl */ `
  uniform float uTint;
  uniform vec3 uTintColor;
  varying vec3 vColor;
  void main() {
    vec3 c = mix(vColor, uTintColor, uTint);
    gl_FragColor = vec4(c, 1.0);
  }
`;
// City tiles: like SOLID_*, plus the territory mask. Outside the area the player can see the
// city is not drawn; over areas that can be licensed next it fades into the paper.
const CITY_VERT = /* glsl */ `
  uniform mat4 uMatrix;
  uniform float uHeight;
  uniform vec4 uMaskXf;
  varying vec3 vColor;
  varying vec2 vMask;
  void main() {
    vColor = color;
    vec4 p = modelMatrix * vec4(position, 1.0);
    vMask = p.xy * uMaskXf.xy + uMaskXf.zw;
    p.z *= uHeight;
    gl_Position = uMatrix * p;
  }
`;
const MASK_GLSL = /* glsl */ `
  uniform sampler2D uMask;
  uniform float uMaskOn;
  varying vec2 vMask;
  float maskLevel() {
    if (uMaskOn < 0.5) return 0.0;
    if (vMask.x < 0.0 || vMask.y < 0.0 || vMask.x > 1.0 || vMask.y > 1.0) return 1.0;
    return texture2D(uMask, vMask).r;
  }
`;
const CITY_FRAG = /* glsl */ `
  uniform float uTint;
  uniform vec3 uTintColor;
  uniform vec3 uPaper;
  varying vec3 vColor;
  ${MASK_GLSL}
  void main() {
    float m = maskLevel();
    if (m > 0.75) discard;
    vec3 c = mix(vColor, uTintColor, uTint);
    c = mix(c, uPaper, smoothstep(0.0, 0.75, m) * 0.8);
    gl_FragColor = vec4(c, 1.0);
  }
`;
const CITY_SHADOW_VERT = /* glsl */ `
  uniform mat4 uMatrix;
  uniform vec4 uMaskXf;
  attribute vec2 uv2;
  varying vec2 vUv;
  varying vec2 vMask;
  void main() {
    vUv = uv2;
    vec4 p = modelMatrix * vec4(position, 1.0);
    vMask = p.xy * uMaskXf.xy + uMaskXf.zw;
    gl_Position = uMatrix * p;
  }
`;
const CITY_SHADOW_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  ${MASK_GLSL}
  void main() {
    float m = maskLevel();
    if (m > 0.75) discard;
    float d = length(vUv - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.35, 1.0, d)) * uOpacity * (1.0 - smoothstep(0.0, 0.75, m));
    gl_FragColor = vec4(vec3(0.33, 0.36, 0.30) * a, a);
  }
`;
interface TileEntry {
  key: string;
  z: number;
  x: number;
  y: number;
  state: 'loading' | 'ready' | 'error';
  group?: THREE.Group;
  origin: THREE.Matrix4; // tile-local metres -> mercator
  lastUsed: number;
  born: number;
}

export interface VehicleVisual {
  id: string;
  object: THREE.Object3D;
}

export class CityLayer implements CustomLayerInterface {
  id = 'city-3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private tiles = new Map<string, TileEntry>();
  private workers: Worker[] = [];
  private nextWorker = 0;
  private reqId = 0;
  private solidMat: THREE.ShaderMaterial;
  private shadowMat: THREE.ShaderMaterial;
  private tmp = new THREE.Matrix4();
  private mvp = new THREE.Matrix4();
  private heightScale = 1;
  private networkTarget = 0;
  private networkT = 0;
  private lastFrame = 0;

  /** Network view: flatten and fade the city so transport lines read like a diagram. */
  setNetworkView(level: number | boolean) {
    this.networkTarget = typeof level === 'number' ? level : level ? 1 : 0;
    this.map?.triggerRepaint();
  }
  private frameHooks: ((now: number) => void)[] = [];
  /** Local frame for dynamic objects (vehicles, highlights). */
  readonly dynamicRoot = new THREE.Group();
  /** Extra scenes drawn after the city, in order, sharing its depth buffer (x-ray, highlights). */
  readonly postScenes: THREE.Scene[] = [];
  private dynamicOrigin = new THREE.Matrix4();
  private dynamicMats = new Set<THREE.ShaderMaterial>();
  private originLngLat: [number, number];
  onStats?: (s: { tiles: number; loading: number }) => void;
  onDemand?: (points: Float32Array[]) => void;
  private demand = new Map<string, Float32Array>();

  constructor(origin: [number, number]) {
    this.originLngLat = origin;
    const mask = () => ({ uMask: { value: null }, uMaskOn: { value: 0 }, uMaskXf: { value: new THREE.Vector4() } });
    this.solidMat = new THREE.ShaderMaterial({
      vertexShader: CITY_VERT,
      fragmentShader: CITY_FRAG,
      uniforms: { uMatrix: { value: new THREE.Matrix4() }, uHeight: { value: 1 }, uTint: { value: 0 }, uTintColor: { value: new THREE.Color('#ffffff') }, uPaper: { value: new THREE.Color(PAPER) }, ...mask() },
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: CITY_SHADOW_VERT,
      fragmentShader: CITY_SHADOW_FRAG,
      uniforms: { uMatrix: { value: new THREE.Matrix4() }, uOpacity: { value: 0.22 }, ...mask() },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.setDynamicOrigin(origin);
    this.scene.add(this.dynamicRoot);
  }

  private maskTex: THREE.CanvasTexture | null = null;
  private maskRect: [number, number, number, number] = [0, 0, 1, 1];
  /** Hide the city outside the visible territory and fade areas offered for licence (null: show all). */
  setMask(m: TerritoryMask | null) {
    this.maskTex?.dispose();
    this.maskTex = null;
    if (m) {
      const t = new THREE.CanvasTexture(m.canvas);
      t.flipY = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      this.maskTex = t;
      this.maskRect = m.rect;
    }
    this.map?.triggerRepaint();
  }

  /** Material for dynamic meshes (vehicles). Shares the projection with the dynamic frame. */
  makeDynamicMaterial(opts: { transparent?: boolean; opacity?: number } = {}): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: SOLID_VERT,
      fragmentShader: opts.transparent
        ? /* glsl */ `uniform float uOpacity; uniform float uTint; uniform vec3 uTintColor; varying vec3 vColor; void main(){ vec3 c = mix(vColor, uTintColor, uTint); gl_FragColor = vec4(c * uOpacity, uOpacity); }`
        : SOLID_FRAG,
      uniforms: {
        uMatrix: { value: new THREE.Matrix4() },
        uHeight: { value: 1 },
        uTint: { value: 0 },
        uTintColor: { value: new THREE.Color('#ffffff') },
        uOpacity: { value: opts.opacity ?? 1 },
      },
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: !!opts.transparent,
      depthWrite: !opts.transparent,
      blending: opts.transparent ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.dynamicMats.add(m);
    return m;
  }

  get origin(): [number, number] {
    return this.originLngLat;
  }

  setDynamicOrigin(lngLat: [number, number]) {
    this.originLngLat = lngLat;
    const s = mercPerMeter(lngLat[1]);
    this.dynamicOrigin.makeTranslation(lngToMercX(lngLat[0]), latToMercY(lngLat[1]), 0).multiply(new THREE.Matrix4().makeScale(s, s, s));
  }

  /** Local metres (x east, y south) relative to the dynamic origin -> lng/lat. */
  localToLngLat(x: number, y: number): [number, number] {
    const s = mercPerMeter(this.originLngLat[1]);
    return [mercXToLng(lngToMercX(this.originLngLat[0]) + x * s), mercYToLat(latToMercY(this.originLngLat[1]) + y * s)];
  }

  lngLatToLocal(lng: number, lat: number): [number, number] {
    const s = mercPerMeter(this.originLngLat[1]);
    return [(lngToMercX(lng) - lngToMercX(this.originLngLat[0])) / s, (latToMercY(lat) - latToMercY(this.originLngLat[1])) / s];
  }

  addFrameHook(fn: (now: number) => void) {
    this.frameHooks.push(fn);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    const n = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./cityWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<TileResult>) => this.onTile(e.data);
      this.workers.push(w);
    }
    map.on('moveend', this.updateTiles);
    map.on('move', this.throttledUpdate);
    this.updateTiles();
  }

  onRemove() {
    this.map.off('moveend', this.updateTiles);
    this.map.off('move', this.throttledUpdate);
    this.workers.forEach((w) => w.terminate());
    this.tiles.forEach((t) => this.disposeTile(t));
    this.renderer.dispose();
  }

  private lastThrottle = 0;
  private throttledUpdate = () => {
    const now = performance.now();
    if (now - this.lastThrottle > 220) {
      this.lastThrottle = now;
      this.updateTiles();
    }
  };

  /** Work out which z14 tiles cover the view by sampling the screen. */
  private updateTiles = () => {
    const map = this.map;
    if (!map) return;
    const zoom = map.getZoom();
    if (zoom < 13.4) return;
    const canvas = map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const wanted = new Map<string, { z: number; x: number; y: number; d: number }>();
    const c = map.getCenter();
    const n = 2 ** TILE_ZOOM;
    const cx = lngToMercX(c.lng) * n, cy = latToMercY(c.lat) * n;
    const maxDist = zoom > 15.5 ? 2.3 : zoom > 14.5 ? 3.2 : 4.2;
    for (let sy = 0; sy <= 1.0001; sy += 1 / 7) {
      for (let sx = -0.05; sx <= 1.0501; sx += 1 / 8) {
        const ll = map.unproject([sx * w, sy * h]);
        const tx = Math.floor(lngToMercX(ll.lng) * n), ty = Math.floor(latToMercY(ll.lat) * n);
        const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        if (d > maxDist) continue;
        const key = `${TILE_ZOOM}/${tx}/${ty}`;
        if (!wanted.has(key)) wanted.set(key, { z: TILE_ZOOM, x: tx, y: ty, d });
      }
    }
    const now = performance.now();
    const list = [...wanted.entries()].sort((a, b) => a[1].d - b[1].d).slice(0, 20);
    for (const [key, t] of list) {
      const existing = this.tiles.get(key);
      if (existing) {
        existing.lastUsed = now;
        continue;
      }
      this.requestTile(key, t.z, t.x, t.y, now);
    }
    // evict least recently used beyond the cache size
    if (this.tiles.size > 36) {
      const old = [...this.tiles.values()].filter((t) => !wanted.has(t.key)).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of old.slice(0, this.tiles.size - 36)) {
        this.disposeTile(t);
        this.tiles.delete(t.key);
      }
    }
    this.reportStats();
  };

  private async requestTile(key: string, z: number, x: number, y: number, now: number) {
    const s = mercPerMeter(tileCenterLat(z, y));
    const origin = new THREE.Matrix4().makeTranslation(x / 2 ** z, y / 2 ** z, 0).multiply(new THREE.Matrix4().makeScale(s, s, s));
    const entry: TileEntry = { key, z, x, y, state: 'loading', origin, lastUsed: now, born: 0 };
    this.tiles.set(key, entry);
    const urls = await tileUrls(z, x, y);
    const req: TileRequest = { id: ++this.reqId, z, x, y, urls };
    this.workers[this.nextWorker++ % this.workers.length].postMessage(req);
  }

  private onTile(res: TileResult) {
    const entry = this.tiles.get(res.key);
    if (!entry) return;
    if (!res.ok || !res.solid) {
      entry.state = 'error';
      console.warn('tile failed', res.key, res.error);
      this.reportStats();
      return;
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.solid.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(res.solid.colors, 3, true));
    const mat = this.solidMat.clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    if (res.shadows && res.shadows.count > 0) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(res.shadows.positions, 3));
      sg.setAttribute('uv2', new THREE.BufferAttribute(res.shadows.uvs, 2));
      const sm = this.shadowMat.clone();
      const smesh = new THREE.Mesh(sg, sm);
      smesh.frustumCulled = false;
      smesh.renderOrder = -1;
      group.add(smesh);
    }
    if (res.demand) {
      this.demand.set(res.key, res.demand);
      this.onDemand?.([...this.demand.values()]);
    }
    entry.group = group;
    entry.state = 'ready';
    entry.born = performance.now();
    this.scene.add(group);
    this.reportStats();
    this.map.triggerRepaint();
  }

  private disposeTile(t: TileEntry) {
    if (!t.group) return;
    this.scene.remove(t.group);
    t.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  private reportStats() {
    let loading = 0;
    this.tiles.forEach((t) => t.state === 'loading' && loading++);
    this.onStats?.({ tiles: this.tiles.size, loading });
  }

  /** True while tiles are still arriving (used by the loading indicator and screenshots). */
  /** Number of 3D tiles currently built and drawable (used by diagnostics). */
  get tileCount(): number {
    let n = 0;
    this.tiles.forEach((t) => t.state === 'ready' && n++);
    return n;
  }

  get busy(): boolean {
    for (const t of this.tiles.values()) if (t.state === 'loading') return true;
    return false;
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const now = performance.now();
    for (const h of this.frameHooks) h(now);
    const zoom = this.map.getZoom();
    // Buildings "grow" out of the flat map between z13.9 and z14.7.
    const t = Math.min(1, Math.max(0, (zoom - 13.9) / 0.8));
    this.heightScale = t * t * (3 - 2 * t);
    this.mvp.fromArray(args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix);
    let animating = false;
    const dtf = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    if (Math.abs(this.networkT - this.networkTarget) > 0.001) {
      this.networkT += (this.networkTarget - this.networkT) * Math.min(1, dtf * 6);
      animating = true;
    } else this.networkT = this.networkTarget;
    const flat = 1 - 0.94 * this.networkT;
    for (const tile of this.tiles.values()) {
      if (!tile.group) continue;
      tile.group.visible = this.heightScale > 0.001;
      const m = this.tmp.multiplyMatrices(this.mvp, tile.origin);
      const age = Math.min(1, (now - tile.born) / 650);
      if (age < 1) animating = true;
      const grow = 1 - Math.pow(1 - age, 3);
      // tile-local metres -> mask texture coordinates
      const o = tile.origin.elements, [rx0, ry0, rx1, ry1] = this.maskRect;
      for (const child of tile.group.children) {
        const mat = (child as THREE.Mesh).material as THREE.ShaderMaterial;
        mat.uniforms.uMatrix.value.copy(m);
        if (mat.uniforms.uMaskOn) {
          mat.uniforms.uMask.value = this.maskTex;
          mat.uniforms.uMaskOn.value = this.maskTex ? 1 : 0;
          (mat.uniforms.uMaskXf.value as THREE.Vector4).set(o[0] / (rx1 - rx0), o[5] / (ry1 - ry0), (o[12] - rx0) / (rx1 - rx0), (o[13] - ry0) / (ry1 - ry0));
        }
        if (mat.uniforms.uHeight) mat.uniforms.uHeight.value = this.heightScale * grow * flat;
        if (mat.uniforms.uTint) { mat.uniforms.uTint.value = 0.62 * this.networkT; (mat.uniforms.uTintColor.value as THREE.Color).set('#e9e6dd'); }
        if (mat.uniforms.uOpacity) mat.uniforms.uOpacity.value = 0.22 * this.heightScale * grow * flat;
      }
    }
    const dm = this.tmp.multiplyMatrices(this.mvp, this.dynamicOrigin);
    for (const mat of this.dynamicMats) mat.uniforms.uMatrix.value.copy(dm);
    this.dynamicRoot.visible = zoom > 13.2;
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    if (this.dynamicRoot.visible) for (const ps of this.postScenes) this.renderer.render(ps, this.camera);
    if (animating) this.map.triggerRepaint();
  }
}
