// Turns "Kupfrian Hall", "323 Dr Martin Luther King Jr Blvd" or a ZIP code
// into a point on the map, using OpenStreetMap's free Nominatim service,
// biased to the area around campus. Also reads a location someone shared in
// iMessage (an Apple or Google Maps link, or the .loc.vcf card iPhones send).

const UA = { 'User-Agent': 'TreeDetective/1.0 (https://github.com/ReyanshBhootra/tree-detective)' };

export function createGeocoder({ center, fetchImpl = fetch } = {}) {
  const cache = new Map();
  let last = 0;
  return async function geocode(query) {
    const q = String(query ?? '').trim().slice(0, 120);
    if (q.length < 2) return null;
    const key = q.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    // Nominatim asks for at most one request a second.
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const p = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'us' });
    if (/^\d{5}(-\d{4})?$/.test(q)) {
      p.set('postalcode', q.slice(0, 5));
    } else {
      p.set('q', q);
      if (center) {
        const d = 0.06; // about 6 km around campus, preferred but not required
        p.set('viewbox', `${center.lng - d},${center.lat + d},${center.lng + d},${center.lat - d}`);
      }
    }
    let hit = null;
    try {
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${p}`, { headers: UA, signal: AbortSignal.timeout(6000) });
      const [r] = res.ok ? await res.json() : [];
      if (r) hit = { lat: Number(r.lat), lng: Number(r.lon), label: String(r.display_name ?? q).split(',').slice(0, 2).join(',').trim() };
    } catch (e) {
      console.warn('geocode failed:', e.message);
    }
    cache.set(key, hit);
    return hit;
  };
}

// lat,lng from a shared map link or location card, if there is one.
export function locationFromText(text) {
  const s = String(text ?? '');
  const m = s.match(/[?&](?:ll|q|sll|daddr|destination|query)=(-?\d{1,2}\.\d+)\\?(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i)
    ?? s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/)
    ?? s.match(/^\s*(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export const WALK_M_PER_MIN = 80;

export const walkingLink = (t) => `https://maps.apple.com/?daddr=${t.lat},${t.lng}&dirflg=w`;
