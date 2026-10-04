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

// Demo reset: open /?reset to start fresh as a new player (all trees asleep, 0 points).
if (new URLSearchParams(location.search).has('reset')) {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('td-')).forEach((k) => localStorage.removeItem(k));
  } catch { /* nothing stored */ }
  history.replaceState(null, '', location.pathname);
}
// From iMessage ("map"): open the site as the same explorer, so their awake trees show.
{
  const fromText = new URLSearchParams(location.search).get('player');
  if (fromText && /^imsg-[a-f0-9-]{36}$/.test(fromText)) {
    try { localStorage.setItem('td-player', fromText); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname);
  }
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
  if (!res.ok) throw Object.assign(new Error(json.error || `request failed (${res.status})`), { status: res.status });
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
    </div>
    ${state.status?.[tree.code] && state.status[tree.code] !== 'ok'
      ? `<span class="tree-alert ${state.status[tree.code]}" title="${state.status[tree.code] === 'confirmed' ? 'Confirmed problem' : 'Possible problem reported'}">!</span>` : ''}<span class="tree-name">${escapeHtml(tree.name)}</span>`,
  });
}

function initMap() {
  const n = state.trees.length || 1;
  const center = state.trees.length
    ? [state.trees.reduce((s, t) => s + t.lat, 0) / n, state.trees.reduce((s, t) => s + t.lng, 0) / n]
    : [40.7424, -74.1784];
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(center, 18);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const tiles = state.config.tiles;
  map.setMaxZoom(tiles.maxZoom);
  L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom, attribution: tiles.attribution }).addTo(map);

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
  $('score-fill').style.width = pct(state.trees.length ? state.visited.size / state.trees.length : 0);
  renderStatusLine();
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
    return toast(e.status === 403 ? e.message : `Couldn't reach the grove: ${e.message}`);
  }
  applySummary(result);
  if (state.routeLayer) showRoute();

  let note;
  if (result.firstVisit) note = `<span class="plus">+${result.pointsEarned} points.</span> You woke ${escapeHtml(tree.name)}!`;
  else note = `You've already woken ${escapeHtml(tree.name)}. Welcome back.`;
  if (locationVerified === true) note += ' 📍 Location confirmed.';
  else if (locationVerified === false) note += ` The QR code counted, though your GPS put you about ${Math.round(distance)} m away.`;
  else note += ' Location is off, so the QR code alone counted.';
  await wakeMoment(tree, result);
  openStory(tree, note);
}

// The map flies to the tree, it lights up with a burst of sparks, and only
// then does its story open.
function wakeMoment(tree, result) {
  const first = result.firstVisit;
  if ($('story-dialog').open) $('story-dialog').close();
  map.flyTo([tree.lat, tree.lng], 19, { duration: 1.1 });
  if (!first) toast(`🌳 ${tree.name} remembers you.`, 1500);
  setTimeout(() => {
    refreshMarker(tree.code, { justWoke: first });
    if (!first) return;
    const glow = persona(tree).glow;
    const sparks = Array.from({ length: 14 }, (_, i) =>
      `<span class="spark" style="--a:${(360 / 14) * i}deg;--d:${70 + (i % 3) * 22}px;--t:${0.9 + (i % 4) * 0.15}s"></span>`).join('');
    const fx = L.marker([tree.lat, tree.lng], {
      interactive: false, keyboard: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: 'wake-fx', iconSize: [0, 0], html: `<div class="wake-fx-inner" style="--glow:${glow}"><span class="ring"></span><span class="ring r2"></span>${sparks}</div>` }),
    }).addTo(map);
    setTimeout(() => fx.remove(), 2800);
    burst(`+${result.pointsEarned}`);
    bumpPoints();
    toast(`✨ ${tree.name} is waking up…`, 2200);
  }, 1150);
  return new Promise((resolve) => setTimeout(resolve, first ? 3400 : 1600));
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
        if (this.tree.liveAudio) {
          $('voice-note').textContent = 'Voice: getting the voice ready… (only slow the first time)';
          this.audio.addEventListener('playing', () => { $('voice-note').textContent = `Voice: ${state.config.features.voice}`; }, { once: true });
        }
        this.audio.addEventListener('error', () => {
          // The voice service failed: read it with the browser instead.
          this.audio = null;
          this.tree = { ...this.tree, audioUrl: null };
          $('voice-note').textContent = 'Voice: your browser (the voice service didn\'t answer)';
          if (this.playing) this.play();
        }, { once: true });
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
      const lang = (this.tree.locale ?? 'en-US').slice(0, 2);
      u.lang = this.tree.locale ?? 'en-US';
      const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith(lang));
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

