import { distanceMeters, planRoute, currentPosition } from './geo.js';
import { startFireflies } from './fireflies.js';
import { eraScene } from './timelapse.js';
import { startScanner, parseTag } from './scanner.js';
import { shrinkPhoto } from './photo.js';
import { initBook } from './book.js';
import { initTimeTravel } from './timetravel.js';

const API = (window.TD_CONFIG?.apiBase || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  trees: [],
  personas: new Map(),
  byCode: new Map(),
  visited: new Set(),
  points: 0,
  markers: new Map(),
  routeLayer: null,
  currentTree: null,
  lastReportId: null,
};

// ---------- helpers ----------

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: fine */ }
}

// Anonymous player id. Nothing personal, just a random id kept on this device.
const playerId = (() => {
  let id = storageGet('td-player');
  if (!id) {
    id = crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    storageSet('td-player', id);
  }
  return id;
})();

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function burst(text) {
  const el = document.createElement('div');
  el.className = 'burst';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const persona = (tree) => state.personas.get(tree.persona) ?? { name: 'Tree', glow: '#ffe08a', browserVoice: {} };

// ---------- map ----------

let map;

function treeSvg(glow) {
  return `<svg viewBox="0 0 56 64" aria-hidden="true">
    <ellipse cx="28" cy="60" rx="16" ry="3.5" fill="rgba(0,0,0,.35)"/>
    <path d="M24 60 Q25 44 26 36 h4 Q31 44 32 60 Z" fill="#8a5a35"/>
    <circle cx="28" cy="24" r="18" fill="#3f9a62"/>
    <circle cx="18" cy="28" r="10" fill="#56b878"/>
    <circle cx="38" cy="28" r="10" fill="#4aa86c"/>
    <circle cx="28" cy="14" r="11" fill="#67c587"/>
    <circle cx="22" cy="20" r="2.4" fill="${glow}" opacity=".9"/>
    <circle cx="35" cy="18" r="1.8" fill="${glow}" opacity=".8"/>
    <circle cx="30" cy="30" r="2" fill="${glow}" opacity=".7"/>
  </svg>`;
}

function treeIcon(tree, { justWoke = false } = {}) {
  const awake = state.visited.has(tree.code);
  const glow = persona(tree).glow;
  return L.divIcon({
    className: 'tree-marker',
    iconSize: [56, 64],
    iconAnchor: [28, 62],
    html: `<div class="tree ${awake ? 'awake' : 'sleeping'} ${justWoke ? 'just-woke' : ''}" style="--tree-glow:${glow}">
      ${treeSvg(awake ? glow : '#556')}
      ${awake ? '' : '<span class="zzz">z z</span>'}
    </div><span class="tree-name">${escapeHtml(tree.name)}</span>`,
  });
}

function initMap() {
  const n = state.trees.length || 1;
  const center = state.trees.length
    ? [state.trees.reduce((s, t) => s + t.lat, 0) / n, state.trees.reduce((s, t) => s + t.lng, 0) / n]
    : [40.7424, -74.1784];
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(center, 18);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  for (const tree of state.trees) {
    const m = L.marker([tree.lat, tree.lng], { icon: treeIcon(tree), title: tree.name, keyboard: true })
      .addTo(map)
      .on('click', () => {
        if (state.visited.has(tree.code)) openStory(tree, null);
        else toast('This tree is still asleep. Find its tag and scan it to wake it up.');
      });
    state.markers.set(tree.code, m);
  }
  if (state.trees.length > 1) map.fitBounds(L.latLngBounds(state.trees.map((t) => [t.lat, t.lng])).pad(0.25));
}

function refreshMarker(code, opts) {
  const tree = state.byCode.get(code);
  state.markers.get(code)?.setIcon(treeIcon(tree, opts));
}

// ---------- HUD ----------

function applySummary(summary) {
  state.summary = summary;
  state.points = summary.totalPoints;
  state.visited = new Set(summary.visited.map((v) => v.code));
  $('points').textContent = state.points;
  $('awake').textContent = state.visited.size;
  $('total').textContent = state.trees.length;
}

async function refreshSummary() {
  try { applySummary(await api(`/api/players/${playerId}`)); } catch { /* keep what we have */ }
}

function bumpPoints() {
  const el = document.querySelector('.score-points');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------- scanning and waking ----------

let stopScanner = () => {};

function openScanner() {
  const dlg = $('scan-dialog');
  dlg.showModal();
  $('scan-status').textContent = 'Starting camera…';
  startScanner($('scan-video'), (tag) => { dlg.close(); wakeTree(tag); }, (msg) => { $('scan-status').textContent = msg; })
    .then((stop) => { stopScanner = stop; });
}

$('scan-dialog').addEventListener('close', () => stopScanner());

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const tag = parseTag($('code-input').value);
  if (!tag) return toast('That doesn\'t look like a tree code.');
  $('scan-dialog').close();
  $('code-input').value = '';
  wakeTree(tag);
});

