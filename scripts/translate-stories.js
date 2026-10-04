// npm run translate [-- TD-001] [--force]
// Translates each story into Spanish, Portuguese and Haitian Creole with Azure
// AI Translator, then records narration in each language (ElevenLabs covers
// all of them; Azure Speech has no Kreyòl voice, so with Azure, Kreyòl is text only).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees, loadPersonas } from '../server/lib/trees.js';
import { LANGUAGES } from '../server/lib/languages.js';
import { translate } from '../server/lib/azure.js';
import { createVoice } from '../server/lib/voice.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const targets = Object.keys(LANGUAGES).filter((l) => l !== 'en');
const personas = new Map(loadPersonas().map((p) => [p.id, p]));
const voice = createVoice();
fs.mkdirSync(path.join(ROOT, 'web', 'audio'), { recursive: true });

const trees = loadTrees();
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  tree.translations ??= {};
  tree.audio ??= tree.audioUrl ? { en: tree.audioUrl } : {};
  const todo = targets.filter((l) => force || tree.translations[l]?.source !== tree.story);
  if (todo.length) {
    process.stdout.write(`${tree.code} ${tree.name}: translating to ${todo.join(', ')}… `);
    const out = await translate(process.env, tree.story, todo);
    for (const l of todo) {
      // `source` remembers which English text this came from, so edits re-translate.
      tree.translations[l] = { story: out[l], source: tree.story, machine: true };
      delete tree.audio[l];
    }
    console.log('done');
  }
  if (!voice) continue;
  const persona = personas.get(tree.persona);
  for (const l of targets) {
    if (!voice.canSpeak(persona, l) || tree.audio[l] || !tree.translations[l]) continue;
    const name = `${tree.code}.${l}.mp3`;
    try {
      fs.writeFileSync(path.join(ROOT, 'web', 'audio', name), await voice.speak(tree.translations[l].story, persona, l));
      tree.audio[l] = `/audio/${name}`;
      console.log(`  ${l} narration by ${voice.provider}`);
    } catch (e) {
      console.log(`  ${l} narration failed: ${e.message}`);
    }
  }
}
saveTrees(trees);
console.log(voice ? 'Done.' : 'Done. Add ELEVENLABS_API_KEY or Azure Speech keys to also record the narration.');
