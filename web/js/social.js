// Website side of the social features: log in with iMessage, adopt a tree,
// photo quests, the explorer photo album and voice memories.
import { shrinkPhoto } from './photo.js';

let d; // shared helpers from app.js
const $ = (id) => document.getElementById(id);
const url = (u) => (/^https?:/.test(u) ? u : `${d.API}${u}`);

export function initSocial(deps) {
  d = deps;
  setupLogin();
  setupQuests();
  setupMemories();
  $('btn-adopt').addEventListener('click', adoptCurrent);
  loadAccount();
}

// ---------- log in with iMessage ----------

let loginTimer = null;

async function loadAccount() {
  try {
    d.state.account = await d.api(`/api/players/${d.playerId}/account`);
  } catch {
    d.state.account = { loggedIn: false };
  }
  const btn = $('btn-link');
  btn.textContent = d.state.account.loggedIn ? `📱 ${d.state.account.phone}` : '📱 Log in';
}

function showLoginStep(step) {
  for (const s of ['login-start', 'login-wait', 'login-done']) $(s).hidden = s !== step;
}

export function openLogin(reason) {
  clearInterval(loginTimer);
  const number = d.state.config.photonNumber;
  document.querySelectorAll('.photon-number').forEach((el) => { el.textContent = number || 'our Tree Detective number'; });
  if (d.state.account?.loggedIn) {
    $('login-phone-shown').textContent = d.state.account.phone;
    showLoginStep('login-done');
  } else {
    $('login-reason').textContent = reason ?? '';
    $('login-reason').hidden = !reason;
    showLoginStep('login-start');
  }
  $('link-dialog').showModal();
}

function setupLogin() {
  $('btn-link').addEventListener('click', () => openLogin());
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await d.api('/api/login', { method: 'POST', body: JSON.stringify({ playerId: d.playerId, phone: $('login-phone').value }) });
      $('login-wait-phone').textContent = r.phone;
      $('login-wait-note').textContent = 'Waiting for your reply…';
      showLoginStep('login-wait');
      const started = Date.now();
      loginTimer = setInterval(async () => {
        try {
          const s = await d.api(`/api/login/${r.loginId}`);
          if (s.status === 'done' && s.playerId) {
            clearInterval(loginTimer);
            // This browser becomes the same explorer as the phone.
            try { localStorage.setItem('td-player', s.playerId); } catch { /* private mode */ }
            $('login-wait-note').textContent = '✅ Logged in!';
            setTimeout(() => location.reload(), 700);
          } else if (s.status === 'expired' || Date.now() - started > 10 * 60 * 1000) {
            clearInterval(loginTimer);
            $('login-wait-note').textContent = 'That took too long. Try again.';
          }
        } catch { /* keep waiting */ }
      }, 2000);
    } catch (err) {
      d.toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('login-cancel').addEventListener('click', () => { clearInterval(loginTimer); showLoginStep('login-start'); });
  $('link-dialog').addEventListener('close', () => clearInterval(loginTimer));
  $('btn-logout').addEventListener('click', () => {
    try {
      localStorage.removeItem('td-player');
      localStorage.removeItem('td-name');
    } catch { /* nothing stored */ }
    location.reload();
  });
}

// ---------- adopt + album (inside a tree's story) ----------

export async function loadTreeSocial(tree) {
  const awake = d.state.visited.has(tree.code);
  $('adopt-row').hidden = !awake;
  $('album').hidden = true;
  try {
    const s = await d.api(`/api/trees/${encodeURIComponent(tree.code)}/social?playerId=${encodeURIComponent(d.playerId)}`);
    if (d.state.currentTree !== tree) return;
    const btn = $('btn-adopt');
    btn.disabled = s.adoptedByMe;
    btn.textContent = s.adoptedByMe ? '💚 Adopted' : '💚 Adopt me';
    $('adopters').textContent = s.adopters
      ? `${s.adopters} ${s.adopters === 1 ? 'person has' : 'people have'} adopted ${tree.name}`
      : `Adopt ${tree.name} and it texts you when it needs you`;
    const strip = $('album-strip');
    strip.innerHTML = s.album.map((p) => `<a href="${url(p.url)}" target="_blank" rel="noopener"><img src="${url(p.url)}" alt="Explorer photo of ${d.escapeHtml(tree.name)}" loading="lazy"></a>`).join('');
    $('album').hidden = !s.album.length;
  } catch { /* the story works without it */ }
}

