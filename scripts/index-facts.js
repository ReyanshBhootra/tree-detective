// npm run index-facts
// Loads every sourced fact into TigerData with an embedding, so "Ask me
// something" can find the most relevant ones. Reads:
//   data/facts/<CODE>.json   facts about one tree
//   data/facts/campus.json   facts about campus in general (any tree may use them)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnv, ROOT } from '../server/config.js';
import { createTiger } from '../server/lib/tiger.js';
import { createAI, requireAI } from '../server/lib/ai.js';

loadEnv();
const ai = createAI();
requireAI(ai, 'embed', 'Loading facts into TigerData');
const tiger = createTiger();
if (!tiger) {
  console.error('Set TIGER_DATABASE_URL (from console.cloud.timescale.com) first.');
  process.exit(1);
}
const dir = path.join(ROOT, 'data', 'facts');
const rows = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.example.json'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const treeCode = file === 'campus.json' ? null : (doc.code ?? path.basename(file, '.json'));
  for (const f of doc.facts ?? []) {
    if (!f.sourceUrl) throw new Error(`${file}: every fact needs a sourceUrl`);
    rows.push({
      id: crypto.createHash('sha1').update(`${treeCode}|${f.text}`).digest('hex').slice(0, 20),
      treeCode, text: f.text, label: doc.label, sourceUrl: f.sourceUrl, sourceNote: f.sourceNote,
    });
  }
}
console.log(`Embedding ${rows.length} facts…`);
for (let i = 0; i < rows.length; i += 16) {
  const batch = rows.slice(i, i + 16);
  const vectors = await ai.embed(batch.map((r) => r.text));
  for (const [j, r] of batch.entries()) await tiger.upsertFact({ ...r, embedding: vectors[j] });
}
await tiger.close();
console.log(`Loaded ${rows.length} facts into TigerData.`);
