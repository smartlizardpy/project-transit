import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, MagnifyingGlass, Crosshair, WifiSlash } from '@phosphor-icons/react';
import { create } from 'zustand';
import '../styles/menu.css';
import { useSession, session } from '../app/session.ts';
import { PRESETS, presetSpec, customSpec } from '../app/presets.ts';
import { mapRuntime } from '../map/runtime.ts';
import { COMPANY_COLOURS, ECON, STARTING_REPUTATION } from '../game/content.ts';
import { currencyFor, formatMoney } from '../game/currency.ts';
import { focusZone, flyToRegion } from './camera.ts';
import { CompanyMark, LOGOS } from './logos.tsx';

/** Whether the player chose "New company" on the start menu. */
export const useNewCompanyFlow = create<{ open: boolean }>(() => ({ open: false }));
const closeFlow = () => useNewCompanyFlow.setState({ open: false });

interface Hit {
  place_id: number;
  display_name: string;
  name?: string;
  type?: string;
  lat: string;
  lon: string;
  address?: Record<string, string>;
}

export function NewCompany() {
  const phase = useSession((s) => s.phase);
  const open = useNewCompanyFlow((s) => s.open);
  useEffect(() => {
    if (phase === 'playing') closeFlow();
  }, [phase]);
  if (phase === 'loading') return <Loading />;
  if (phase === 'setup') return <Setup />;
  if (phase === 'menu' && open) return <Location />;
  return null;
}

