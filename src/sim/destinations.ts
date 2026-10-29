// Real places (OSM positions) used as passenger destinations. Trip counts are prototype values.
export interface Destination {
  id: string;
  name: string;
  kind: 'culture' | 'shopping' | 'education' | 'hub';
  colour: string;
  lngLat: [number, number];
  tripsPerHour: number;
}

const C = { culture: '#3fae7a', shopping: '#e0667c', education: '#4f8fe0', hub: '#47545d' } as const;

const RAW: Omit<Destination, 'colour'>[] = [
  { id: 'galata', name: 'Galata Kulesi', kind: 'culture', lngLat: [28.97421, 41.02563], tripsPerHour: 46 },
  { id: 'spice', name: 'Mısır Çarşısı', kind: 'shopping', lngLat: [28.9706, 41.0166], tripsPerHour: 62 },
  { id: 'khas', name: 'Kadir Has Üniversitesi', kind: 'education', lngLat: [28.9594, 41.0247], tripsPerHour: 28 },
  { id: 'sirkeci', name: 'Sirkeci Garı', kind: 'hub', lngLat: [28.9769, 41.0148], tripsPerHour: 54 },
  { id: 'karakoy-pier', name: 'Karaköy İskelesi', kind: 'hub', lngLat: [28.9773, 41.0219], tripsPerHour: 38 },
  { id: 'modern', name: 'İstanbul Modern', kind: 'culture', lngLat: [28.9836, 41.0262], tripsPerHour: 24 },
  { id: 'msgsu', name: 'Mimar Sinan GSÜ', kind: 'education', lngLat: [28.9851, 41.0293], tripsPerHour: 19 },
  { id: 'pera', name: 'Pera Müzesi', kind: 'culture', lngLat: [28.9752, 41.0318], tripsPerHour: 17 },
  { id: 'kabatas', name: 'Kabataş İskelesi', kind: 'hub', lngLat: [28.9935, 41.0332], tripsPerHour: 41 },
];

export const DESTINATIONS: Destination[] = RAW.map((d) => ({ ...d, colour: C[d.kind] }));
