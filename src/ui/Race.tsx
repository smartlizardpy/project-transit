// Race UI: open a race from the start menu, wait in the lobby, the scoreboard under the clock while
// racing, and the results at the finish.

import { useEffect, useState } from 'react';
import { Copy, Check, Flag, FlagCheckered, HourglassMedium, SignOut, Trophy } from '@phosphor-icons/react';
import '../styles/coop.css';
import { session } from '../app/session.ts';
import { PRESETS } from '../app/presets.ts';
import { copyText } from '../app/agents.ts';
import { savedName, coopAvailable } from '../net/room.ts';
import { RACE_DAYS, changeRace, dismissRace, leaveRace, openRace, raceClock, startRace, useRace } from '../net/race.ts';
import { rank } from '../net/racing.ts';
import type { Player, RaceResult } from '../net/protocol.ts';
import { DAY, HOUR } from '../game/content.ts';
import { useSession } from '../app/session.ts';
import { Avatar, NameField, NO_RTC } from './Friends.tsx';
import { Dialog } from './GameMenu.tsx';
import { Segmented } from './primitives.tsx';

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
const num = (n: number) => n.toLocaleString();

/** "2 d 4 h", "3 h 20 min", "45 min" */
function left(s: number) {
  s = Math.max(0, s);
  const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / HOUR), m = Math.floor((s % HOUR) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

function Players({ players, me }: { players: Player[]; me: Player | null }) {
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

function CityPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="rc-cities" role="radiogroup" aria-label="City">
      {PRESETS.map((p) => (
        <button key={p.id} role="radio" aria-checked={p.id === value} className={'rc-city' + (p.id === value ? ' on' : '')} onClick={() => onChange(p.id)}>
          <b>{p.city}</b>
          <span>{p.area}</span>
        </button>
      ))}
    </div>
  );
}

function LengthPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <>
      <Segmented options={RACE_DAYS.map((n) => ({ value: String(n), label: days(n) }))} value={String(value)} onChange={(v) => onChange(Number(v))} />
      <p className="co-hint rc-len">A game day takes about 2 minutes at the fastest speed, or 12 minutes at the speed before it.</p>
    </>
  );
}

