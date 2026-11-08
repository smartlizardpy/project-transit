// Co-op UI: invite friends from the game menu, join from the start menu, and while playing
// together a small strip under the clock shows who is here and what they just did.

import { useEffect, useState } from 'react';
import { Copy, Check, UsersThree, SignOut, HourglassMedium } from '@phosphor-icons/react';
import '../styles/coop.css';
import { coopAvailable, dismissEnded, hostGame, joinGame, leaveCoop, normaliseCode, savedName, useCoop } from '../net/coop.ts';
import { Avatar, NameField, NO_RTC } from './Friends.tsx';
import { useRace, leaveRace, dismissRace } from '../net/race.ts';
import { RaceLobby } from './Race.tsx';
import { copyText } from '../app/agents.ts';
import { Dialog } from './GameMenu.tsx';
import { useUI } from '../state/store.ts';

function PlayerList() {
  const players = useCoop((s) => s.players);
  const me = useCoop((s) => s.me);
  return (
    <ul className="co-players">
      {players.map((p) => (
        <li key={p.id}>
          <Avatar p={p} />
          <b>{p.name}</b>
          <span>{[p.id === me?.id ? 'you' : null, p.host ? 'host' : null].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

/** Game menu → Play with friends. */
export function CoopPanel() {
  const role = useCoop((s) => s.role);
  const code = useCoop((s) => s.code);
  const players = useCoop((s) => s.players);
  const [name, setName] = useState(savedName);
  const [copied, setCopied] = useState(false);
  if (!coopAvailable()) return <p className="mn-note warn">{NO_RTC}</p>;
  if (role === 'guest') {
    return (
      <>
        <p className="mn-note">You are playing in a friend’s game. Everything either of you does happens in both games.</p>
        <PlayerList />
        <div className="mn-row-end"><button className="btn" onClick={leaveCoop}><SignOut size={14} weight="bold" />Leave game</button></div>
      </>
    );
  }
  if (role === 'host' && code) {
    const copy = async () => {
      if (await copyText(code)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    };
    return (
      <>
        <p className="mn-note">Send this code to your friends. On the start screen they choose <b>Multiplayer</b>, then <b>Join a friend</b>, and type it in.</p>
        <div className="co-code">
          <span>{code}</span>
          <button className="btn sm" onClick={() => void copy()}>{copied ? <><Check size={13} weight="bold" />Copied</> : <><Copy size={13} weight="bold" />Copy</>}</button>
        </div>
        <PlayerList />
        {players.length < 2 && <p className="co-hint"><HourglassMedium size={13} weight="bold" /> Waiting for someone to join…</p>}
        <div className="mn-row-end"><button className="btn" onClick={leaveCoop}>End session</button></div>
      </>
    );
  }
  return (
    <>
      <p className="mn-note">Friends join this game and run the company with you: you see each other’s cursors, and whatever anyone builds, buys or changes happens for everyone. The game is saved on your computer.</p>
      <NameField value={name} onChange={setName} autoFocus />
      <div className="mn-row-end">
        <button className="btn primary" disabled={!name.trim()} onClick={() => void hostGame(name)}><UsersThree size={15} weight="bold" />Invite friends</button>
      </div>
    </>
  );
}

/** Start menu → Join a friend. */
export function JoinDialog({ onClose }: { onClose: () => void }) {
  const phase = useCoop((s) => s.phase);
  const loading = useCoop((s) => s.loading);
  const ended = useCoop((s) => s.ended);
  const raceRole = useRace((s) => s.role);
  const raceEnded = useRace((s) => (s.phase === 'ended' ? s.ended : null));
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const busy = phase === 'connecting' || phase === 'loading';
  const valid = normaliseCode(code);
  const problem = ended ?? raceEnded;
  const cancel = () => {
    if (busy) leaveCoop();
    if (ended) dismissEnded();
    if (raceEnded) dismissRace();
    onClose();
  };
  const go = () => {
    if (!valid || !name.trim()) return;
    if (ended) dismissEnded();
    if (raceEnded) dismissRace();
    void joinGame(valid, name);
  };
  // the code was for a race: its lobby
  if (raceRole === 'guest') {
    return (
      <Dialog title="Race a friend" onClose={() => { leaveRace(); onClose(); }}>
        <RaceLobby />
      </Dialog>
    );
  }
  return (
    <Dialog title="Join a friend" onClose={cancel}>
      {!coopAvailable() ? <p className="mn-note warn">{NO_RTC}</p> : (
        <form className="co-join" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <p className="mn-note">Ask your friend for their code. To play in their game, they choose <b>Play with friends</b> in the menu (Esc); for a race, <b>Multiplayer</b> → <b>Race a friend</b> on the start screen.</p>
          <NameField value={name} onChange={setName} autoFocus={!name} />
          <label className="co-field">
            <span>Code</span>
            <input className="co-code-in" value={code} placeholder="ABCD-2345" autoFocus={!!name} spellCheck={false} autoCapitalize="characters" maxLength={9} disabled={busy}
              onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          {problem && <div className="mn-error" role="alert"><span>{problem}</span></div>}
          {busy && (
            <div className="co-status">
              {phase === 'connecting' ? 'Finding your friend’s game…' : `Downloading the game… ${Math.round((loading ?? 0) * 100)}%`}
              <div className="co-bar"><i style={{ width: phase === 'loading' ? `${Math.round((loading ?? 0) * 100)}%` : undefined }} className={phase === 'connecting' ? 'indef' : ''} /></div>
            </div>
          )}
          <div className="mn-row-end">
            <button type="button" className="btn" onClick={cancel}>{busy ? 'Cancel' : 'Close'}</button>
            <button type="submit" className="btn primary" disabled={busy || !valid || !name.trim()}>Join</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** While playing together: who is here, whether the clock waits for someone, and what friends just did. */
export function CoopHud() {
  const role = useCoop((s) => s.role);
  const players = useCoop((s) => s.players);
  const waiting = useCoop((s) => s.waiting);
  const feed = useCoop((s) => s.feed);
  const [, tick] = useState(0);
  // fade old feed lines
  useEffect(() => {
    if (!feed.length) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [feed.length]);
  if (!role) return null;
  const now = performance.now();
  const recent = feed.filter((f) => now - f.at < 7000);
  return (
    <div className="co-hud">
      <button className="card co-pill" onClick={() => useUI.getState().openModal({ kind: 'menu' })} aria-label="Players">
        <span className="co-stack">{players.map((p) => <Avatar key={p.id} p={p} size={22} />)}</span>
        <span className="co-pill-t">{players.length < 2 ? 'Waiting for friends' : `${players.length} playing`}</span>
      </button>
      {waiting.length > 0 && <div className="card co-wait"><HourglassMedium size={13} weight="bold" /> Waiting for {waiting.join(', ')} to catch up</div>}
      {recent.map((f) => (
        <div key={f.id} className="co-feed" style={{ opacity: Math.min(1, (7000 - (now - f.at)) / 1500) }}>
          <i style={{ background: f.colour }} /><b>{f.who}</b> {f.text}
        </div>
      ))}
    </div>
  );
}

/** The host ended the session or the connection dropped: the game stays open here. */
export function CoopEnded() {
  const phase = useCoop((s) => s.phase);
  const ended = useCoop((s) => s.ended);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(phase === 'ended' && !!ended), [phase, ended]);
  if (!open || !ended) return null;
  return (
    <Dialog title="Playing together ended" onClose={() => { setOpen(false); dismissEnded(); }}>
      <p className="mn-note">{ended}</p>
      <p className="mn-note">Your copy of the game is still open and paused. Save it to keep playing on your own, or quit to the menu.</p>
      <div className="mn-row-end"><button className="btn primary" onClick={() => { setOpen(false); dismissEnded(); }} autoFocus>OK</button></div>
    </Dialog>
  );
}
