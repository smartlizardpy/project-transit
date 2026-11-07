// Peer-to-peer co-op over WebRTC data channels (Trystero). Public Nostr relays only introduce the
// two computers (the offer is encrypted with the room code); after that the game talks directly,
// computer to computer. No server of ours is involved.

import { joinRoom, selfId } from 'trystero';
import type { JsonValue } from 'trystero';
import type { Msg } from './protocol.ts';
import type { Transport } from './transport.ts';

const APP_ID = 'dev.projecttransit.coop.v1';

export function rtcTransport(code: string): Transport {
  const room = joinRoom({ appId: APP_ID, password: code }, `room-${code}`);
  const msg = room.makeAction<string>('m');
  const blob = room.makeAction<ArrayBuffer | ArrayBufferView>('b');
  const t: Transport = {
    // Trystero's id for this computer (the same in every room for the page's lifetime)
    selfId,
    send: (m: Msg, to?: string | null) => void msg.send(JSON.stringify(m), { target: to ?? null }).catch(warn),
    sendBlob: (meta, bytes, to, onProgress) => blob.send(bytes, { target: to, metadata: meta as JsonValue, onProgress: onProgress && ((p) => onProgress(p)) }),
    onMessage: null,
    onBlob: null,
    onBlobProgress: null,
    onPeer: null,
    ping: (id) => room.ping(id),
    leave: () => void room.leave().catch(warn),
  };
  msg.onMessage = (data, { peerId }) => {
    let m: Msg;
    try {
      m = JSON.parse(data) as Msg;
    } catch {
      return;
    }
    t.onMessage?.(m, peerId);
  };
  blob.onMessage = (data, { peerId, metadata }) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    t.onBlob?.(metadata, bytes, peerId);
  };
  blob.onReceiveProgress = (p, { peerId }) => t.onBlobProgress?.(p, peerId);
  room.onPeerJoin = (id) => t.onPeer?.(id, true);
  room.onPeerLeave = (id) => t.onPeer?.(id, false);
  return t;
}

const warn = (e: unknown) => console.warn('co-op connection:', e);
