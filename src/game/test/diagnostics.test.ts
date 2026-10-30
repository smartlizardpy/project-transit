// Route diagnostics on real map data: measurements, causes found by counterfactual routing,
// fixes evaluated on the road graph, commit, undo and redo. İstanbul (bundled tiles) always runs;
// Barcelona El Born runs when its tiles have been fetched (node scripts/dev/fetch-test-tiles.mjs).
import { describe, expect, it } from 'vitest';
import { Game, newGameState } from '../engine.ts';
import { buildPatterns, checkStop } from '../network.ts';
import { EDGE_ONEWAY, distanceM, edgeBetween, isContraflow, route, type LngLat } from '../world/graph.ts';
import { applyFix, legGeometry, lineDiagnostics, lineStats, routeShape, routeTarget, shortestPath, suggestFixes, tradeoffs, type Diagnostic, type LineShape } from '../diagnostics.ts';
import { newGame } from './helpers.ts';
import { post } from '../finance.ts';
import { BARCELONA_BORN_SPEC, hasTiles, tileRegion } from './tileFixtures.ts';
import type { Id } from '../types.ts';

const osmStop = (game: Game, name: string, near?: LngLat): LngLat => {
  const c = game.region.osmStops.filter((s) => s.name === name).sort((a, b) => (near ? distanceM(a.lngLat, near) - distanceM(b.lngLat, near) : 0));
  if (!c.length) throw new Error(`no OSM stop named ${name}`);
  return c[0].lngLat;
};
const place = (game: Game, at: LngLat): Id => {
  const r = game.placeStop(at);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const shapeOf = (game: Game, id: Id): LineShape => {
  const r = game.state.routes[id];
  return { id, number: r.number, colour: r.colour, kind: r.kind, stops: r.stops, returnStops: r.returnStops, via: r.via };
};
const detours = (game: Game, id: Id) => (game.patterns.get(id) ?? []).flatMap((p) => p.diagnostics).filter((d) => d.kind === 'detour');
const snapshot = (game: Game) => JSON.stringify([game.state.routes, game.state.stops, game.state.finance.balance]);

/** The blocking street coordinates run along real one-way edges in their permitted direction. */
function expectPermittedDirection(game: Game, d: Diagnostic) {
  const g = game.region.graph;
  const [x, y] = [(ll: LngLat) => game.geo.xy(ll)[0], (ll: LngLat) => game.geo.xy(ll)[1]];
  for (const street of d.cause!.blocking) {
    expect(street.coords.length).toBeGreaterThan(1);
    for (let i = 0; i + 1 < street.coords.length; i++) {
      // nodes at these positions, joined by an edge that is one-way a → b
      const a = street.coords[i], b = street.coords[i + 1];
      const na = [...Array(g.n).keys()].find((v) => Math.abs(g.x[v] - x(a)) < 0.01 && Math.abs(g.y[v] - y(a)) < 0.01);
      const nb = [...Array(g.n).keys()].find((v) => Math.abs(g.x[v] - x(b)) < 0.01 && Math.abs(g.y[v] - y(b)) < 0.01);
      if (na === undefined || nb === undefined) continue; // merged streets may jump between runs
      const de = edgeBetween(g, na, nb);
      if (de < 0) continue;
      expect(g.flags[de >> 1] & EDGE_ONEWAY).toBeTruthy();
      expect(isContraflow(g, de)).toBe(false);
    }
  }
}

describe('route diagnostics (İstanbul)', () => {
  it('measures a one-way detour in Beyoğlu and finds its cause by counterfactual routing', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const a = place(game, osmStop(game, 'İplikçi', [28.9709, 41.0381]));
    const b = place(game, osmStop(game, 'Ahmet Emin Yalman İlköğretim Okulu', [28.9697, 41.0343]));
    const r = game.createRoute({ stops: [a, b], kind: 'linear' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pats = game.patterns.get(r.value)!;
    const d = pats.flatMap((p) => p.diagnostics).find((x) => x.kind === 'detour' && x.stops[0] === a)!;
    expect(d).toBeTruthy();
    const p = pats[d.pat!];
    // measurements are the real ones: straight line between the stops and the routed path
    const A = game.state.stops[a], B = game.state.stops[b];
    expect(d.measure!.directM).toBeCloseTo(distanceM(A.lngLat, B.lngLat), 3);
    expect(d.measure!.roadM).toBeCloseTo(p.stopS[d.leg! + 1] - p.stopS[d.leg!], 3);
    expect(d.measure!.extraM).toBeCloseTo(d.measure!.roadM - d.measure!.directM, 3);
    // the legacy warning text is kept for compatibility and matches the diagnostic
    expect(p.warnings).toContain(d.text);
    expect(d.text).toMatch(/^İplikçi → Ahmet Emin Yalman İlköğretim Okulu: one-way streets force a \d\.\d km detour for \d+ m\./);
    // cause: legal routing is no shorter, ignoring one-way rules is much shorter
    const c = d.cause!;
    expect(c.kind).toBe('oneway');
    expect(c.legalM!).toBeGreaterThan(d.measure!.roadM * 0.95);
    expect(c.onewayFreeM!).toBeLessThan(d.measure!.roadM * 0.5);
    expect(c.blocking.length).toBeGreaterThan(0);
    for (const s of c.blocking) expect(s.name.length).toBeGreaterThan(2);
    expect(d.explanation).toMatch(/one-way/);
    expectPermittedDirection(game, d);
    // the span is the leg inside the path, from halt to halt
    expect(p.path.nodes[d.span![0]]).toBe(p.stopNodes[d.leg!]);
    expect(p.path.nodes[d.span![1]]).toBe(p.stopNodes[d.leg! + 1]);
    const geo = legGeometry(game.region.graph, game.state, d, p);
    expect(geo.leg.length).toBe(d.span![1] - d.span![0] + 1);
    expect(geo.direct).toEqual([A.lngLat, B.lngLat]);
    expect(geo.frame.length).toBeGreaterThan(4);
    expect(d.fixes).toContain('other-stop');
  });

  it('counterfactual shortest paths are consistent with the bus router', () => {
    const game = newGame();
    const g = game.region.graph;
    let checked = 0;
    for (let k = 0; k < 400 && checked < 25; k++) {
      const a = (k * 7919) % g.n, b = (k * 104729 + 17) % g.n;
      if (Math.hypot(g.x[a] - g.x[b], g.y[a] - g.y[b]) > 1500) continue;
      const bus = route(g, a, b);
      const legal = shortestPath(g, [a], [b]);
      const free = shortestPath(g, [a], [b], { ignoreOneway: true });
      if (!bus || !legal || !free) continue;
      expect(legal.metres).toBeLessThanOrEqual(bus.metres + 0.5);
      expect(free.metres).toBeLessThanOrEqual(legal.metres + 0.5);
      expect(legal.dedges.some((de) => isContraflow(g, de))).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('suggests only fixes that really shorten the line, and commits, undoes and redoes them', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const a = place(game, osmStop(game, 'İplikçi', [28.9709, 41.0381]));
    const b = place(game, osmStop(game, 'Ahmet Emin Yalman İlköğretim Okulu', [28.9697, 41.0343]));
    const r = game.createRoute({ stops: [a, b], kind: 'linear' });
    if (!r.ok) throw new Error(r.error);
    const id = r.value;
    const d = detours(game, id).find((x) => x.stops[0] === a)!;
    const base = shapeOf(game, id);
    const before = snapshot(game);
    const plans = suggestFixes(game, base, d);
    // previewing never changes the game (nothing is committed before confirmation)
    expect(snapshot(game)).toBe(before);
    expect(plans.length).toBeGreaterThan(0);
    const len0 = routeShape(game, base).reduce((s, p) => s + p.path.length, 0);
    for (const p of plans) {
      expect(p.savedM).toBeGreaterThan(150);
      // re-route the plan independently with the engine's own preview
      const st = lineStats(game, p.shape, p.moves, p.builds);
      expect(st.valid).toBe(true);
      expect(st.totalM).toBeCloseTo(p.totalM, 0);
      expect(st.totalM).toBeLessThan(len0);
    }
    expect(snapshot(game)).toBe(before);
    const plan = plans[0];
    const s0 = lineStats(game, base), s1 = lineStats(game, plan.shape, plan.moves, plan.builds);
    expect(s1.totalM).toBeLessThan(s0.totalM);
    expect(tradeoffs(game, plan, s0, s1).join(' ')).toMatch(/shorter per round trip/);
    // commit
    const applied = applyFix(game, base, plan, routeTarget(game, id, base));
    if (typeof applied === 'string') throw new Error(applied);
    const after = game.patterns.get(id)!.reduce((s, p) => s + p.path.length, 0);
    expect(after).toBeCloseTo(s1.totalM, 0);
    // undo restores the line exactly
    expect(applied.undo()).toBeNull();
    expect(game.patterns.get(id)!.reduce((s, p) => s + p.path.length, 0)).toBeCloseTo(len0, 3);
    expect(JSON.stringify(shapeOf(game, id))).toBe(JSON.stringify(base));
    // redo applies it again
    expect(applied.redo()).toBeNull();
    expect(game.patterns.get(id)!.reduce((s, p) => s + p.path.length, 0)).toBeCloseTo(after, 3);
  });

  it('moving a shared stop reports the other lines it changes', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const a = place(game, osmStop(game, 'İplikçi', [28.9709, 41.0381]));
    const b = place(game, osmStop(game, 'Ahmet Emin Yalman İlköğretim Okulu', [28.9697, 41.0343]));
    const r1 = game.createRoute({ stops: [a, b], kind: 'linear' });
    const c = place(game, osmStop(game, 'Kasımpaşa', [28.9685, 41.0322]));
    const r2 = game.createRoute({ stops: [b, c], kind: 'linear' });
    if (!r1.ok || !r2.ok) throw new Error('lines');
    const d = detours(game, r1.value).find((x) => x.stops[0] === a)!;
    const base = shapeOf(game, r1.value);
    const moves = suggestFixes(game, base, { ...d, fixes: ['move-stop'] }, { maxPlans: 8 }).filter((p) => p.kind === 'move-stop');
    const shared = moves.find((p) => b in p.moves) ?? moves[0];
    if (!shared) return; // no better position nearby: nothing to report
    const s0 = lineStats(game, base), s1 = lineStats(game, shared.shape, shared.moves, shared.builds);
    const text = tradeoffs(game, shared, s0, s1).join(' ');
    if (b in shared.moves) expect(text).toMatch(new RegExp(`also changes line ${game.state.routes[r2.value].number}`));
    else expect(text).toMatch(/used by no other line/);
    expect(checkStop(game.state, game.region, game.geo, Object.values(shared.moves)[0].lngLat, Object.keys(shared.moves)[0]).ok).toBe(true);
  });

  it('a line with too few buses gets a timetable diagnostic', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const a = place(game, osmStop(game, 'İplikçi', [28.9709, 41.0381]));
    const b = place(game, osmStop(game, 'Ahmet Emin Yalman İlköğretim Okulu', [28.9697, 41.0343]));
    const r = game.createRoute({ stops: [a, b], kind: 'linear' });
    if (!r.ok) throw new Error(r.error);
    const d = lineDiagnostics(game, r.value).find((x) => x.kind === 'insufficient-buses');
    expect(d?.fixes).toEqual(['timetable', 'assign-buses']);
    expect(d?.text).toMatch(/None are assigned/);
  });
});

describe('routing defects found by the diagnostics', () => {
  it('a stop on a divided road uses the halt that suits the next leg too', () => {
    // Pertevniyal Valide Sultan (Fatih) has a halt on each carriageway. Choosing the halt only by
    // the leg into the stop sent buses off the far side and round a long loop.
    const game = newGame({ extraFunds: 1_000_000 });
    const ids = [[28.95731, 41.01319], [28.95325, 41.0117], [28.95092, 41.00927]].map((ll) => place(game, ll as LngLat));
    const mid = game.state.stops[ids[1]];
    expect(mid.alt).toBeGreaterThanOrEqual(0);
    const r = game.createRoute({ stops: ids, kind: 'linear' });
    if (!r.ok) throw new Error(r.error);
    for (const p of game.patterns.get(r.value)!) {
      // the pattern is as short as the better of the two halts forced (within a few percent)
      const forced = [mid.node, mid.alt!].map((h) => {
        const st = { ...game.state, stops: { ...game.state.stops, [mid.id]: { ...mid, node: h, alt: -1 } } };
        return buildPatterns(st, game.region, game.geo, game.state.routes[r.value], { diagnostics: false })[p.index].path.length;
      });
      expect(p.path.length).toBeLessThanOrEqual(Math.min(...forced) * 1.05 + 30);
    }
  });

  it('stop positions come from where each leg ends, even when a waypoint takes the bus past the stop and back', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const g = game.region.graph;
    // a straight run of a two-way main road: A … B … W (waypoint beyond B)
    let found = false;
    for (let e = 0; e < g.m && !found; e++) {
      if (g.cls[e] < 2 || g.cls[e] > 3 || g.flags[e] & EDGE_ONEWAY) continue;
      const a = g.ea[e];
      for (let f = e + 1; f < Math.min(g.m, e + 4000) && !found; f += 7) {
        const w = g.eb[f];
        const dist = Math.hypot(g.x[w] - g.x[a], g.y[w] - g.y[a]);
        if (dist < 700 || dist > 1000) continue;
        const l = route(g, a, w);
        if (!l || l.metres > dist * 1.08 || l.dedges.some((de) => g.flags[de >> 1] & EDGE_ONEWAY)) continue;
        const bNode = l.nodes[Math.floor(l.nodes.length / 2)];
        const sa = game.placeStop([g.lng[a], g.lat[a]]), sb = game.placeStop([g.lng[bNode], g.lat[bNode]]);
        if (!sa.ok || !sb.ok) continue;
        if (game.state.stops[sb.value].node !== bNode || (game.state.stops[sb.value].alt ?? -1) >= 0) continue;
        const end = l.nodes[Math.floor(l.nodes.length * 0.2)];
        const sc = game.placeStop([g.lng[end] + 0.004, g.lat[end] + 0.004]);
        if (!sc.ok) continue;
        const r = game.createRoute({ stops: [sa.value, sb.value, sc.value], kind: 'linear', via: { 'o:0': [[g.lng[w], g.lat[w]]] } });
        if (!r.ok) continue;
        const p = game.patterns.get(r.value)![0];
        const nodes = Array.from(p.path.nodes);
        const firstPass = nodes.indexOf(bNode);
        const viaAt = nodes.indexOf(w);
        if (firstPass < 0 || viaAt < 0 || firstPass > viaAt) continue;
        // B is served after the waypoint, where the leg really ends, not on the first pass
        expect(p.stopIdx[1]).toBeGreaterThan(viaAt);
        expect(p.path.nodes[p.stopIdx[1]]).toBe(p.stopNodes[1]);
        expect(p.stopS[1]).toBeCloseTo(p.path.cum[p.stopIdx[1]], 6);
        expect(p.stopS[1]).toBeGreaterThan(p.path.cum[viaAt]);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe.skipIf(!hasTiles(BARCELONA_BORN_SPEC))('route diagnostics (Barcelona, El Born)', () => {
  const setup = () => {
    const region = tileRegion(BARCELONA_BORN_SPEC);
    const home = region.zones.find((z) => /Ribera/.test(z.name))!.id;
    const state = newGameState({ region, company: { name: 'Test', colour: '#e0573e', logo: 0 }, homeZone: home, seed: 7, startHour: 8 });
    state.territory.owned = region.zones.map((z) => z.id);
    post(state, { amt: 2_000_000, cat: 'grant', memo: 'Test funding' });
    const game = new Game(state, region);
    const born = place(game, osmStop(game, 'El Born - Ciutadella - Zoo'));
    const comerc = place(game, osmStop(game, 'Placeta del Comerç'));
    const r = game.createRoute({ stops: [born, comerc], kind: 'linear' });
    if (!r.ok) throw new Error(r.error);
    return { game, born, comerc, id: r.value };
  };

  it('reproduces the warning and explains it: Passeig de Picasso is one-way towards the sea', () => {
    const { game, born, comerc, id } = setup();
    const [out] = game.patterns.get(id)!;
    expect(out.warnings).toContain('El Born - Ciutadella - Zoo → Placeta del Comerç: one-way streets force a 1.5 km detour for 422 m. Consider a different stop or a separate return route.');
    const d = out.diagnostics.find((x) => x.kind === 'detour')!;
    expect(d.stops).toEqual([born, comerc]);
    expect(Math.round(d.measure!.directM)).toBe(422);
    expect(d.measure!.roadM).toBeGreaterThan(1400);
    expect(d.measure!.roadM).toBeLessThan(1500);
    expect(d.cause!.kind).toBe('oneway');
    // legally there is no shorter way; ignoring one-way rules it is about the straight-line distance
    expect(d.cause!.legalM!).toBeGreaterThan(d.measure!.roadM - 5);
    expect(d.cause!.onewayFreeM!).toBeLessThan(450);
    const picasso = d.cause!.blocking.find((s) => s.name === 'Passeig de Picasso');
    expect(picasso?.allowed).toBe('south-east');
    expect(d.explanation).toMatch(/El Born - Ciutadella - Zoo is on a one-way street, so buses leave it heading south-east/);
    expectPermittedDirection(game, d);
    // the way back is short: the restriction only hurts this direction
    expect(game.patterns.get(id)![1].path.length).toBeLessThan(500);
    // camera target and overlay data
    const geo = legGeometry(game.region.graph, game.state, d, out);
    expect(geo.leg[0]).toEqual([game.region.graph.lng[out.stopNodes[0]], game.region.graph.lat[out.stopNodes[0]]]);
    expect(geo.stops.map((s) => s.label)).toEqual(['A', 'B']);
    expect(geo.blocking.length).toBeGreaterThan(0);
    for (const p of [game.state.stops[born].lngLat, game.state.stops[comerc].lngLat]) expect(geo.frame).toContainEqual(p);
  });

  it('finds real alternatives, previews before/after, and commits only on confirmation with undo', () => {
    const { game, born, id } = setup();
    const d = detours(game, id)[0];
    const base = shapeOf(game, id);
    const before = snapshot(game);
    const plans = suggestFixes(game, base, d, { maxPlans: 6 });
    expect(snapshot(game)).toBe(before);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].savedM).toBeGreaterThan(500);
    const s0 = lineStats(game, base);
    // every suggestion removes the detour when routed on the graph
    for (const p of plans) {
      const ps = routeShape(game, p.shape, p.moves, p.builds);
      expect(ps.every((x) => x.valid)).toBe(true);
      expect(ps.reduce((s, x) => s + x.path.length, 0)).toBeLessThan(s0.totalM - 500);
    }
    // stop repositioning: move El Born to a valid road position nearby
    const move = suggestFixes(game, base, { ...d, fixes: ['move-stop'] }).find((p) => p.kind === 'move-stop' && born in p.moves);
    expect(move).toBeTruthy();
    const target = move!.moves[born];
    expect(checkStop(game.state, game.region, game.geo, target.lngLat, born).ok).toBe(true);
    expect(distanceM(target.lngLat, game.state.stops[born].lngLat)).toBeLessThan(270);
    const s1 = lineStats(game, move!.shape, move!.moves);
    expect(s1.totalM).toBeLessThan(s0.totalM - 500);
    expect(s1.minutes).toBeLessThan(s0.minutes);
    expect(s1.stops).toBe(s0.stops);
    expect(s0.residents + s0.jobs).toBeGreaterThan(0);
    expect(snapshot(game)).toBe(before);
    // accept → the stop moves and the warning is gone
    const applied = applyFix(game, base, move!, routeTarget(game, id, base));
    if (typeof applied === 'string') throw new Error(applied);
    expect(distanceM(game.state.stops[born].lngLat, target.lngLat)).toBeLessThan(1);
    expect(game.patterns.get(id)!.reduce((s, p) => s + p.path.length, 0)).toBeCloseTo(s1.totalM, 0);
    // the leg is far shorter (a residual warning may remain; it is reported honestly)
    const outLen = () => game.patterns.get(id)![0].path.length;
    expect(outLen()).toBeLessThan(d.measure!.roadM - 500);
    // undo → exactly as before (cancel before accepting changes nothing at all, checked above)
    expect(applied.undo()).toBeNull();
    expect(snapshot(game)).toBe(before);
    expect(game.patterns.get(id)![0].warnings[0]).toMatch(/1\.5 km detour for 422 m/);
    expect(applied.redo()).toBeNull();
    expect(outLen()).toBeLessThan(d.measure!.roadM - 500);
  });
});
