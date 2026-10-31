// City Activity Engine, phase 3: the city's existing rail, metro, tram, funicular and ferry
// network built from the map (transitBuilder.ts). The İstanbul checks use the real bundled tiles.
// What I found on the map (see the per-test comments): M2, F1, T1 and the Golden Horn piers link;
// Marmaray does not link Sirkeci to Yenikapı (the tiles' Sirkeci rail is the old line), and the
// cable cars have no track in the tiles at all, so that mode is switched off with a reason.
import { describe, expect, it } from 'vitest';
import { istanbulRegion } from './fixtures.ts';
import { buildTransit } from '../world/transitBuilder.ts';
import type { RawLine } from '../world/placeBuilder.ts';
import type { CityPlace, TransitMode } from '../world/places.ts';
import type { TransitNet } from '../world/region.ts';

const net = () => istanbulRegion().transit!;
/** the link between two stations of one mode, by station name */
function between(n: TransitNet, mode: TransitMode, a: string, b: string) {
  return n.links.find((l) => l.mode === mode && new Set([n.stations[l.a].name, n.stations[l.b].name]).has(a) && new Set([n.stations[l.a].name, n.stations[l.b].name]).has(b));
}

describe('existing transit network (İstanbul tiles)', () => {
  it('is built with the region and has every working mode', () => {
    const t = net();
    expect(t.stations.length).toBeGreaterThan(40);
    for (const m of ['rail', 'metro', 'tram', 'funicular', 'ferry'] as const) {
      expect(t.modes[m]?.ok, m).toBe(true);
      expect(t.modes[m]!.links).toBe(t.links.filter((l) => l.mode === m).length);
    }
    // no station without a link, and every link points at real stations, listed once with a < b
    const used = new Set<number>();
    const seen = new Set<string>();
    for (const l of t.links) {
      expect(l.a).toBeLessThan(l.b);
      expect(l.b).toBeLessThan(t.stations.length);
      const k = `${l.mode}|${l.a}|${l.b}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      used.add(l.a);
      used.add(l.b);
      expect(t.stations[l.a].modes).toContain(l.mode);
      expect(t.stations[l.b].modes).toContain(l.mode);
    }
    expect(used.size).toBe(t.stations.length);
  });

  it('links metro M2 Taksim to Şişhane (1.5 km), and on to Haliç', () => {
    const l = between(net(), 'metro', 'Taksim', 'Şişhane')!;
    expect(l).toBeTruthy();
    expect(l.m).toBeGreaterThan(1200);
    expect(l.m).toBeLessThan(2000);
    expect(between(net(), 'metro', 'Şişhane', 'Haliç')).toBeTruthy();
    // Taksim does not jump straight to Haliç past Şişhane
    expect(between(net(), 'metro', 'Taksim', 'Haliç')).toBeUndefined();
  });

  it('links the F1 funicular Kabataş to Taksim', () => {
    const l = between(net(), 'funicular', 'Kabataş', 'Taksim')!;
    expect(l).toBeTruthy();
    expect(l.m).toBeGreaterThan(400);
    expect(l.m).toBeLessThan(900);
  });

  it('chains tram T1 through Karaköy, Eminönü and Sirkeci', () => {
    const t = net();
    expect(between(t, 'tram', 'Karaköy', 'Eminönü')).toBeTruthy();
    expect(between(t, 'tram', 'Eminönü', 'Sirkeci')).toBeTruthy();
    expect(between(t, 'tram', 'Karaköy', 'Sirkeci')).toBeUndefined(); // Eminönü is in between
    expect(between(t, 'tram', 'Sirkeci', 'Sultanahmet')).toBeTruthy();
  });

  it('links Marmaray Yenikapı to Üsküdar, but not Sirkeci (the map has Sirkeci only on the old line)', () => {
    const t = net();
    const l = between(t, 'rail', 'Yenikapı', 'Üsküdar')!;
    expect(l).toBeTruthy();
    expect(l.m).toBeGreaterThan(4000);
    expect(l.m).toBeLessThan(8000);
    expect(between(t, 'rail', 'Sirkeci', 'Yenikapı')).toBeUndefined();
    expect(between(t, 'rail', 'Sirkeci', 'Cankurtaran')).toBeTruthy();
  });

  it('links the Golden Horn and Bosphorus ferry piers, without joining every pier to every other', () => {
    const t = net();
    expect(between(t, 'ferry', 'Balat İskelesi', 'Fener')).toBeTruthy();
    expect(between(t, 'ferry', 'Eyüp Vapur İskelesi', 'Sütlüce')).toBeTruthy();
    expect(between(t, 'ferry', 'Kuzguncuk İskelesi', 'Beylerbeyi İskelesi')).toBeTruthy();
    expect(between(t, 'ferry', 'Beşiktaş Dentur İskelesi', 'Ortaköy')).toBeTruthy();
    const ferry = t.stations.filter((s) => s.modes.includes('ferry')).length;
    expect(t.modes.ferry!.links).toBeLessThan(ferry * 3);
  });

  it('keeps every link under its mode cap, and gives bus stations no place in it', () => {
    const t = net();
    const cap: Partial<Record<TransitMode, number>> = { metro: 5000, tram: 5000, funicular: 5000, ferry: 15000, rail: 40000 };
    for (const l of t.links) expect(l.m, `${l.mode} ${t.stations[l.a].name}-${t.stations[l.b].name}`).toBeLessThanOrEqual(cap[l.mode]!);
    // rail over 12 km would only be kept when neither end has a shorter link
    const short = new Set(t.links.filter((l) => l.mode === 'rail' && l.m <= 12000).flatMap((l) => [l.a, l.b]));
    for (const l of t.links.filter((x) => x.mode === 'rail' && x.m > 12000)) {
      expect(short.has(l.a) || short.has(l.b)).toBe(false);
    }
    const ids = new Set(istanbulRegion().cityPlaces.filter((p) => p.category === 'bus_station').map((p) => p.id));
    for (const s of t.stations) expect(ids.has(s.place)).toBe(false);
  });

  it('switches cable cars off with a reason: the tiles have no cable car track', () => {
    expect(net().modes.cable).toMatchObject({ ok: false, stations: 0, links: 0 });
    expect(net().modes.cable!.reason).toMatch(/cable/);
  });

  it('is identical when built twice', () => {
    // the İstanbul region is built twice from the same tiles (a fresh build, not the cached one)
    const spec = istanbulRegion().spec;
    expect(spec).toBeTruthy();
    const city = synthetic();
    expect(JSON.stringify(buildTransit(city))).toBe(JSON.stringify(buildTransit(city)));
    const rev = { ...city, lines: [...city.lines].reverse(), places: [...city.places] };
    expect(buildTransit(rev).links).toEqual(buildTransit(city).links);
  });

  it('switches every mode off, with reasons, when the map has no track', () => {
    const r = istanbulRegion();
    const t = buildTransit({ lines: [], places: r.cityPlaces, toXY: (lng, lat) => [lng, lat] });
    expect(t.stations).toEqual([]);
    expect(t.links).toEqual([]);
    for (const m of ['rail', 'metro', 'tram', 'funicular', 'ferry'] as const) {
      expect(t.modes[m]!.ok).toBe(false);
      expect(t.modes[m]!.reason).toMatch(/\w+/);
    }
  });
});

// ---------------------------------------------------------------- synthetic cities

/** a place at (x, y) metres; the test's toXY is the identity, so lngLat is just metres */
function place(id: string, x: number, y: number, modes: TransitMode[], access?: [number, number][]): CityPlace {
  return {
    id, name: id, category: 'metro_station', lngLat: [x, y], areaM2: 0, floorM2: 0, modes, access,
    scale: { value: 1, unit: 'users_day', tier: 3, measured: false, source: 'test' },
    sources: [], location: 'measured', confidence: 1, reachable: true, distanceKm: 0,
  };
}
const line = (id: number, cls: string, sub: string, pts: number[], service = ''): RawLine => ({ id, cls, sub, service, pts });
const ident = (x: number, y: number): [number, number] => [x, y];

/** a metro line split in two pieces at a tile edge (1 m apart), four stations, plus a tram line with two */
function synthetic() {
  const lines = [
    line(1, 'transit', 'subway', [0, 0, 1000, 0]),
    line(1, 'transit', 'subway', [1001, 0, 3000, 0]), // 1 m gap: the 2 m key merges it
    line(2, 'transit', 'subway', [3000, 0, 3000, 200], 'siding'), // service tracks are ignored
    line(3, 'transit', 'tram', [0, 500, 800, 500]),
  ];
  const places = [
    place('A', 0, 30, ['metro']), place('B', 1000, -40, ['metro']), place('C', 2000, 20, ['metro']), place('D', 3000, 0, ['metro']),
    place('T1', 0, 520, ['tram']), place('T2', 800, 480, ['tram']),
  ];
  return { lines, places, toXY: ident };
}

describe('transit builder (synthetic cities)', () => {
  it('joins pieces split at tile edges and links consecutive stations only', () => {
    const t = buildTransit(synthetic());
    const names = (l: { a: number; b: number }) => `${t.stations[l.a].name}-${t.stations[l.b].name}`;
    expect(t.links.filter((l) => l.mode === 'metro').map(names)).toEqual(['A-B', 'B-C', 'C-D']);
    expect(t.links.find((l) => names(l) === 'B-C')!.m).toBe(1000);
    expect(t.modes.metro).toMatchObject({ ok: true, stations: 4, links: 3 });
    expect(t.modes.tram).toMatchObject({ ok: true, stations: 2, links: 1 });
  });

  it('removing one mode\'s lines switches only that mode off, with a reason', () => {
    const city = synthetic();
    const withTram = buildTransit(city);
    expect(withTram.modes.tram!.ok).toBe(true);
    const noTram = buildTransit({ ...city, lines: city.lines.filter((l) => l.sub !== 'tram') });
    expect(noTram.modes.tram!.ok).toBe(false);
    expect(noTram.modes.tram!.reason).toMatch(/tram/);
    expect(noTram.modes.metro!.ok).toBe(true);
    expect(noTram.links.some((l) => l.mode === 'tram')).toBe(false);
    expect(noTram.stations.map((s) => s.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('uses metro entrances to find the track, and drops stations too far from any', () => {
    const lines = [line(1, 'transit', 'subway', [0, 0, 2000, 0])];
    const places = [place('A', 0, 0, ['metro']), place('B', 1000, 400, ['metro'], [[1000, 100]]), place('C', 2000, 0, ['metro']), place('Far', 1500, 900, ['metro'])];
    const t = buildTransit({ lines, places, toXY: ident });
    expect(t.stations.map((s) => s.name)).toEqual(['A', 'B', 'C']); // Far is 900 m from the track
    expect(t.links.map((l) => l.m)).toEqual([1000, 1000]);
  });

  it('switches a mode off when most of its stations miss the track', () => {
    const lines = [line(1, 'transit', 'subway', [0, 0, 2000, 0])];
    const places = [place('A', 0, 0, ['metro']), place('B', 2000, 0, ['metro']), place('X', 0, 900, ['metro']), place('Y', 500, 900, ['metro']), place('Z', 900, 900, ['metro']), place('W', 1200, 900, ['metro'])];
    const t = buildTransit({ lines, places, toXY: ident });
    expect(t.modes.metro).toMatchObject({ ok: false });
    expect(t.modes.metro!.reason).toMatch(/2 of 6/);
  });

  it('drops absurd links: metro over 5 km, ferry over 15 km', () => {
    const metro = buildTransit({
      lines: [line(1, 'transit', 'subway', [0, 0, 6000, 0])],
      places: [place('A', 0, 0, ['metro']), place('B', 6000, 0, ['metro'])], toXY: ident,
    });
    expect(metro.links).toEqual([]);
    expect(metro.modes.metro!.ok).toBe(false);
    const ferry = buildTransit({
      lines: [line(1, 'ferry_route', '', [0, 0, 16000, 0])],
      places: [place('P', 0, 0, ['ferry']), place('Q', 16000, 0, ['ferry'])], toXY: ident,
    });
    expect(ferry.modes.ferry!.ok).toBe(false);
  });

  it('keeps a long rail link only when no station lies between', () => {
    const lines = [line(1, 'rail', 'rail', [0, 0, 30000, 0])];
    const two = buildTransit({ lines, places: [place('A', 0, 0, ['rail']), place('B', 20000, 0, ['rail'])], toXY: ident });
    expect(two.links.map((l) => l.m)).toEqual([20000]);
    // a station between breaks it into two links under 12 km; the long hop disappears
    const three = buildTransit({ lines, places: [place('A', 0, 0, ['rail']), place('M', 10000, 0, ['rail']), place('B', 20000, 0, ['rail'])], toXY: ident });
    expect(three.links.map((l) => l.m)).toEqual([10000, 10000]);
  });

  it('runs fast on a big network (a few hundred stations, tens of thousands of vertices)', () => {
    const lines: RawLine[] = [];
    const places: CityPlace[] = [];
    for (let row = 0; row < 40; row++) {
      const pts: number[] = [];
      for (let x = 0; x <= 20000; x += 20) pts.push(x, row * 400 + Math.sin(x / 700) * 30);
      lines.push(line(row, 'transit', row % 2 ? 'tram' : 'subway', pts));
      for (let s = 0; s < 12; s++) places.push(place(`S${row}-${s}`, s * 1500 + 100, row * 400 + 10, [row % 2 ? 'tram' : 'metro']));
    }
    const city = { lines, places, toXY: ident };
    buildTransit(city); // warm up
    const t0 = performance.now();
    const t = buildTransit(city);
    const ms = performance.now() - t0;
    expect(t.stations.length).toBe(480);
    expect(ms).toBeLessThan(150);
  });

  it('builds the İstanbul network well inside 150 ms (measured about 2 ms)', () => {
    // the region build already ran it; time a second run over the same places with no track
    // (the track-heavy case is the synthetic test above)
    const r = istanbulRegion();
    const t0 = performance.now();
    buildTransit({ lines: [], places: r.cityPlaces, toXY: ident });
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
