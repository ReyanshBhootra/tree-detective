import { POINTS_PER_TREE } from '../config.js';

// Points are simply the total of a player's visits. A tree pays out once per player.
export function totalPoints(visits) {
  return visits.reduce((sum, v) => sum + (v.points ?? 0), 0);
}

export function visitPoints(alreadyVisited) {
  return alreadyVisited ? 0 : POINTS_PER_TREE;
}
