// The world palette. Values are derived from colour sampling of the reference
// screenshots (see docs/design/design-system.md), then tuned for our own renderer.

export const WORLD = {
  ground: '#ebe8e0',
  groundLow: '#e7e4da', // wide zoom: slightly deeper so the flat map reads calmly
  park: '#c9dbbb',
  parkEdge: '#bfd3b0',
  wood: '#bdd3ad',
  cemetery: '#cfdac3',
  pitch: '#c4d8b6',
  campus: '#e9e3d8',
  hospital: '#efe1dc',
  pedestrian: '#e4e2da',
  water: '#a4cad6',
  waterDeep: '#9ac2cf',
  waterEdge: '#b6d5de',
  waterLabel: '#5f8e9f',
  road: '#c6ced1',
  roadMajor: '#bfc8cc',
  roadBridgeCasing: '#a9b4b9',
  path: '#d8dbd6',
  rail: '#b9bdbb',
  ferry: '#7fa8b8',
  oneway: '#8a959c',
  streetLabel: '#68727d',
  placeLabel: '#7d838b',
  buildingFlat: '#d9d6cd',
} as const;

/** Building top colours (lit). Walls are derived by shading in the tile worker. */
export const BUILDING_TOPS: [string, number][] = [
  ['#d9d7d0', 0.3], // cool stone grey
  ['#dcd8ce', 0.24], // warm grey
  ['#e3e0d8', 0.16], // off-white
  ['#d9cdc2', 0.14], // taupe / pink-beige
  ['#ddd3c4', 0.1], // sand
  ['#d2d3cd', 0.06], // slate-tinted grey
];

export const ROOF_COLOURS: [string, number][] = [
  ['#d3bcaa', 0.45], // muted terracotta
  ['#cdb5a6', 0.2],
  ['#d0cec7', 0.35], // zinc grey
];

export const TREE = {
  trunk: '#7d5538',
  leafy: ['#8fbd5f', '#80b25a', '#9cc66c', '#76a957'],
  conifer: ['#417c5d', '#4b8763', '#386f53'],
  cypress: ['#3d6e52', '#46785a'],
} as const;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function pickWeighted<T>(items: [T, number][], r: number): T {
  let acc = 0;
  const total = items.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of items) {
    acc += w / total;
    if (r < acc) return v;
  }
  return items[items.length - 1][0];
}
