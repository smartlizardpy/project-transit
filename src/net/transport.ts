// How co-op messages travel. The game uses WebRTC peer-to-peer (rtc.ts); tests use the
// in-memory hub below.

import type { Msg } from './protocol.ts';

export interface Transport {
  readonly selfId: string;
  /** `to` null: everyone else in the room */
  send(msg: Msg, to?: string | null): void;
  /** a large binary payload (a game snapshot), with JSON metadata */
  sendBlob(meta: unknown, bytes: Uint8Array, to: string, onProgress?: (share: number) => void): Promise<void>;
  onMessage: ((msg: Msg, from: string) => void) | null;
  onBlob: ((meta: unknown, bytes: Uint8Array, from: string) => void) | null;
  onBlobProgress: ((share: number, from: string) => void) | null;
  onPeer: ((id: string, joined: boolean) => void) | null;
  /** round-trip time to a peer in milliseconds */
  ping(id: string): Promise<number>;
  leave(): void;
}

/** An in-memory room for tests: messages are delivered after `delayMs` (0: on the next microtask). */
export class MemoryHub {
  private peers = new Map<string, MemoryTransport>();
  constructor(readonly delayMs = 0) {}

  join(id: string): MemoryTransport {
    const t = new MemoryTransport(id, this);
    for (const p of this.peers.values()) {
      this.later(() => p.onPeer?.(id, true));
      this.later(() => t.onPeer?.(p.selfId, true));
    }
    this.peers.set(id, t);
    return t;
  }

  /** @internal */
  deliver(from: string, to: string | null | undefined, fn: (t: MemoryTransport) => void) {
    for (const [id, p] of this.peers) if (id !== from && (to == null || to === id)) this.later(() => this.peers.has(id) && fn(p));
  }

  /** @internal */
  remove(id: string) {
    this.peers.delete(id);
    for (const p of this.peers.values()) this.later(() => p.onPeer?.(id, false));
  }

  private later(fn: () => void) {
    if (this.delayMs > 0) setTimeout(fn, this.delayMs);
    else queueMicrotask(fn);
  }
}

class MemoryTransport implements Transport {
  onMessage: Transport['onMessage'] = null;
  onBlob: Transport['onBlob'] = null;
  onBlobProgress: Transport['onBlobProgress'] = null;
  onPeer: Transport['onPeer'] = null;
  constructor(readonly selfId: string, private hub: MemoryHub) {}

  send(msg: Msg, to?: string | null) {
    const json = JSON.stringify(msg);
    this.hub.deliver(this.selfId, to, (p) => p.onMessage?.(JSON.parse(json) as Msg, this.selfId));
  }

  async sendBlob(meta: unknown, bytes: Uint8Array, to: string) {
    const copy = bytes.slice();
    const m = JSON.parse(JSON.stringify(meta)) as unknown;
    this.hub.deliver(this.selfId, to, (p) => p.onBlob?.(m, copy, this.selfId));
  }

  async ping() {
    return this.hub.delayMs * 2;
  }

  leave() {
    this.hub.remove(this.selfId);
  }
}
