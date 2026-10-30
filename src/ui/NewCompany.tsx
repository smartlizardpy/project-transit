import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, MagnifyingGlass, Crosshair, MapPin, WifiSlash, X } from '@phosphor-icons/react';
import { LngLatBounds } from 'maplibre-gl';
import { create } from 'zustand';
import '../styles/menu.css';
import { useSession, session } from '../app/session.ts';
import { PRESETS, presetSpec, customSpec } from '../app/presets.ts';
import { mapRuntime } from '../map/runtime.ts';
import { COMPANY_COLOURS, ECON, MODELS, STARTING_REPUTATION } from '../game/content.ts';
import { currencyFor, formatMoney } from '../game/currency.ts';
import { landOf, startingZones, START_AREA_KM2 } from '../game/progress.ts';
import { flyToRegion } from './camera.ts';
import { CompanyMark, LOGOS } from './logos.tsx';
import { BusArt } from './BusArt.tsx';
import { tileAt, zoneId } from '../game/world/zoneTiles.ts';
import type { PoiKind, Region, Zone } from '../game/world/region.ts';

const COLOUR_NAMES: Record<string, string> = { '#e0573e': 'Coral', '#2f9e9a': 'Teal', '#4f7fd6': 'Blue', '#d9a03a': 'Amber', '#8b6fd6': 'Violet', '#3e9e5b': 'Green', '#d65f8f': 'Rose', '#3b4a54': 'Slate' };
const LOGO_NAMES = ['Bridge', 'Bus', 'Loop line', 'Compass', 'Waves', 'Junction'];

/** Places worth a line, in the order they are listed. */
const PLACE_KINDS: [PoiKind, string, string][] = [
  ['university', 'university', 'universities'],
  ['hospital', 'hospital', 'hospitals'],
  ['station', 'station', 'stations'],
  ['ferry', 'ferry pier', 'ferry piers'],
  ['mall', 'shopping centre', 'shopping centres'],
  ['school', 'school', 'schools'],
];
const placeNames = new WeakMap<Region, Map<string, Map<PoiKind, Set<string>>>>();

/**
 * "Universities · hospitals · a station" for a set of areas. Kinds only, not counts: OSM often
 * maps one university or hospital as many buildings.
 */
function placesIn(region: Region, ids: readonly string[]): string {
  let byZone = placeNames.get(region);
  if (!byZone) {
    byZone = new Map();
    for (const p of region.pois) {
      const id = zoneId(...tileAt(p.lngLat));
      const kinds = byZone.get(id) ?? new Map<PoiKind, Set<string>>();
      kinds.set(p.kind, (kinds.get(p.kind) ?? new Set()).add(p.name.toLowerCase()));
      byZone.set(id, kinds);
    }
    placeNames.set(region, byZone);
  }
  const names = new Map<PoiKind, Set<string>>();
  for (const id of ids)
    for (const [k, v] of byZone.get(id) ?? []) names.set(k, new Set([...(names.get(k) ?? []), ...v]));
  const list = PLACE_KINDS.filter(([k]) => names.get(k)?.size).slice(0, 4).map(([k, one, many]) => (names.get(k)!.size === 1 ? `a ${one}` : many));
  return list.join(' · ').replace(/^a /, 'A ').replace(/^./, (c) => c.toUpperCase());
}

/** How busy an area is compared with the rest of the city (rank 0 = busiest). */
function busyness(rank: number, count: number): { label: string; cls: string } {
  const q = rank / Math.max(1, count - 1);
  if (q < 0.2) return { label: 'Very busy', cls: 'good' };
  if (q < 0.5) return { label: 'Busy', cls: 'info' };
  if (q < 0.8) return { label: 'Moderate', cls: '' };
  return { label: 'Quiet', cls: 'gen' };
}

