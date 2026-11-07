import { Film, hasFilm } from '../components/Film.tsx';
import { SectionHead } from '../components/SectionHead.tsx';

const STEPS = [
  { title: 'Invite', body: 'The host opens the menu (Esc), chooses Play with friends, then Invite friends. The game shows a code such as RYY4-QC6N.' },
  { title: 'Send the code', body: 'In a message, on a call, any way you like. It works while the host’s game is open.' },
  { title: 'Join', body: 'Friends choose Join a friend on the start screen and type the code. A copy of the company arrives in a few seconds.' },
] as const;

const FACTS = [
  {
    title: 'Point instead of explaining',
    body: 'Option-click (Alt-click on Windows and Linux) puts a ping on everyone’s map. The strip under the clock shows who is playing and what they just did, such as “Ben bought a bus”.',
  },
  {
    title: 'One clock for everyone',
    body: 'Anyone can pause the game or change its speed, and it changes for all. If one computer falls behind, the clock waits for it and says who it is waiting for.',
  },
  {
    title: 'The same city on every screen',
    body: 'Every computer runs the same simulation from the same moves, down to each bus and passenger, on Mac and Windows alike. Every ten game minutes the games compare notes, and one that differs gets a fresh copy in about a second.',
  },
  {
    title: 'Saved on the host’s computer',
    body: 'The company lives in the host’s saves. If the host leaves, everyone else keeps a paused copy that they can save and play on their own.',
  },
] as const;

export function Together() {
  return (
    <section className="sec band band--signal" id="together" aria-labelledby="together-title">
      <div className="wrap">
        <SectionHead
          id="together"
          split
          title="Run the company with a friend."
          lead="New in 0.5.0: up to four people can play in one game. You see each other’s mouse on the map, and anyone can build, buy or change anything. There are no accounts and no game server: your computers connect to each other directly."
        />
        {hasFilm('coop') && (
          <figure className="film-fig coop-film">
            <div className="coop-who" aria-hidden="true">
              <span><i style={{ background: '#f2a93b' }} />Ana’s screen · hosting</span>
              <span><i style={{ background: '#4fb3e8' }} />Ben’s screen · joined with a code</span>
            </div>
            <Film
              id="coop"
              sizes="(min-width: 1400px) 1272px, 92vw"
              alt="Two screens of the same game side by side, İstanbul with three bus lines. Ben moves his mouse and a cursor labelled Ben follows it on Ana’s map. He builds a stop: it appears in both games, Ana’s screen says “Ben built a stop” and Ben’s says “Stop built”. Ana then Option-clicks beside it and a ping appears on both maps, with her labelled cursor on Ben’s screen."
            />
            <figcaption className="cap">Recorded in the running game: two copies on one computer, joined with a code as two friends would be. Ben’s mouse moves over Ana’s map, the stop he builds appears in both games, and Ana points at a spot for him.</figcaption>
          </figure>
        )}
        <div className="coop-grid">
          <div>
            <h3 className="h3 coop-sub">Playing together takes three steps</h3>
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
          <strong>Good to know:</strong> up to four players. Some work, school and mobile networks block direct connections; if joining fails, try another network. Some Linux systems can’t play together, because their web engine leaves out WebRTC.
        </p>
      </div>
    </section>
  );
}
