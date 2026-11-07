// Frame rate and graphics card in a corner (Settings → Show frame rate), so a slow PC can be
// told apart from a game that runs on the wrong graphics chip or without one.
import { useEffect, useState } from 'react';
import { mapRuntime } from '../map/runtime.ts';
import { loadSettings, onSettings } from '../app/session.ts';
import { gpuKind, gpuLabel } from '../map/pacing.ts';

export function PerfMeter() {
  const [on, setOn] = useState(() => loadSettings().showFps);
  useEffect(() => onSettings((s) => setOn(s.showFps)), []);
  const [info, setInfo] = useState<{ fps: number; worst: number; gpu: string | null; px: string } | null>(null);
  useEffect(() => {
    if (!on) return;
    let frames = 0, worst = 0, prev = 0;
    let cleanup = () => {};
    const off = mapRuntime.onReady(() => {
      const map = mapRuntime.map!;
      const onRender = () => {
        const now = performance.now();
        if (prev) worst = Math.max(worst, now - prev);
        prev = now;
        frames++;
      };
      map.on('render', onRender);
      const id = setInterval(() => {
        const c = map.getCanvas();
        setInfo({ fps: frames, worst: Math.round(worst), gpu: mapRuntime.city?.gpu ?? null, px: `${c.width}×${c.height}` });
        frames = 0;
        worst = 0;
      }, 1000);
      cleanup = () => {
        map.off('render', onRender);
        clearInterval(id);
      };
    });
    return () => {
      off();
      cleanup();
      setInfo(null);
    };
  }, [on]);
  if (!on || !info) return null;
  const kind = info.gpu ? gpuKind(info.gpu) : null;
  return (
    <div className="perf-meter" aria-live="off">
      <b>{info.fps} fps</b>
      <span>slowest {info.worst} ms</span>
      <span>{info.px}</span>
      {info.gpu && <span title={info.gpu}>{gpuLabel(info.gpu)}</span>}
      {kind && <span className="perf-warn">{kind === 'software' ? 'No graphics card in use' : 'Integrated graphics'}</span>}
    </div>
  );
}
