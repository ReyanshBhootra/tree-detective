import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

export const TREES_FILE = path.join(ROOT, 'data', 'trees.json');
export const PERSONAS_FILE = path.join(ROOT, 'data', 'personas.json');

export function loadTrees(file = TREES_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveTrees(trees, file = TREES_FILE) {
  fs.writeFileSync(file, JSON.stringify(trees, null, 2) + '\n');
}

export function loadPersonas(file = PERSONAS_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Checks a tree has everything it needs. Returns a list of problems;
// an empty list means the tree is safe to show in a live demo.
export function contentProblems(tree, personas) {
  const p = [];
  if (!/^[A-Z0-9-]{3,20}$/.test(tree.code ?? '')) p.push('code must be 3-20 chars of A-Z, 0-9 or -');
  if (!tree.name) p.push('missing name');
  if (!personas.some((x) => x.id === tree.persona)) p.push(`unknown persona "${tree.persona}"`);
  if (typeof tree.lat !== 'number' || typeof tree.lng !== 'number') p.push('missing lat/lng');
  if (!tree.story) p.push('missing story');
  if (!['Fact', 'Local Legend'].includes(tree.label)) p.push('label must be "Fact" or "Local Legend"');
  if (!tree.sourceUrl) p.push('missing sourceUrl');
  if (!tree.verified) p.push('story not human-verified yet (verified: false)');
  if (!Array.isArray(tree.timelapse) || tree.timelapse.length < 2) p.push('time-lapse needs at least 2 eras');
  else if (tree.timelapse.some((e) => !e.imageUrl)) p.push('time-lapse has eras without a generated image');
  if (!tree.audioUrl) p.push('no pre-generated narration (browser voice will be used)');
  return p;
}
