// Region data: everything the simulation needs to know about a real place.
// Built at runtime from OpenMapTiles vector tiles (see regionBuilder.ts).

import type { LngLat, RoadGraph, SpatialIndex } from './graph.ts';
import type { CityPlace } from './places.ts';

export interface RegionSpec {
  /** stable id, e.g. "istanbul-galata" */
  id: string;
  /** player-facing place name, e.g. "İstanbul" */
  city: string;
  /** area label, e.g. "Beyoğlu & Fatih" */
  area: string;
  /** ISO 3166-1 alpha-2 country code, for currency */
  country: string;
  centre: LngLat;
  /** z14 tiles that make up the playable region */
  tiles: [number, number][];
  /** tile URL template the region was built from (keeps saves reproducible) */
  tileTemplate?: string;
}

export type PoiKind =
  | 'school' | 'university' | 'hospital' | 'clinic' | 'shopping' | 'mall' | 'market'
  | 'food' | 'culture' | 'leisure' | 'park' | 'station' | 'ferry' | 'office' | 'civic' | 'hotel' | 'worship';

export interface Poi {
  id: number;
  name: string;
  kind: PoiKind;
  lngLat: LngLat;
  /** relative importance for display (trip attraction share) */
  weight: number;
}

export interface Place {
  name: string;
  kind: string;
  lngLat: LngLat;
}

/** Aggregated land use on a regular grid in local metres. Estimates, not official statistics. */
export interface DemandGrid {
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
  /** estimated residents per cell */
  residents: Float32Array;
  /** estimated jobs per cell */
  jobs: Float32Array;
  /** attraction weights per purpose */
  education: Float32Array;
  shopping: Float32Array;
  leisure: Float32Array;
  /** health, civic and transport hubs */
  other: Float32Array;
  /** road length per cell, metres (used for traffic density and land detection) */
  roads: Float32Array;
}

export interface Zone {
  id: string;
  name: string;
  /** outline in lng/lat (closed implicitly) */
  ring: LngLat[];
  centroid: LngLat;
  seed: LngLat;
  neighbours: string[];
  areaKm2: number;
  /** built-up land: the part with streets or buildings (not water); missing in older data */
  landKm2?: number;
  /** open water (hardly any land): never licensed, shown beside the areas you operate */
  water?: boolean;
  residents: number;
  jobs: number;
  /** named after an OSM place (true) or an unnamed generated area (false) */
  named: boolean;
  /** notable destinations inside */
  highlights: string[];
}

export interface OsmStop {
  name: string;
  lngLat: LngLat;
}

export interface StreetName {
  name: string;
  /** flattened local metre coordinates x0,y0,x1,y1,... */
  pts: number[];
}

export interface RegionCoverage {
  roadKm: number;
  oneWayShare: number;
  bridges: number;
  tunnels: number;
  buildings: number;
  buildingsWithHeight: number;
  pois: number;
  osmStops: number;
  places: number;
  /** entries in the Place Registry (missing in older data) */
  cityPlaces?: number;
  /** traffic data source; we only have a simulated model */
  traffic: 'simulated';
  /** tiles that failed to load */
  missingTiles: number;
}

export interface RegionData {
  spec: RegionSpec;
  graph: RoadGraph;
  bounds: { w: number; s: number; e: number; n: number };
  pois: Poi[];
  /** OSM place labels (neighbourhoods, suburbs) */
  places: Place[];
  /** the Place Registry: airports, stations and destinations (placeBuilder.ts) */
  cityPlaces: CityPlace[];
  demand: DemandGrid;
  zones: Zone[];
  osmStops: OsmStop[];
  streets: StreetName[];
  coverage: RegionCoverage;
  /** fingerprint of the graph, stored in saves to detect changed source data */
  fingerprint: string;
}

/** Region data plus derived runtime indexes (not serialised). */
export interface Region extends RegionData {
  index: SpatialIndex;
}

export const POI_LABEL: Record<PoiKind, string> = {
  school: 'School', university: 'University', hospital: 'Hospital', clinic: 'Clinic', shopping: 'Shops', mall: 'Shopping centre',
  market: 'Market', food: 'Food & drink', culture: 'Culture', leisure: 'Leisure', park: 'Park', station: 'Station', ferry: 'Ferry pier',
  office: 'Offices', civic: 'Public services', hotel: 'Hotel', worship: 'Place of worship',
};
