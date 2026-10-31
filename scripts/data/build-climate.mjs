// Build src/data/climate.json: monthly climate statistics for a set of points, derived from NASA
// POWER daily data (https://power.larc.nasa.gov/, accessed via the POWER daily point API).
// Baked at build time; never fetched at runtime.
//
// Licence: the AWS Open Data registry lists NASA POWER as "Creative Commons BY 4.0" and says
// "There are no restrictions on the use, access, and/or download of data from the NASA POWER
// Project." (https://registry.opendata.aws/nasa-power/). Citation requested; see CITATION below.
//
// Usage: node scripts/data/build-climate.mjs <cache-dir>
//   Responses are cached as <cache-dir>/power/<id>.json; re-runs make no requests. Requests go one
//   at a time with a pause, and are retried on failure.
//
// Parameters (community AG): T2M_MAX, T2M_MIN (MERRA-2 2 m temperature extremes, degC),
// PRECTOTCORR (MERRA-2 bias-corrected total precipitation, mm/day; observation-corrected with a
// merged gauge/satellite product, CPCU / GPCP, tapering to model precipitation poleward of
// ~42.5-62.5 degrees; Reichle et al. 2017), PRECSNO (snow precipitation, mm/day water equivalent).
// Period fixed to 1995-2024. Missing values (-999) are skipped. POWER is gridded (~0.5 x 0.625
// degrees), so values describe a grid cell, not a station: expect more light-rain days and
// fewer heavy ones than a gauge.
//
// Per station, per calendar month, 12 numbers (FIELDS below):
//   wet   share of days with PRECTOTCORR >= 1.0 mm (days with PRECTOTCORR reported)
//   ww    P(wet | previous day wet), consecutive reported days (month of the second day)
//   heavy P(PRECTOTCORR >= 10 mm | wet)
//   rain  mean PRECTOTCORR on wet days, mm
//   snow  share of days with snowfall: POWER PRECSNO (snow precipitation, water equivalent,
//         mm/day) >= 0.5 mm, i.e. roughly 5 mm of fresh snow. (PRECTOTCORR >= 1 mm with T2M_MAX <= 1 degC
//         is the fallback on a day where PRECSNO is missing.)
//   tx/txSd  mean / sample standard deviation of daily T2M_MAX, degC
//   tn/tnSd  same for T2M_MIN
//   hot   share of days with T2M_MAX >= 30 degC
//   cold  share of days with T2M_MAX <= 3 degC
//   ar    lag-1 autocorrelation of T2M_MAX anomalies (T2M_MAX minus the station-month mean), over
//         consecutive reported days within the month
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const cache = process.argv[2];
if (!cache) throw new Error('usage: build-climate.mjs <cache-dir>');
mkdirSync(`${cache}/power`, { recursive: true });

const API = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const Y0 = 1995, Y1 = 2024, SNOW_MM = 0.5, PAUSE_MS = 400;
const FIELDS = ['wet', 'ww', 'heavy', 'rain', 'snow', 'tx', 'txSd', 'tn', 'tnSd', 'hot', 'cold', 'ar'];
const OUT = new URL('../../src/data/climate.json', import.meta.url);
const ACCESSED = '2026-10-30';
const CITATION = `NASA Prediction of Worldwide Energy Resources (POWER) Project, daily data (MERRA-2 based, community AG), 1995-2024, accessed on ${ACCESSED} from https://registry.opendata.aws/nasa-power (https://power.larc.nasa.gov/).`;

// Presets: centres from src/app/presets.ts: id -> [name, lat, lon].
const PRESETS = {
  'istanbul-galata': ['Istanbul (Galata)', 41.0262, 28.9766],
  durham: ['Durham', 54.7745, -1.5752],
  'barcelona-eixample': ['Barcelona (Eixample)', 41.391, 2.165],
  'hamburg-altstadt': ['Hamburg (Altstadt)', 53.549, 9.985],
  'tokyo-shibuya': ['Tokyo (Shibuya)', 35.6595, 139.7005],
};

