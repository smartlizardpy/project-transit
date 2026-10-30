import { SectionHead } from '../components/SectionHead.tsx';
import { DayCurve, LiveBoard, useBoardClock } from '../illustrations/LiveBoard.tsx';

export function Living() {
  const [ref, now] = useBoardClock();
  return (
    <section className="sec band band--dark" id="living" aria-labelledby="living-title">
      <div className="wrap">
        <SectionHead
          id="living"
          split
          title="A city that never stops."
          lead="Buses leave the depot, keep to the timetable and stop for passengers. People travel between where they live and where they work, and choose between your bus, walking and driving by time, price, crowding and reliability."
        />
        <div className="living-grid" ref={ref}>
          <figure className="living-board">
            <LiveBoard now={now} />
            <figcaption className="cap">The game’s arrival board, redrawn for this page with example times.</figcaption>
          </figure>
          <ul className="living-points">
            <li>
              <h3 className="h3">An arrival board at every stop</h3>
              <p>Click a stop to see the next buses on every line, how late they are and how full. The times are predicted from the running simulation.</p>
            </li>
            <li>
              <h3 className="h3">Ride along</h3>
              <p>Click a bus to see its passengers and where it stops next. Press F to follow it through town.</p>
            </li>
            <li>
              <h3 className="h3">Rush hour is slower</h3>
              <p>Congestion follows the time of day, the type of road and how built-up the area is, so a timetable that works at noon can slip at eight in the morning.</p>
              <DayCurve now={now} />
              <p className="cap">Simulated traffic, not live data.</p>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
