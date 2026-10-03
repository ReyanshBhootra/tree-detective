// Browser copy of server/lib/geo.js
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function planRoute(start, stops) {
  const left = [...stops];
  const route = [];
  let here = start;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (distanceMeters(here, left[i]) < distanceMeters(here, left[best])) best = i;
    }
    here = left.splice(best, 1)[0];
    route.push(here);
  }
  return route;
}

// Resolves to {lat, lng} or null. Never throws, never blocks for long:
// the QR code alone is enough to identify a tree.
export function currentPosition(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const done = setTimeout(() => resolve(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(done); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
      () => { clearTimeout(done); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
