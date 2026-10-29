import '../styles/board.css';
import { arrivalsAt, vehicleStops, type Arrival } from '../game/eta.ts';
import { waitingAt } from '../game/passengers.ts';
import { hhmm } from '../game/time.ts';
import { useUI } from '../state/store.ts';
import { focusStop, focusVehicle } from './camera.ts';
import { useGameUpdates } from './hooks.ts';

function timeCell(a: Arrival, now: number): { text: string; unit?: string; due: boolean } {
  const min = (a.eta - now) / 60;
  if (a.status === 'boarding') return { text: 'Boarding', due: true };
  if (min <= 0.5) return { text: 'Due', due: true };
  if (min < 20) return { text: String(Math.max(1, Math.round(min))), unit: 'min', due: false };
  return { text: hhmm(a.eta), due: false };
}

function minuteLabel(eta: number, now: number): string {
  const min = (eta - now) / 60;
  if (min <= 0.5) return 'Now';
  if (min < 20) return `${Math.max(1, Math.round(min))} min`;
  return hhmm(eta);
}

function Pips({ load, cap }: { load: number; cap: number }) {
  const n = 5;
  const f = cap > 0 ? load / cap : 0;
  const lit = load > 0 ? Math.max(1, Math.round(f * n)) : 0;
  const tone = f > 0.9 ? 'hot' : f > 0.65 ? 'warm' : '';
  return (
    <span className={`bd-pips ${tone}`} role="img" aria-label={`${load} of ${cap} seats and standing places taken`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  );
}

export function ArrivalBoard({ stopId }: { stopId: string }) {
  const game = useGameUpdates(4);
  if (!game) return null;
  const stop = game.state.stops[stopId];
  if (!stop) return null;
  const rows = arrivalsAt(game, stopId, 7);
  const waiting = waitingAt(game.state, stopId);
  const served = game.routesUsing(stopId).length > 0;
  const paused = game.speed === 0;

  return (
    <section className="board" aria-label={`Departures from ${stop.name}`}>
      <header className="bd-head">
        <div className="bd-title">
          <span className="bd-stop">{stop.name}</span>
          <span className="bd-clock" aria-label="Game time">{hhmm(game.t)}</span>
        </div>
        <div className="bd-sub">
          <span>{waiting === 1 ? '1 waiting' : `${waiting} waiting`}</span>
          {paused && <span className="bd-tag">PAUSED</span>}
        </div>
      </header>
      <div className="bd-rows">
        {rows.length === 0 ? (
          <p className="bd-empty">{served ? 'No departures in the next 3 hours' : 'No lines serve this stop yet'}</p>
        ) : (
          rows.map((a) => {
            const r = game.state.routes[a.route];
            const t = timeCell(a, game.t);
            const unassigned = a.status === 'unassigned';
            const dest = a.terminates ? 'Terminates here' : a.towards;
            const note = unassigned
              ? { text: 'No bus assigned', cls: 'bad' }
              : a.delayMin >= 2
                ? { text: `+${a.delayMin} late`, cls: a.delayMin >= 5 ? 'bad' : 'warn' }
                : a.delayMin <= -2
                  ? { text: `${-a.delayMin} early`, cls: 'soft' }
                  : null;
            const label = `Line ${r?.number} towards ${a.towards}, ${t.unit ? `${t.text} ${t.unit}` : t.text}${note ? `, ${note.text}` : ''}`;
            const body = (
              <>
                <span className="bd-line" style={{ ['--c' as string]: r?.colour ?? '#888' }}>{r?.number}</span>
                <span className="bd-dest">
                  <span className="bd-towards">{dest}</span>
                  {(note || (a.load !== null && a.capacity)) && (
                    <span className="bd-meta">
                      {note && <span className={`bd-note ${note.cls}`}>{note.text}</span>}
                      {a.load !== null && a.capacity ? <Pips load={a.load} cap={a.capacity} /> : null}
                    </span>
                  )}
                </span>
                <span className={`bd-time ${t.due ? 'due' : ''}`}>
                  {t.text}
                  {t.unit && <small>{t.unit}</small>}
                </span>
              </>
            );
            return a.veh ? (
              <button
                key={`${a.trip}-${a.eta}`}
                type="button"
                className={`bd-row ${unassigned ? 'dim' : ''}`}
                aria-label={label}
                onClick={() => {
                  useUI.getState().select({ kind: 'vehicle', id: a.veh! });
                  focusVehicle(a.veh!);
                }}
              >
                {body}
              </button>
            ) : (
              <div key={`${a.trip}-${a.eta}`} className="bd-row static dim" role="group" aria-label={label}>
                {body}
              </div>
            );
          })
        )}
      </div>
      <footer className="bd-foot">Predicted from the live simulation</footer>
    </section>
  );
}

export function VehicleStops({ vehicleId }: { vehicleId: string }) {
  const game = useGameUpdates(4);
  if (!game) return null;
  const v = game.state.vehicles[vehicleId];
  const list = v ? vehicleStops(game, v) : [];
  const shown = list.slice(0, 5);
  const more = list.length - shown.length;
  return (
    <section className="board compact" aria-label="Upcoming stops">
      <div className="bd-rows">
        {shown.length === 0 ? (
          <p className="bd-empty">Not in service</p>
        ) : (
          shown.map((s) => {
            const name = game.state.stops[s.stop]?.name ?? 'Stop';
            const lbl = minuteLabel(s.eta, game.t);
            return (
              <button
                key={`${s.index}-${s.stop}`}
                type="button"
                className="bd-row"
                aria-label={`${name}, ${lbl}`}
                onClick={() => {
                  useUI.getState().select({ kind: 'stop', id: s.stop });
                  focusStop(s.stop);
                }}
              >
                <span className="bd-towards">{name}</span>
                <span className={`bd-time ${lbl === 'Now' ? 'due' : ''}`}>{lbl}</span>
              </button>
            );
          })
        )}
        {more > 0 && <p className="bd-more">+{more} more</p>}
      </div>
      <footer className="bd-foot">Predicted from the live simulation</footer>
    </section>
  );
}
