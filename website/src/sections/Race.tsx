import { Film, hasFilm } from '../components/Film.tsx';
import { SectionHead } from '../components/SectionHead.tsx';

const STEPS = [
  { title: 'Open a race', body: 'On the start screen, choose Race a friend. Pick a city and a length (1, 3 or 7 game days) and you get a code.' },
  { title: 'Friends join', body: 'They choose Join a friend and type the code. Their screen shows the city and the length while everyone gathers.' },
  { title: 'Start', body: 'Everyone gets the same map, and the clock starts as soon as every computer has it.' },
] as const;

const FACTS = [
  {
    title: 'A level start',
    body: 'Every company starts in the same home area of the same city, with the same money, at five in the morning on the same Monday.',
  },
  {
    title: 'One clock for everyone',
    body: 'Anyone can pause or change the speed, and it changes for all. If one computer falls behind, the clock waits for it.',
  },
  {
    title: 'Watch your rival',
    body: 'Their lines appear dashed on your map in their colour. The scoreboard under the clock counts each company’s journeys; click it for balance, lines, buses and reputation.',
  },
  {
    title: 'Keep your company',
    body: 'When time runs out, everyone sees the same results. Your company is saved like any other game, so you can play on from there.',
  },
] as const;

export function Race() {
  return (
    <section className="sec band band--plum" id="race" aria-labelledby="race-title">
      <div className="wrap">
        <SectionHead
          id="race"
          split
          title="Or race each other."
          lead="New in 0.6.0: you and up to three friends each found a bus company in the same city at the same moment. One clock runs for everyone, a scoreboard counts the journeys each company carries, and whoever has carried the most when time runs out wins."
        />
        {hasFilm('race') && (
          <figure className="film-fig coop-film">
            <div className="coop-who" aria-hidden="true">
              <span><i style={{ background: '#f2a93b' }} />Ana’s screen · Ben’s lines dashed in blue</span>
              <span><i style={{ background: '#4fb3e8' }} />Ben’s screen · Ana’s lines dashed in amber</span>
            </div>
            <Film
              id="race"
              sizes="(min-width: 1400px) 1272px, 92vw"
              alt="Two screens of the same race side by side, İstanbul at speed. Each player has two bus lines of their own, and the other player’s lines show as dashed lines in their colour. The scoreboard under the clock counts both companies’ journeys as they rise. Ben clicks it and a table opens with journeys, balance, lines, buses and reputation for both."
            />
            <figcaption className="cap">Recorded in the running game: two copies on one computer, racing as two friends would. Ana built to the west, Ben to the east; each sees the other’s network and the score as it changes.</figcaption>
          </figure>
        )}
        <div className="coop-grid">
          <div>
            <h3 className="h3 coop-sub">A race takes three steps</h3>
            <ol className="steps coop-steps">
              {STEPS.map((s, i) => (
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
          <ul className="coop-facts">
            {FACTS.map((f) => (
              <li key={f.title}>
                <h3 className="h3">{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="coop-note">
          <strong>Good to know:</strong> up to four players. The most journeys carried wins, and a tie goes to the higher balance. Each of you runs your own company, so building in your city never gets in a friend’s way. If the host leaves, the race ends and everyone’s company carries on as a normal game.
        </p>
      </div>
    </section>
  );
}