// "Today" shows the real photo of the spot when there is one.
function erasOf(tree) {
  return (tree.timelapse ?? []).map((era) => (era.era === 'today' && tree.referencePhoto
    ? { ...era, imageUrl: tree.referencePhoto, real: true, photo: true, credit: tree.referenceCredit ?? 'taken at this spot' }
    : era));
}

function buildTimelapse(tree) {
  const stage = $('tl-stage');
  const dots = $('tl-dots');
  stage.innerHTML = '';
  dots.innerHTML = '';
  const eras = erasOf(tree);
  const glow = persona(tree).glow;
  eras.forEach((era, i) => {
    let layer;
    if (era.imageUrl) {
      layer = document.createElement('img');
      layer.src = era.imageUrl.startsWith('http') ? era.imageUrl : `${API}${era.imageUrl}`;
      layer.alt = era.photo
        ? 'Real photo of this spot today'
        : era.real
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
  const eras = erasOf(tree);
  if (!eras.length) return;
  i = Math.max(0, Math.min(eras.length - 1, i));
  $('tl-stage').querySelectorAll('.layer').forEach((el, j) => el.classList.toggle('on', j === i));
  [...$('tl-dots').children].forEach((el, j) => el.setAttribute('aria-selected', String(j === i)));
  const era = eras[i];
  $('tl-year').textContent = era.year ? `c. ${era.year}` : '';
  $('tl-caption').textContent = era.caption ?? '';
  $('tl-note').textContent = era.real
    ? `Real photo. ${era.credit ?? 'Historic aerial survey'}`
    : era.imageUrl
      ? 'AI-generated impression, not a real historical photo'
      : 'Storybook placeholder, not a real photo';
  $('tl-note').classList.toggle('real', Boolean(era.real));
  $('tl-ring').hidden = !era.real || era.photo;
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

// The story in the reader's chosen language. Falls back to English until a
// translation exists, and says so.
function storyView(tree) {
  const lang = state.lang;
  const t = lang !== 'en' ? tree.translations?.[lang] : null;
  const pending = lang !== 'en' && !t && state.config.features.liveTranslation;
  if (pending) fetchTranslation(tree, lang);
  const used = t ? lang : 'en';
  const locale = state.config.languages.find((l) => l.code === used)?.locale ?? 'en-US';
  const made = t ? tree.audio?.[lang] : tree.audio?.en ?? tree.audioUrl;
  // No recording yet? The server makes one with ElevenLabs (or Azure) on first play and keeps it.
  const live = state.config.features.voice && !pending ? `/api/trees/${encodeURIComponent(tree.code)}/audio/${used}` : null;
  return {
    ...tree,
    story: t?.story ?? tree.story,
    audioUrl: made ?? live,
    liveAudio: !made && Boolean(live),
    locale,
    translated: Boolean(t),
    machine: Boolean(t?.machine),
    pending,
  };
}

const translating = new Set();
async function fetchTranslation(tree, lang) {
  const key = `${tree.code}:${lang}`;
  if (translating.has(key)) return;
  translating.add(key);
  try {
    const r = await api(`/api/trees/${encodeURIComponent(tree.code)}/story/${lang}`);
    tree.translations = { ...tree.translations, [lang]: { story: r.story, machine: r.machine } };
    if (state.currentTree === tree && state.lang === lang && $('story-dialog').open) {
      openStory(tree, $('story-visit').hidden ? null : $('story-visit').innerHTML, { keepNote: true });
    }
  } catch (e) {
    if (state.currentTree === tree) $('lang-note').textContent = `Couldn't translate right now (${e.message}).`;
  } finally {
    translating.delete(key);
  }
}

function renderLanguagePicker(tree) {
  const box = $('lang-picker');
  box.innerHTML = state.config.languages.map((l) =>
    `<button type="button" data-lang="${l.code}" aria-pressed="${l.code === state.lang}" lang="${l.code}">${escapeHtml(l.label)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.lang = b.dataset.lang;
    storageSet('td-lang', state.lang);
    openStory(tree, $('story-visit').hidden ? null : $('story-visit').innerHTML, { keepNote: true });
  }));
}

function openStory(tree, visitNote, { keepNote = false } = {}) {
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
  renderLanguagePicker(tree);
  const view = storyView(tree);
  state.view = view;
  renderStoryWords(view);
  const langName = state.config.languages.find((l) => l.code === state.lang)?.name;
  $('lang-note').textContent = state.lang === 'en' ? ''
    : view.translated ? 'Machine translated from English (Azure Translator).'
      : view.pending ? `Translating into ${langName}…` : `Not translated into ${langName} yet, so here it is in English.`;
  $('lang-note').hidden = state.lang === 'en';
  $('story-place').textContent = tree.place ? `📍 ${tree.place}` : '';
  const sources = tree.sources?.length ? tree.sources : tree.sourceUrl ? [{ url: tree.sourceUrl, note: tree.sourceNote }] : [];
  $('story-source').innerHTML = sources.length
    ? `${escapeHtml(tree.label)} · Sources: ${sources.map((x) => `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.note || x.url)}</a>`).join(' · ')}`
    : `<em>${escapeHtml(tree.sourceNote || 'Source pending.')}</em>`;

  buildTimelapse(tree);
  autoTimelapse(tree);
  renderBenefits(tree);
  loadTreeStatus(tree);
  $('ask').hidden = !state.config.features.ask || !state.visited.has(tree.code);
  $('ask-answer').hidden = true;
  $('ask-input').value = '';
  const chips = tree.questions?.length ? tree.questions : ['How old can trees like you get?', 'What happens to you in winter?', 'What was here before?'];
  $('ask-chips').innerHTML = chips.map((q) => `<button type="button" class="chip">${escapeHtml(q)}</button>`).join('');
  $('ask-chips').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    $('ask-input').value = c.textContent;
    $('ask-form').requestSubmit();
  }));

  lastProgress = 0;
  $('narration-progress').style.width = '0';
  narrator = new Narrator(view, (x) => paintProgress(view, x), () => { $('btn-play').textContent = '↺'; $('btn-play').setAttribute('aria-label', 'Play again'); });
  const modeNote = {
    azure: view.liveAudio ? `Voice: ${state.config.features.voice}` : `Voice: recorded with ${state.config.features.voice ?? 'Azure Speech'}`,
    browser: view.pending ? 'Voice: waiting for the translation…' : 'Voice: your browser',
    none: 'This browser cannot read aloud.',
  }[narrator.mode];
  $('voice-note').textContent = modeNote;
  $('btn-play').textContent = '▶';
  $('btn-play').setAttribute('aria-label', 'Play story');
  $('btn-play').disabled = narrator.mode === 'none';

  resetReport();
  renderCompare(tree);
  loadNotes(tree);
  const dlg = $('story-dialog');
  if (!dlg.open) dlg.showModal();

  // Try to start talking right away; browsers may insist on a tap first.
  if (visitNote && !keepNote) togglePlay().catch(() => toast('Tap ▶ to hear the tree speak.'));
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
    if (state.weather?.line) bits.unshift(`☀️ ${state.weather.line}`);
    el.innerHTML = bits.map(escapeHtml).join('<br>');
    el.hidden = !bits.length;
  } catch { /* status is a nice extra, never block the story */ }
}

// ---------- then and now ----------

// With a real reference photo of the spot, drag to wipe between today and the
// selected era. Eras made from that photo line up with it exactly.
function renderCompare(tree) {
  const btn = $('btn-compare');
  const box = $('compare');
  box.hidden = true;
  btn.hidden = !tree.referencePhoto;
  btn.setAttribute('aria-pressed', 'false');
  if (!tree.referencePhoto) return;
  $('compare-today').src = tree.referencePhoto.startsWith('http') ? tree.referencePhoto : `${API}${tree.referencePhoto}`;
  $('compare-range').value = 50;
  box.style.setProperty('--cut', '50%');
}

$('btn-compare').addEventListener('click', () => {
  const on = $('compare').hidden;
  $('compare').hidden = !on;
  $('btn-compare').setAttribute('aria-pressed', String(on));
  $('btn-compare').textContent = on ? 'Back to the time-lapse' : 'Compare with today';
  if (on) stopAutoTimelapse();
});
$('compare-range').addEventListener('input', (e) => $('compare').style.setProperty('--cut', `${e.target.value}%`));

// ---------- notes for the tree ----------

async function loadNotes(tree) {
  const list = $('notes-list');
  $('notes').hidden = false;
  $('note-form').hidden = !state.visited.has(tree.code);
  $('note-locked').hidden = state.visited.has(tree.code);
  try {
    const notes = await api(`/api/trees/${encodeURIComponent(tree.code)}/notes`);
    if (state.currentTree !== tree) return;
    list.innerHTML = notes.length
      ? notes.map((n) => `<li><p>${escapeHtml(n.text)}</p><small>${n.name ? `${escapeHtml(n.name)} · ` : ''}${new Date(n.timestamp).toLocaleDateString()}
          <button class="link-btn" data-flag="${escapeHtml(n.id)}">Report</button></small></li>`).join('')
      : '<li class="muted">No notes yet. Be the first.</li>';
    list.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/trees/${encodeURIComponent(tree.code)}/notes/${encodeURIComponent(b.dataset.flag)}/flag`, { method: 'POST', body: JSON.stringify({ playerId }) });
        b.closest('li').remove();
        toast('Thanks. Notes reported by a couple of people are hidden.');
      } catch (err) { toast(err.message); }
    }));
  } catch { list.innerHTML = ''; }
}

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tree = state.currentTree;
  const name = $('note-name').value.trim();
  storageSet('td-name', name);
  try {
    await api(`/api/trees/${encodeURIComponent(tree.code)}/notes`, {
      method: 'POST', body: JSON.stringify({ playerId, text: $('note-text').value, name }),
    });
    $('note-text').value = '';
    toast(`${tree.name} will treasure that.`);
    loadNotes(tree);
  } catch (err) { toast(err.message); }
});

