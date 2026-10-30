import { BusArt } from '../../../src/ui/BusArt.tsx';
import { useInView } from '../components/hooks.ts';
import { SectionHead } from '../components/SectionHead.tsx';
import { FLEET } from '../content/fleet.ts';
import { MapSquares } from '../illustrations/MapSquares.tsx';

const LADDER = [
  { title: 'Start at home', body: 'Your home area and the squares around it: about 15 km² of real city, and money for a depot and a few buses.' },
  { title: 'Earn a reputation', body: 'Short waits, quick trips, buses that are on time and not packed, and a fair fare raise it. Missed departures cost you.' },
  { title: 'License new areas', body: 'Each neighbouring map square has a price and a minimum reputation. License one and the map grows.' },
  { title: 'Unlock bigger buses', body: 'Double-deckers at reputation 40, electric buses at 45, articulated buses at 60.' },
  { title: 'Meet objectives', body: 'Twelve goals, from your first hundred passengers to a campus connection, with grants along the way.' },
];

function Fleet() {
  const [ref, seen] = useInView<HTMLUListElement>(0.3, true);
  return (
    <ul className="fleet" ref={ref} data-seen={seen}>
      {FLEET.map((m, i) => (
        <li className="bus" key={m.id} style={{ ['--i' as string]: i }}>
          <div className="bus-art">
            <BusArt model={m.id} width={240} />
          </div>
          <h4 className="bus-name">{m.name}</h4>
          <p className="bus-stats tnum">
            {m.kind}, {m.capacity} places
          </p>
          <p className="bus-blurb">{m.blurb}</p>
          <p className="bus-unlock">{m.unlock}</p>
        </li>
      ))}
    </ul>
  );
}

export function Company() {
  return (
    <section className="sec band band--amber" id="company" aria-labelledby="company-title">
      <div className="wrap">
        <SectionHead
          id="company"
          split
          title="Build a company, not just a network."
          lead="You start small. Fares pay the bills; wages, fuel, maintenance and depots cost money. Grow carefully: stay in the red too long and the company goes bankrupt."
        />
        <div className="company-grid">
          <figure className="squares-fig">
            <MapSquares />
            <figcaption className="cap">The operating areas view, drawn. Names and prices from a game in Barcelona.</figcaption>
          </figure>
          <ol className="ladder">
            {LADDER.map((r) => (
              <li className="rung" key={r.title}>
                <h3 className="h3">{r.title}</h3>
                <p>{r.body}</p>
              </li>
            ))}
          </ol>
        </div>
        <h3 className="h3 fleet-title">Six buses, each with a job</h3>
        <Fleet />
      </div>
    </section>
  );
}
