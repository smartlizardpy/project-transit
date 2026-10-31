// The place card: an airport, station or destination from the Place Registry, its size and
// where that figure comes from, and which of your stops are within a walk of it.
// See docs/city-activity-engine-plan.md, section 13.
import type { ComponentType } from 'react';
import {
  Airplane, Train, Subway, Tram, Boat, Bus, CableCar, Hospital, GraduationCap, Student, SoccerBall, MaskHappy, ShoppingBag, Storefront,
  Martini, Bed, Bank, Tree, Waves, Factory, Crosshair, MapPin, Info,
} from '@phosphor-icons/react';
import { useUI } from '../state/store.ts';
import { useGameUpdates } from './hooks.ts';
import { LineBadge } from './primitives.tsx';
import { focusPoint } from './camera.ts';
import { STOP_RULES } from '../game/content.ts';
import { describeScale, MODE_LABEL, PLACE_LABEL, placeCredits, TIER_LABEL, walkDistanceM, type PlaceCategory } from '../game/world/places.ts';
import { placeDay, placeTravel, stationLinks } from '../game/analytics/query.ts';
import { marketDayOf, placeNote, PROFILE, profileOf } from '../game/activity/profiles.ts';
import { TRANSIT_SERVICE } from '../game/activity/transit.ts';
import type { CityPlace } from '../game/world/places.ts';
import { approx, share } from './network/common.tsx';
import type { Game } from '../game/engine.ts';
import { EVENT_TEMPLATES, actualEnd, whenLabel, type GameEvent } from '../game/events.ts';
import { hhmm } from '../game/time.ts';

type Icon = ComponentType<{ size?: number; weight?: 'fill' | 'bold' | 'regular' }>;
export const PLACE_ICON: Record<PlaceCategory, Icon> = {
  airport: Airplane, rail_station: Train, metro_station: Subway, tram_stop: Tram, ferry_pier: Boat, bus_station: Bus, cable_car: CableCar,
  hospital: Hospital, university: GraduationCap, school: Student, stadium: SoccerBall, venue: MaskHappy, mall: ShoppingBag, market: Storefront,
  nightlife: Martini, hotel_area: Bed, attraction: Bank, park: Tree, beach: Waves, industrial: Factory,
};

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

const TRAVEL_MODES = [
  { i: 4, label: 'Your network' },
  { i: 5, label: 'Metro, tram, ferry' },
  { i: 0, label: 'Walk' },
  { i: 1, label: 'Bike' },
  { i: 2, label: 'Car' },
  { i: 3, label: 'Taxi' },
];

/** Modelled trips a day to and from the place by mode, and your share (an estimate). */
function HowPeopleTravel({ game, id, beyond }: { game: Game; id: string; beyond: boolean }) {
  const t = placeTravel(game, id);
  if (!t) return null;
  const count = (v: number) => approx(v).toLocaleString('en-GB');
  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 6, minHeight: 0 }}>
        <div className="label grow">How people travel here</div>
        <span className="pn-tag nc-tag-est">Estimate</span>
      </div>
      {t.trips < 1 ? (
        <div className="faint" style={{ fontSize: 12 }}>The model expects almost no trips between here and your areas today.</div>
      ) : (
        <>
          <div className="t" style={{ fontSize: 15, fontWeight: 800 }}>About {count(t.trips)} trips a day</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>
            {beyond ? 'From and to your areas' : 'To and from here, from and to your areas'}
            {t.modes[4] >= 1 ? `; about ${count(t.modes[4])} by your network.` : '; none by your network.'}
          </div>
          <div className="mini-list">
            {TRAVEL_MODES.map((m) => (
              <div className="mini-row" key={m.i} style={{ minHeight: 26 }}>
                <span className="t" style={{ flex: 1 }}>{m.label}</span>
                <span className="faint num" style={{ fontSize: 12, minWidth: 56, textAlign: 'right' }}>{t.modes[m.i] >= 0.5 ? count(t.modes[m.i]) : '—'}</span>
                <span className="num" style={{ fontSize: 12, minWidth: 38, textAlign: 'right' }}>{share(t.modes[m.i], t.trips)}</span>
              </div>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            Modelled for today, not journeys carried. Metro, tram and ferry use the city’s mapped network with assumed speeds and waits.
          </div>
        </>
      )}
    </div>
  );
}


/** What today's calendar means for this place, or '' on an ordinary day. */
function todayAt(game: Game, p: CityPlace): string {
  const d = game.dayTypeAt();
  switch (p.category) {
    case 'school':
      return d.school ? 'Today is a school day.' : d.weekend ? 'No school at the weekend.' : d.holiday ? 'Public holiday: no school today.' : 'School holidays: no school today.';
    case 'university':
      if (d.uni === 'break') return 'Summer break: nearly empty.';
      if (d.weekend || d.holiday) return d.holiday ? 'Public holiday: few students today.' : 'Weekend: few students.';
      return d.uni === 'exams' ? 'Exam week: quieter and more spread out.' : 'Teaching week.';
    case 'market':
      if (profileOf(p) !== PROFILE.bazaar) return d.weekday === marketDayOf(p) ? 'Market day today.' : '';
      return d.weekday === 6 ? 'Sunday: quiet today.' : d.holiday ? 'Public holiday today.' : '';
    case 'mall':
      return d.shops < 0.2 ? 'Shops are shut today (Sunday trading rules).' : d.holiday ? 'Public holiday today.' : '';
    default:
      return d.holiday ? 'Public holiday today.' : '';
  }
}

/** When the place is busy: today's trips to and from it by hour (places with a zone), and its typical pattern. */
function WhenBusy({ game, p }: { game: Game; p: CityPlace }) {
  const note = placeNote(p);
  const today = todayAt(game, p);
  const day = p.reachable || p.category === 'airport' ? placeDay(game, p.id) : null;
  if (!note && !day) return null;
  const max = day ? Math.max(...day.hours) : 0;
  const now = Math.floor((game.t % 86400) / 3600);
  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 6, minHeight: 0 }}>
        <div className="label grow">When it’s busy</div>
        <span className="pn-tag">Typical pattern</span>
      </div>
      {today && <div className="t" style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{today}</div>}
      {day && max > 0 && (
        <>
          <div className="pc-busy" role="img" aria-label="Modelled trips to and from here by hour today">
            {day.hours.map((v, h) => <i key={h} className={h === now ? 'now' : ''} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />)}
          </div>
          <div className="pc-busy-axis faint"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        </>
      )}
      {note && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{note}</div>}
    </div>
  );
}