// ---------- map status line ----------

async function loadMapStatus() {
  try {
    state.status = await api('/api/status');
    for (const code of state.markers.keys()) refreshMarker(code);
    renderStatusLine();
  } catch { /* the map works without it */ }
}

function renderStatusLine() {
  const el = $('status-line');
  if (!el || !state.trees.length) return;
  const asleep = state.trees.length - state.visited.size;
  const needHelp = Object.values(state.status ?? {}).filter((v) => v !== 'ok').length;
  const parts = [asleep ? `🌙 ${asleep} still asleep` : '🌳 Every tree is awake'];
  parts.push(needHelp ? `⚠️ ${needHelp} ${needHelp === 1 ? 'needs' : 'need'} a check-up` : '💚 All quiet in the grove');
  if (state.weather) parts.push(`${Math.round(state.weather.tempF)}°F`);
  el.textContent = parts.join(' · ');
  el.hidden = false;
}

// ---------- hold to talk ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function setupHoldToTalk() {
  const btn = $('btn-talk');
  if (!Recognition) { btn.hidden = true; return; }
  btn.hidden = false;
  let rec = null;
  let heard = '';
  const start = (e) => {
    e.preventDefault();
    if (rec) return;
    heard = '';
    rec = new Recognition();
    rec.lang = state.config.languages.find((l) => l.code === state.lang)?.locale ?? 'en-US';
    rec.interimResults = true;
    rec.onresult = (ev) => {
      heard = [...ev.results].map((r) => r[0].transcript).join(' ');
      $('ask-input').value = heard;
    };
    rec.onerror = () => toast('Couldn\'t hear that. Check the microphone permission.');
    rec.onend = () => {
      rec = null;
      btn.classList.remove('listening');
      if (heard.trim()) $('ask-form').requestSubmit();
    };
    btn.classList.add('listening');
    narrator?.pause();
    rec.start();
  };
  const stop = () => rec?.stop();
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') start(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stop(); });
}

