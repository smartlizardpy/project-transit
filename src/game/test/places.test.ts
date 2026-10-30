// City Activity Engine, phase 1: the Place Registry built from the map tiles (airports,
// stations, destinations), its spatial index, and the place snapshot kept in the save.
import { describe, expect, it } from 'vitest';
import { istanbulRegion } from './fixtures.ts';
import { BARCELONA_AIRPORT_SPEC, BARCELONA_BORN_SPEC, hasTiles, tileRegion } from './tileFixtures.ts';
import { newGame, region } from './helpers.ts';
import { reload } from './determinism.ts';
import { buildRegion } from '../world/regionBuilder.ts';
import { ISTANBUL_SPEC } from './fixtures.ts';
import { PlaceIndex, placeSnapshot, SNAPSHOT_MAX, type CityPlace } from '../world/places.ts';
import { distanceM, projector, type LngLat } from '../world/graph.ts';
import { upgradeState } from '../upgrade.ts';
import type { GameState } from '../types.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const places = () => istanbulRegion().cityPlaces;
const named = (name: string, cat?: string) => places().find((p) => p.name === name && (!cat || p.category === cat));

describe('Place Registry (İstanbul tiles)', () => {
  it('lists both airports beyond the map, with measured passenger numbers', () => {
    const ist = places().find((p) => p.id === 'iata:IST')!;
    const saw = places().find((p) => p.id === 'iata:SAW')!;
    for (const a of [ist, saw]) {
      expect(a.category).toBe('airport');
      expect(a.reachable).toBe(false);
      expect(a.scale).toMatchObject({ unit: 'pax_year', measured: true, tier: 1 });
      expect(a.scale.source).toMatch(/^Wikidata, 20\d\d$/);
      expect(a.sources).toEqual(expect.arrayContaining(['ourairports', 'wikidata']));
      expect(a.distanceKm).toBeGreaterThan(25);
      expect(a.distanceKm).toBeLessThan(40);
    }
    expect(ist.scale.value).toBeGreaterThan(50e6);
  });

  it('merges stations into one place per station, with every mode that calls there', () => {
    const yenikapi = named('Yenikapı', 'rail_station')!;
    expect(yenikapi.modes).toEqual(expect.arrayContaining(['rail', 'metro']));
    expect(yenikapi.scale.tier).toBe(1);
    expect(yenikapi.access?.length).toBeGreaterThan(0); // metro entrances
    // the funiculars are mapped as railway stations; the tracks tell them apart from trains
    expect(named('Kabataş')!.modes).toEqual(['ferry', 'funicular']);
    expect(named('Taksim')!.modes).toEqual(expect.arrayContaining(['metro', 'funicular']));
    expect(places().filter((p) => p.name === 'Yenikapı' && p.category.endsWith('station'))).toHaveLength(1);
    // the busy piers rank above the small ones
    const piers = places().filter((p) => p.category === 'ferry_pier');
    expect(named('Eminönü', 'ferry_pier')!.scale.tier).toBe(2);
    expect(piers.some((p) => p.scale.tier === 3)).toBe(true);
  });

  it('merges points inside one outline into one place, and keeps junk names out', () => {
    // the models inside Miniatürk (an airport, Anıtkabir…) are not separate sights
    expect(places().filter((p) => ['Atatürk Havalimanı', 'Anıtkabir', 'TBMM'].includes(p.name))).toHaveLength(0);
    for (const p of places()) expect(p.name).toMatch(/\p{L}{3}/u);
    // in Turkish "market" alone is a grocery shop; markets are bazaars and street markets
    for (const p of places().filter((q) => q.category === 'market')) expect(p.name).toMatch(/pazar|çarşı|bazaar|bazar/i);
    // no two places of one category share a name within 250 m
    const P = projector(ISTANBUL_SPEC.centre);
    const list = places().map((p) => ({ p, xy: P.toXY(p.lngLat[0], p.lngLat[1]) }));
    for (const a of list)
      for (const b of list)
        if (a.p !== b.p && a.p.category === b.p.category && a.p.name === b.p.name) expect(Math.hypot(a.xy[0] - b.xy[0], a.xy[1] - b.xy[1])).toBeGreaterThan(250);
  });

  it('uses measured sizes from Wikidata where they exist and says when a size is an estimate', () => {
    const besiktas = places().find((p) => p.category === 'stadium' && p.scale.measured && p.scale.value > 40000);
    expect(besiktas?.scale.source).toMatch(/^Wikidata Q\d+/);
    const estimated = places().filter((p) => !p.scale.measured);
    expect(estimated.length).toBeGreaterThan(places().length * 0.8);
    for (const p of places()) {
      expect(p.scale.tier).toBeGreaterThanOrEqual(1);
      expect(p.scale.tier).toBeLessThanOrEqual(5);
      expect(p.scale.source.length).toBeGreaterThan(3);
      expect(p.sources.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.lngLat[0]) && Number.isFinite(p.lngLat[1])).toBe(true);
    }
  });

  it('has unique, stable ids and is the same on every build', () => {
    const ids = places().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const root = join(import.meta.dirname, '..', '..', '..', 'public', 'tiles', '14');
    const tiles = ISTANBUL_SPEC.tiles.map(([x, y]) => {
      const f = join(root, String(x), `${y}.pbf`);
      return { x, y, data: existsSync(f) ? new Uint8Array(readFileSync(f)) : null };
    });
    const t0 = performance.now();
    const again = buildRegion(ISTANBUL_SPEC, tiles).cityPlaces;
    console.log('region build with registry', Math.round(performance.now() - t0), 'ms;', again.length, 'places');
    expect(again).toEqual(places());
  });

  it('marks everything on the map reachable, and finds places by distance', () => {
    const r = istanbulRegion();
    for (const p of places().filter((q) => q.reachable)) {
      expect(p.lngLat[0]).toBeGreaterThanOrEqual(r.bounds.w);
      expect(p.lngLat[0]).toBeLessThanOrEqual(r.bounds.e);
    }
    const index = new PlaceIndex(places(), projector(ISTANBUL_SPEC.centre).toXY);
    const at: LngLat = [28.9744, 41.0166]; // Sirkeci
    const near = index.near(at, 600);
    expect(near.length).toBeGreaterThan(0);
    for (let i = 1; i < near.length; i++) expect(near[i].d).toBeGreaterThanOrEqual(near[i - 1].d);
    for (const q of near) expect(Math.abs(distanceM(at, q.place.lngLat) - q.d)).toBeLessThan(25);
    expect(near.every((q) => q.place.reachable)).toBe(true);
    expect(index.beyond()[0].id).toBe('iata:SAW');
  });
});