async function wakeTree({ code, key }) {
  const tree = state.byCode.get(code);
  if (!tree) return toast(`No tree with the code ${code} lives on this map.`);

  // The location check happens here on the phone; only yes/no goes to the server.
  const pos = await currentPosition();
  let locationVerified = null;
  let distance = null;
  if (pos) {
    distance = distanceMeters(pos, tree);
    locationVerified = distance <= state.config.locationRadiusMeters + Math.min(pos.accuracy ?? 0, 50);
  }

  let result;
  try {
    result = await api('/api/visits', { method: 'POST', body: JSON.stringify({ playerId, treeCode: code, locationVerified, treeKey: key }) });
  } catch (e) {
    return toast(`Couldn't reach the grove: ${e.message}`);
  }
  applySummary(result);
  refreshMarker(code, { justWoke: result.firstVisit });
  map.flyTo([tree.lat, tree.lng], Math.max(map.getZoom(), 18), { duration: 0.8 });
  if (result.firstVisit) {
    burst(`+${result.pointsEarned}`);
    bumpPoints();
  }
  if (state.routeLayer) showRoute();

  let note;
  if (result.firstVisit) note = `<span class="plus">+${result.pointsEarned} points.</span> You woke ${escapeHtml(tree.name)}!`;
  else note = `You've already woken ${escapeHtml(tree.name)}. Welcome back.`;
  if (locationVerified === true) note += ' 📍 Location confirmed.';
  else if (locationVerified === false) note += ` The QR code counted, though your GPS put you about ${Math.round(distance)} m away.`;
  else note += ' Location is off, so the QR code alone counted.';
  openStory(tree, note);
}

// ---------- story, voice and time-lapse ----------

class Narrator {
  constructor(tree, onProgress, onEnd) {
    this.tree = tree;
    this.onProgress = onProgress;
    this.onEnd = onEnd;
    this.playing = false;
    this.audio = null;
    this.timer = null;
  }

  get mode() {
    if (this.tree.audioUrl) return 'azure';
    return 'speechSynthesis' in window ? 'browser' : 'none';
  }

