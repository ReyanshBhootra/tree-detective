// npm run stories [-- TD-001 TD-002] [--dry-run]
// Writes each tree's story in its persona voice from data/facts/<code>.json.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees, loadPersonas } from '../server/lib/trees.js';
import { createAI, requireAI } from '../server/lib/ai.js';

loadEnv();
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const ai = createAI();
if (!dry) requireAI(ai, 'chat', 'Writing stories');
const only = args.filter((a) => !a.startsWith('--'));
const trees = loadTrees();
const personas = new Map(loadPersonas().map((p) => [p.id, p]));
const factsDir = path.join(ROOT, 'data', 'facts');

export function buildMessages(tree, persona, facts) {
  return [
    {
      role: 'system',
      content:
        'You write short spoken monologues for trees on a university campus, for a family-friendly game. ' +
        'Use ONLY the facts provided. Do not add any names, dates, numbers, events or places that are not in the facts. ' +
        'If the facts are thin, keep the story short and talk about the present moment instead of inventing history. ' +
        `Every fact here is labeled "${facts.label}". ` +
        (facts.label === 'Local Legend'
          ? 'Make it clear, in the tree\'s own voice, that this is a legend people tell, not proven history. '
          : '') +
        'Write in first person as the tree. 110 to 170 words. Plain text, no headings, no stage directions, no emoji.',
    },
    {
      role: 'user',
      content:
        `Tree name: ${tree.name}\nPersona: ${persona.name}. ${persona.style}\n\nFacts:\n` +
        facts.facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n'),
    },
  ];
}

let changed = 0;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  const file = path.join(factsDir, `${tree.code}.json`);
  if (!fs.existsSync(file)) {
    console.log(`${tree.code}: no data/facts/${tree.code}.json yet, skipping`);
    continue;
  }
  const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!['Fact', 'Local Legend'].includes(facts.label)) throw new Error(`${tree.code}: label must be "Fact" or "Local Legend"`);
  if (!facts.facts?.length || facts.facts.some((f) => !f.sourceUrl)) throw new Error(`${tree.code}: every fact needs a sourceUrl`);
  const persona = personas.get(tree.persona);
  const messages = buildMessages(tree, persona, facts);
  if (dry) {
    console.log(`--- ${tree.code} prompt ---\n${messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')}\n`);
    continue;
  }
  const story = await ai.chat(messages);
  tree.story = story;
  tree.label = facts.label;
  tree.sourceUrl = facts.facts[0].sourceUrl;
  tree.sourceNote = facts.facts.map((f) => f.sourceNote || f.sourceUrl).join('; ');
  tree.sources = facts.facts.map((f) => ({ url: f.sourceUrl, note: f.sourceNote ?? '' }));
  if (facts.plantedYearEstimate) tree.plantedYearEstimate = facts.plantedYearEstimate;
  if (Array.isArray(facts.eras) && facts.eras.length >= 2) {
    const old = new Map((tree.timelapse ?? []).map((e) => [e.era, e]));
    tree.timelapse = facts.eras.map((e) => ({
      era: e.era, year: e.year, caption: e.caption || old.get(e.era)?.caption || '', details: e.details ?? '',
      imageUrl: old.get(e.era)?.imageUrl ?? null,
    }));
  }
  tree.verified = false; // a human must read it against the sources first
  tree.audioUrl = null; // old narration no longer matches the words
  changed++;
  console.log(`${tree.code} ${tree.name} (${tree.label}):\n${story}\n`);
}
if (changed) {
  saveTrees(trees);
  console.log(`Updated ${changed} stories. Read each one against its sources, then set "verified": true in data/trees.json.`);
}