function Location() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewName, setViewName] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && closeFlow();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term || busy) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en&q=${encodeURIComponent(term)}`, { signal: abort.current.signal });
      if (!r.ok) throw new Error(String(r.status));
      setHits((await r.json()) as Hit[]);
    } catch (x) {
      if ((x as Error).name !== 'AbortError') setErr('Search is unavailable right now. Check your connection, or pick a starting point below.');
    } finally {
      setBusy(false);
    }
  };
  const pick = (h: Hit) => {
    const a = h.address ?? {};
    const city = a.city || a.town || a.village || h.name || h.display_name.split(',')[0];
    void session.beginNew(customSpec([Number(h.lon), Number(h.lat)], city, a.suburb || a.neighbourhood || '', (a.country_code ?? '').toUpperCase()));
  };
  const here = () => {
    const c = mapRuntime.map?.getCenter();
    if (!c) return;
    const name = viewName.trim() || 'Home town';
    void session.beginNew(customSpec([c.lng, c.lat], name, '', ''));
  };

  return (
    <div className="mn-flow">
      <div className="mn-scrim" />
      <div className="card mn-panel">
        <div className="mn-panel-head">
          <button className="icon-btn" onClick={closeFlow} aria-label="Back"><ArrowLeft size={18} /></button>
          <div><h2>Where will your company run?</h2><p>Step 1 of 2 · Choose a place</p></div>
        </div>
        <div className="mn-scroll">
          <div className="label">Starting points</div>
          <div className="mn-presets">
            {PRESETS.map((p) => (
              <button key={p.id} className="mn-preset" onClick={() => void session.beginNew(presetSpec(p))}>
                <b>{p.city}</b>
                <span className="mn-area">{p.area}</span>
                <span className="mn-pnote">{p.note}</span>
                {p.offline && <span className="pill good mn-offline"><WifiSlash size={12} weight="bold" /> Works offline</span>}
              </button>
            ))}
          </div>

          <div className="label mn-gap">Anywhere else</div>
          <form className="mn-search" onSubmit={search}>
            <MagnifyingGlass size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a town or city, then press Enter" aria-label="Search for a place" />
            <button className="btn sm" type="submit" disabled={busy || !q.trim()}>{busy ? 'Searching…' : 'Search'}</button>
          </form>
          {err && <p className="mn-note warn">{err}</p>}
          {hits && !hits.length && <p className="mn-note">No places found. Try a different spelling.</p>}
          {hits && hits.length > 0 && (
            <ul className="mn-hits">
              {hits.map((h) => (
                <li key={h.place_id}>
                  <button onClick={() => pick(h)}>
                    <b>{h.display_name}</b>
                    <span>{h.type?.replace(/_/g, ' ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mn-here">
            <input value={viewName} onChange={(e) => setViewName(e.target.value.slice(0, 40))} placeholder="City name (optional)" aria-label="City name for the current map view" />
            <button className="btn sm" onClick={here} disabled={!mapRuntime.map}><Crosshair size={14} /> Start at the current map view</button>
          </div>

          <p className="mn-fine">
            Streets, buildings and places come from OpenStreetMap, downloaded when you choose a place (except offline ones). Residents, jobs and demand are modelled estimates, not census figures.
          </p>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  const progress = useSession((s) => s.progress);
  const city = useSession((s) => s.pending?.spec.city);
  const pct = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <div className="mn-flow center">
      <div className="mn-scrim full" />
      <div className="card mn-loading" role="status">
        <h2>{city ? `Building ${city}…` : 'Loading…'}</h2>
        <p>{progress?.stage ?? 'Preparing'}</p>
        <div className="mn-bar"><i style={{ width: `${Math.round(pct * 100)}%` }} /></div>
        <span className="mn-fine">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}

function Setup() {
  const region = session.region;
  const spec = useSession((s) => s.pending?.spec);
  const homeZone = useSession((s) => s.homeZone);
  const city = spec?.city ?? region?.spec.city ?? '';
  const [name, setName] = useState(`${city} Transit`);
  const [colour, setColour] = useState(COMPANY_COLOURS[0]);
  const [logo, setLogo] = useState(0);
  useEffect(() => { flyToRegion(); }, []);
  const zones = useMemo(() => [...(region?.zones ?? [])].sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs)), [region]);
  // suggest the busiest area; the player can pick any other
  useEffect(() => {
    if (!useSession.getState().homeZone && zones[0]) useSession.setState({ homeZone: zones[0].id });
  }, [zones]);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (homeZone) refs.current.get(homeZone)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [homeZone]);
  const cur = currencyFor(spec?.country ?? region?.spec.country);
  const n = (v: number) => Math.round(v / 100) * 100;
  const ready = name.trim().length > 0 && !!homeZone;

  return (
    <div className="mn-flow">
      <div className="mn-scrim" />
      <div className="card mn-panel setup">
        <div className="mn-panel-head">
          <button className="icon-btn" onClick={() => session.cancelSetup()} aria-label="Back"><ArrowLeft size={18} /></button>
          <div><h2>Found your company</h2><p>Step 2 of 2 · {city}</p></div>
        </div>
        <div className="mn-scroll">
          <div className="label">Choose your home area</div>
          <p className="mn-note">Your first licensed area. Pick from the list or click an area on the map. Figures are estimates.</p>
          <div className="mn-zones">
            {zones.map((z) => (
              <button
                key={z.id}
                ref={(el) => { if (el) refs.current.set(z.id, el); }}
                className={'mn-zone' + (homeZone === z.id ? ' on' : '')}
                aria-pressed={homeZone === z.id}
                onClick={() => { useSession.setState({ homeZone: z.id }); focusZone(z.id); }}
              >
                <span className="mn-zone-top"><b>{z.name}</b><span className={'pill mn-tag' + (z.named ? '' : ' gen')}>{z.named ? 'Neighbourhood' : 'Generated area'}</span></span>
                <span className="mn-zone-sub">≈{n(z.residents).toLocaleString()} residents · ≈{n(z.jobs).toLocaleString()} jobs</span>
                {z.highlights.length > 0 && <span className="mn-zone-hl">{z.highlights.slice(0, 3).join(' · ')}</span>}
              </button>
            ))}
          </div>

          <div className="label mn-gap">Your company</div>
          <div className="mn-id">
            <CompanyMark logo={logo} colour={colour} size={52} />
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Company name" />
          </div>
          <div className="mn-swatches" role="radiogroup" aria-label="Company colour">
            {COMPANY_COLOURS.map((c) => (
              <button key={c} role="radio" aria-checked={c === colour} aria-label={c} className={c === colour ? 'on' : ''} style={{ background: c }} onClick={() => setColour(c)} />
            ))}
          </div>
          <div className="mn-logos" role="radiogroup" aria-label="Company logo">
            {LOGOS.map((_, i) => (
              <button key={i} role="radio" aria-checked={i === logo} aria-label={`Logo ${i + 1}`} className={i === logo ? 'on' : ''} onClick={() => setLogo(i)}>
                <CompanyMark logo={i} colour={colour} size={38} />
              </button>
            ))}
          </div>

          <div className="mn-summary">
            <div><b className="num">{formatMoney(cur, ECON.startingFunds)}</b><span>Starting funds</span></div>
            <div><b className="num">{STARTING_REPUTATION}</b><span>Reputation</span></div>
            <div><b>1 area</b><span>Licensed, expand later</span></div>
          </div>
        </div>
        <div className="mn-panel-foot">
          <button className="btn" onClick={() => session.cancelSetup()}>Back</button>
          <button className="btn primary" disabled={!ready} onClick={() => homeZone && session.startNew({ name: name.trim(), colour, logo }, homeZone)}>Found company</button>
        </div>
      </div>
    </div>
  );
}
