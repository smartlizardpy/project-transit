// Stateless, deterministic hashing for city randomness (weather, events, market days…).
// Values depend only on their inputs, so they never consume the shared `rng` stream and a
// reloaded game reproduces them exactly.

/** FNV-1a, 32 bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix any number of integers into one 32-bit hash (murmur3 finaliser per step). */
export function mix(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    let k = Math.imul((x | 0) ^ Math.floor(x / 4294967296), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform number in [0, 1) from the inputs. */
export function unit(...xs: number[]): number {
  return mix(...xs) / 4294967296;
}
