import { useRef, useState, type KeyboardEvent } from 'react';
import { SectionHead } from '../components/SectionHead.tsx';
import { Picture } from '../components/Picture.tsx';
import { CITIES } from '../content/cities.ts';

const LEGEND = [
  {
    title: 'Real',
    from: 'From OpenStreetMap',
    swatches: ['var(--water)', 'var(--park)', 'var(--road)', 'var(--building)'],
    items: ['Streets, one-way rules, bridges and tunnels', 'Building footprints, water, parks and railways', 'Bus stops, street names and place names', 'Universities, hospitals, stations and shopping centres'],
  },
  {
    title: 'Estimated',
    from: 'Labelled as estimates in the game',
    swatches: ['var(--roof)', '#c9c3b6'],
    items: ['Building heights, where the map has none', 'Where people live and work, from floor area and land use', 'Operating areas: map squares named after their main place'],
  },
  {
    title: 'Simulated',
    from: 'Run by the game itself',
    swatches: ['var(--line)', 'var(--amber)', 'var(--violet)'],
    items: ['Traffic, by time of day and type of road. Not live data', 'Passengers choosing between your bus, walking and driving', 'Money: fares, wages, fuel, maintenance and loans'],
  },
];

export function Places() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const city = CITIES[active];

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + CITIES.length) % CITIES.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <section className="sec" id="places" aria-labelledby="places-title">
      <div className="wrap">
        <SectionHead
          id="places"
          split
          title="Play in real places."
          lead="Start in İstanbul, Tokyo or Durham, or search for your own town. Its streets, bridges, parks and buildings come from OpenStreetMap, rebuilt as a quiet miniature model for your buses to run through."
        />

        <div className="places-switch">
          <figure>
            <div className="places-stage">
              {CITIES.map((c, i) => (
                <div
                  key={c.id}
                  className="media"
                  id={`city-panel-${c.id}`}
                  role="tabpanel"
                  aria-labelledby={`city-tab-${c.id}`}
                  data-active={i === active}
                  aria-hidden={i !== active}
                  inert={i !== active}
                >
                  <Picture id={c.image} alt={c.alt} sizes="(min-width: 1000px) 62vw, 92vw" />
                </div>
              ))}
            </div>
            <figcaption className="places-caption figcap">
              <span className="body">
                <strong>
                  {city.name}, {city.area}.
                </strong>{' '}
                {city.note}
              </span>
              <span className="facts">
                <span className="fact">Drives on the {city.traffic}</span>
                <span className="fact">Prices in {city.currency.toLowerCase()}</span>
                {city.id === 'istanbul' && <span className="fact">Comes with the game, works offline</span>}
              </span>
            </figcaption>
          </figure>

          <div>
            <div className="cities" role="tablist" aria-label="Starting cities" aria-orientation="vertical" onKeyDown={onKey}>
              {CITIES.map((c, i) => (
                <button
                  key={c.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  className="city"
                  role="tab"
                  id={`city-tab-${c.id}`}
                  aria-selected={i === active}
                  aria-controls={`city-panel-${c.id}`}
                  tabIndex={i === active ? 0 : -1}
                  onClick={() => setActive(i)}
                >
                  <span className="city-dot" aria-hidden="true" />
                  <span className="city-name">{c.name}</span>
                  <span className="city-area">{c.area}</span>
                </button>
              ))}
            </div>
            <p className="places-search">
              Anywhere else: search for a town when you found your company. Places look as good as their OpenStreetMap data, so well-mapped towns work best.
            </p>
          </div>
        </div>

        <div className="legend">
          {LEGEND.map((l) => (
            <div key={l.title}>
              <h3 className="h3">
                <span className="swatches" aria-hidden="true">
                  {l.swatches.map((s) => (
                    <i key={s} style={{ background: s }} />
                  ))}
                </span>
                {l.title}
              </h3>
              <p className="cap" style={{ marginBottom: 10 }}>
                {l.from}
              </p>
              <ul>
                {l.items.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
