// Small per-country conventions.

/** Countries where traffic keeps to the left. */
const LEFT = new Set([
  'GB', 'IE', 'JP', 'AU', 'NZ', 'IN', 'ZA', 'HK', 'MO', 'SG', 'MY', 'TH', 'ID', 'KE', 'UG', 'TZ', 'PK', 'BD', 'LK', 'NP',
  'CY', 'MT', 'JM', 'TT', 'BB', 'BS', 'MU', 'ZW', 'ZM', 'MW', 'BW', 'NA', 'MZ', 'SZ', 'LS', 'FJ', 'PG', 'BN', 'GY', 'SR',
]);

export function drivesOnLeft(country: string): boolean {
  return LEFT.has(country.toUpperCase());
}