// ---------- ask the tree ----------

$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tree = state.currentTree;
  const question = $('ask-input').value.trim();
  if (!question) return;
  const btn = e.target.querySelector('button:not(.talk)');
  btn.disabled = true;
  btn.textContent = '…';
  narrator?.pause();
  state.answerAudio?.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  state.askHistory ??= {};
  const history = state.askHistory[tree.code] ??= [];
  try {
    const r = await api(`/api/trees/${encodeURIComponent(tree.code)}/ask`, {
      method: 'POST', body: JSON.stringify({ playerId, question, lang: state.lang, history }),
    });
    if (state.currentTree !== tree) return;
    history.push({ q: question, a: r.answer });
    if (history.length > 3) history.shift();
    $('ask-input').value = '';
    $('ask-answer').innerHTML = `<span class="you-asked">You asked: ${escapeHtml(question)}</span>${escapeHtml(r.answer)}`;
    $('ask-answer').hidden = false;
    if (r.audio) {
      state.answerAudio = new Audio(r.audio);
      state.answerAudio.play().catch(() => {});
    } else if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(r.answer);
      u.lang = state.config.languages.find((l) => l.code === state.lang)?.locale ?? 'en-US';
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
  if (lastProgress >= 1) narrator = new Narrator(state.view, (x) => paintProgress(state.view, x), narrator.onEnd);
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
    loadMapStatus();
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
  } else if (r.speciesNote && r.report.photoUrl && (state.config.features.speciesVision || state.config.features.speciesProvider)) {
    html += `<p class="muted small" style="margin:0">Species guess skipped: ${escapeHtml(r.speciesNote)}.</p>`;
  }
  if (r.flag) {
    const f = r.flag;
    const label = { pest: 'pests', damage: 'damage', dying: 'a dying tree' }[f.flagType] ?? f.flagType;
    html += `<div><p style="margin:0 0 6px">Flag: <strong>${escapeHtml(label)}</strong> is
      <strong>${f.status === 'confirmed' ? 'CONFIRMED' : 'possible'}</strong>
      (${f.reporters} of ${f.needed} independent reports${r.report.flagSource === 'vision' ? ', spotted by the photo check' : ''})</p>
      ${r.photoCheck?.reason ? `<p class="muted small" style="margin:0 0 6px">📷 ${escapeHtml(r.photoCheck.by)} saw: ${escapeHtml(r.photoCheck.reason)}</p>` : ''}
      <div class="meter ${f.status === 'confirmed' ? 'danger' : 'warn'}"><div style="width:${pct(Math.min(1, f.reporters / f.needed))}"></div></div>
      ${r.report.photoUrl ? '' : '<p class="muted small" style="margin:6px 0 0">Only reports with a photo count toward confirming it. Add one next time you pass by.</p>'}</div>`;
  }
  if (r.pestReport) {
    html += `<p class="small" style="margin:0">Think it's a <b>spotted lanternfly</b>? New Jersey tracks them:
      <a href="${escapeHtml(r.pestReport.url)}" target="_blank" rel="noopener">report it to the state</a>
      or call <a href="tel:${escapeHtml(r.pestReport.hotline)}">${escapeHtml(r.pestReport.hotline)}</a>.</p>`;
  }
  if (r.report.season) html += '<p class="small" style="margin:0">🍃 Season sighting saved. Thanks for watching the seasons.</p>';
  if (r.rescueBonus) {
    html += `<p style="margin:0"><b>🛟 Rescue bonus: +${r.rescueBonus} points!</b> This tree had an open problem, and your photo helps the grounds team decide.</p>`;
    burst(`+${r.rescueBonus}`);
    bumpPoints();
  }
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