  async play() {
    this.playing = true;
    if (this.mode === 'azure') {
      if (!this.audio) {
        this.audio = new Audio(this.tree.audioUrl.startsWith('http') ? this.tree.audioUrl : `${API}${this.tree.audioUrl}`);
        this.audio.addEventListener('timeupdate', () => this.onProgress(this.audio.currentTime / (this.audio.duration || 1)));
        this.audio.addEventListener('ended', () => { this.playing = false; this.onProgress(1); this.onEnd(); });
      }
      await this.audio.play();
      return;
    }
    if (this.mode === 'browser') {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(this.tree.story);
      const pv = persona(this.tree).browserVoice ?? {};
      u.rate = pv.rate ?? 1;
      u.pitch = pv.pitch ?? 1;
      const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en'));
      if (voices.length) u.voice = voices[[...this.tree.persona].reduce((s, c) => s + c.charCodeAt(0), 0) % voices.length];
      const len = this.tree.story.length;
      u.onboundary = (e) => this.onProgress(e.charIndex / len);
      u.onend = () => { this.playing = false; this.onProgress(1); this.onEnd(); };
      speechSynthesis.speak(u);
      // Some browsers never fire boundary events; keep the bar moving anyway.
      const est = (this.tree.story.split(/\s+/).length / 2.6 / u.rate) * 1000;
      const start = Date.now();
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (!this.playing) return clearInterval(this.timer);
        this.onProgress(Math.min(0.98, (Date.now() - start) / est), true);
      }, 300);
    }
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
    if (this.audio) this.audio.pause();
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}

let narrator = null;
let tlTimer = null;
let lastProgress = 0;

function buildTimelapse(tree) {
  const stage = $('tl-stage');
  const dots = $('tl-dots');
  stage.innerHTML = '';
  dots.innerHTML = '';
  const eras = tree.timelapse ?? [];
  const glow = persona(tree).glow;
  eras.forEach((era, i) => {
    let layer;
    if (era.imageUrl) {
      layer = document.createElement('img');
      layer.src = era.imageUrl.startsWith('http') ? era.imageUrl : `${API}${era.imageUrl}`;
      layer.alt = era.real
        ? `Real aerial photo of this spot, ${era.year}`
        : `Generated impression of this spot, ${era.year ?? era.era}`;
    } else {
      layer = document.createElement('div');
      layer.innerHTML = eraScene({ era: era.era, index: i, total: eras.length, code: tree.code, glow });
    }
    layer.classList.add('layer');
    stage.appendChild(layer);
    const dot = document.createElement('button');
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `${era.year ?? ''} ${era.era}`);
    dot.addEventListener('click', () => { stopAutoTimelapse(); showEra(tree, i); });
    dots.appendChild(dot);
  });
  const ring = document.createElement('div');
  ring.id = 'tl-ring';
  ring.className = 'tl-ring';
  ring.hidden = true;
  stage.appendChild(ring);
  showEra(tree, 0);
}

function showEra(tree, i) {
  const eras = tree.timelapse ?? [];
  if (!eras.length) return;
  i = Math.max(0, Math.min(eras.length - 1, i));
  $('tl-stage').querySelectorAll('.layer').forEach((el, j) => el.classList.toggle('on', j === i));
  [...$('tl-dots').children].forEach((el, j) => el.setAttribute('aria-selected', String(j === i)));
  const era = eras[i];
  $('tl-year').textContent = era.year ? `c. ${era.year}` : '';
  $('tl-caption').textContent = era.caption ?? '';
  $('tl-note').textContent = era.real
    ? `Real photo: ${era.credit ?? 'historic aerial survey'}`
    : era.imageUrl
      ? 'AI-generated impression, not a real historical photo'
      : 'Storybook placeholder, not a real photo';
  $('tl-note').classList.toggle('real', Boolean(era.real));
  $('tl-ring').hidden = !era.real;
  state.currentEra = i;
}

function autoTimelapse(tree) {
  stopAutoTimelapse();
  let i = 0;
  tlTimer = setInterval(() => {
    i++;
    if (i >= (tree.timelapse?.length ?? 0)) return stopAutoTimelapse();
    showEra(tree, i);
  }, 3200);
}
function stopAutoTimelapse() { clearInterval(tlTimer); tlTimer = null; }

function renderStoryWords(tree) {
  const words = tree.story.split(/(\s+)/);
  let offset = 0;
  $('story-text').innerHTML = words.map((w) => {
    const start = offset;
    offset += w.length;
    return /\s+/.test(w) ? w : `<span class="w" data-at="${start}">${escapeHtml(w)}</span>`;
  }).join('');
}

