// What the co-op and race screens share: player avatars, the name field, and the WebRTC note.

import type { Player } from '../net/protocol.ts';

const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

export function Avatar({ p, size = 26 }: { p: Player; size?: number }) {
  return (
    <span className="co-av" style={{ background: p.colour, width: size, height: size, fontSize: size * 0.42 }} title={p.host ? `${p.name} (host)` : p.name}>
      {initials(p.name)}
    </span>
  );
}

export function NameField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="co-field">
      <span>Your name</span>
      <input value={value} maxLength={24} placeholder="How friends see you" autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export const NO_RTC = 'Playing together needs WebRTC, which this copy of the game does not have (some Linux systems leave it out). It works in the macOS and Windows apps and in Chrome, Edge, Firefox and Safari.';