// ---------- how to play ----------

function openWelcome() {
  storageSet('td-welcomed', '1');
  $('welcome-dialog').showModal();
}
$('btn-help').addEventListener('click', openWelcome);
$('welcome-scan').addEventListener('click', () => { $('welcome-dialog').close(); openScanner(); });
$('welcome-route').addEventListener('click', () => { $('welcome-dialog').close(); showRoute(); });

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
    const savedLang = storageGet('td-lang');
    const browserLang = (navigator.language || 'en').slice(0, 2);
    const known = (c) => config.languages.some((l) => l.code === c);
    state.lang = known(savedLang) ? savedLang : known(browserLang) ? browserLang : 'en';
    $('note-name').value = storageGet('td-name') ?? '';
    document.querySelectorAll('.confirm-n').forEach((el) => { el.textContent = config.confirmThreshold; });
    $('btn-link').hidden = !config.features.photon;
    applySummary(summary);
  } catch (e) {
    toast(`The grove is unreachable right now (${e.message}).`, 10000);
    return;
  }
  initMap();
  startFireflies($('fireflies'));
  initTimeTravel(map, state.config.historic, toast, api);
  setupHoldToTalk();
  loadMapStatus();
  api('/api/weather').then((w) => { state.weather = w; renderStatusLine(); }).catch(() => {});
  initBook({ state, persona, escapeHtml, onOpenTree: (code) => openStory(state.byCode.get(code), null) });

  const params = new URLSearchParams(location.search);
  const tag = params.get('tree') ? parseTag(location.href) : null;
  const code = tag?.code;
  if (code || params.has('route')) history.replaceState(null, '', location.pathname);
  if (tag) wakeTree(tag);
  else if (params.has('route')) showRoute();
  else if (!state.visited.size && !storageGet('td-welcomed')) openWelcome();
  else if (!state.visited.size) toast('The trees are asleep. Find a tagged tree on campus and scan it to wake it up.', 6000);
}

boot();
