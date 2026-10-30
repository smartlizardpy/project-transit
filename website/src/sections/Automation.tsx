import { Film, hasFilm } from '../components/Film.tsx';
import { SectionHead } from '../components/SectionHead.tsx';

const CLIPS = [
  {
    id: 'automation-build',
    title: 'Build a workflow from nodes',
    body: 'A new workflow starts with a trigger. Search for a node, drag it onto the canvas and join it up: here a Line node feeding a Compare node. Pick a line and press Test. The test shows what each node did and changes nothing. At 07:30 it read Line 1 as 0% full on average with 3 people waiting, so the condition was false.',
    alt: 'Automation Studio with a large mouse pointer, zooming in as a Line node and a Compare node are searched for, dragged onto the canvas and joined to a trigger. A test run then lists the path through the three nodes.',
  },
  {
    id: 'automation-live',
    title: 'A suggestion on the live network',
    body: 'This workflow is in Suggest mode: it looks for a busy line and proposes an extra departure. Approving it checks the plan again. Here bus 106 leaves the depot, runs a real extra trip on Line 1 from Eminönü, then returns. The threshold is set to 1% because this test company is quiet.',
    alt: 'Network Control, Automation tab, zoomed in on a suggestion for an extra departure. The pointer clicks Approve, the card confirms it, and the game then runs with buses moving along the lines.',
  },
  {
    id: 'automation-lab',
    title: 'Try it first in the Lab',
    body: 'The Simulation Lab plays the next hours twice on copies of the company, once without the workflow and once with it. Your own company is not touched. In this four-hour run it added three trips and two journeys, and cost ₺345 more. It is one possible future, not a forecast.',
    alt: 'The Simulation Lab tab of Automation Studio: a table compares journeys, boardings, trips, punctuality, waiting, satisfaction, fares and result, without and with the workflow.',
  },
  {
    id: 'automation-flows',
    title: 'See where passengers go',
    body: 'Network Control is the analytics around the Studio. Its flows view draws the busiest journeys on the map. Solid arcs are journeys that happened: Akdeniz to Tünel had 440 in the last 7 days. Dashed arcs are demand estimated by the game’s model: about 257 trips a day for the same pair, an estimate and not journeys carried.',
    alt: 'Network Control, Passengers tab, with a large mouse pointer. A flow is selected and drawn as a solid blue arc on the map of İstanbul, then the view is switched to estimated demand, which draws dashed arcs.',
  },
] as const;

const FACTS = [
  {
    title: 'Trigger, data, action',
    body: 'Workflows join nodes: triggers (a time, a late bus, a breakdown), data (lines, buses, Network Control figures), logic, maths, memory and actions. There are 57 node types. For anything else, an Expression node takes a short formula.',
  },
  {
    title: 'Observe, suggest or apply',
    body: 'Every new workflow starts in Observe, which only records what it would have done. Suggest turns each action into a suggestion you approve; it is checked again when you do, and lapses after 30 game minutes. Automatic acts by itself, but big changes (frequency, fares, suspending a line) still need your approval unless you allow them.',
  },
  {
    title: 'Limits and the same rules',
    body: 'By default a workflow may start 60 runs an hour, take 40 actions and spend 2,000 a day, and waits 30 game minutes before repeating an action. Five failed runs in a row switch it off. It uses the same commands as your own buttons, so a bus still finishes its trip first. Changes you make by hand are left alone for 24 game hours.',
  },
  {
    title: 'Templates to start from',
    body: 'Six ready-made workflows: an extra bus when a line is crowded, a watch on every line, a late-bus alert, breakdown cover, a daily summary and a low-balance warning. Each starts in Observe.',
  },
] as const;

export function Automation() {
  return (
    <section className="sec band band--dark" id="automation" aria-labelledby="automation-title">
      <div className="wrap">
        <SectionHead
          id="automation"
          split
          title="Let the network run itself, within limits."
          lead="Automation Studio, new in 0.3.0, is a node-based workflow builder inside Network Control. You join nodes into a workflow that watches the company and acts through the game’s normal rules. Most workflows need no typing."
        />
        <div className="auto-grid">
          {CLIPS.map((c) => (
            <figure className="film-fig auto-clip" key={c.id}>
              {hasFilm(c.id) && <Film id={c.id} sizes="(min-width: 1000px) 46vw, 92vw" alt={c.alt} />}
              <figcaption>
                <h3 className="h3">{c.title}</h3>
                <p>{c.body}</p>
              </figcaption>
            </figure>
          ))}
        </div>
        <p className="cap auto-note">Recorded in the running game, interface shown, from a test company in İstanbul. The figures are the game’s own.</p>
        <ul className="auto-facts">
          {FACTS.map((f) => (
            <li key={f.title}>
              <h3 className="h3">{f.title}</h3>
              <p>{f.body}</p>
            </li>
          ))}
        </ul>
        <p className="auto-unlock">
          <strong>When it unlocks:</strong> Network Control opens once the company has 30 operating days of history and reaches level 3. A card in the game then offers a short tour.
        </p>
      </div>
    </section>
  );
}
