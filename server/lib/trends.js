// Week-by-week activity and season "firsts" for the grounds dashboard.
// TigerData computes these in the database; this is the same math in plain
// JS, used when TigerData isn't connected.

// Monday 00:00 UTC of the week, same buckets as TimescaleDB's time_bucket('1 week').
export function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export function computeTrends(visits, reports, { weeks = 8, now = new Date() } = {}) {
  const buckets = new Map();
  const first = weekStart(new Date(now.getTime() - (weeks - 1) * 7 * 86400_000).toISOString());
  for (let i = 0; i < weeks; i++) {
    const w = weekStart(new Date(Date.parse(first) + i * 7 * 86400_000).toISOString());
    buckets.set(w, { week: w, visits: 0, reports: 0, seasons: 0, flags: { pest: 0, damage: 0, dying: 0 } });
  }
  for (const v of visits) {
    const b = buckets.get(weekStart(v.timestamp));
    if (b) b.visits++;
  }
  for (const r of reports) {
    const b = buckets.get(weekStart(r.timestamp));
    if (!b) continue;
    if (r.photoUrl || r.flagType !== 'none') b.reports++;
    if (r.season) b.seasons++;
    if (b.flags[r.flagType] !== undefined) b.flags[r.flagType]++;
  }
  return [...buckets.values()];
}

// First time each season sign was seen on each tree, per year. Year over year,
// this is real phenology data: is "first leaves" coming earlier?
export function computeSeasonTimeline(reports) {
  const firsts = new Map();
  for (const r of reports) {
    if (!r.season) continue;
    const year = Number(r.timestamp.slice(0, 4));
    const key = `${r.treeCode}|${r.season}|${year}`;
    if (!firsts.has(key) || r.timestamp < firsts.get(key).firstSeen) {
      firsts.set(key, { treeCode: r.treeCode, season: r.season, year, firstSeen: r.timestamp });
    }
  }
  return [...firsts.values()].sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
}
