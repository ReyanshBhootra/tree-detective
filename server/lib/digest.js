import { treeHealth } from './vouch.js';

// Weekly grounds summary: what's new, what's confirmed, what's possible.
export function buildDigest(trees, reports, sinceIso) {
  const recent = reports.filter((r) => r.timestamp >= sinceIso);
  const rows = trees.map((t) => {
    const h = treeHealth(reports, t.code);
    const fresh = recent.filter((r) => r.treeCode === t.code);
    return { tree: t, health: h, newReports: fresh.length, newSeasons: fresh.filter((r) => r.season) };
  });
  const confirmed = rows.flatMap((r) => Object.values(r.health.flags).filter((f) => f.status === 'confirmed').map((f) => ({ ...f, tree: r.tree })));
  const possible = rows.flatMap((r) => Object.values(r.health.flags).filter((f) => f.status === 'possible').map((f) => ({ ...f, tree: r.tree })));
  return { recentCount: recent.length, confirmed, possible, rows };
}
