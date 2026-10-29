// Company ledger. Every change to the balance goes through `post`, which also keeps the
// daily and per-line aggregates in step, so summaries always reconcile with the ledger.

import { DAY } from './content.ts';
import type { FinanceState, GameState, Id, LedgerCategory, LedgerEntry } from './types.ts';

export const INCOME: LedgerCategory[] = ['fares', 'grant', 'contract', 'vehicle_sale', 'loan'];
/** one-off grants and awards are not operating income */
export const OPERATING_INCOME: LedgerCategory[] = ['fares', 'contract'];
export const OPERATING_COST: LedgerCategory[] = ['driver', 'fuel', 'maintenance', 'fleet_fixed', 'depot', 'stops', 'interest'];
export const CAPITAL: LedgerCategory[] = ['equity', 'vehicle_purchase', 'vehicle_sale', 'construction', 'licence', 'loan', 'repayment'];

export const CATEGORY_LABEL: Record<LedgerCategory, string> = {
  equity: 'Founding capital',
  fares: 'Ticket sales',
  grant: 'Grants & awards',
  contract: 'Municipal contracts',
  vehicle_sale: 'Vehicle sales',
  loan: 'Loan drawn',
  vehicle_purchase: 'Vehicle purchases',
  driver: 'Driver wages',
  fuel: 'Fuel & energy',
  maintenance: 'Maintenance',
  fleet_fixed: 'Insurance & licensing',
  depot: 'Depot running costs',
  stops: 'Stop upkeep',
  licence: 'Operating licences',
  interest: 'Interest',
  repayment: 'Loan repayments',
  construction: 'Construction',
};

/** Ledger window kept in full detail; older entries are folded into daily totals. */
const DETAIL_DAYS = 8;

export function emptyFinance(opening: number): FinanceState {
  return { balance: 0, ledger: [], archive: [], daily: {}, routeDaily: {}, acc: { fares: {}, driver: {}, fuel: {} }, loan: 0, opening };
}

export function post(state: GameState, entry: Omit<LedgerEntry, 'id' | 't'> & { t?: number }): LedgerEntry {
  const f = state.finance;
  const e: LedgerEntry = { id: ++state.counters.ledger, t: entry.t ?? state.clock.t, amt: round2(entry.amt), cat: entry.cat, memo: entry.memo };
  if (entry.route) e.route = entry.route;
  if (entry.veh) e.veh = entry.veh;
  if (entry.ref) e.ref = entry.ref;
  if (e.amt === 0) return e;
  f.ledger.push(e);
  f.balance = round2(f.balance + e.amt);
  aggregate(f, Math.floor(e.t / DAY), e.cat, e.amt, e.route);
  return e;
}

function aggregate(f: FinanceState, day: number, cat: LedgerCategory, amt: number, route?: Id) {
  const d = (f.daily[day] ??= {});
  d[cat] = round2((d[cat] ?? 0) + amt);
  // line profitability counts operating money only (not purchases, licences or construction)
  if (route && (OPERATING_INCOME.includes(cat) || OPERATING_COST.includes(cat))) {
    const r = ((f.routeDaily[day] ??= {})[route] ??= { rev: 0, cost: 0 });
    if (amt >= 0) r.rev = round2(r.rev + amt);
    else r.cost = round2(r.cost - amt);
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Accrue fare revenue for the current hour (posted on the hour). */
export function accrueFare(state: GameState, route: Id, amount: number, n: number) {
  const a = (state.finance.acc.fares[route] ??= { amt: 0, n: 0 });
  a.amt += amount;
  a.n += n;
}

export function accrueCost(state: GameState, kind: 'driver' | 'fuel', key: Id, amount: number) {
  const acc = state.finance.acc[kind];
  acc[key] = (acc[key] ?? 0) + amount;
}

/** Post the hour's accrued fares and running costs as ledger entries, timestamped at `t`. */
export function flushHour(state: GameState, t: number, label: string) {
  const f = state.finance;
  const name = (id: Id) => (state.routes[id] ? `line ${state.routes[id].number}` : 'unassigned buses');
  for (const [route, a] of Object.entries(f.acc.fares))
    if (a.amt) post(state, { t, amt: a.amt, cat: 'fares', memo: `${a.n} passengers, ${name(route)}, ${label}`, route: state.routes[route] ? route : undefined });
  for (const [route, amt] of Object.entries(f.acc.driver))
    if (amt) post(state, { t, amt: -amt, cat: 'driver', memo: `Driver hours, ${name(route)}, ${label}`, route: state.routes[route] ? route : undefined });
  for (const [route, amt] of Object.entries(f.acc.fuel))
    if (amt) post(state, { t, amt: -amt, cat: 'fuel', memo: `Fuel & energy, ${name(route)}, ${label}`, route: state.routes[route] ? route : undefined });
  f.acc = { fares: {}, driver: {}, fuel: {} };
}

/** Fold detailed entries older than the detail window into daily archive rows. */
export function compactLedger(state: GameState) {
  const f = state.finance;
  const cutoff = (Math.floor(state.clock.t / DAY) - DETAIL_DAYS) * DAY;
  if (!f.ledger.length || f.ledger[0].t >= cutoff) return;
  const keep: LedgerEntry[] = [];
  const fold = new Map<string, { day: number; cat: LedgerCategory; route?: Id; amt: number }>();
  for (const e of f.ledger) {
    if (e.t >= cutoff) {
      keep.push(e);
      continue;
    }
    const day = Math.floor(e.t / DAY);
    const k = `${day}|${e.cat}|${e.route ?? ''}`;
    const row = fold.get(k);
    if (row) row.amt = round2(row.amt + e.amt);
    else fold.set(k, { day, cat: e.cat, route: e.route, amt: e.amt });
  }
  f.archive.push(...fold.values());
  f.ledger = keep;
  // keep aggregates for 120 days
  const minDay = Math.floor(state.clock.t / DAY) - 120;
  for (const d of Object.keys(f.daily)) if (+d < minDay) delete f.daily[+d];
  for (const d of Object.keys(f.routeDaily)) if (+d < minDay) delete f.routeDaily[+d];
}

/** Recompute the balance from the ledger and archive; used by tests and save validation. */
export function reconcile(state: GameState): { ledgerTotal: number; balance: number; ok: boolean } {
  const f = state.finance;
  let total = 0;
  for (const e of f.ledger) total += e.amt;
  for (const a of f.archive) total += a.amt;
  total = round2(total);
  return { ledgerTotal: total, balance: f.balance, ok: Math.abs(total - f.balance) < 0.05 };
}

export function dayTotals(state: GameState, day: number) {
  const d = state.finance.daily[day] ?? {};
  let income = 0, operating = 0, capital = 0;
  for (const [cat, v] of Object.entries(d) as [LedgerCategory, number][]) {
    if (OPERATING_INCOME.includes(cat)) income += v;
    else if (OPERATING_COST.includes(cat)) operating += v;
    else capital += v;
  }
  return { income, operating, capital, result: income + operating, cash: income + operating + capital };
}
