// Build src/data/airports.json from the OurAirports airports list (public domain,
// https://ourairports.com/data/). Keeps airports with scheduled passenger service and an IATA
// code: [iata, icao, type (L large, M medium, S small), name, lng, lat].
// Usage: curl -LO https://davidmegginson.github.io/ourairports-data/airports.csv
//        node scripts/data/build-airports.mjs path/to/airports.csv
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: build-airports.mjs airports.csv');

/** Minimal CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parse(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else if (c !== '\r') field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

const [head, ...rows] = parse(readFileSync(file, 'utf8'));
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const TYPE = { large_airport: 'L', medium_airport: 'M', small_airport: 'S' };
const out = [];
for (const r of rows) {
  const type = TYPE[r[col.type]];
  const iata = r[col.iata_code]?.trim();
  if (!type || r[col.scheduled_service] !== 'yes' || !/^[A-Z]{3}$/.test(iata ?? '')) continue;
  const icao = (r[col.icao_code] || r[col.gps_code] || '').trim();
  const lng = +(+r[col.longitude_deg]).toFixed(4), lat = +(+r[col.latitude_deg]).toFixed(4);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
  out.push([iata, /^[A-Z0-9]{4}$/.test(icao) ? icao : '', type, r[col.name].trim(), lng, lat]);
}
out.sort((a, b) => a[0].localeCompare(b[0]));
const json = '{"source":"OurAirports (public domain), https://ourairports.com/data/","airports":[\n' + out.map((a) => JSON.stringify(a)).join(',\n') + '\n]}\n';
writeFileSync('src/data/airports.json', json);
console.log(`${out.length} airports, ${(json.length / 1024).toFixed(0)} KB (L ${out.filter((a) => a[2] === 'L').length}, M ${out.filter((a) => a[2] === 'M').length}, S ${out.filter((a) => a[2] === 'S').length})`);