/** Start menu → Race a friend. */
export function RaceDialog({ onClose }: { onClose: () => void }) {
  const role = useRace((s) => s.role);
  const phase = useRace((s) => s.phase);
  const code = useRace((s) => s.code);
  const players = useRace((s) => s.players);
  const me = useRace((s) => s.me);
  const setup = useRace((s) => s.setup);
  const ended = useRace((s) => s.ended);
  const [name, setName] = useState(savedName);
  const [city, setCity] = useState(PRESETS[0].id);
  const [length, setLength] = useState<number>(3);
  const [copied, setCopied] = useState(false);
  const hosting = role === 'host';
  const close = () => {
    if (hosting) leaveRace();
    if (ended) dismissRace();
    onClose();
  };
  const pick = (c: string, n: number) => {
    setCity(c);
    setLength(n);
    if (hosting) changeRace(c, n);
  };
  const copy = async () => {
    if (code && (await copyText(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };
  return (
    <Dialog title="Race a friend" onClose={close} wide>
      {!coopAvailable() ? <p className="mn-note warn">{NO_RTC}</p> : (
        <>
          {!hosting && <p className="mn-note">You and your friends each found a bus company in the same city, at the same moment, on one shared clock. Whoever has carried the most passengers when time runs out wins.</p>}
          {ended && <div className="mn-error" role="alert"><span>{ended}</span></div>}
          {!hosting && <NameField value={name} onChange={setName} autoFocus={!name} />}
          {hosting && code && (
            <>
              <p className="mn-note">Send this code to your friends. They choose <b>Join a friend</b> on the start screen and type it in.</p>
              <div className="co-code">
                <span>{code}</span>
                <button className="btn sm" onClick={() => void copy()}>{copied ? <><Check size={13} weight="bold" />Copied</> : <><Copy size={13} weight="bold" />Copy</>}</button>
              </div>
              <Players players={players} me={me} />
              {players.length < 2 && <p className="co-hint"><HourglassMedium size={13} weight="bold" /> Waiting for someone to join…</p>}
            </>
          )}
          <div className="label">City</div>
          <CityPicker value={setup?.preset ?? city} onChange={(c) => pick(c, setup?.days ?? length)} />
          <div className="label mn-gap">Length</div>
          <LengthPicker value={setup?.days ?? length} onChange={(n) => pick(setup?.preset ?? city, n)} />
          <div className="mn-row-end">
            <button className="btn" onClick={close}>{hosting ? 'Call off' : 'Close'}</button>
            {hosting ? (
              <button className="btn primary" disabled={players.length < 2 || phase !== 'lobby'} onClick={() => void startRace()}><Flag size={15} weight="fill" />Start the race</button>
            ) : (
              <button className="btn primary" disabled={!name.trim() || phase === 'lobby'} onClick={() => { if (ended) dismissRace(); void openRace(name, city, length); }}><Flag size={15} weight="fill" />Open a race</button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Join a friend → the code was for a race: wait here until the host starts it. */
export function RaceLobby() {
  const phase = useRace((s) => s.phase);
  const players = useRace((s) => s.players);
  const me = useRace((s) => s.me);
  const setup = useRace((s) => s.setup);
  const loading = useRace((s) => s.loading);
  const host = players.find((p) => p.host);
  if (!setup) return null;
  return (
    <>
      <p className="mn-note">You joined <b>{host?.name ?? 'your friend'}</b>’s race: <b>{setup.city}</b> ({setup.area}), {days(setup.days)}. Everyone founds a company in the same place, and whoever carries the most passengers wins.</p>
      <Players players={players} me={me} />
      <div className="co-status">
        {phase === 'lobby' ? `Waiting for ${host?.name ?? 'the host'} to start the race…` : loading === null ? `${host?.name ?? 'The host'} is loading the city…` : `Downloading the map… ${Math.round(loading * 100)}%`}
        <div className="co-bar"><i className={loading === null ? 'indef' : ''} style={{ width: loading === null ? undefined : `${Math.round(loading * 100)}%` }} /></div>
      </div>
      <div className="mn-row-end"><button className="btn" onClick={leaveRace}><SignOut size={14} weight="bold" />Leave</button></div>
    </>
  );
}

/** Game menu → Play with friends, during a race. */
export function RacePanel() {
  const players = useRace((s) => s.players);
  const me = useRace((s) => s.me);
  const setup = useRace((s) => s.setup);
  const role = useRace((s) => s.role);
  return (
    <>
      <p className="mn-note">You are racing in <b>{setup?.city}</b>. Each of you runs your own company; the clock is shared, so pausing pauses everyone.</p>
      <Players players={players} me={me} />
      <p className="mn-note">If you leave, your company stays open and you can keep playing on your own{role === 'host' ? ', but the race ends for everyone' : ''}.</p>
      <div className="mn-row-end"><button className="btn" onClick={leaveRace}><SignOut size={14} weight="bold" />{role === 'host' ? 'End the race' : 'Leave the race'}</button></div>
    </>
  );
}

/** Under the clock while racing: time left and the standings. Click for the details. */
export function RaceHud() {
  const phase = useRace((s) => s.phase);
  const players = useRace((s) => s.players);
  const scores = useRace((s) => s.scores);
  const start = useRace((s) => s.start);
  const me = useRace((s) => s.me);
  const waiting = useRace((s) => s.waiting);
  const ghosts = useRace((s) => s.ghosts);
  const game = useSession((s) => (s.phase === 'playing' ? session.game : null));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (phase !== 'racing') return;
    const t = setInterval(() => setNow(raceClock()), 500);
    return () => clearInterval(t);
  }, [phase]);
  if (phase !== 'racing' || !start) return null;
  const standings = rank(players, scores);
  const remaining = start.endT - (now || start.startT);
  const started = (now || start.startT) > start.startT;
  const money = (v: number) => game?.money(v, { compact: true }) ?? num(v);
  return (
    <div className="co-hud rc-hud">
      <button className="card rc-board" onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-label="Race standings">
        <span className={'rc-left' + (remaining < HOUR * 3 ? ' close' : '')}><FlagCheckered size={14} weight="fill" />{started ? left(remaining) : 'Starting'}</span>
        {standings.map((r, i) => (
          <span key={r.id} className={'rc-chip' + (r.id === me?.id ? ' me' : '')}>
            <em>{i + 1}</em>
            <i style={{ background: r.colour }} />
            <b>{r.id === me?.id ? 'You' : r.name}</b>
            <span>{num(r.score?.journeys ?? 0)}</span>
          </span>
        ))}
      </button>
      {open && (
        <div className="card rc-detail">
          <table>
            <thead><tr><th /><th>Journeys</th><th>Balance</th><th>Lines</th><th>Buses</th><th>Reputation</th></tr></thead>
            <tbody>
              {standings.map((r) => (
                <tr key={r.id} className={r.id === me?.id ? 'me' : ''}>
                  <td><i style={{ background: r.colour }} />{r.name}{r.score?.bankrupt ? ' · bankrupt' : ''}</td>
                  <td>{num(r.score?.journeys ?? 0)}</td>
                  <td>{r.score ? money(r.score.balance) : '–'}</td>
                  <td>{r.score?.lines ?? '–'}</td>
                  <td>{r.score?.buses ?? '–'}</td>
                  <td>{r.score?.rep ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="rc-toggle"><input type="checkbox" checked={ghosts} onChange={(e) => useRace.setState({ ghosts: e.target.checked })} />Show rivals’ lines on the map</label>
          <p className="co-hint">Most journeys carried wins; a tie goes to the higher balance.</p>
        </div>
      )}
      {waiting.length > 0 && <div className="card co-wait"><HourglassMedium size={13} weight="bold" /> {started ? `Waiting for ${waiting.join(', ')} to catch up` : `Waiting for ${waiting.join(', ')} to get the map`}</div>}
    </div>
  );
}

function ResultRow({ r, i, me, money }: { r: RaceResult; i: number; me: string | undefined; money: (v: number) => string }) {
  return (
    <tr className={r.id === me ? 'me' : ''}>
      <td className="rc-place">{i === 0 ? <Trophy size={16} weight="fill" /> : i + 1}</td>
      <td><i style={{ background: r.colour }} />{r.name}{r.id === me ? ' (you)' : ''}{r.score?.bankrupt ? ' · bankrupt' : ''}</td>
      <td>{r.score ? num(r.score.journeys) : 'left'}</td>
      <td>{r.score ? money(r.score.balance) : '–'}</td>
    </tr>
  );
}

/** The finish, or a race that ended early. */
export function RaceOver() {
  const phase = useRace((s) => s.phase);
  const results = useRace((s) => s.results);
  const ended = useRace((s) => s.ended);
  const me = useRace((s) => s.me);
  const game = useSession((s) => (s.phase === 'playing' ? session.game : null));
  // the lobby's own dialogs show why a race that never started ended
  if (phase === 'ended' && ended && game) {
    return (
      <Dialog title="The race ended" onClose={dismissRace}>
        <p className="mn-note">{ended}</p>
        <div className="mn-row-end"><button className="btn primary" onClick={dismissRace} autoFocus>OK</button></div>
      </Dialog>
    );
  }
  if (phase !== 'finished' || !results) return null;
  const won = results[0]?.id === me?.id;
  const money = (v: number) => game?.money(v, { compact: true }) ?? num(v);
  return (
    <Dialog title={won ? 'You won the race!' : `${results[0]?.name ?? 'Nobody'} won the race`} onClose={dismissRace}>
      <table className="rc-results">
        <thead><tr><th /><th /><th>Journeys</th><th>Balance</th></tr></thead>
        <tbody>{results.map((r, i) => <ResultRow key={r.id} r={r} i={i} me={me?.id} money={money} />)}</tbody>
      </table>
      <p className="mn-note">Your company is yours to keep: it is saved like any other game, and you can play on from here.</p>
      <div className="mn-row-end">
        <button className="btn" onClick={() => { dismissRace(); void session.quitToMenu(); }}>Main menu</button>
        <button className="btn primary" onClick={dismissRace} autoFocus>Keep playing</button>
      </div>
    </Dialog>
  );
}
