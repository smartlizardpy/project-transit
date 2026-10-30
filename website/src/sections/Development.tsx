import { SectionHead } from '../components/SectionHead.tsx';
import { BASE, PROGRESS, RELEASE, RELEASES, formatDate } from '../content/site.ts';
import { MILESTONES, NEXT, UPDATES, type Status } from '../content/devlog.ts';

const WORD: Record<Status, string> = { done: 'Done', partial: 'In progress', planned: 'Planned' };

export function Development() {
  return (
    <section className="sec" id="development" aria-labelledby="development-title">
      <div className="wrap">
        <SectionHead id="development" split title="In development." lead="Project Transit is early and playable. Here is what works today, what is still being tuned, and what is planned." />
        <div className="dev-grid">
          <div>
            <article className="status-card on-card" aria-labelledby="status-title">
              <div className="status-top">
                <span className="badge">
                  <img src={`${BASE}mark-96.png`} alt="" width={44} height={44} />
                </span>
                <div className="status-title">
                  <strong id="status-title">Early build {RELEASE.version}</strong>
                  <span>
                    Released <time dateTime={RELEASE.date}>{formatDate(RELEASE.date)}</time> for macOS, Windows and Linux
                  </span>
                </div>
              </div>
              <div className="status-section">
                <p className="status-label">Milestones</p>
                <ul className="milestones">
                  {MILESTONES.map((m) => (
                    <li className="milestone" key={m.name}>
                      <span className="pip" data-status={m.status} aria-hidden="true" />
                      <strong>{m.name}</strong>
                      <span className="status-word">{WORD[m.status]}</span>
                      <p>{m.summary}</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="actions">
                <a className="btn" href={RELEASES}>
                  Download {RELEASE.version}
                </a>
                <a className="btn btn--quiet" href={PROGRESS}>
                  Read the progress notes
                </a>
              </div>
            </article>
          </div>

          <div>
            <h3 className="h3" style={{ marginBottom: 24 }}>
              Recent updates
            </h3>
            <ol className="updates">
              {UPDATES.map((u) => (
                <li className="update" key={u.title}>
                  <span className="update-dot" aria-hidden="true" />
                  <time dateTime={u.date}>{formatDate(u.date)}</time>
                  <h4 className="h3">{u.href ? <a href={u.href}>{u.title}</a> : u.title}</h4>
                  <p>{u.body}</p>
                </li>
              ))}
            </ol>
            <div className="next">
              <h3 className="h3">Next</h3>
              <ul style={{ display: 'grid', gap: 16 }}>
                {NEXT.map((n) => (
                  <li className="next-item" key={n.title}>
                    <strong>{n.title}</strong>
                    <span className="tag" data-status={n.status}>
                      {WORD[n.status]}
                    </span>
                    <p>{n.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
