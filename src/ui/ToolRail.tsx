import { useEffect, useState } from 'react';
import { Cursor, Path, Graph, TrafficSignal, Fire, ListBullets, Bus, ChartLineUp, Plus, Minus, Cube, House, Info } from '@phosphor-icons/react';
import { useUI, type Tool, type Panel } from '../state/store.ts';
import { Tip } from './primitives.tsx';
import { mapRuntime } from '../map/runtime.ts';
import { HOME_VIEW } from '../sim/demoCity.ts';
import { sim } from '../sim/sim.ts';
import { clock } from './format.ts';
import { useSimMinute } from './hooks.ts';

const TOOLS: { id: Tool; icon: (on: boolean) => React.ReactNode; label: string; k: string; hint: string }[] = [
  { id: 'select', icon: (on) => <Cursor size={19} weight={on ? 'fill' : 'bold'} />, label: 'Select', k: 'V', hint: 'Inspect buses, lines and stops' },
  { id: 'route', icon: (on) => <Path size={20} weight={on ? 'fill' : 'bold'} />, label: 'Create route', k: 'R', hint: 'Click existing bus stops in order; the line follows real roads' },
];

export function ToolRail() {
  const tool = useUI((s) => s.tool);
  const overlays = useUI((s) => s.overlays);
  const panel = useUI((s) => s.panel);
  const setTool = useUI((s) => s.setTool);
  const toggle = useUI((s) => s.toggleOverlay);
  const openPanel = useUI((s) => s.openPanel);
  const panelBtn = (id: Exclude<Panel, null>, icon: React.ReactNode, label: string, k: string) => (
    <button className={`rail-btn has-tip ${panel === id ? 'panel-on' : ''}`} onClick={() => openPanel(panel === id ? null : id)} aria-label={label}>
      {icon}
      <Tip label={label} k={k} />
    </button>
  );
  return (
    <div className="card rail" role="toolbar" aria-label="Map tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={`rail-btn has-tip ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(tool === t.id && t.id !== 'select' ? 'select' : t.id)} aria-label={t.label}>
          {t.icon(tool === t.id)}
          <Tip label={t.label} k={t.k} hint={t.hint} />
        </button>
      ))}
      <div className="rail-sep" />
      <button className={`rail-btn has-tip ${overlays.network ? 'toggle-on' : ''}`} onClick={() => toggle('network')} aria-label="Network view">
        <Graph size={20} weight={overlays.network ? 'fill' : 'bold'} />
        <Tip label="Network view" k="N" hint="Flatten the city so your lines stand out" />
      </button>
      <button className={`rail-btn has-tip ${overlays.traffic ? 'toggle-on' : ''}`} onClick={() => toggle('traffic')} aria-label="Traffic">
        <TrafficSignal size={20} weight={overlays.traffic ? 'fill' : 'bold'} />
        <Tip label="Traffic" k="T" hint="Simulated congestion by time of day" />
      </button>
      <button className={`rail-btn has-tip ${overlays.demand ? 'toggle-on' : ''}`} onClick={() => toggle('demand')} aria-label="Demand">
        <Fire size={20} weight={overlays.demand ? 'fill' : 'bold'} />
        <Tip label="Passenger demand" k="P" hint="Estimated trip potential from building density" />
      </button>
      <div className="rail-sep" />
      {panelBtn('lines', <ListBullets size={20} weight="bold" />, 'Lines', 'L')}
      {panelBtn('fleet', <Bus size={20} weight="bold" />, 'Fleet', 'G')}
      {panelBtn('finance', <ChartLineUp size={20} weight="bold" />, 'Finances', 'M')}
    </div>
  );
}