/** A station's links on the city's existing rail and ferry network (assumed service). */
function CityTransit({ game, p }: { game: Game; p: CityPlace }) {
  const t = stationLinks(game, p.id);
  if (!t || (!t.links.length && !t.off.length)) return null;
  const ui = useUI.getState();
  const modes = [...new Set(t.links.map((l) => l.mode))];
  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 6, minHeight: 0 }}>
        <div className="label grow">City transit</div>
        <span className="pn-tag">Assumed service</span>
      </div>
      {t.links.length > 0 && (
        <div className="mini-list">
          {t.links.slice(0, 8).map((l) => (
            <div className="mini-row" key={`${l.mode}|${l.place}`} style={{ minHeight: 26 }}>
              <button className="t grow" onClick={() => ui.select({ kind: 'place', id: l.place })}>
                {MODE_LABEL[l.mode]} to {l.name}
              </button>
              <span className="faint num" style={{ fontSize: 12 }}>{km(l.m)} · {Math.max(1, Math.round(l.min))} min</span>
            </div>
          ))}
        </div>
      )}
      {t.off.map((o) => (
        <div className="issue info" key={o.mode} style={{ marginTop: 6 }}><Info size={14} weight="bold" />{MODE_LABEL[o.mode]} is not in the model here. {o.reason}</div>
      ))}
      {modes.length > 0 && (
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          {modes.map((m) => `${MODE_LABEL[m]} every ${TRANSIT_SERVICE[m]?.wait ?? '?'} min at the peak, ${TRANSIT_SERVICE[m]?.kmh ?? '?'} km/h`).join('; ')} (assumed), 06:00 to midnight. It competes with your buses, and people can also ride your bus to a stop within 300 m of a station and change to it there.
        </div>
      )}
    </div>
  );
}

/** Events at the place: what is coming (announced), what is on, and how recent ones went. */
function PlaceEvents({ game, p }: { game: Game; p: CityPlace }) {
  const t = game.t;
  const mine = game.eventList().filter((ev) => ev.place === p.id && (ev.announced || ev.start <= t));
  if (!mine.length) return null;
  const now = mine.filter((ev) => !ev.cancelled && ev.start <= t && actualEnd(ev) > t);
  const next = mine.filter((ev) => ev.start > t).sort((a, b) => a.start - b.start).slice(0, 4);
  const past = mine.filter((ev) => actualEnd(ev) <= t).sort((a, b) => b.start - a.start).slice(0, 3);
  const row = (ev: GameEvent, status: React.ReactNode) => (
    <div className="mini-row" key={ev.id} style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div className="t" style={{ fontWeight: 700 }}>{EVENT_TEMPLATES[ev.kind].label}{ev.series ? `, day ${ev.series[0]} of ${ev.series[1]}` : ''}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          {whenLabel(ev, t, game.state.clock.startWeekday)}–{hhmm(actualEnd(ev))}
          {ev.people > 0 && ` · about ${ev.people.toLocaleString('en-GB')} expected`}
          {ev.reason && ` · ${ev.reason}`}
        </div>
      </div>
      {status}
    </div>
  );
  return (
    <div className="section">
      <div className="label" style={{ marginBottom: 6 }}>Events</div>
      <div className="mini-list">
        {now.map((ev) => row(ev, <span className="pill warn">On now</span>))}
        {next.map((ev) => row(ev, ev.cancelled ? <span className="pill">Called off</span> : <span className="pill info">Coming</span>))}
        {past.map((ev) =>
          row(
            ev,
            ev.cancelled ? (
              <span className="pill">Called off</span>
            ) : ev.people > 0 ? (
              <span className="faint num" style={{ fontSize: 12, textAlign: 'right' }}>
                {(ev.carried ?? 0).toLocaleString('en-GB')} journeys on your buses
                {ev.lost ? <><br />{ev.lost.toLocaleString('en-GB')} gave up or stranded</> : null}
              </span>
            ) : (
              <span className="pill">Over</span>
            ),
          ),
        )}
      </div>
      {next.some((ev) => !ev.cancelled) && (
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          Crowds arrive over the hours before and leave together at the end; roads nearby get busy and parking is scarce. Extra departures, spare buses or a match-day service plan carry more of them. Events bring no money of their own: only the fares of people who board.
        </div>
      )}
    </div>
  );
}

