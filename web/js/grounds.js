const API = (window.TD_CONFIG?.apiBase || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pest: 'Pests', damage: 'Damage', dying: 'Dying' };

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

function render(data) {
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
          <span class="muted small">${f.reporters}/${f.needed} people</span></div>`).join('')
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
      <td>${t.reportCount}${t.lastReportAt ? `<br><span class="muted small">last ${new Date(t.lastReportAt).toLocaleDateString()}</span>` : ''}</td>
      <td><div class="thumbs">${thumbs || '<span class="muted small">None yet</span>'}</div></td>
    </tr>`;
  }).join('');

  if (!map) {
    map = L.map('gmap', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    if (trees.length) map.fitBounds(L.latLngBounds(trees.map((t) => [t.lat, t.lng])).pad(0.3));
  }
  for (const t of trees) {
    const icon = L.divIcon({ className: '', html: `<div class="pin ${worst(t)}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    const popup = `<b>${esc(t.name)}</b><br>${Object.values(t.flags).map((f) => `${LABEL[f.flagType] ?? esc(f.flagType)}: ${f.status} (${f.reporters}/${f.needed})`).join('<br>') || 'No flags'}`;
    if (pins.has(t.code)) pins.get(t.code).setIcon(icon).setPopupContent(popup);
    else pins.set(t.code, L.marker([t.lat, t.lng], { icon }).bindPopup(popup).addTo(map));
  }
}

async function load() {
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error(res.status);
    render(await res.json());
  } catch (e) {
    $('rows').innerHTML = `<tr><td colspan="5">Could not load reports (${esc(e.message)}).</td></tr>`;
  }
}

load();
setInterval(load, 30000);
