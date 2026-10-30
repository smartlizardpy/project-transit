import { Film, hasFilm } from '../components/Film.tsx';
import { SectionHead } from '../components/SectionHead.tsx';
import { ROUTE_STEPS, RouteSketch } from '../illustrations/RouteSketch.tsx';

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
        {hasFilm('route') ? (
          <div className="route-sketch">
            <figure className="film-fig">
              <Film
                id="route"
                sizes="(min-width: 1000px) 60vw, 92vw"
                alt="Gameplay in Barcelona: stops are placed one by one, the new line is drawn along the streets of the Eixample, and buses leave the depot to run it while the camera follows one."
              />
              <figcaption className="cap">Recorded in the game with the interface hidden.</figcaption>
            </figure>
            <ol className="steps">
              {ROUTE_STEPS.map((s, i) => (
                <li className="step" key={s.title}>
                  <span className="step-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3 className="h3">{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <RouteSketch />
        )}
      </div>
    </section>
  );
}
