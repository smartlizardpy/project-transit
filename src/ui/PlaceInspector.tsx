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

type Icon = ComponentType<{ size?: number; weight?: 'fill' | 'bold' | 'regular' }>;
export const PLACE_ICON: Record<PlaceCategory, Icon> = {
  airport: Airplane, rail_station: Train, metro_station: Subway, tram_stop: Tram, ferry_pier: Boat, bus_station: Bus, cable_car: CableCar,
  hospital: Hospital, university: GraduationCap, school: Student, stadium: SoccerBall, venue: MaskHappy, mall: ShoppingBag, market: Storefront,
  nightlife: Martini, hotel_area: Bed, attraction: Bank, park: Tree, beach: Waves, industrial: Factory,
};

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

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
