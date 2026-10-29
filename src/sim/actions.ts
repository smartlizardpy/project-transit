// Player actions that mutate the prototype simulation.
import { sim, MODELS, type VehicleModel } from './sim.ts';
import { useUI } from '../state/store.ts';
import { cumulativeOf, type Line } from './network.ts';

export function assignDepotVehicle(lineId: string) {
  const line = sim.line(lineId);
  const v = sim.vehicles.find((x) => x.status === 'depot');
  if (!line || !v) return useUI.getState().notify('No buses in the depot. Buy one in the Fleet panel.', 'warn');
  const onLine = sim.vehicles.filter((x) => x.lineId === lineId);
  // insert into the largest gap so service stays even
  const ss = onLine.map((x) => ((x.s % line.length) + line.length) % line.length).sort((a, b) => a - b);
  let best = 0, gap = -1;
  for (let i = 0; i < ss.length; i++) {
    const a = ss[i], b = i + 1 < ss.length ? ss[i + 1] : ss[0] + line.length;
    if (b - a > gap) { gap = b - a; best = a + (b - a) / 2; }
  }
  v.lineId = lineId;
  v.status = 'running';
  v.s = best;
  v.nextStop = sim.nextStopIndex(line, best);
  v.occupancy = Math.round(MODELS[v.model].capacity * 0.1);
  line.fleetSize++;
  sim.emitNetwork();
  useUI.getState().notify(`Bus ${v.fleetNo} now runs on line ${line.number}`, 'good');
}

export function buyVehicle(model: VehicleModel) {
  const spec = MODELS[model];
  if (sim.funds < spec.price) return useUI.getState().notify('Not enough funds for this vehicle.', 'warn');
  sim.funds -= spec.price;
  const n = sim.vehicles.length + 1;
  sim.vehicles.push({
    id: `V${n}`, fleetNo: `34-${String(100 + n * 7).padStart(3, '0')}`, model, lineId: null, s: 0, v: 0, dwell: 0, nextStop: 0,
    occupancy: 0, status: 'depot', delayMin: 0, condition: 1, ageYears: 0, odometerKm: 12,
  });
  sim.emitNetwork();
  useUI.getState().notify(`${model} delivered to Kasımpaşa depot · −₺${(spec.price / 1e6).toFixed(1)}M`, 'good');
}

const NEXT_NUMBERS = ['52', '54', '61', '68', '73'];
export const DRAFT_COLOURS = ['#4fa3e0', '#e0667c', '#3fae7a', '#d08a3c', '#5d6bd6'];

export function nextLineNumber() {
  return NEXT_NUMBERS[sim.lines.filter((l) => l.draft).length % NEXT_NUMBERS.length];
}

export function createLine(opts: { number: string; colour: string; stops: { name: string; lngLat: [number, number]; stopId?: string }[]; path: [number, number][]; stopDistances: number[] }): Line {
  const id = `L${opts.number}`;
  const cumulative = cumulativeOf(opts.path);
  const line: Line = {
    id, number: opts.number, name: `${opts.stops[0].name} – ${opts.stops[opts.stops.length - 1].name}`, colour: opts.colour,
    stops: [], path: opts.path, cumulative, length: cumulative[cumulative.length - 1], fleetSize: 0, headwayMin: 10,
    service: ['06:00', '22:00'], fare: 27, draft: true,
    perf: { profitPerDay: 0, load: 0, satisfaction: 0.7, ridersPerDay: 0, onTime: 1, issue: 'New line: ridership builds up over the next days' },
  };
  opts.stops.forEach((st, i) => {
    // reuse the game stop if this real stop is already served, otherwise bring it into play
    let stopId = st.stopId && sim.stops.has(st.stopId) ? st.stopId : undefined;
    stopId ??= [...sim.stops.values()].find((s) => s.name === st.name && Math.abs(s.lngLat[0] - st.lngLat[0]) < 0.0008 && Math.abs(s.lngLat[1] - st.lngLat[1]) < 0.0008)?.id;
    if (!stopId) {
      stopId = st.stopId ?? `D${id}-${i}`;
      sim.stops.set(stopId, { id: stopId, name: st.name, lngLat: st.lngLat, lines: [], waiting: 4, demand: 'medium', catchmentM: 300 });
    }
    const stop = sim.stops.get(stopId)!;
    if (!stop.lines.includes(id)) stop.lines.push(id);
    line.stops.push({ stopId, distance: opts.stopDistances[i] });
  });
  sim.lines.push(line);
  sim.emitNetwork();
  return line;
}
