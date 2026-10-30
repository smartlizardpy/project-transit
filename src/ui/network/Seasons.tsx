// Seasons and weather (docs/city-activity-engine-plan.md, section 12): the same season compared
// across game years from the weekly roll-ups, and recent days by weather and kind of day.
import type { Game } from '../../game/engine.ts';
import { SEASONS, SEASON_LABEL, type Season } from '../../game/calendar.ts';
import { dayKind, seasonYears, weatherGroup } from '../../game/analytics/labels.ts';
import type { GroupBy, QueryResult } from '../../game/analytics/query.ts';
import { SectionHead, fmt, useAgg } from './common.tsx';

const WINDOW = 35;

/** Recorded days in the window by group key (weather or kind of day). */
function dayCounts(game: Game, by: 'weather' | 'daykind'): Map<string, number> {
  const today = Math.floor(game.t / 86400);
  const out = new Map<string, number>();
  for (const rec of game.state.analytics.days) {
    if (rec.day < today - WINDOW) continue;
    const k = by === 'weather' ? weatherGroup(rec.lbl) : dayKind(rec.lbl);
    if (k) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function PerDay({ game, res, counts, head }: { game: Game; res: QueryResult | null; counts: Map<string, number>; head: string }) {
  const rows = (res?.rows ?? []).filter((r) => counts.get(r.key));
  if (!rows.length) return <div className="pn-note">No recorded days with weather and kind-of-day labels yet. They are kept from this update on.</div>;
  return (
    <div className="nc-scroll">
      <table className="pn-table nc-table">
        <thead><tr><th>{head}</th><th>Days</th><th>Journeys a day</th><th>Fares a day</th><th>Satisfaction</th><th>On time</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const n = counts.get(r.key)!;
            return (
              <tr key={r.key}>
                <td className="name">{r.label}</td>
                <td>{n}</td>
                <td>{fmt(game, 'count', (r.values.journeys ?? 0) / n)}</td>
                <td>{fmt(game, 'money', (r.values.revenue ?? 0) / n)}</td>
                <td>{fmt(game, 'score', r.values.satisfaction)}</td>
                <td>{fmt(game, 'percent', r.values.onTime)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Seasons({ game }: { game: Game }) {
  const q = (groupBy: GroupBy) => ({ groupBy, days: { last: WINDOW }, includeToday: false });
  const byWx = useAgg(game, q('weather'));
  const byKind = useAgg(game, q('daykind'));
  const weeks = game.state.analytics.weeks ?? [];
  const seasons = SEASONS.filter((s) => weeks.some((w) => w.season === s));
  const years = new Set(weeks.map((w) => w.y));
  return (
    <>
      <div className="section">
        <SectionHead title="Same season, year on year" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>weekly totals, kept 3 game years</span>} />
        {!seasons.length ? (
          <div className="pn-note">No finished game week yet. Each week's totals are kept for three game years (a game year is 12 weeks: 3 of each season).</div>
        ) : (
          <>
            <div className="nc-scroll">
              <table className="pn-table nc-table">
                <thead><tr><th>Season</th><th>Year</th><th>Days</th><th>Journeys a day</th><th>Fares a day</th><th>Satisfaction</th></tr></thead>
                <tbody>
                  {seasons.flatMap((s: Season) => seasonYears(game.state, s).map((y, i) => (
                    <tr key={`${s}${y.y}`}>
                      <td className="name">{i === 0 ? SEASON_LABEL[s] : ''}</td>
                      <td>Year {y.y}</td>
                      <td>{y.days}</td>
                      <td>{fmt(game, 'count', y.journeys)}</td>
                      <td>{fmt(game, 'money', y.fares)}</td>
                      <td>{fmt(game, 'score', y.satisfaction)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
            {years.size < 2 && <div className="nc-hint" style={{ marginTop: 6 }}>Year-on-year comparisons appear once a season has been played in two game years. Seasons change who travels: schools close in summer, universities break, and beaches and parks fill in the heat.</div>}
          </>
        )}
      </div>

      <div className="section">
        <SectionHead title="By weather" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>last {WINDOW} days</span>} />
        <PerDay game={game} res={byWx} counts={dayCounts(game, 'weather')} head="Weather" />
        <div className="nc-hint" style={{ marginTop: 6 }}>Rain keeps some people at home and puts others off walking and cycling; roads are slower, so buses run later. Compare days of the same kind: weekends are quieter whatever the weather.</div>
      </div>

      <div className="section">
        <SectionHead title="By kind of day" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>last {WINDOW} days</span>} />
        <PerDay game={game} res={byKind} counts={dayCounts(game, 'daykind')} head="Kind of day" />
      </div>
    </>
  );
}