describe('place snapshot in the save', () => {
  it('keeps at most 300 significant places, every airport first, in under 50 KB', () => {
    const snap = placeSnapshot(places());
    expect(snap.significant.length).toBeLessThanOrEqual(SNAPSHOT_MAX);
    expect(snap.significant.slice(0, 4).map((p) => p.category)).toEqual(['airport', 'airport', 'airport', 'airport']);
    console.log('snapshot', JSON.stringify(snap).length, 'bytes');
    expect(JSON.stringify(snap).length).toBeLessThan(50_000);
    expect(placeSnapshot(places().slice().reverse())).toEqual(snap);
  });

  it('is written for new games, kept on reload, and filled for upgraded saves', () => {
    const game = newGame({ seed: 4 });
    expect(game.state.world.places.digest).toBe(placeSnapshot(region().cityPlaces).digest);
    expect(reload(game).state.world.places).toEqual(game.state.world.places);
    const old = JSON.parse(game.serialize()) as GameState;
    delete (old as Partial<GameState>).world;
    old.version = 2;
    const up = upgradeState(old);
    expect(up.world.places.significant).toEqual([]);
    const loaded = reload({ serialize: () => JSON.stringify(up) } as never);
    expect(loaded.state.world.places).toEqual(game.state.world.places);
  });

  it('changes its digest when the places change', () => {
    const changed: CityPlace[] = places().map((p, i) => (i === 0 ? { ...p, scale: { ...p.scale, tier: p.scale.tier === 1 ? 2 : 1 } } : p));
    expect(placeSnapshot(changed).digest).not.toBe(placeSnapshot(places()).digest);
  });
});

describe.skipIf(!hasTiles(BARCELONA_AIRPORT_SPEC))('Place Registry (Barcelona airport tiles)', () => {
  it('anchors El Prat at the landside of a terminal, not between the runways', () => {
    const bcn = tileRegion(BARCELONA_AIRPORT_SPEC).cityPlaces.find((p) => p.id === 'iata:BCN')!;
    expect(bcn.reachable).toBe(true);
    expect(bcn.location).toBe('measured');
    const t1: LngLat = [2.0733, 41.2887], t2: LngLat = [2.0742, 41.3036];
    expect(Math.min(distanceM(bcn.lngLat, t1), distanceM(bcn.lngLat, t2))).toBeLessThan(1000);
    expect(bcn.scale).toMatchObject({ measured: true, tier: 1 });
  });
});

describe.skipIf(!hasTiles(BARCELONA_BORN_SPEC))('Place Registry (Barcelona, El Born tiles)', () => {
  it('finds the beaches and lists El Prat beyond the map', () => {
    const list = tileRegion(BARCELONA_BORN_SPEC).cityPlaces;
    expect(list.filter((p) => p.category === 'beach').length).toBeGreaterThan(0);
    const bcn = list.find((p) => p.id === 'iata:BCN')!;
    expect(bcn.reachable).toBe(false);
    expect(bcn.distanceKm).toBeGreaterThan(8);
  });
});