export function PlaceInspector({ id, close }: { id: string; close: React.ReactNode }) {
  const game = useGameUpdates(1);
  if (!game) return null;
  const p = game.geo.places.byId.get(id);
  if (!p)
    return (
      <div className="p-head">
        <div className="grow">
          <div className="p-title">Place</div>
          <div className="p-sub">Not on this map</div>
        </div>
        {close}
      </div>
    );
  const Icon = PLACE_ICON[p.category];
  const zone = p.reachable ? game.geo.zoneAt(p.lngLat) : null;
  const walk = STOP_RULES.catchmentM;
  const yours = Object.values(game.state.stops)
    .map((s) => ({ s, d: walkDistanceM(p, s.lngLat) }))
    .sort((a, b) => a.d - b.d || a.s.id.localeCompare(b.s.id));
  const near = yours.filter((x) => x.d <= walk).slice(0, 6);
  const nearest = yours[0];
  const ui = useUI.getState();
  return (
    <>
      <div className="p-head">
        <div className="stop-icon place"><Icon size={20} weight="fill" /></div>
        <div className="grow">
          <div className="p-title">{p.name}</div>
          <div className="p-sub">{PLACE_LABEL[p.category]}{zone ? ` · ${zone.name}` : ` · ${Math.round(p.distanceKm)} km away`}</div>
        </div>
        {close}
      </div>
      <div className="p-body">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-start', minHeight: 0 }}>
          <span className="pill">{TIER_LABEL[p.scale.tier - 1]}</span>
          {p.modes?.map((m) => <span className="pill info" key={m}>{MODE_LABEL[m]}</span>)}
          {p.codes?.iata && <span className="pill">{p.codes.iata}</span>}
        </div>
        <div className="section">
          <div className="label" style={{ marginBottom: 4 }}>Size</div>
          <div className="t" style={{ fontSize: 15, fontWeight: 800 }}>{describeScale(p.scale)}</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            {p.scale.measured ? `Measured: ${p.scale.source}.` : `Estimated ${p.scale.source}.`}
            {p.location === 'estimated' && ' The position is approximate.'}
          </div>
        </div>
        <div className="section">
          <div className="label" style={{ marginBottom: 6 }}>Your network</div>
          {!p.reachable ? (
            <div className="issue info"><Info size={14} weight="bold" />Beyond your map, {p.distanceKm} km from its centre. Your buses cannot reach it.</div>
          ) : near.length ? (
            <div className="mini-list">
              {near.map(({ s, d }) => (
                <div className="mini-row" key={s.id}>
                  <button className="t grow" onClick={() => ui.select({ kind: 'stop', id: s.id })}>
                    <MapPin size={13} weight="fill" /> {s.name}
                  </button>
                  <span className="faint num" style={{ fontSize: 12 }}>{km(d)}</span>
                  {game.routesUsing(s.id).slice(0, 3).map((r) => <LineBadge key={r.id} colour={r.colour}>{r.number}</LineBadge>)}
                </div>
              ))}
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 12 }}>
              None of your stops is within a {walk} m walk{nearest ? `. The nearest, ${nearest.s.name}, is ${km(nearest.d)} away.` : '.'}
            </div>
          )}
        </div>
        <PlaceEvents game={game} p={p} />
        <WhenBusy game={game} p={p} />
        <CityTransit game={game} p={p} />
        <HowPeopleTravel game={game} id={p.id} beyond={!p.reachable} />
        <div className="faint" style={{ fontSize: 11 }}>Data: {placeCredits(p).join(' · ')}</div>
      </div>
      {p.reachable && (
        <div className="p-foot">
          <button className="btn primary" style={{ flex: 1 }} onClick={() => { ui.setTool('stop'); focusPoint(p.lngLat, 16.6); }}>
            <MapPin size={16} weight="bold" /> Place a stop nearby
          </button>
          <button className="btn has-tip" onClick={() => focusPoint(p.lngLat, p.category === 'airport' ? 15 : 16.4)} aria-label="Show on map">
            <Crosshair size={16} weight="bold" />
          </button>
        </div>
      )}
    </>
  );
}
