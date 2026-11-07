// What co-op sessions and races share: room codes, the player's name, and opening a connection.

import type { Transport } from './transport.ts';

const NAME_KEY = 'pt-coop-name';
export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
export function rememberName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* ignore */
  }
}

/** Room codes: 8 characters without look-alikes (0/O, 1/I/L), e.g. "K7QM-2XVD". */
export function makeCode(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normaliseCode = (c: string) => {
  const s = c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

/** WebRTC is missing in some webviews (Linux WebKitGTK builds without it). */
export const coopAvailable = () => typeof RTCPeerConnection !== 'undefined';

/** The WebRTC library loads only when someone hosts or joins. */
export const connect = async (code: string): Promise<Transport> => (await import('./rtc.ts')).rtcTransport(code);