function paintProgress(tree, p) {
  lastProgress = p;
  $('narration-progress').style.width = pct(p);
  const at = p * tree.story.length;
  const playing = p > 0 && p < 1;
  let current = null;
  for (const span of $('story-text').querySelectorAll('.w')) {
    const done = Number(span.dataset.at) <= at;
    span.classList.toggle('spoken', done || p >= 1);
    span.classList.toggle('unspoken', !done && playing);
    span.classList.remove('now');
    if (done && playing) current = span;
  }
  current?.classList.add('now');
  const n = tree.timelapse?.length ?? 0;
  if (n && narrator?.playing) showEra(tree, Math.min(n - 1, Math.floor(p * n)));
}

function openStory(tree, visitNote) {
  state.currentTree = tree;
  narrator?.pause();
  const p = persona(tree);
  $('story-persona').textContent = p.name;
  $('story-name').textContent = tree.name;
  const label = $('story-label');
  label.textContent = tree.label;
  label.classList.toggle('legend', tree.label === 'Local Legend');
  $('story-draft').hidden = Boolean(tree.verified);
  $('story-visit').innerHTML = visitNote ?? '';
  $('story-visit').hidden = !visitNote;
  renderStoryWords(tree);
  $('story-source').innerHTML = tree.sourceUrl
    ? `${escapeHtml(tree.label)} · Source: <a href="${escapeHtml(tree.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(tree.sourceNote || tree.sourceUrl)}</a>`
    : `<em>${escapeHtml(tree.sourceNote || 'Source pending.')}</em>`;

  buildTimelapse(tree);
  autoTimelapse(tree);
  renderBenefits(tree);
  loadTreeStatus(tree);
  $('ask').hidden = !state.config.features.ask || !state.visited.has(tree.code);
  $('ask-answer').hidden = true;
  $('ask-input').value = '';

  lastProgress = 0;
  $('narration-progress').style.width = '0';
  narrator = new Narrator(tree, (x) => paintProgress(tree, x), () => { $('btn-play').textContent = '↺'; $('btn-play').setAttribute('aria-label', 'Play again'); });
  const modeNote = {
    azure: `Voice: ${p.voice} (Azure Speech)`,
    browser: 'Voice: your browser (Azure narration not generated yet)',
    none: 'This browser cannot read aloud.',
  }[narrator.mode];
  $('voice-note').textContent = modeNote;
  $('btn-play').textContent = '▶';
  $('btn-play').setAttribute('aria-label', 'Play story');
  $('btn-play').disabled = narrator.mode === 'none';

  resetReport();
  const dlg = $('story-dialog');
  if (!dlg.open) dlg.showModal();

  // Try to start talking right away; browsers may insist on a tap first.
  if (visitNote) togglePlay().catch(() => toast('Tap ▶ to hear the tree speak.'));
}

// What this tree does for campus each year, from an i-Tree MyTree estimate
// worked out ahead of time and saved on the tree (tree.benefits).
function renderBenefits(tree) {
  const b = tree.benefits;
  const box = $('story-benefits');
  if (!b) { box.hidden = true; return; }
  const items = [
    b.stormwaterGallons && `<li><b>${Math.round(b.stormwaterGallons).toLocaleString()}</b> gallons of rain soaked up</li>`,
    b.co2Pounds && `<li><b>${Math.round(b.co2Pounds).toLocaleString()}</b> lbs of carbon dioxide taken in</li>`,
    b.airPollutionOunces && `<li><b>${Math.round(b.airPollutionOunces).toLocaleString()}</b> oz of air pollution cleaned</li>`,
  ].filter(Boolean);
  box.innerHTML = `<h3>What I do for campus every year</h3><ul>${items.join('')}</ul>
    <p class="muted small">Estimate from ${escapeHtml(b.source ?? 'i-Tree MyTree')}${b.year ? `, ${b.year}` : ''}.</p>`;
  box.hidden = !items.length;
}