// Cities players are likely to search for: [name, lat, lon]. The nearest good station is used.
const CITIES = `
New York 40.71 -74.01;Los Angeles 34.05 -118.24;Chicago 41.88 -87.63;Houston 29.76 -95.37;Phoenix 33.45 -112.07;
Miami 25.76 -80.19;Seattle 47.61 -122.33;Denver 39.74 -104.99;Atlanta 33.75 -84.39;Boston 42.36 -71.06;
San Francisco 37.77 -122.42;Minneapolis 44.98 -93.27;Dallas 32.78 -96.8;New Orleans 29.95 -90.07;Honolulu 21.31 -157.86;
Anchorage 61.22 -149.9;Fairbanks 64.84 -147.72;Salt Lake City 40.76 -111.89;Las Vegas 36.17 -115.14;Washington 38.9 -77.04;
Toronto 43.65 -79.38;Montreal 45.5 -73.57;Vancouver 49.28 -123.12;Winnipeg 49.9 -97.14;Calgary 51.05 -114.07;
Halifax 44.65 -63.57;Yellowknife 62.45 -114.37;Iqaluit 63.75 -68.52;Reykjavik 64.15 -21.94;
Mexico City 19.43 -99.13;Monterrey 25.67 -100.31;Guatemala City 14.63 -90.51;San Jose CR 9.93 -84.08;Panama City 8.98 -79.52;
Havana 23.13 -82.38;Kingston 17.97 -76.79;San Juan 18.47 -66.1;Santo Domingo 18.49 -69.93;
Bogota -4.0 -74.0;Lima -12.05 -77.04;Quito -0.18 -78.47;Caracas 10.5 -66.92;Medellin 6.25 -75.57;
Sao Paulo -23.55 -46.63;Rio de Janeiro -22.91 -43.17;Brasilia -15.79 -47.88;Manaus -3.12 -60.02;Salvador -12.97 -38.51;
Recife -8.05 -34.88;Fortaleza -3.73 -38.52;Porto Alegre -30.03 -51.23;Buenos Aires -34.6 -58.38;Cordoba AR -31.42 -64.18;
Santiago -33.45 -70.67;Punta Arenas -53.16 -70.91;Montevideo -34.9 -56.16;Asuncion -25.26 -57.58;La Paz -16.5 -68.15;
London 51.51 -0.13;Manchester 53.48 -2.24;Edinburgh 55.95 -3.19;Aberdeen 57.15 -2.09;Belfast 54.6 -5.93;
Dublin 53.35 -6.26;Paris 48.86 2.35;Lyon 45.76 4.84;Marseille 43.3 5.37;Brest 48.39 -4.49;
Madrid 40.42 -3.7;Seville 37.39 -5.98;Lisbon 38.72 -9.14;Porto 41.15 -8.61;Rome 41.9 12.5;
Milan 45.46 9.19;Naples 40.85 14.27;Palermo 38.12 13.36;Athens 37.98 23.73;Thessaloniki 40.64 22.94;
Berlin 52.52 13.4;Munich 48.14 11.58;Frankfurt 50.11 8.68;Vienna 48.21 16.37;Zurich 47.37 8.54;
Amsterdam 52.37 4.9;Brussels 50.85 4.35;Copenhagen 55.68 12.57;Oslo 59.91 10.75;Stockholm 59.33 18.07;
Helsinki 60.17 24.94;Tromso 69.65 18.96;Warsaw 52.23 21.01;Prague 50.08 14.44;Budapest 47.5 19.04;
Bucharest 44.43 26.1;Sofia 42.7 23.32;Belgrade 44.79 20.45;Kyiv 50.45 30.52;Moscow 55.76 37.62;
St Petersburg 59.93 30.34;Murmansk 68.97 33.09;Ankara 39.93 32.86;Izmir 38.42 27.14;Antalya 36.9 30.7;
Novosibirsk 55.03 82.92;Yekaterinburg 56.84 60.6;Irkutsk 52.29 104.3;Yakutsk 62.03 129.73;Vladivostok 43.12 131.89;
Tbilisi 41.72 44.79;Baku 40.41 49.87;Tehran 35.69 51.39;Baghdad 33.31 44.37;Riyadh 24.71 46.68;
Jeddah 21.49 39.19;Dubai 25.2 55.27;Muscat 23.59 58.41;Tel Aviv 32.09 34.78;Amman 31.95 35.93;
Cairo 30.04 31.24;Alexandria 31.2 29.92;Tunis 36.81 10.18;Algiers 36.75 3.06;Casablanca 33.57 -7.59;
Marrakech 31.63 -8.0;Tripoli 32.89 13.19;Khartoum 15.5 32.56;Addis Ababa 9.03 38.74;Nairobi -1.29 36.82;
Dar es Salaam -6.79 39.21;Kampala 0.35 32.58;Lagos 6.52 3.38;Accra 5.6 -0.19;Dakar 14.72 -17.47;
Bamako 12.64 -8.0;Niamey 13.51 2.11;Kinshasa -4.44 15.27;Luanda -8.84 13.23;Harare -17.83 31.05;
Lusaka -15.39 28.32;Johannesburg -26.2 28.05;Cape Town -33.92 18.42;Durban -29.86 31.02;Windhoek -22.56 17.08;
Antananarivo -18.88 47.51;Maputo -25.97 32.57;Mogadishu 2.05 45.32;
Karachi 24.86 67.0;Lahore 31.55 74.34;Islamabad 33.68 73.05;Delhi 28.61 77.21;Mumbai 19.08 72.88;
Kolkata 22.57 88.36;Chennai 13.08 80.27;Bangalore 12.97 77.59;Hyderabad 17.39 78.49;Dhaka 23.81 90.41;
Kathmandu 27.72 85.32;Colombo 6.93 79.86;Kabul 34.53 69.17;Tashkent 41.3 69.24;Almaty 43.24 76.89;
Ulaanbaatar 47.89 106.91;Beijing 39.9 116.4;Shanghai 31.23 121.47;Guangzhou 23.13 113.26;Chengdu 30.57 104.07;
Urumqi 43.83 87.62;Harbin 45.8 126.53;Hong Kong 22.32 114.17;Taipei 25.03 121.57;Seoul 37.57 126.98;
Osaka 34.69 135.5;Sapporo 43.06 141.35;Fukuoka 33.59 130.4;Naha 26.21 127.68;Bangkok 13.76 100.5;
Hanoi 21.03 105.85;Ho Chi Minh City 10.82 106.63;Phnom Penh 11.56 104.92;Yangon 16.87 96.2;Kuala Lumpur 3.14 101.69;
Singapore 1.35 103.82;Jakarta -6.21 106.85;Surabaya -7.25 112.75;Manila 14.6 120.98;Cebu 10.32 123.89;
Sydney -33.87 151.21;Melbourne -37.81 144.96;Brisbane -27.47 153.03;Perth -31.95 115.86;Adelaide -34.93 138.6;
Darwin -12.46 130.84;Alice Springs -23.7 133.88;Hobart -42.88 147.33;Cairns -16.92 145.77;Auckland -36.85 174.76;
Wellington -41.29 174.78;Christchurch -43.53 172.64;Port Moresby -9.44 147.18;Suva -18.14 178.44;Noumea -22.28 166.46;
Papeete -17.54 -149.57;Ushuaia -54.8 -68.3;Nuuk 64.18 -51.72;
`.replace(/\n/g, '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = s.match(/^(.*?) (-?[\d.]+) (-?[\d.]+)$/);
  return [m[1], +m[2], +m[3]];
});

