// Pack a value with typed arrays (the region's road graph, demand grid…) into compressed bytes,
// for sending a game to a friend: JSON for the structure, the arrays' raw bytes after it.
// Layout: [u8 gzip?][u32 json length][json][for each array: u32 byte length, padding to 8, bytes].

type TypedArray = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray;
const KINDS: Record<string, new (b: ArrayBuffer) => TypedArray> = {
  Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray,
};

export function encode(value: unknown): Uint8Array {
  const arrays: TypedArray[] = [];
  const json = JSON.stringify(value, (_k, v: unknown) => {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      arrays.push(v as TypedArray);
      return { __ta: v.constructor.name, i: arrays.length - 1 };
    }
    return v;
  });
  const head = new TextEncoder().encode(json);
  let size = 4 + head.length;
  for (const a of arrays) size = align(size + 4) + a.byteLength;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, head.length, true);
  out.set(head, 4);
  let off = 4 + head.length;
  for (const a of arrays) {
    dv.setUint32(off, a.byteLength, true);
    off = align(off + 4);
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), off);
    off += a.byteLength;
  }
  return out;
}

export function decode<T>(bytes: Uint8Array): T {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const json = new TextDecoder().decode(bytes.subarray(4, 4 + n));
  const arrays: ArrayBuffer[] = [];
  let off = 4 + n;
  while (off < bytes.length) {
    const len = dv.getUint32(off, true);
    off = align(off + 4);
    arrays.push(bytes.slice(off, off + len).buffer);
    off += len;
  }
  return JSON.parse(json, (_k, v: unknown) => {
    if (v && typeof v === 'object' && '__ta' in v) {
      const t = v as { __ta: string; i: number };
      const Kind = KINDS[t.__ta];
      if (!Kind) throw new Error(`Unknown array type ${t.__ta}`);
      return new Kind(arrays[t.i]);
    }
    return v;
  }) as T;
}

const align = (n: number) => (n + 7) & ~7;

/** encode() then gzip when the platform can (first byte says which). */
export async function pack(value: unknown): Promise<Uint8Array> {
  const raw = encode(value);
  if (typeof CompressionStream === 'undefined') return withFlag(0, raw);
  const zipped = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return withFlag(1, zipped);
}

export async function unpack<T>(bytes: Uint8Array): Promise<T> {
  const body = bytes.subarray(1);
  if (bytes[0] === 0) return decode<T>(body);
  const raw = new Uint8Array(await new Response(new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return decode<T>(raw);
}

function withFlag(flag: number, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length + 1);
  out[0] = flag;
  out.set(b, 1);
  return out;
}
