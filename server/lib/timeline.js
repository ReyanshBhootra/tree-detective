// The map's time travel stops: real aerial and satellite photos of campus,
// oldest first. New Jersey's statewide aerial surveys (1930 and whichever later
// years the state server has) and Esri's World Imagery Wayback archive
// (satellite photos from 2014 on). Each source is checked before it's offered.
import { pickLayer } from './historic.js';

const NJ = 'https://img.nj.gov/imagerywms/';
// Older NJ surveys. Wayback covers 2014 onward, so only earlier years here.
const NJ_SURVEYS = [
  ['BlackWhite1970', 1970], ['BlackWhite1977', 1977], ['Infrared1986', 1986],
  ['Infrared1995', 1995], ['Natural2002', 2002], ['Natural2007', 2007], ['Natural2012', 2012],
];
const WAYBACK_CONFIG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
const WAYBACK_YEARS = [2014, 2017, 2020, 2023];

async function njStop(name, year, fetchImpl) {
  const url = NJ + name;
  const res = await fetchImpl(`${url}?service=WMS&request=GetCapabilities&version=1.1.1`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const xml = await res.text();
  if (!xml.includes('<Layer')) return null;
  const { layer } = pickLayer(xml, name);
  if (!layer) return null;
  return {
    year, kind: 'wms', url, layer,
    label: /Infrared/.test(name) ? `${year} (infrared)` : String(year),
    attribution: `${year} aerial photography: NJ Office of GIS`,
  };
}

// Picks one Wayback release per wanted year (the first of that year) plus the newest.
export function waybackStops(config, years = WAYBACK_YEARS) {
  const releases = Object.entries(config ?? {})
    .map(([id, r]) => ({ id, date: r.itemTitle?.match(/(\d{4})-(\d{2})-(\d{2})/)?.[0], url: r.itemURL }))
    .filter((r) => r.date && r.url)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!releases.length) return [];
  const picked = years
    .map((y) => releases.find((r) => r.date.startsWith(String(y))))
    .filter(Boolean);
  const newest = releases.at(-1);
  if (!picked.includes(newest)) picked.push(newest);
  return picked.map((r) => ({
    year: Number(r.date.slice(0, 4)),
    kind: 'tiles',
    url: r.url.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}'),
    label: r === newest ? `${r.date.slice(0, 4)} (latest)` : r.date.slice(0, 4),
    attribution: `Satellite imagery ${r.date.slice(0, 4)}: Esri World Imagery Wayback, Maxar, Earthstar Geographics`,
  }));
}

export function createTimeline({ historic, fetchImpl = fetch, ttlMs = 12 * 3600e3 } = {}) {
  let cached = null;
  let at = 0;
  return async function timeline() {
    if (cached && Date.now() - at < ttlMs) return cached;
    const first = historic
      ? [{ year: historic.year, kind: 'wms', url: historic.wmsUrl, layer: historic.layer, label: String(historic.year), attribution: historic.attribution }]
      : [];
    const [nj, wb] = await Promise.all([
      Promise.all(NJ_SURVEYS.map(([n, y]) => njStop(n, y, fetchImpl).catch(() => null))),
      fetchImpl(WAYBACK_CONFIG, { signal: AbortSignal.timeout(6000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => waybackStops(c))
        .catch(() => []),
    ]);
    const stops = [...first, ...nj.filter(Boolean), ...wb].sort((a, b) => a.year - b.year);
    cached = { stops };
    at = Date.now();
    return cached;
  };
}