const mix = (z: Zone) => (z.residents > 1.6 * z.jobs ? 'mostly homes' : z.jobs > 1.6 * z.residents ? 'mostly workplaces' : 'homes and workplaces');

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
  const loadError = useSession((s) => s.error);
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
          <div><h2>Where will your company run?</h2><p>Step 1 of 3 · Choose a place</p></div>
        </div>
        <div className="mn-scroll">
          {loadError && (
            <div className="mn-error" role="alert">
              <span>{loadError}</span>
              <button className="close-btn" aria-label="Dismiss" onClick={() => useSession.setState({ error: null })}><X size={12} weight="bold" /></button>
            </div>
          )}
          <div className="label">Pick a city</div>
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

          <div className="label mn-gap">Or anywhere in the world</div>
          <form className="mn-search" onSubmit={search}>
            <MagnifyingGlass size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="A town or city, e.g. Leeds, Lyon, Kadıköy" aria-label="Search for a place" />
            <button className="btn sm" type="submit" disabled={busy || !q.trim()}>{busy ? 'Searching…' : 'Search'}</button>
          </form>
          {err && <p className="mn-note warn">{err}</p>}
          {hits && !hits.length && <p className="mn-note">No places found. Try a different spelling, or add the country.</p>}
          {hits && hits.length > 0 && <p className="mn-hint">Pick one to build its map. Downloading takes a few seconds.</p>}
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
          <div className="label mn-gap">Or start where the map is</div>
          <p className="mn-hint">Drag the map behind this panel to any place, then start there.</p>
          <div className="mn-here">
            <input value={viewName} onChange={(e) => setViewName(e.target.value.slice(0, 40))} placeholder="Name this place (optional)" aria-label="Name for the place in the map view" />
            <button className="btn sm" onClick={here} disabled={!mapRuntime.map}><Crosshair size={14} /> Start here</button>
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

/** The starting area a home area gives: it plus the areas around it. */
function startOf(id: string) {
  const zones = session.region?.zones ?? [];
  const list = startingZones(zones, id).map((zid) => zones.find((z) => z.id === zid)!).filter(Boolean);
  const sum = (f: (z: (typeof list)[number]) => number) => list.reduce((a, z) => a + f(z), 0);
  return { zones: list, km2: sum(landOf), residents: sum((z) => z.residents), jobs: sum((z) => z.jobs) };
}

/** Frame a home area's whole starting area on the map beside the setup panel. */
function showZone(id: string) {
  const map = mapRuntime.map;
  const start = startOf(id);
  if (!map || !start.zones.length) return;
  const b = new LngLatBounds();
  for (const z of start.zones) for (const p of z.ring) b.extend(p as [number, number]);
  const right = document.querySelector('.mn-panel')?.getBoundingClientRect().right ?? 0;
  map.fitBounds(b, { padding: { left: right + 40, right: 60, top: 80, bottom: 80 }, maxZoom: 15.5, pitch: 45, bearing: map.getBearing(), duration: 1100 });
}

/** "You start with Mahmutpaşa + 4 areas around it · 14.8 km² …" */
function StartSummary({ id }: { id: string }) {
  const s = startOf(id);
  const n = (v: number) => Math.round(v / 1000) * 1000;
  const others = s.zones.length - 1;
  const places = session.region ? placesIn(session.region, s.zones.map((z) => z.id)) : '';
  return (
    <span className="mn-zone-start">
      You start with {others > 0 ? `${s.zones[0].name} + ${others} area${others > 1 ? 's' : ''} around it` : s.zones[0].name}: {s.km2.toFixed(1)} km², ≈{n(s.residents).toLocaleString()} residents and ≈{n(s.jobs).toLocaleString()} jobs
      {places && <><br />With {places.charAt(0).toLowerCase() + places.slice(1)}</>}
    </span>
  );
}

function Setup() {
  const region = session.region;
  const spec = useSession((s) => s.pending?.spec);
  const step = useSession((s) => s.setupStep);
  const city = spec?.city ?? region?.spec.city ?? '';
  // kept here so going back to the area step does not lose them
  const [name, setName] = useState(`${city} Transit`);
  const [colour, setColour] = useState(COMPANY_COLOURS[0]);
  const [logo, setLogo] = useState(0);
  useEffect(() => { flyToRegion(); }, []);
  return step === 'area' ? <AreaStep city={city} /> : <CompanyStep city={city} name={name} setName={setName} colour={colour} setColour={setColour} logo={logo} setLogo={setLogo} />;
}

