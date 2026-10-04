// npm run audio [-- TD-001] [--force]
// Pre-renders every story with Azure Speech in its persona's voice.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees, loadPersonas } from '../server/lib/trees.js';
import { createVoice } from '../server/lib/voice.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const outDir = path.join(ROOT, 'web', 'audio');
fs.mkdirSync(outDir, { recursive: true });
const personas = new Map(loadPersonas().map((p) => [p.id, p]));
const voice = createVoice();
if (!voice) {
  console.error('Add ELEVENLABS_API_KEY (or Azure Speech keys) to .env first.');
  process.exit(1);
}
console.log(`Voices by ${voice.provider}`);

const trees = loadTrees();
let made = 0;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  if (tree.audioUrl && !force) continue;
  if (!tree.verified) console.warn(`${tree.code}: story is not verified yet, generating anyway so you can listen while reviewing`);
  const persona = personas.get(tree.persona);
  process.stdout.write(`${tree.code} ${tree.name} as ${voice.voiceName(persona, 'en')}… `);
  try {
    const mp3 = await voice.speak(tree.story, persona, 'en');
    fs.writeFileSync(path.join(outDir, `${tree.code}.mp3`), mp3);
    tree.audioUrl = `/audio/${tree.code}.mp3`;
    tree.audio = { ...tree.audio, en: tree.audioUrl };
    made++;
    console.log('done');
  } catch (e) {
    console.log(`failed: ${e.message}`);
  }
}
saveTrees(trees);
console.log(`Rendered ${made} narrations into web/audio/.`);
