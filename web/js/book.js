// The grove book: one card per tree plus badges. Everything is worked out
// from the player's summary, so there's nothing extra to store.

export const BADGES = [
  { id: 'first', icon: '🌱', name: 'First Light', desc: 'Wake your first tree', test: (c) => c.woken >= 1 },
  { id: 'walker', icon: '🥾', name: 'Grove Walker', desc: 'Wake 3 trees', test: (c) => c.woken >= 3 },
  { id: 'whole', icon: '🌳', name: 'Whole Grove', desc: 'Wake every tree', test: (c) => c.total > 0 && c.woken === c.total },
  { id: 'voices', icon: '🎭', name: 'Many Voices', desc: 'Meet 5 different personalities', test: (c) => c.personas >= 5 },
  { id: 'owl', icon: '🦉', name: 'Night Owl', desc: 'Wake a tree after dark (8pm to 5am)', test: (c) => c.nightVisits >= 1 },
  { id: 'doctor', icon: '🩺', name: 'Tree Doctor', desc: 'Send a photo or problem report', test: (c) => c.reports >= 1 },
  { id: 'seasons', icon: '🍂', name: 'Season Watcher', desc: 'Log a season sighting', test: (c) => c.seasons >= 1 },
  { id: 'lanternfly', icon: '🦗', name: 'Lanternfly Squad', desc: 'Report pests on a tree', test: (c) => c.pestReports >= 1 },
  { id: 'rescuer', icon: '🛟', name: 'Rescuer', desc: 'Photograph a tree with an open problem', test: (c) => c.rescues >= 1 },
];

export function bookCounts(summary, trees, personaOf) {
  const visited = summary?.visited ?? [];
  const byCode = new Map(trees.map((t) => [t.code, t]));
  return {
    woken: visited.length,
    total: trees.length,
    personas: new Set(visited.map((v) => personaOf(byCode.get(v.code)))).size,
    nightVisits: visited.filter((v) => {
      const h = new Date(v.timestamp).getHours();
      return h >= 20 || h < 5;
    }).length,
    reports: summary?.reportsSent ?? 0,
    seasons: summary?.seasonsLogged ?? 0,
    pestReports: summary?.pestReports ?? 0,
    rescues: summary?.rescues ?? 0,
  };
}

let ctx;

export function initBook(context) {
  ctx = context;
  document.getElementById('btn-book').addEventListener('click', openBook);
}

export function openBook() {
  const { state, persona, escapeHtml, onOpenTree } = ctx;
  const visited = new Map((state.summary?.visited ?? []).map((v) => [v.code, v]));
  const counts = bookCounts(state.summary, state.trees, (t) => t?.persona);

  document.getElementById('book-progress').textContent =
    `${counts.woken} of ${counts.total} trees woken · ${state.points} points`;

  document.getElementById('book-badges').innerHTML = BADGES.map((b) => {
    const got = b.test(counts);
    return `<li class="badge-item ${got ? 'got' : ''}" title="${escapeHtml(b.desc)}">
      <span class="badge-icon" aria-hidden="true">${got ? b.icon : '🔒'}</span>
      <span><b>${escapeHtml(b.name)}</b><small>${escapeHtml(b.desc)}</small></span></li>`;
  }).join('');

  const cards = document.getElementById('book-cards');
  cards.innerHTML = state.trees.map((t) => {
    const v = visited.get(t.code);
    const p = persona(t);
    if (!v) {
      return `<li class="card sleeping"><div class="card-art" aria-hidden="true">🌑</div>
        <b>???</b><small>Still asleep somewhere on campus</small></li>`;
    }
    return `<li class="card" style="--card-glow:${p.glow}">
      <button data-code="${t.code}">
        <div class="card-art" aria-hidden="true">🌳</div>
        <b>${escapeHtml(t.name)}</b>
        <small>${escapeHtml(p.name)}</small>
        <small>Met ${new Date(v.timestamp).toLocaleDateString()}</small>
      </button></li>`;
  }).join('');
  cards.querySelectorAll('button[data-code]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById('book-dialog').close();
    onOpenTree(b.dataset.code);
  }));
  document.getElementById('book-dialog').showModal();
}