function AreaStep({ city }: { city: string }) {
  const region = session.region;
  const homeZone = useSession((s) => s.homeZone);
  const zones = useMemo(() => (region?.zones ?? []).filter((z) => !z.water).sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs)), [region]);
  // suggest the busiest area; the player can pick any other
  useEffect(() => {
    if (!useSession.getState().homeZone && zones[0]) useSession.setState({ homeZone: zones[0].id });
  }, [zones]);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (homeZone) refs.current.get(homeZone)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [homeZone]);
  const n = (v: number) => Math.round(v / 100) * 100;
  const next = () => homeZone && useSession.setState({ setupStep: 'company' });

  return (
    <div className="mn-flow">
      <div className="mn-scrim" />
      <div className="card mn-panel setup">
        <div className="mn-panel-head">
          <button className="icon-btn" onClick={() => session.cancelSetup()} aria-label="Back"><ArrowLeft size={18} /></button>
          <div><h2>Choose your home area</h2><p>Step 2 of 3 · {city}</p></div>
        </div>
        <div className="mn-scroll">
          <p className="mn-note">Your company starts in its home area and the areas around it: about {START_AREA_KM2} km² of streets. Each area is a map square about 2 km across. Busier areas have more riders, and more traffic. Later you can license the areas next door, and the map opens up as you grow.</p>
          <p className="mn-hint">Click an area in the list or on the map. Residents, jobs and places are estimates from OpenStreetMap.</p>
          <div className="mn-zones">
            {zones.map((z, rank) => {
              const busy = busyness(rank, zones.length);
              const places = region ? placesIn(region, [z.id]) : '';
              return (
              <button
                key={z.id}
                ref={(el) => { if (el) refs.current.set(z.id, el); }}
                className={'mn-zone' + (homeZone === z.id ? ' on' : '')}
                aria-pressed={homeZone === z.id}
                onClick={() => { useSession.setState({ homeZone: z.id }); showZone(z.id); }}
                onDoubleClick={next}
              >
                <span className="mn-zone-top"><b>{z.name}</b><span className={'pill mn-tag ' + busy.cls}>{busy.label}</span></span>
                <span className="mn-zone-sub">≈{n(z.residents).toLocaleString()} residents · ≈{n(z.jobs).toLocaleString()} jobs · {mix(z)}</span>
                {places ? <span className="mn-zone-hl">{places}</span> : z.highlights.length > 0 && <span className="mn-zone-hl">{z.highlights.slice(0, 3).join(' · ')}</span>}
                {homeZone === z.id && <StartSummary id={z.id} />}
              </button>
              );
            })}
          </div>
        </div>
        <div className="mn-panel-foot">
          <button className="btn" onClick={() => session.cancelSetup()}>Back</button>
          <button className="btn primary" disabled={!homeZone} onClick={next}>Next: your company <ArrowRight size={14} weight="bold" /></button>
        </div>
      </div>
    </div>
  );
}

interface CompanyStepProps {
  city: string;
  name: string;
  setName: (v: string) => void;
  colour: string;
  setColour: (v: string) => void;
  logo: number;
  setLogo: (v: number) => void;
}

