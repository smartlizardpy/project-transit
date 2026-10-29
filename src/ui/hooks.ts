import { useEffect, useReducer } from 'react';
import { sim } from '../sim/sim.ts';

/** Re-render on a fixed cadence while mounted (for live readouts). */
export function useTicker(hz = 4) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(force, 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
}

/** Re-render once per in-game minute (clock, money). */
export function useSimMinute() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => sim.onMinute(force), []);
}