const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

function stats(days) {
  const rows = [];
  const use = [...days].sort((a, b) => a.t - b.t);
  for (let m = 0; m < 12; m++) {
    const dm = use.filter((d) => d.m === m);
    let np = 0, wet = 0, heavy = 0, rainSum = 0, snowN = 0, snowD = 0;
    let nx = 0, sx = 0, sxx = 0, nn = 0, sn = 0, snn = 0, hot = 0, cold = 0;
    for (const d of dm) {
      if (d.p !== null) { np++; if (d.p >= 1) { wet++; rainSum += d.p; if (d.p >= 10) heavy++; } }
      if (d.s !== null) { snowD++; if (d.s >= SNOW_MM) snowN++; }
      else if (d.p !== null && d.x !== null) { snowD++; if (d.p >= 1 && d.x <= 1) snowN++; }
      if (d.x !== null) { nx++; sx += d.x; sxx += d.x * d.x; if (d.x >= 30) hot++; if (d.x <= 3) cold++; }
      if (d.n !== null) { nn++; sn += d.n; snn += d.n * d.n; }
    }
    const mx = sx / nx;
    const sd = (n, s, ss) => Math.sqrt(Math.max(0, (ss - (s * s) / n) / (n - 1)));
    // transitions and autocorrelation over consecutive days (second day in this month)
    let prevWet = 0, wetWet = 0, ac = 0, a0 = 0, a1 = 0;
    for (let i = 1; i < use.length; i++) {
      const d = use[i], q = use[i - 1];
      if (d.m !== m || d.t - q.t !== 1) continue;
      if (d.p !== null && q.p !== null && q.p >= 1) { prevWet++; if (d.p >= 1) wetWet++; }
      if (d.x !== null && q.x !== null) { const a = d.x - mx, b = q.x - mx; ac += a * b; a0 += a * a; a1 += b * b; }
    }
    rows.push([
      r3(wet / np), r3(prevWet ? wetWet / prevWet : 0), r3(wet ? heavy / wet : 0), r1(wet ? rainSum / wet : 0),
      r3(snowD ? snowN / snowD : 0), r1(mx), r1(sd(nx, sx, sxx)), r1(sn / nn), r1(sd(nn, sn, snn)),
      r3(hot / nx), r3(cold / nx), r3(a0 && a1 ? ac / Math.sqrt(a0 * a1) : 0),
    ]);
  }
  return rows;
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0, bytes = 0;
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fetchPoint(id, lat, lon) {
  const p = `${cache}/power/${id.replace(/[^a-z0-9-]/g, '_')}.json`;
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const url = `${API}?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,PRECSNO&community=AG&longitude=${lon}&latitude=${lat}&start=${Y0}0101&end=${Y1}1231&format=JSON`;
  let err;
  for (let i = 0; i < 5; i++) {
    try {
      requests++;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status}`);
      const text = await r.text();
      const j = JSON.parse(text);
      if (!j.properties?.parameter?.T2M_MAX) throw new Error('no data');
      bytes += text.length;
      writeFileSync(p, text);
      await sleep(PAUSE_MS);
      return j;
    } catch (e) { err = e; await sleep(2000 * (i + 1)); }
  }
  throw new Error(`${id}: ${err.message}`);
}

/** Daily records from a POWER response. */
function daily(j) {
  const P = j.properties.parameter;
  const v = (o, k) => (o && o[k] !== undefined && o[k] > -998 ? o[k] : null);
  const days = [];
  for (const k of Object.keys(P.T2M_MAX)) {
    const y = +k.slice(0, 4), m = +k.slice(4, 6) - 1;
    days.push({ y, m, t: Date.UTC(y, m, +k.slice(6, 8)) / 864e5, p: v(P.PRECTOTCORR, k), x: v(P.T2M_MAX, k), n: v(P.T2M_MIN, k), s: v(P.PRECSNO, k) });
  }
  return days;
}

const all = new Map();
const add = (id, name, lat, lon, days) => {
  all.set(id, [id, name, lat, lon, '', stats(days)]);
};
const presetOut = {};
for (const [pid, [name, lat, lon]] of Object.entries(PRESETS)) {
  const id = `power:${pid}`;
  add(id, name, lat, lon, daily(await fetchPoint(id, lat, lon)));
  presetOut[pid] = id;
}
for (const [name, lat, lon] of CITIES) {
  const id = `power:${slug(name)}`;
  if (all.has(id)) continue;
  add(id, name, lat, lon, daily(await fetchPoint(id, lat, lon)));
}

const sorted = [...all.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const json = {
  source: 'NASA POWER daily (MERRA-2 temperatures; precipitation as POWER documents it: PRECTOTCORR, MERRA-2 bias-corrected total precipitation), 1995-2024',
  citation: CITATION,
  licence: 'CC BY 4.0; no restrictions on use (registry.opendata.aws/nasa-power)',
  checked: ACCESSED,
  period: `${Y0}-${Y1}`,
  fields: FIELDS,
  stations: sorted,
  presets: presetOut,
};
writeFileSync(OUT, JSON.stringify(json).replace(/\],\["/g, '],\n["') + '\n');
console.log(`points: ${sorted.length}, requests this run: ${requests}, downloaded: ${(bytes / 1e6).toFixed(1)} MB`);