const SEASON_NAMES = {
  buds: 'buds', 'first-leaves': 'first leaves', 'full-leaf': 'full leaf', 'flowers-fruit': 'flowers or fruit',
  'color-change': 'leaves changing color', dropping: 'leaves dropping', bare: 'bare branches',
};
const PROBLEM_NAMES = { pest: 'pests', damage: 'damage', dying: 'that it might be dying' };

async function loadTreeStatus(tree) {
  const el = $('story-status');
  el.hidden = true;
  try {
    const s = await api(`/api/trees/${encodeURIComponent(tree.code)}/status`);
    if (state.currentTree !== tree) return;
    const bits = [];
    for (const f of Object.values(s.flags ?? {})) {
      bits.push(f.status === 'confirmed'
        ? `⚠️ The grounds team knows about ${PROBLEM_NAMES[f.flagType] ?? f.flagType} here.`
        : `🔎 ${f.reporters + f.withoutPhoto} ${f.reporters + f.withoutPhoto === 1 ? 'person has' : 'people have'} reported ${PROBLEM_NAMES[f.flagType] ?? f.flagType}. Seen it too? Add a photo below.`);
    }
    if (s.season) bits.push(`🍃 Last season sighting: ${SEASON_NAMES[s.season.season] ?? s.season.season} (${new Date(s.season.timestamp).toLocaleDateString()}).`);
    el.innerHTML = bits.map(escapeHtml).join('<br>');
    el.hidden = !bits.length;
  } catch { /* status is a nice extra, never block the story */ }
}

// ---------- ask the tree ----------

$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tree = state.currentTree;
  const question = $('ask-input').value.trim();
  if (!question) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '…';
  narrator?.pause();
  try {
    const r = await api(`/api/trees/${encodeURIComponent(tree.code)}/ask`, {
      method: 'POST', body: JSON.stringify({ playerId, question }),
    });
    if (state.currentTree !== tree) return;
    $('ask-answer').textContent = r.answer;
    $('ask-answer').hidden = false;
    if (r.audio) {
      new Audio(r.audio).play().catch(() => {});
    } else if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(r.answer);
      const pv = persona(tree).browserVoice ?? {};
      u.rate = pv.rate ?? 1;
      u.pitch = pv.pitch ?? 1;
      speechSynthesis.speak(u);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
  }
});

async function togglePlay() {
  if (!narrator) return;
  if (narrator.playing) {
    narrator.pause();
    $('btn-play').textContent = '▶';
    $('btn-play').setAttribute('aria-label', 'Play story');
    return;
  }
  stopAutoTimelapse();
  if (lastProgress >= 1) narrator = new Narrator(state.currentTree, (x) => paintProgress(state.currentTree, x), narrator.onEnd);
  $('btn-play').textContent = '❚❚';
  $('btn-play').setAttribute('aria-label', 'Pause story');
  try {
    await narrator.play();
  } catch (e) {
    narrator.playing = false;
    $('btn-play').textContent = '▶';
    throw e;
  }
}

$('btn-play').addEventListener('click', () => togglePlay().catch(() => toast('Could not play the voice on this device.')));
$('story-dialog').addEventListener('close', () => { narrator?.pause(); stopAutoTimelapse(); });

// ---------- photo + pest/damage report ----------

function resetReport() {
  $('report').open = false;
  $('report-form').reset();
  $('report-form').hidden = false;
  document.querySelector('.file').classList.remove('has-file');
  document.querySelector('.file span').textContent = '📷 Take or choose a photo of this tree';
  $('report-result').hidden = true;
  $('report-result').innerHTML = '';
}

document.querySelector('.file input').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.closest('.file').classList.toggle('has-file', Boolean(f));
  e.target.nextElementSibling.textContent = f ? `📷 ${f.name}` : '📷 Take or choose a photo of this tree';
});

