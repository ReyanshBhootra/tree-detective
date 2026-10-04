// Walking route from where you actually are. Uses live location when the
// browser allows it (and follows you as you walk); otherwise you type a
// building, address or ZIP code, or tap where you are on the map.
import { distanceMeters, planRoute } from './geo.js';

const $ = (id) => document.getElementById(id);
const NEAR_M = 35;
const FAR_M = 3000;
let d;
let watchId = null;
let from = null; // { lat, lng, label, live }
let you = null;
let layer = null;
let tapping = false;
const nearTold = new Set();

export function initRoute(deps) {
  d = deps;
  $('btn-route').addEventListener('click', openRoute);
  $('route-close').addEventListener('click', closeRoute);
  $('route-where').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('route-place').value.trim();
    if (!q) return;
    try {
      const hit = await d.api(`/api/geocode?q=${encodeURIComponent(q)}`);
      setFrom({ lat: hit.lat, lng: hit.lng, label: hit.label, live: false });
    } catch (err) {
      d.toast(err.message);
    }
  });
  d.map.on('click', (e) => {
    if (!tapping) return;
    setFrom({ lat: e.latlng.lat, lng: e.latlng.lng, label: 'the spot you tapped', live: false });
  });
}

export function openRoute() {
  $('route-panel').hidden = false;
  if (from) return draw();
  askWhere('Finding you…');
  if (!('geolocation' in navigator) || !window.isSecureContext) return askWhere();
  let first = true;
  const fail = setTimeout(() => first && askWhere(), 8000);
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      clearTimeout(fail);
      const here = { lat: p.coords.latitude, lng: p.coords.longitude, label: 'you', live: true, accuracy: p.coords.accuracy };
      // Only redraw when you've really moved, so the route doesn't flicker.
      if (first || !from?.live || distanceMeters(from, here) > 12) setFrom(here, { fit: first });
      first = false;
    },
    () => { clearTimeout(fail); if (first) askWhere(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function askWhere(status) {
  $('route-from').textContent = status ?? '📍 Where are you?';
  $('route-where').hidden = Boolean(status);
  $('route-tap').hidden = Boolean(status);
  $('route-list').innerHTML = '';
  tapping = !status;
  if (!status) setTimeout(() => $('route-place').focus(), 50);
}

function setFrom(place, { fit = true } = {}) {
  from = place;
  tapping = false;
  $('route-where').hidden = true;
  $('route-tap').hidden = true;
  draw({ fit });
}

function walkLink(t) {
  const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${t.lat},${t.lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=walking`;
}

export function draw({ fit = true } = {}) {
  if (!from) return;
  const { map, state, escapeHtml } = d;
  layer?.remove();
  const unvisited = state.trees.filter((t) => !state.visited.has(t.code));
  const campus = map.getCenter && state.trees.length
    ? { lat: state.trees.reduce((s, t) => s + t.lat, 0) / state.trees.length, lng: state.trees.reduce((s, t) => s + t.lng, 0) / state.trees.length }
    : from;
  const far = distanceMeters(from, campus) > FAR_M;
  const start = far ? campus : from;

  // "You are here" dot (pulsing when it's your live location).
  const dot = L.marker([from.lat, from.lng], {
    interactive: false, zIndexOffset: 900,
    icon: L.divIcon({ className: '', html: `<div class="you-dot ${from.live ? 'live' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
  });
  const parts = [dot];
  if (from.live && from.accuracy && from.accuracy < 200) {
    parts.push(L.circle([from.lat, from.lng], { radius: from.accuracy, color: '#5aa9ff', weight: 1, fillOpacity: 0.08, interactive: false }));
  }

  if (!unvisited.length) {
    $('route-from').textContent = 'Every tree is awake. The grove thanks you 🌳';
    $('route-list').innerHTML = '';
    layer = L.layerGroup(parts).addTo(map);
    return;
  }

  const route = planRoute(start, unvisited);
  const points = [[start.lat, start.lng], ...route.map((t) => [t.lat, t.lng])];
  parts.push(
    L.polyline(points, { color: '#ffe08a', weight: 10, opacity: 0.18, interactive: false }),
    L.polyline(points, { color: '#ffe08a', weight: 3, dashArray: '2 10', lineCap: 'round', interactive: false }),
    ...route.map((t, i) => L.marker([t.lat, t.lng], {
      interactive: false,
      icon: L.divIcon({ className: '', html: `<div class="route-num">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 80] }),
    })),
  );
  layer = L.layerGroup(parts).addTo(map);
  you = from;

  $('route-from').innerHTML = far
    ? `You're about ${(distanceMeters(from, campus) / 1000).toFixed(1)} km from campus. Here's the order once you're there:`
    : `From ${from.live ? '<strong>you</strong> <span class="live-badge">● live</span>' : `<strong>${escapeHtml(from.label)}</strong>`} <button class="link-btn" id="route-change">change</button>`;
  $('route-change')?.addEventListener('click', () => { stopWatch(); from = null; layer?.remove(); askWhere(); });

  let prev = start;
  $('route-list').innerHTML = route.map((t, i) => {
    const m = Math.round(distanceMeters(prev, t));
    prev = t;
    const min = Math.max(1, Math.round(m / 80));
    return `<li><button data-code="${t.code}">${escapeHtml(t.name)}</button>
      <span class="muted">${m} m · ${min} min walk · ${state.config.pointsPerTree} pts</span>
      ${i === 0 && !far ? `<a class="walk-link" href="${walkLink(t)}" target="_blank" rel="noopener">👣 Walk there</a>` : ''}</li>`;
  }).join('');
  $('route-list').querySelectorAll('button[data-code]').forEach((b) => b.addEventListener('click', () => {
    const t = state.byCode.get(b.dataset.code);
    map.flyTo([t.lat, t.lng], 19);
  }));
  if (fit) map.fitBounds(L.latLngBounds(points).pad(0.2));

  // Walking up to a sleeping tree? Point it out.
  if (from.live) {
    for (const t of unvisited) {
      if (!nearTold.has(t.code) && distanceMeters(from, t) <= NEAR_M) {
        nearTold.add(t.code);
        d.toast(`👀 You're right by ${t.name}! Look for its QR tag.`, 5000);
      }
    }
  }
}

function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

export function closeRoute() {
  stopWatch();
  tapping = false;
  from = null;
  you = null;
  layer?.remove();
  layer = null;
  $('route-panel').hidden = true;
}

// Called after a tree wakes, so the route skips it.
export function refreshRoute() {
  if (!$('route-panel').hidden && from) draw({ fit: false });
}

export const lastKnownPosition = () => you;
