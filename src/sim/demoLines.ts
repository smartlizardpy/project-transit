// Demonstration network for the Istanbul prototype.
// Stop names and positions come from OpenStreetMap bus-stop nodes; line numbers,
// colours, fleets and all performance numbers are invented prototype data.

export interface DemoStopDef {
  name: string;
  at: [number, number]; // lng, lat (snapped to the road graph when baked)
  via?: [number, number][]; // routing hints after this stop
}

export interface DemoLineDef {
  id: string;
  number: string;
  name: string;
  colour: string;
  vehicles: number;
  stops: DemoStopDef[];
}

export const DEMO_LINES: DemoLineDef[] = [
  {
    id: 'L26',
    number: '26',
    name: 'Eminönü – Kabataş',
    colour: '#2f9e9a',
    vehicles: 4,
    stops: [
      { name: 'Eminönü İskele', at: [28.97531, 41.0167] },
      { name: 'Karaköy', at: [28.97503, 41.02211] },
      { name: 'Tophane', at: [28.98046, 41.02674] },
      { name: 'Salıpazarı', at: [28.98408, 41.02785] },
      { name: 'Fındıklı', at: [28.9898, 41.03148] },
      { name: 'Kabataş', at: [28.9932, 41.03456] },
    ],
  },
  {
    id: 'L32',
    number: '32',
    name: 'Haliç Bridges Loop',
    colour: '#e3a33b',
    vehicles: 3,
    stops: [
      { name: 'Mısır Çarşısı', at: [28.97019, 41.01776] },
      { name: 'Kantarcılar', at: [28.96498, 41.01925] },
      { name: 'Unkapanı', at: [28.95942, 41.02042] },
      { name: 'Azapkapı', at: [28.96926, 41.02495] },
      { name: 'Perşembe Pazarı', at: [28.97033, 41.0237] },
      { name: 'Karaköy', at: [28.97441, 41.02217] },
    ],
  },
  {
    id: 'L46',
    number: '46',
    name: 'Sirkeci – Tepebaşı',
    colour: '#8b6fd6',
    vehicles: 3,
    stops: [
      { name: 'Sirkeci', at: [28.97714, 41.01611] },
      { name: 'Karaköy', at: [28.97503, 41.02211] },
      { name: 'Kemeraltı', at: [28.97694, 41.02501] },
      { name: 'Şişhane', at: [28.96988, 41.02791] },
      { name: 'Tepebaşı', at: [28.97444, 41.03296] },
    ],
  },
];