$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tree = state.currentTree;
  const form = new FormData(e.target);
  form.append('playerId', playerId);
  if (!form.get('photo')?.size) form.delete('photo');
  if (!form.get('photo') && form.get('flagType') === 'none' && !form.get('season')) {
    return toast('Add a photo, a problem, or a season sighting.');
  }
  const btn = e.target.querySelector('button[class~="btn-primary"]');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    if (form.get('photo')) form.set('photo', await shrinkPhoto(form.get('photo')));
    const r = await api(`/api/trees/${encodeURIComponent(tree.code)}/reports`, { method: 'POST', body: form });
    state.lastReportId = r.report.id;
    refreshSummary();
    loadTreeStatus(tree);
    e.target.hidden = true;
    showReportResult(tree, r);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send report';
  }
});

function showReportResult(tree, r) {
  const out = $('report-result');
  let html = '<div class="result-card"><strong>Thank you, detective. Your report is on the grounds map.</strong>';
  if (r.species) {
    const c = r.species.confidence ?? 0;
    html += `<div><p style="margin:0 0 6px">Species guess: <strong>${escapeHtml(r.species.guess)}</strong> (${pct(c)} confident${r.species.provider ? `, via ${escapeHtml(r.species.provider)}` : ''})</p>
      <div class="meter ${c < 0.5 ? 'warn' : ''}"><div style="width:${pct(c)}"></div></div>
      ${r.species.alternatives?.length ? `<p class="muted small" style="margin:6px 0 0">Could also be: ${r.species.alternatives.map((a) => `${escapeHtml(a.name)} (${pct(a.confidence)})`).join(', ')}</p>` : ''}
      <p class="small" style="margin:8px 0 0">Guesses are sometimes wrong. Does it look right?
        <button class="btn" data-fb="agree" style="min-height:34px">Yes</button>
        <button class="btn" data-fb="disagree" style="min-height:34px">Not sure</button></p></div>`;
  } else if (r.speciesNote && r.report.photoUrl) {
    html += `<p class="muted small" style="margin:0">Species guess skipped: ${escapeHtml(r.speciesNote)}.</p>`;
  }
  if (r.flag) {
    const f = r.flag;
    const label = { pest: 'pests', damage: 'damage', dying: 'a dying tree' }[f.flagType] ?? f.flagType;
    html += `<div><p style="margin:0 0 6px">Flag: <strong>${escapeHtml(label)}</strong> is
      <strong>${f.status === 'confirmed' ? 'CONFIRMED' : 'possible'}</strong>
      (${f.reporters} of ${f.needed} independent reports${r.report.flagSource === 'vision' ? ', spotted by the photo check' : ''})</p>
      <div class="meter ${f.status === 'confirmed' ? 'danger' : 'warn'}"><div style="width:${pct(Math.min(1, f.reporters / f.needed))}"></div></div>
      ${r.report.photoUrl ? '' : '<p class="muted small" style="margin:6px 0 0">Only reports with a photo count toward confirming it. Add one next time you pass by.</p>'}</div>`;
  }
  if (r.pestReport) {
    html += `<p class="small" style="margin:0">Think it's a <b>spotted lanternfly</b>? New Jersey tracks them:
      <a href="${escapeHtml(r.pestReport.url)}" target="_blank" rel="noopener">report it to the state</a>
      or call <a href="tel:${escapeHtml(r.pestReport.hotline)}">${escapeHtml(r.pestReport.hotline)}</a>.</p>`;
  }
  if (r.report.season) html += '<p class="small" style="margin:0">🍃 Season sighting saved. Thanks for watching the seasons.</p>';
  html += '</div>';
  out.innerHTML = html;
  out.hidden = false;
  out.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/trees/${encodeURIComponent(tree.code)}/reports/${state.lastReportId}/feedback`, {
        method: 'POST', body: JSON.stringify({ playerId, feedback: b.dataset.fb }),
      });
      b.parentElement.innerHTML = '<span class="muted">Thanks, that helps the next guess.</span>';
    } catch (err) { toast(err.message); }
  }));
}

// ---------- walking route ----------

async function showRoute() {
  const unvisited = state.trees.filter((t) => !state.visited.has(t.code));
  if (state.routeLayer) { state.routeLayer.remove(); state.routeLayer = null; }
  const list = $('route-list');
  if (!unvisited.length) {
    list.innerHTML = '<li>Every tree is awake. The grove thanks you.</li>';
    $('route-panel').hidden = false;
    return;
  }
  const pos = await currentPosition(4000);
  const start = pos ?? map.getCenter();
  const route = planRoute({ lat: start.lat, lng: start.lng }, unvisited);
  const points = [[start.lat, start.lng], ...route.map((t) => [t.lat, t.lng])];
  state.routeLayer = L.layerGroup([
    L.polyline(points, { color: '#ffe08a', weight: 10, opacity: 0.18 }),
    L.polyline(points, { color: '#ffe08a', weight: 3, dashArray: '2 10', lineCap: 'round' }),
    ...route.map((t, i) => L.marker([t.lat, t.lng], {
      interactive: false,
      icon: L.divIcon({ className: '', html: `<div class="route-num">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 80] }),
    })),
  ]).addTo(map);
  let prev = start;
  list.innerHTML = route.map((t, i) => {
    const d = Math.round(distanceMeters(prev, t));
    prev = t;
    return `<li><button data-code="${t.code}">${escapeHtml(t.name)}</button><span class="muted">${d} m ${i === 0 && !pos ? 'from map center' : 'walk'} · ${state.config.pointsPerTree} pts</span></li>`;
  }).join('');
  list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const t = state.byCode.get(b.dataset.code);
    map.flyTo([t.lat, t.lng], 19);
  }));
  $('route-panel').hidden = false;
  map.fitBounds(L.latLngBounds(points).pad(0.2));
}

