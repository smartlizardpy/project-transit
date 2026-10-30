// The map grows as the company expands: areas stay fixed, and a running company moves onto
// the bigger map without its stops, lines or buses being disturbed.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegion } from '../world/regionBuilder.ts';
import { prepareRegion } from '../world/geo.ts';
import { Game, newGameState } from '../engine.ts';
import { post, reconcile } from '../finance.ts';
import { buildLine, region } from './helpers.ts';
import { ISTANBUL_SPEC } from './fixtures.ts';
import { moveToRegion } from '../growth.ts';
import { GROW_MARGIN, tilesNeeded, zoneId } from '../world/zoneTiles.ts';
import { distanceM, type LngLat } from '../world/graph.ts';
import { TripState } from '../types.ts';
import { HOUR } from '../content.ts';

function regionOf(tiles: [number, number][]) {
  const root = join(import.meta.dirname, '..', '..', '..', 'public', 'tiles', '14');
  const input = tiles.map(([x, y]) => {
    const f = join(root, String(x), `${y}.pbf`);
    return { x, y, data: existsSync(f) ? new Uint8Array(readFileSync(f)) : null };
  });
  return prepareRegion(buildRegion({ ...ISTANBUL_SPEC, tiles }, input));
}

describe('a growing map', () => {
  // the old 4×3 tile İstanbul map, and the current 6×5 one around it (same centre)
  const small = regionOf(ISTANBUL_SPEC.tiles.filter(([x, y]) => x >= 9509 && x <= 9512 && y >= 6140 && y <= 6142));
  const big = region();

  it('keeps every area fixed: the same tile has the same id and outline', () => {
    const inBig = new Map(big.zones.map((z) => [z.id, z]));
    expect(small.zones.length).toBe(12);
    for (const z of small.zones) expect(inBig.get(z.id)?.ring).toEqual(z.ring);
  });

  it('loads more map when the territory comes near the edge', () => {
    const [x, y] = small.spec.tiles[0];
    const need = tilesNeeded(small.spec, [zoneId(x, y)]);
    expect(need).not.toBeNull();
    const xs = need!.map((t) => t[0]), ys = need!.map((t) => t[1]);
    expect(Math.min(...xs)).toBe(x - GROW_MARGIN);
    expect(Math.min(...ys)).toBe(y - GROW_MARGIN);
    // a region never shrinks, and nothing is missing deep inside the big map
    for (const t of small.spec.tiles) expect(need!.some((u) => u[0] === t[0] && u[1] === t[1])).toBe(true);
    expect(tilesNeeded(big.spec, [zoneId(9510, 6140)])).toBeNull();
  });

  it('moves a running company onto the bigger map without disturbing it', () => {
    const st = newGameState({ region: small, company: { name: 'Grow Transit', colour: '#2f7fd6', logo: 0 }, homeZone: small.zones[0].id, seed: 9, startHour: 5 });
    st.territory.owned = small.zones.map((z) => z.id);
    post(st, { amt: 1_000_000, cat: 'grant', memo: 'Test funding' });
    const a = new Game(st, small);
    const { route, buses } = buildLine(a, { stops: 6, buses: 3, headway: 10 });
    a.run(2.5 * HOUR);
    const nodeAt = (r: typeof small, v: number): LngLat => [r.graph.lng[v], r.graph.lat[v]];
    const stopsBefore = Object.values(a.state.stops).map((s) => ({ id: s.id, at: nodeAt(small, s.node) }));
    const statuses = buses.map((id) => a.state.vehicles[id].status);
    const doneBefore = a.state.trips[route].filter((t) => t.state === TripState.Done).length;
    const balance = a.state.finance.balance;

    const state = JSON.parse(a.serialize());
    const lost = moveToRegion(state, small, big);
    const b = new Game(state, big);
    b.settleAfterGrowth();

    expect(lost).toBe(0);
    for (const s of stopsBefore) expect(distanceM(nodeAt(big, b.state.stops[s.id].node), s.at)).toBeLessThan(1);
    expect(buses.map((id) => b.state.vehicles[id].status)).toEqual(statuses);
    expect(b.state.finance.balance).toBe(balance);
    expect(b.patterns.get(route)!.every((p) => p.valid)).toBe(true);
    expect(b.audit()).toEqual([]);

    b.run(2 * HOUR);
    expect(b.state.trips[route].filter((t) => t.state === TripState.Done).length).toBeGreaterThan(doneBefore + 5);
    expect(b.audit()).toEqual([]);
    expect(reconcile(b.state).ok).toBe(true);
  });
});
