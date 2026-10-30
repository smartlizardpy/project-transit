import { BASE, NAV, README, RELEASES, REPO } from '../content/site.ts';

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-top">
          <a className="brand" href="#top">
            <img src={`${BASE}mark-96.png`} alt="" width={40} height={40} />
            <span className="brand-name">
              <strong>Project Transit</strong>
              <span>A bus company in a real city</span>
            </span>
          </a>
          <nav aria-label="Footer">
            <ul>
              {NAV.map((l) => (
                <li key={l.href}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
              <li>
                <a href={RELEASES}>Downloads</a>
              </li>
              <li>
                <a href={REPO}>GitHub</a>
              </li>
              <li>
                <a href={README}>Read me</a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="footer-bottom">
          <p>
            Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, available under the Open Database License. Map tiles from <a href="https://openmaptiles.org/">OpenMapTiles</a>, served by{' '}
            <a href="https://openfreemap.org/">OpenFreeMap</a>. The screenshots show the game&rsquo;s own rendering of that data.
          </p>
          <p>Project Transit is an independent game in development. Set in Figtree, under the SIL Open Font License.</p>
        </div>
      </div>
    </footer>
  );
}
