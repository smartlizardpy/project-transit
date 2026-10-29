// Growable flat-shaded mesh buffers with baked "miniature model" lighting.
// Coordinates are local metres: x = east, y = south, z = up.

export const LIGHT_3D = normalize3([-0.48, 0.6, 0.86]); // from the south-west, high sun
export const LIGHT_2D = normalize2([-0.9, 0.3]); // walls: west light, south mid, east dark

function normalize3(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function normalize2(v: number[]): [number, number] {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
}

export class MeshBuilder {
  pos: Float32Array;
  col: Uint8Array;
  n = 0; // vertex count

  constructor(initial = 65536) {
    this.pos = new Float32Array(initial * 3);
    this.col = new Uint8Array(initial * 3);
  }

  private ensure(extra: number) {
    if ((this.n + extra) * 3 <= this.pos.length) return;
    let cap = this.pos.length / 3;
    while ((this.n + extra) > cap) cap *= 2;
    const p = new Float32Array(cap * 3);
    p.set(this.pos);
    const c = new Uint8Array(cap * 3);
    c.set(this.col);
    this.pos = p;
    this.col = c;
  }

  vertex(x: number, y: number, z: number, r: number, g: number, b: number) {
    this.ensure(1);
    const i = this.n * 3;
    this.pos[i] = x;
    this.pos[i + 1] = y;
    this.pos[i + 2] = z;
    this.col[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    this.col[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    this.col[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    this.n++;
  }

  /** Triangle shaded by its own face normal. `ambient` + `diffuse` control contrast. */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    rgb: [number, number, number], ambient: number, diffuse: number,
  ) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // our solids are viewed from above
    const d = Math.max(0, nx * LIGHT_3D[0] + ny * LIGHT_3D[1] + nz * LIGHT_3D[2]);
    const s = ambient + diffuse * d;
    const r = rgb[0] * s, g = rgb[1] * s, b = rgb[2] * s;
    this.vertex(ax, ay, az, r, g, b);
    this.vertex(bx, by, bz, r, g, b);
    this.vertex(cx, cy, cz, r, g, b);
  }

  /** Triangle with a fixed shade multiplier (no normal maths). */
  flatTri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    rgb: [number, number, number], shade: number,
  ) {
    const r = rgb[0] * shade, g = rgb[1] * shade, b = rgb[2] * shade;
    this.vertex(ax, ay, az, r, g, b);
    this.vertex(bx, by, bz, r, g, b);
    this.vertex(cx, cy, cz, r, g, b);
  }

  result() {
    return { positions: this.pos.slice(0, this.n * 3), colors: this.col.slice(0, this.n * 3), count: this.n };
  }
}
