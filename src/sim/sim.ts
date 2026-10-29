// Lightweight prototype simulation: game clock, vehicle movement along lines,
// boarding at stops and a time-of-day traffic profile. Independent of React.

import { buildNetwork, sampleAlong, type Line, type Stop } from './network.ts';
import { congestionAt } from './traffic.ts';

export type VehicleModel = 'Urban 12' | 'Midi 9' | 'Artic 18';

export const MODELS: Record<VehicleModel, { capacity: number; length: number; price: number; costPerHour: number; speed: number; seats: number }> = {
  'Midi 9': { capacity: 52, length: 9.2, price: 7_400_000, costPerHour: 840, speed: 3, seats: 22 },
  'Urban 12': { capacity: 98, length: 12, price: 10_900_000, costPerHour: 1080, speed: 3, seats: 31 },
  'Artic 18': { capacity: 154, length: 18, price: 15_600_000, costPerHour: 1460, speed: 2, seats: 44 },
};

export interface Vehicle {
  id: string;
  fleetNo: string;
  model: VehicleModel;
  lineId: string | null;
  s: number; // metres along the line loop
  v: number; // m/s (visual)
  dwell: number; // seconds remaining at stop
  nextStop: number; // index into line.stops
  occupancy: number;
  status: 'running' | 'boarding' | 'delayed' | 'depot';
  delayMin: number;
  condition: number;
  ageYears: number;
  odometerKm: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Listener = () => void;

export class Simulation {
  lines: Line[];
  stops: Map<string, Stop>;
  vehicles: Vehicle[] = [];
  minutes = 7 * 60 + 42; // 07:42
  day = 38;
  speed = 1; // 0 = paused, 1, 2, 4
  funds = 18_420_000;
  todayIncome = 0;
  private rand = rng(42);
  private minuteListeners = new Set<Listener>();
  private lastMinute = -1;
  private accum = 0;

  constructor() {
    const net = buildNetwork();
    this.lines = net.lines;
    this.stops = net.stops;
    let n = 1;
    const models: VehicleModel[] = ['Urban 12', 'Urban 12', 'Artic 18', 'Midi 9'];
    for (const line of this.lines) {
      for (let k = 0; k < line.fleetSize; k++) {
        const s = (line.length / line.fleetSize) * k + this.rand() * 40;
        const model = line.id === 'L32' ? 'Midi 9' : models[(n + k) % 3];
        const cap = MODELS[model].capacity;
        const v: Vehicle = {
          id: `V${n}`,
          fleetNo: `${34}-${String(100 + n * 7).padStart(3, '0')}`,
          model,
          lineId: line.id,
          s,
          v: 0,
          dwell: 0,
          nextStop: 0,
          occupancy: Math.round(cap * (line.perf.load * (0.6 + this.rand() * 0.8))),
          status: 'running',
          delayMin: 0,
          condition: 0.72 + this.rand() * 0.26,
          ageYears: Math.round(1 + this.rand() * 9),
          odometerKm: Math.round(40_000 + this.rand() * 380_000),
        };
        v.nextStop = this.nextStopIndex(line, s);
        this.vehicles.push(v);
        n++;
      }
    }
    // a few vehicles waiting in the depot for assignment
    for (const model of ['Urban 12', 'Artic 18'] as VehicleModel[]) {
      this.vehicles.push({
        id: `V${n}`, fleetNo: `34-${String(100 + n * 7).padStart(3, '0')}`, model, lineId: null, s: 0, v: 0, dwell: 0, nextStop: 0,
        occupancy: 0, status: 'depot', delayMin: 0, condition: 0.98, ageYears: 0, odometerKm: 1200,
      });
      n++;
    }
  }

  line(id: string | null | undefined) {
    return this.lines.find((l) => l.id === id);
  }

  vehicle(id: string | null | undefined) {
    return this.vehicles.find((v) => v.id === id);
  }

  nextStopIndex(line: Line, s: number): number {
    const d = ((s % line.length) + line.length) % line.length;
    for (let i = 0; i < line.stops.length; i++) if (line.stops[i].distance > d + 0.5) return i;
    return 0;
  }