export function MapControls() {
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(HOME_VIEW.pitch);
  useEffect(
    () =>
      mapRuntime.onReady(() => {
        const map = mapRuntime.map!;
        const upd = () => {
          setBearing(map.getBearing());
          setPitch(map.getPitch());
        };
        map.on('rotate', upd);
        map.on('pitch', upd);
        upd();
      }),
    [],
  );
  const map = () => mapRuntime.map;
  return (
    <div className="mapctl">
      <div className="card">
        <button className="icon-btn has-tip" onClick={() => map()?.easeTo({ bearing: 0, duration: 600 })} aria-label="Reset north">
          <span className="compass" style={{ display: 'grid' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" style={{ transform: `rotate(${-bearing}deg)` }}>
              <path d="M10 2.5 13 10h-6z" fill="#ef8f7d" />
              <path d="M10 17.5 7 10h6z" fill="#a9b4ac" />
            </svg>
          </span>
          <Tip label="Reset north" k="Q / E rotate" side="left" />
        </button>
        <button className="icon-btn has-tip" onClick={() => map()?.easeTo({ pitch: pitch > 20 ? 0 : HOME_VIEW.pitch, duration: 700 })} aria-label="Toggle tilt">
          <Cube size={18} weight={pitch > 20 ? 'fill' : 'bold'} />
          <Tip label={pitch > 20 ? 'Top-down view' : 'Miniature view'} hint="Right-drag to tilt and rotate" side="left" />
        </button>
        <button className="icon-btn has-tip" onClick={() => map()?.flyTo({ ...HOME_VIEW, duration: 1400 })} aria-label="Home view">
          <House size={18} weight="bold" />
          <Tip label="Home view" k="H" side="left" />
        </button>
      </div>
      <div className="card">
        <button className="icon-btn has-tip" onClick={() => map()?.zoomIn({ duration: 300 })} aria-label="Zoom in">
          <Plus size={18} weight="bold" />
          <Tip label="Zoom in" k="+" side="left" />
        </button>
        <button className="icon-btn has-tip" onClick={() => map()?.zoomOut({ duration: 300 })} aria-label="Zoom out">
          <Minus size={18} weight="bold" />
          <Tip label="Zoom out" k="−" side="left" />
        </button>
      </div>
    </div>
  );
}

export function Attribution() {
  return (
    <div className="attrib">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> ·{' '}
      <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ·{' '}
      <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
    </div>
  );
}

export function Legends() {
  useSimMinute();
  const overlays = useUI((s) => s.overlays);
  const [h, m] = clock(Math.floor(sim.minutes / 10) * 10);
  return (
    <>
      {overlays.traffic && (
        <div className="card legend">
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Traffic</span>
            <span className="faint num" style={{ fontSize: 12, fontWeight: 700 }}>{h}:{m}</span>
          </div>
          <div className="ramp" style={{ background: 'linear-gradient(90deg,#62c98d,#9fd35f,#f0c04f,#ee8b55,#de5a5a)' }} />
          <div className="ramp-labels"><span>Free flowing</span><span>Heavy</span><span>Standstill</span></div>
          <div className="estimate"><Info size={13} weight="bold" /> Simulated estimate, not live data</div>
        </div>
      )}
      {overlays.demand && (
        <div className="card legend">
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Passenger demand</span>
            <span className="faint" style={{ fontSize: 12, fontWeight: 700 }}>All day</span>
          </div>
          <div className="ramp" style={{ background: 'linear-gradient(90deg,rgba(70,170,180,.5),rgba(150,205,120,.8),#f2c652,#ee8054,#de566e)' }} />
          <div className="ramp-labels"><span>Low</span><span>Medium</span><span>High</span></div>
          <div className="estimate"><Info size={13} weight="bold" /> Estimated from OSM building floor area</div>
        </div>
      )}
    </>
  );
}

export function Toast() {
  const toast = useUI((s) => s.toast);
  const [shown, setShown] = useState<typeof toast>(null);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShown(toast);
    setOut(false);
    const a = setTimeout(() => setOut(true), 3600);
    const b = setTimeout(() => setShown(null), 3850);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [toast]);
  if (!shown) return null;
  const colour = shown.tone === 'warn' ? 'var(--amber)' : shown.tone === 'good' ? 'var(--mint)' : '#8cc6ef';
  return (
    <div className={`card toast ${out ? 'out' : ''}`} key={shown.id}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: colour }} />
      {shown.text}
    </div>
  );
}
