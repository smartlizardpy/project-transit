// The starting cities offered in the game (src/app/presets.ts). Players can also search for
// any town; these five are the ones checked by hand.
export interface City {
  id: string;
  name: string;
  area: string;
  /** the game's own one-line description of the place */
  note: string;
  traffic: 'right' | 'left';
  currency: string;
  image: string;
  alt: string;
}

export const CITIES: City[] = [
  {
    id: 'istanbul',
    name: 'İstanbul',
    area: 'Beyoğlu & Fatih',
    note: 'Dense historic core, one-way streets, the Golden Horn bridges.',
    traffic: 'right',
    currency: 'Turkish lira',
    image: 'city-istanbul',
    alt: 'İstanbul in Project Transit: the old city beside the Golden Horn as a pale miniature model, with a coloured bus line crossing a bridge.',
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    area: 'Shibuya',
    note: 'Very dense, rail-centred, narrow streets.',
    traffic: 'left',
    currency: 'Japanese yen',
    image: 'city-tokyo',
    alt: 'Tokyo in Project Transit: tightly packed blocks around Shibuya with a bus line threading between them.',
  },
  {
    id: 'barcelona',
    name: 'Barcelona',
    area: 'Eixample',
    note: 'A regular grid of chamfered blocks.',
    traffic: 'right',
    currency: 'Euro',
    image: 'city-barcelona',
    alt: 'Barcelona in Project Transit: the Eixample grid of chamfered blocks with a bus line along one of its avenues.',
  },
  {
    id: 'hamburg',
    name: 'Hamburg',
    area: 'Altstadt & St. Pauli',
    note: 'A port city with canals and ring roads.',
    traffic: 'right',
    currency: 'Euro',
    image: 'city-hamburg',
    alt: 'Hamburg in Project Transit: canals and the old town as a miniature model, with a bus line running beside the water.',
  },
  {
    id: 'durham',
    name: 'Durham',
    area: 'City centre',
    note: 'A small university city on a river peninsula.',
    traffic: 'left',
    currency: 'Pound sterling',
    image: 'city-durham',
    alt: 'Durham in Project Transit: the river loop around the old city with a bus line crossing it.',
  },
];
