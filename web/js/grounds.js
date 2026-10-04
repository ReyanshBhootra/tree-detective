const API = (window.TD_CONFIG?.apiBase || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pest: 'Pests', damage: 'Damage', dying: 'Dying' };
const SEASON = {
  buds: 'Buds', 'first-leaves': 'First leaves', 'full-leaf': 'Full leaf', 'flowers-fruit': 'Flowers or fruit',
  'color-change': 'Color change', dropping: 'Leaves dropping', bare: 'Bare',
};

let map;
const pins = new Map();

function worst(tree) {
  const flags = Object.values(tree.flags);
  if (flags.some((f) => f.status === 'confirmed')) return 'confirmed';
  if (flags.length) return 'possible';
  return 'ok';
}

function photoUrl(u) {
  return u.startsWith('http') ? u : `${API}${u}`;
}

async function render(data) {
  $('threshold').textContent = data.confirmThreshold;
  $('updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $('csv').href = `${API}/api/reports.csv`;

  const trees = data.trees;
  const confirmed = trees.filter((t) => worst(t) === 'confirmed').length;
  const possible = trees.filter((t) => worst(t) === 'possible').length;
  const reports = trees.reduce((s, t) => s + t.reportCount, 0);
  $('stats').innerHTML = `
    <div class="stat"><b>${trees.length}</b>tagged trees</div>
    <div class="stat"><b>${reports}</b>community reports</div>
    <div class="stat possible"><b>${possible}</b>trees with a possible problem</div>
    <div class="stat confirmed"><b>${confirmed}</b>trees with a confirmed problem</div>`;

  const order = { confirmed: 0, possible: 1, ok: 2 };
  $('rows').innerHTML = [...trees].sort((a, b) => order[worst(a)] - order[worst(b)] || b.reportCount - a.reportCount).map((t) => {
    const flags = Object.values(t.flags);
    const flagHtml = flags.length
      ? flags.map((f) => `<div><span class="tag ${f.status}">${LABEL[f.flagType] ?? esc(f.flagType)}: ${f.status}</span>
          <div class="bar ${f.status}" title="${f.reporters} of ${f.needed} independent reports"><div style="width:${Math.min(100, (f.reporters / f.needed) * 100)}%"></div></div>
          <span class="muted small">${f.reporters}/${f.needed} people with photos${f.withoutPhoto ? `, +${f.withoutPhoto} without` : ''}</span></div>`).join('')
      : '<span class="tag ok">No flags</span>';
    const sp = t.species[0];
    const speciesHtml = sp
      ? `<b>${esc(sp.name)}</b><br><span class="muted small">${sp.votes} photo${sp.votes === 1 ? '' : 's'}, avg ${Math.round(sp.avgConfidence * 100)}% confident, ${sp.agreed} agreed</span>`
      : `<span class="muted">${t.curatedSpecies ? esc(t.curatedSpecies) : 'No guesses yet'}</span>`;
    const thumbs = t.photos.map((p) => `<a href="${esc(photoUrl(p.url))}" target="_blank" rel="noopener"><img src="${esc(photoUrl(p.url))}" alt="Photo of ${esc(t.name)}, ${new Date(p.timestamp).toLocaleDateString()}" class="flag-${p.flagType === 'none' ? 'none' : p.status}" loading="lazy"></a>`).join('');
    return `<tr>
      <td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.code)}</span></td>
      <td>${flagHtml}</td>
      <td>${speciesHtml}</td>
      <td>${t.season ? `${esc(SEASON[t.season.season] ?? t.season.season)}<br><span class="muted small">${new Date(t.season.timestamp).toLocaleDateString()}</span>` : '<span class="muted small">No sightings</span>'}</td>
      <td>${t.reportCount}${t.lastReportAt ? `<br><span class="muted small">last ${new Date(t.lastReportAt).toLocaleDateString()}</span>` : ''}</td>
      <td><div class="thumbs">${thumbs || '<span class="muted small">None yet</span>'}</div></td>
    </tr>`;
  }).join('');

  const pestTrees = trees.filter((t) => t.flags.pest);
  if (pestTrees.length && data.pestReport) {
    $('pest-note').hidden = false;
    $('pest-note').innerHTML = `🦗 Pest reports on ${pestTrees.map((t) => esc(t.name)).join(', ')}. If it's spotted lanternfly, New Jersey asks for sightings at
      <a href="${esc(data.pestReport.url)}" target="_blank" rel="noopener">the state reporting tool</a> or ${esc(data.pestReport.hotline)}.`;
  }

  if (!map) {
    map = L.map('gmap', { scrollWheelZoom: false });
    const tiles = (await fetch(`${API}/api/config`).then((r) => r.json()).catch(() => ({}))).tiles
      ?? { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' };
    L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom, attribution: tiles.attribution }).addTo(map);
    if (trees.length) map.fitBounds(L.latLngBounds(trees.map((t) => [t.lat, t.lng])).pad(0.3));
  }
  for (const t of trees) {
    const icon = L.divIcon({ className: '', html: `<div class="pin ${worst(t)}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    const popup = `<b>${esc(t.name)}</b><br>${Object.values(t.flags).map((f) => `${LABEL[f.flagType] ?? esc(f.flagType)}: ${f.status} (${f.reporters}/${f.needed})`).join('<br>') || 'No flags'}`;
    if (pins.has(t.code)) pins.get(t.code).setIcon(icon).setPopupContent(popup);
    else pins.set(t.code, L.marker([t.lat, t.lng], { icon }).bindPopup(popup).addTo(map));
  }
}

// One single-series bar chart: weeks along the bottom, count up the side.
function barChart(el, weeks, key, label) {
  const W = 320, H = 150, pad = { l: 26, r: 6, t: 8, b: 22 };
  const vals = weeks.map((w) => w[key]);
  const max = Math.max(1, ...vals);
  const step = (W - pad.l - pad.r) / weeks.length;
  const bw = Math.max(4, step - 2); // 2px gap between bars
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
    ${weeks.map((w, i) => {
      const x = pad.l + i * step + (step - bw) / 2;
      const top = y(w[key]);
      const h = H - pad.b - top;
      const r = Math.min(4, h / 2, bw / 2);
      const path = h > 0
        ? `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - pad.b} Z`
        : '';
      return `<path class="bar" data-i="${i}" d="${path}"/>
        <rect class="hit" data-i="${i}" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${H - pad.t - pad.b}"/>
        ${i % 2 === weeks.length % 2 ? '' : `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${fmt(w.week)}</text>`}`;
    }).join('')}
  </svg>`;
  const tip = $('tooltip');
  el.querySelectorAll('.hit').forEach((h) => {
    const i = Number(h.dataset.i);
    const bar = el.querySelector(`.bar[data-i="${i}"]`);
    h.addEventListener('mousemove', (e) => {
      tip.hidden = false;
      tip.textContent = `Week of ${fmt(weeks[i].week)}: ${weeks[i][key]} ${key}`;
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY}px`;
      bar.classList.add('hover');
    });
    h.addEventListener('mouseleave', () => { tip.hidden = true; bar.classList.remove('hover'); });
  });
}

async function loadTrends(names) {
  try {
    const t = await (await fetch(`${API}/api/trends?weeks=8`)).json();
    $('trends-source').textContent = t.source === 'TigerData'
      ? 'Computed live in TigerData (TimescaleDB time buckets).'
      : 'Computed from the app\'s own records. Connect TigerData for the full history.';
    barChart($('chart-visits'), t.weeks, 'visits', 'Tree visits per week');
    barChart($('chart-reports'), t.weeks, 'reports', 'Community reports per week');
    $('trend-rows').innerHTML = t.weeks.map((w) => `<tr><td>${esc(w.week)}</td><td>${w.visits}</td><td>${w.reports}</td>
      <td>${w.flags.pest}</td><td>${w.flags.damage}</td><td>${w.flags.dying}</td><td>${w.seasons}</td></tr>`).join('');
    $('season-rows').innerHTML = t.seasonTimeline.length
      ? t.seasonTimeline.map((r) => `<tr><td>${esc(names.get(r.treeCode) ?? r.treeCode)}</td><td>${esc(SEASON[r.season] ?? r.season)}</td>
          <td>${r.year}</td><td>${new Date(r.firstSeen).toLocaleDateString()}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">No season sightings yet.</td></tr>';
  } catch (e) {
    $('trends-source').textContent = `Trends unavailable (${e.message}).`;
  }
}

async function load() {
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    await render(data);
    loadTrends(new Map(data.trees.map((t) => [t.code, t.name])));
  } catch (e) {
    $('rows').innerHTML = `<tr><td colspan="6">Could not load reports (${esc(e.message)}).</td></tr>`;
  }
}

load();
setInterval(load, 30000);