  /** distance (m) from vehicle to its next stop along the loop */
  distanceToNext(v: Vehicle): number {
    const line = this.line(v.lineId);
    if (!line) return 0;
    const d = ((v.s % line.length) + line.length) % line.length;
    let target = line.stops[v.nextStop].distance;
    if (target < d) target += line.length;
    return target - d;
  }

  private netListeners = new Set<Listener>();

  /** Fired when lines, stops or vehicle assignments change. */
  onNetwork(fn: Listener): () => void {
    this.netListeners.add(fn);
    return () => this.netListeners.delete(fn);
  }

  emitNetwork() {
    this.netListeners.forEach((l) => l());
  }

  onMinute(fn: Listener): () => void {
    this.minuteListeners.add(fn);
    return () => this.minuteListeners.delete(fn);
  }

  get hour() {
    return (this.minutes / 60) % 24;
  }

  setSpeed(s: number) {
    this.speed = s;
    this.minuteListeners.forEach((l) => l());
  }

  tick(dtReal: number) {
    if (this.speed === 0) return;
    const dt = Math.min(0.1, dtReal) * this.speed;
    // clock: one game minute per real second at 1x
    this.minutes += dt;
    if (this.minutes >= 24 * 60) {
      this.minutes -= 24 * 60;
      this.day++;
      this.todayIncome = 0;
    }
    const congestion = congestionAt(this.hour);
    for (const v of this.vehicles) {
      const line = this.line(v.lineId);
      if (!line || v.status === 'depot') continue;
      if (v.dwell > 0) {
        v.dwell -= dt;
        v.v = 0;
        v.status = 'boarding';
        if (v.dwell <= 0) v.status = v.delayMin > 2 ? 'delayed' : 'running';
        continue;
      }
      const toStop = this.distanceToNext(v);
      // local congestion varies along the route
      const seg = Math.floor(v.s / 140);
      const local = congestion * (0.55 + ((seg * 2654435761) % 1000) / 1000);
      let target = 9.5 * (1 - 0.62 * Math.min(1, local));
      if (toStop < 30) target = Math.min(target, 2 + toStop * 0.25);
      v.v += (target - v.v) * Math.min(1, dt * 1.6);
      const step = v.v * dt;
      if (step >= toStop) {
        v.s += toStop;
        // arrive: alight + board
        const stop = this.stops.get(line.stops[v.nextStop].stopId)!;
        const cap = MODELS[v.model].capacity;
        const alight = Math.round(v.occupancy * (0.15 + this.rand() * 0.3));
        const board = Math.min(cap - (v.occupancy - alight), Math.round(stop.waiting * (0.3 + this.rand() * 0.5)));
        v.occupancy = Math.max(0, v.occupancy - alight + board);
        stop.waiting = Math.max(0, stop.waiting - board);
        v.dwell = 4 + (alight + board) * 0.18;
        v.delayMin = Math.max(0, Math.round((local - 0.45) * 8));
        v.nextStop = (v.nextStop + 1) % line.stops.length;
      } else {
        v.s += step;
      }
      v.odometerKm += step / 1000;
    }
    // stops accumulate passengers; economy trickles in
    this.accum += dt;
    if (this.accum >= 1) {
      const minutes = Math.floor(this.accum);
      this.accum -= minutes;
      const daily = this.lines.reduce((s, l) => s + l.perf.profitPerDay, 0);
      const peak = 0.6 + congestion * 0.8;
      const income = (daily / (24 * 60)) * minutes * peak;
      this.funds += income;
      this.todayIncome += income;
      for (const s of this.stops.values()) s.waiting = Math.min(120, s.waiting + (this.rand() < 0.5 * peak ? 1 : 0));
    }
    const m = Math.floor(this.minutes);
    if (m !== this.lastMinute) {
      this.lastMinute = m;
      this.minuteListeners.forEach((l) => l());
    }
  }

  /** World position for a vehicle (lng/lat) plus a heading taken over a short look-ahead. */
  pose(v: Vehicle): { at: [number, number]; ahead: [number, number]; behind: [number, number] } | null {
    const line = this.line(v.lineId);
    if (!line) return null;
    const at = sampleAlong(line.path, line.cumulative, v.s).p;
    const ahead = sampleAlong(line.path, line.cumulative, v.s + 4).p;
    const behind = sampleAlong(line.path, line.cumulative, v.s - 4).p;
    return { at, ahead, behind };
  }
}

export const sim = new Simulation();
