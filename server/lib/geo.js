// Great-circle distance in meters. Shared with the browser copy in web/js/geo.js.
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Greedy nearest-neighbour walk. Good enough for a dozen trees on one campus.
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
