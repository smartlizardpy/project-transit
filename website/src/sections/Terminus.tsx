import { BusArt } from '../../../src/ui/BusArt.tsx';
import { Download, GitHub } from '../components/Icons.tsx';
import { ISSUES, RELEASES, REPO } from '../content/site.ts';

export function Terminus() {
  return (
    <section className="sec band band--coral terminus" id="get" aria-labelledby="get-title">
      <div className="wrap terminus-grid">
        <div>
          <h2 className="display" id="get-title">
            A whole city is waiting for your first route.
          </h2>
          <p className="lead">Download the early build, pick a city and draw a line. Ideas and bug reports are welcome on GitHub.</p>
          <div className="actions">
            <a className="btn btn--dark" href={RELEASES}>
              <Download />
              Download the early build
            </a>
            <a className="btn btn--paper" href={REPO}>
              <GitHub />
              Follow on GitHub
            </a>
            <a className="btn btn--line" href={ISSUES}>
              Report a bug
            </a>
          </div>
          <p className="install-note">
            The builds are not code-signed yet. On a Mac, right-click the app and choose Open the first time. Windows may ask you to confirm before it runs. After that, the game updates itself.
          </p>
        </div>
        {/* a line 1 bus waiting at the terminus stop */}
        <div className="terminus-bus" aria-hidden="true">
          <div className="terminus-pole">
            <span>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#18201b" strokeWidth="2.2" strokeLinejoin="round">
                <rect x="5" y="3" width="14" height="15" rx="3" />
                <path d="M5 11h14M8 21v-3M16 21v-3" />
              </svg>
            </span>
            <i />
          </div>
          <BusArt model="city12" line="1" lineColour="#2f9e9a" livery="#2f9e9a" width={560} />
        </div>
      </div>
    </section>
  );
}
