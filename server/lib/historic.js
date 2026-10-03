// Helpers for the 1930s aerial photos (WMS).

export function pickLayer(capabilitiesXml, wanted) {
  const names = [...capabilitiesXml.matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  if (wanted && names.includes(wanted)) return { layer: wanted, names };
  return { layer: names.find((n) => /1930/.test(n)) ?? names[0], names };
}

// Bounding box (lng/lat) around a point, sized in meters, for WMS 1.1.1 EPSG:4326.
export function bbox(lat, lng, halfWidthM = 110, halfHeightM = 82) {
  const dLat = halfHeightM / 111320;
  const dLng = halfWidthM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(6)).join(',');
}
