import { CONFIRM_THRESHOLD } from '../config.js';

// A flag is "confirmed" only once enough *different* people reported the same
// flag on the same tree, each with a photo as evidence. One person reporting
// five times still counts once, and photo-less flags stay "possible" forever.
export function flagStatus(reports, treeCode, flagType, threshold = CONFIRM_THRESHOLD) {
  if (!flagType || flagType === 'none') return null;
  const same = reports.filter((r) => r.treeCode === treeCode && r.flagType === flagType);
  const reporters = new Set(same.filter((r) => r.photoUrl).map((r) => r.reporterHash));
  const allPeople = new Set(same.map((r) => r.reporterHash));
  return {
    flagType,
    reporters: reporters.size,
    withoutPhoto: allPeople.size - reporters.size,
    needed: threshold,
    status: reporters.size >= threshold ? 'confirmed' : 'possible',
  };
}

export function latestSeason(reports, treeCode) {
  const r = reports
    .filter((x) => x.treeCode === treeCode && x.season)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
  return r ? { season: r.season, timestamp: r.timestamp } : null;
}

// Summary per tree for the grounds dashboard.
export function treeHealth(reports, treeCode, threshold = CONFIRM_THRESHOLD) {
  const mine = reports.filter((r) => r.treeCode === treeCode);
  const flags = {};
  for (const type of new Set(mine.map((r) => r.flagType))) {
    const s = flagStatus(mine, treeCode, type, threshold);
    if (s) flags[type] = s;
  }
  const species = {};
  for (const r of mine) {
    if (!r.speciesGuess) continue;
    const s = (species[r.speciesGuess] ??= { name: r.speciesGuess, votes: 0, confidenceSum: 0, agreed: 0 });
    s.votes++;
    s.confidenceSum += Number(r.confidence) || 0;
    if (r.speciesFeedback === 'agree') s.agreed++;
  }
  const speciesList = Object.values(species)
    .map((s) => ({ name: s.name, votes: s.votes, agreed: s.agreed, avgConfidence: s.confidenceSum / s.votes }))
    .sort((a, b) => b.votes - a.votes || b.avgConfidence - a.avgConfidence);
  return {
    treeCode,
    reportCount: mine.length,
    lastReportAt: mine.reduce((t, r) => (!t || r.timestamp > t ? r.timestamp : t), null),
    flags,
    species: speciesList,
    season: latestSeason(mine, treeCode),
  };
}