$('btn-route').addEventListener('click', () => showRoute());
$('route-close').addEventListener('click', () => {
  $('route-panel').hidden = true;
  state.routeLayer?.remove();
  state.routeLayer = null;
});

// ---------- Photon linking ----------

$('btn-link').addEventListener('click', async () => {
  try {
    const { code } = await api('/api/link-codes', { method: 'POST', body: JSON.stringify({ playerId }) });
    $('link-code').textContent = code;
    if (state.config.photonNumber) $('link-number').textContent = state.config.photonNumber;
    $('link-dialog').showModal();
  } catch (e) {
    toast(e.message);
  }
});

// ---------- boot ----------

$('btn-scan').addEventListener('click', openScanner);

async function boot() {
  try {
    const [config, trees, personas, summary] = await Promise.all([
      api('/api/config'), api('/api/trees'), api('/api/personas'), api(`/api/players/${playerId}`),
    ]);
    state.config = config;
    state.trees = trees;
    state.byCode = new Map(trees.map((t) => [t.code, t]));
    state.personas = new Map(personas.map((p) => [p.id, p]));
    document.querySelectorAll('.confirm-n').forEach((el) => { el.textContent = config.confirmThreshold; });
    $('btn-link').hidden = !config.features.photon;
    applySummary(summary);
  } catch (e) {
    toast(`The grove is unreachable right now (${e.message}).`, 10000);
    return;
  }
  initMap();
  startFireflies($('fireflies'));
  initTimeTravel(map, state.config.historic, toast);
  initBook({ state, persona, escapeHtml, onOpenTree: (code) => openStory(state.byCode.get(code), null) });

  const params = new URLSearchParams(location.search);
  const tag = params.get('tree') ? parseTag(location.href) : null;
  const code = tag?.code;
  if (code || params.has('route')) history.replaceState(null, '', location.pathname);
  if (tag) wakeTree(tag);
  else if (params.has('route')) showRoute();
  else if (!state.visited.size) toast('The trees are asleep. Find a tagged tree on campus and scan it to wake it up.', 6000);
}

boot();
