import { SectionHead } from '../components/SectionHead.tsx';
import { RouteSketch } from '../illustrations/RouteSketch.tsx';

export function Routes() {
  return (
    <section className="sec band band--teal" id="routes" aria-labelledby="routes-title">
      <div className="wrap">
        <SectionHead
          id="routes"
          split
          title="Every route is your decision."
          lead="Lines follow the real road network, one-way streets and all. Where the stops go, which streets the buses take and how often they come is up to you."
        />
        <RouteSketch />
      </div>
    </section>
  );
}
