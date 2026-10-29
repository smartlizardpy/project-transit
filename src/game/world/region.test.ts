import { describe, it, expect } from 'vitest';
import { istanbulRegion } from '../test/fixtures.ts';

describe('region builder (Istanbul tiles)', () => {
  it('builds a plausible region', () => {
    const t0 = performance.now();
    const r = istanbulRegion();
    const ms = performance.now() - t0;
    console.log('build ms', Math.round(ms), 'nodes', r.graph.n, 'edges', r.graph.m, r.coverage);
    console.log('zones', r.zones.length, r.zones.map((z) => `${z.name}(${z.residents}/${z.jobs}, n${z.neighbours.length})`).join(', '));
    console.log('osm stops', r.osmStops.length, 'pois', r.pois.length, r.pois.slice(0, 12).map((p) => `${p.kind}:${p.name}`).join(', '));
    let res = 0, jobs = 0;
    for (let i = 0; i < r.demand.residents.length; i++) { res += r.demand.residents[i]; jobs += r.demand.jobs[i]; }
    console.log('residents', Math.round(res), 'jobs', Math.round(jobs), 'grid', r.demand.w, r.demand.h);
    expect(r.graph.n).toBeGreaterThan(1000);
    expect(r.zones.length).toBeGreaterThan(5);
  });
});
