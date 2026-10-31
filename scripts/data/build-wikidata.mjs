// Build src/data/wikidata-places.json from Wikidata (CC0, https://www.wikidata.org): measured
// sizes that the map tiles do not carry.
//   airports: annual passengers (P3872) by IATA code, latest full year (run build-airports first)
//   places:   stadium capacity (P1083), university students (P2196), hospital beds (P6801)
//             within 15 km of each preset city centre
// Usage: node scripts/data/build-wikidata.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { PRESETS } from '../../src/app/presets.ts';

const UA = 'ProjectTransitDataBuild/0.1 (offline game data extract)';
async function sparql(query) {
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
    if (r.ok) return (await r.json()).results.bindings;
    await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
  }
  throw new Error('query failed');
}

// ---- airports: yearly figures only (monthly series are ignored)
const rows = await sparql(`SELECT ?iata ?pax ?year WHERE {
  ?a wdt:P238 ?iata ; p:P3872 ?st . ?st ps:P3872 ?pax ; pqv:P585 ?tv .
  ?tv wikibase:timePrecision 9 ; wikibase:timeValue ?time . BIND(YEAR(?time) AS ?year) FILTER(?year >= 2015) }`);
const byCode = new Map();
for (const r of rows) {
  const code = r.iata.value, year = +r.year.value, pax = Math.round(+r.pax.value);
  if (!/^[A-Z]{3}$/.test(code) || !(pax > 0)) continue;
  const m = byCode.get(code) ?? new Map();
  m.set(year, Math.max(m.get(year) ?? 0, pax));
  byCode.set(code, m);
}
// only airports the game knows (src/data/airports.json, from build-airports.mjs): [passengers, year]
const known = new Set(JSON.parse(readFileSync('src/data/airports.json', 'utf8')).airports.map((a) => a[0]));
const airports = {};
for (const [code, years] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
  // the latest year from 2022 on; otherwise the busiest pre-2020 year (2020-21 were not typical)
  const recent = [...years].filter(([y]) => y >= 2022).sort((a, b) => b[0] - a[0])[0];
  const before = [...years].filter(([y]) => y <= 2019).sort((a, b) => b[1] - a[1])[0];
  const pick = recent ?? before;
  if (pick && pick[1] >= 10000 && known.has(code)) airports[code] = [pick[1], pick[0]];
}

// ---- stadiums, universities and hospitals around the preset cities
const places = [];
const seen = new Set();
for (const p of PRESETS) {
  const [lng, lat] = p.centre;
  const res = await sparql(`SELECT ?item ?itemLabel ?kind ?coord ?cap ?students ?beds WHERE {
    SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "15" . }
    { ?item wdt:P31/wdt:P279* wd:Q483110 . ?item wdt:P1083 ?cap . BIND("stadium" AS ?kind) }
    UNION { ?item wdt:P31/wdt:P279* wd:Q3918 . ?item wdt:P2196 ?students . BIND("university" AS ?kind) }
    UNION { ?item wdt:P31/wdt:P279* wd:Q16917 . ?item wdt:P6801 ?beds . BIND("hospital" AS ?kind) }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tr,es,ca,de,ja". } }`);
  for (const r of res) {
    const q = r.item.value.split('/').pop();
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord.value);
    if (!m) continue;
    const key = `${q}:${r.kind.value}:${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const num = (b) => (b ? Math.round(+b.value) : undefined);
    const e = { q, name: r.itemLabel.value, kind: r.kind.value, lng: +(+m[1]).toFixed(5), lat: +(+m[2]).toFixed(5) };
    const cap = num(r.cap), students = num(r.students), beds = num(r.beds);
    if (cap) e.capacity = cap;
    if (students) e.students = students;
    if (beds) e.beds = beds;
    // the largest value when an item has several statements
    const prev = places.find((x) => x.q === q && x.kind === e.kind && x.lng === e.lng && x.lat === e.lat);
    if (prev) for (const k of ['capacity', 'students', 'beds']) prev[k] = Math.max(prev[k] ?? 0, e[k] ?? 0) || undefined;
    else places.push(e);
  }
  console.log(`${p.city}: ${res.length} rows`);
  await new Promise((res) => setTimeout(res, 1500)); // be gentle with the public endpoint
}
places.sort((a, b) => a.q.localeCompare(b.q, 'en', { numeric: true }) || a.lng - b.lng);
const json = JSON.stringify({ source: 'Wikidata (CC0), https://www.wikidata.org', airports, places }, null, 0)
  .replace('"airports":{', '"airports":{\n').replace(/\],"/g, '],\n"').replace(/\},"places":\[/, '},\n"places":[\n').replace(/\},\{/g, '},\n{');
writeFileSync('src/data/wikidata-places.json', json + '\n');
console.log(`${Object.keys(airports).length} airports with passengers, ${places.length} places, ${(json.length / 1024).toFixed(0)} KB`);