async function adoptCurrent() {
  const tree = d.state.currentTree;
  if (!tree) return;
  try {
    await d.api(`/api/trees/${encodeURIComponent(tree.code)}/adopt`, { method: 'POST', body: JSON.stringify({ playerId: d.playerId }) });
    d.toast(`💚 You adopted ${tree.name}! It'll text you on iMessage.`, 3500);
    loadTreeSocial(tree);
  } catch (err) {
    if (err.status === 409) openLogin(`Log in so ${tree.name} can text you 💚`);
    else d.toast(err.message);
  }
}

// ---------- photo quests ----------

function setupQuests() {
  $('btn-quests').addEventListener('click', openQuests);
}

async function openQuests() {
  const list = $('quest-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  $('quests-dialog').showModal();
  try {
    const quests = await d.api(`/api/quests?playerId=${encodeURIComponent(d.playerId)}`);
    list.innerHTML = quests.map((q) => `<li class="quest ${q.done ? 'done' : ''}">
      <span class="quest-emoji">${q.emoji}</span>
      <div><strong>${d.escapeHtml(q.title)}</strong> <span class="muted small">+${q.points}</span><p class="muted small">${d.escapeHtml(q.hint)}</p></div>
      ${q.done ? '<span class="quest-done">✅</span>' : `<label class="btn btn-small btn-primary">📷 Snap<input type="file" accept="image/*" capture="environment" hidden data-quest="${q.id}"></label>`}
    </li>`).join('') || '<li class="muted">No quests right now. Check back soon!</li>';
    list.querySelectorAll('[data-quest]').forEach((input) => input.addEventListener('change', () => submitQuest(input)));
  } catch (err) {
    list.innerHTML = `<li class="muted">${d.escapeHtml(err.message)}</li>`;
  }
}

async function submitQuest(input) {
  const file = input.files?.[0];
  if (!file) return;
  const label = input.closest('label');
  label.classList.add('busy');
  label.firstChild.textContent = 'Checking… ';
  try {
    const form = new FormData();
    form.append('playerId', d.playerId);
    const tree = d.state.currentTree ?? d.state.byCode.get(d.state.summary?.visited?.at(-1)?.code ?? '');
    if (tree) form.append('treeCode', tree.code);
    form.append('photo', await shrinkPhoto(file));
    const r = await d.api(`/api/quests/${encodeURIComponent(input.dataset.quest)}`, { method: 'POST', body: form });
    if (!r.ok) {
      d.toast(`Not quite: ${r.reason}`, 4000);
    } else {
      d.burst(`+${r.points}`);
      d.bumpPoints();
      d.toast(`🎉 ${r.reason}${r.treeName ? ` Added to ${r.treeName}'s album.` : ''}`, 3500);
      d.refreshSummary();
    }
    openQuests();
  } catch (err) {
    d.toast(err.message);
    openQuests();
  }
}

// ---------- voice memories ----------

let recorder = null;
let recordTimer = null;

function setupMemories() {
  const btn = $('btn-memory');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    btn.hidden = true;
    return;
  }
  btn.addEventListener('click', async () => {
    if (recorder?.state === 'recording') return recorder.stop();
    const tree = d.state.currentTree;
    if (!tree) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return d.toast('Allow the microphone to record a memory.');
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      clearInterval(recordTimer);
      stream.getTracks().forEach((t) => t.stop());
      btn.textContent = 'Saving…';
      btn.disabled = true;
      try {
        const type = recorder.mimeType || 'audio/webm';
        const form = new FormData();
        form.append('playerId', d.playerId);
        form.append('name', $('note-name').value.trim());
        form.append('audio', new Blob(chunks, { type }), `memory.${type.includes('mp4') ? 'mp4' : 'webm'}`);
        await d.api(`/api/trees/${encodeURIComponent(tree.code)}/memories`, { method: 'POST', body: form });
        d.toast(`🎙️ Saved! The next person who wakes ${tree.name} will hear it.`, 3500);
        d.loadNotes(tree);
      } catch (err) {
        d.toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '🎙️ Record a voice memory';
      }
    };
    recorder.start();
    const started = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - started) / 1000);
      btn.textContent = `⏹ Stop recording (0:${String(s).padStart(2, '0')})`;
      if (s >= 45) recorder.stop(); // keep memories short
    };
    tick();
    recordTimer = setInterval(tick, 500);
  });
}