function CompanyStep({ city, name, setName, colour, setColour, logo, setLogo }: CompanyStepProps) {
  const region = session.region;
  const spec = useSession((s) => s.pending?.spec);
  const homeZone = useSession((s) => s.homeZone);
  const zone = region?.zones.find((z) => z.id === homeZone);
  useEffect(() => {
    if (homeZone) showZone(homeZone);
  }, [homeZone]);
  const cur = currencyFor(spec?.country ?? region?.spec.country);
  const n = (v: number) => Math.round(v / 100) * 100;
  const start = zone ? startOf(zone.id) : null;
  const cheapestBus = Math.min(...MODELS.filter((m) => m.unlockRep <= STARTING_REPUTATION && !m.unlockObjective).map((m) => m.price));
  const suggestions = [...new Set([`${city} Transit`, zone?.named ? `${zone.name} Buses` : '', `${city} City Lines`, zone?.named ? `${zone.name} Express` : `${city} Bus Company`])].filter((s) => s && s.length <= 40);
  const back = () => useSession.setState({ setupStep: 'area' });
  const ready = name.trim().length > 0 && !!homeZone;
  const found = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (ready && homeZone) session.startNew({ name: name.trim(), colour, logo }, homeZone);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && back();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="mn-flow">
      <div className="mn-scrim" />
      <form className="card mn-panel setup compact" onSubmit={found}>
        <div className="mn-panel-head">
          <button type="button" className="icon-btn" onClick={back} aria-label="Back"><ArrowLeft size={18} /></button>
          <div><h2>Found your company</h2><p>Step 3 of 3 · {zone ? `${zone.name}, ` : ''}{city}</p></div>
        </div>
        <div className="mn-scroll">
          {zone && (
            <div className="mn-home">
              <MapPin size={18} weight="fill" />
              <div><b>{zone.name}</b><span>Home area · {start?.zones.length} areas, {start?.km2.toFixed(1)} km² · ≈{n(start?.residents ?? 0).toLocaleString()} residents</span></div>
              <button type="button" className="btn sm" onClick={back}>Change</button>
            </div>
          )}
          <div className="label mn-gap">Company name</div>
          <div className="mn-id">
            <CompanyMark logo={logo} colour={colour} size={52} />
            <input value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${city} Transit`} aria-label="Company name" />
          </div>
          <div className="mn-suggest" aria-label="Name ideas">
            {suggestions.map((s) => (
              <button type="button" key={s} className={s === name.trim() ? 'on' : ''} onClick={() => setName(s)}>{s}</button>
            ))}
          </div>
          <div className="mn-paint">
            <div>
              <div className="label mn-gap">Colour · <span className="mn-pick">{COLOUR_NAMES[colour] ?? colour}</span></div>
              <p className="mn-hint">The paint on your buses and depots.</p>
              <div className="mn-swatches" role="radiogroup" aria-label="Company colour">
                {COMPANY_COLOURS.map((c) => (
                  <button type="button" key={c} role="radio" aria-checked={c === colour} aria-label={COLOUR_NAMES[c] ?? c} title={COLOUR_NAMES[c]} className={c === colour ? 'on' : ''} style={{ background: c }} onClick={() => setColour(c)} />
                ))}
              </div>
            </div>
            <div className="mn-bus" aria-hidden><BusArt model="midi10" livery={colour} width={150} /></div>
          </div>
          <div className="label mn-gap">Logo · <span className="mn-pick">{LOGO_NAMES[logo] ?? `Logo ${logo + 1}`}</span></div>
          <div className="mn-logos" role="radiogroup" aria-label="Company logo">
            {LOGOS.map((_, i) => (
              <button type="button" key={i} role="radio" aria-checked={i === logo} aria-label={LOGO_NAMES[i] ?? `Logo ${i + 1}`} title={LOGO_NAMES[i]} className={i === logo ? 'on' : ''} onClick={() => setLogo(i)}>
                <CompanyMark logo={i} colour={colour} size={38} />
              </button>
            ))}
          </div>
          <div className="label mn-gap">What you start with</div>
          <div className="mn-summary">
            <div><b className="num">{formatMoney(cur, ECON.startingFunds, { compact: true })}</b><span>A depot costs {formatMoney(cur, ECON.depotCost, { compact: true })}; buses from {formatMoney(cur, cheapestBus, { compact: true })}</span></div>
            <div><b className="num">{STARTING_REPUTATION}<small> / 100</small></b><span>Reputation. Good service raises it and unlocks bigger buses and new areas</span></div>
            <div><b>{start?.zones.length ?? 1} areas</b><span>{start ? `${start.km2.toFixed(1)} km² licensed. ` : ''}The areas next door are for sale</span></div>
          </div>
          <p className="mn-hint mn-next">The game starts paused at 05:00 on a Monday. A short guide shows you how to build your first depot, bus and line; you can hide it.</p>
        </div>
        <div className="mn-panel-foot">
          <button type="button" className="btn" onClick={back}>Back</button>
          {!name.trim() && <span className="mn-foot-hint">Name your company to continue</span>}
          <button type="submit" className="btn primary" disabled={!ready}>Found company</button>
        </div>
      </form>
    </div>
  );
}
