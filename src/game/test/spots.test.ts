import { describe, expect, it } from 'vitest';
import { newGame, region } from './helpers.ts';
import { stopSpots, MAIN_GAP } from '../spots.ts';
import { checkStop } from '../network.ts';
import { distanceM, nearestNode } from '../world/graph.ts';

describe('stop spots', () => {
  const r = region();
  const spots = stopSpots(r);
  const gen = spots.filter((s) => !s.osm);

  it('include every real stop from OpenStreetMap, plus generated ones', () => {
    expect(spots.filter((s) => s.osm).length).toBe(r.osmStops.length);
    expect(gen.length).toBeGreaterThan(20);
    console.log(`spots: ${r.osmStops.length} real + ${gen.length} generated`);
  });

  it('keep generated spots apart from every other spot', () => {
    for (const s of gen)
      for (const o of spots) if (o !== s) expect(distanceM(s.lngLat, o.lngLat)).toBeGreaterThan(MAIN_GAP - 1);
  });

  it('are buildable when the area is licensed', () => {
    const g = newGame();
    const ok = spots.filter((s) => checkStop(g.state, g.region, g.geo, s.lngLat).ok).length;
    console.log(`buildable: ${ok}/${spots.length}`);
    expect(ok / spots.length).toBeGreaterThan(0.9);
    // generated spots sit on stop-capable roads by construction
    for (const s of gen) expect(checkStop(g.state, g.region, g.geo, s.lngLat).ok).toBe(true);
  });

  it('leave almost nobody a bus could reach far from a spot', () => {
    const d = r.demand;
    const g = newGame();
    let total = 0, covered = 0;
    for (let j = 0; j < d.h; j++)
      for (let i = 0; i < d.w; i++) {
        const k = j * d.w + i;
        const v = d.residents[k] + d.jobs[k];
        if (!v) continue;
        const x = d.x0 + (i + 0.5) * d.cell, y = d.y0 + (j + 0.5) * d.cell;
        // homes across the water from the road network (e.g. Üsküdar) cannot be served at all
        if (nearestNode(r.graph, r.index, x, y, 250) < 0) continue;
        const ll = g.geo.P.toLngLat(x, y);
        total += v;
        if (spots.some((s) => distanceM(s.lngLat, ll) < 500)) covered += v;
      }
    console.log(`reachable homes + jobs within 500 m of a spot: ${((100 * covered) / total).toFixed(1)}%`);
    expect(covered / total).toBeGreaterThan(0.97);
  });
});
