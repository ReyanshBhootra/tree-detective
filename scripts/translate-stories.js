// npm run translate [-- TD-001] [--force]
// Translates each story into Spanish, Portuguese and Haitian Creole with Azure
// AI Translator, then records Spanish and Portuguese narration with Azure Speech
// (Azure has no Kreyòl voice yet, so Kreyòl is text the browser can read).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees, loadPersonas } from '../server/lib/trees.js';
import { LANGUAGES, voiceFor } from '../server/lib/languages.js';
import { translate, speak } from '../server/lib/azure.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const targets = Object.keys(LANGUAGES).filter((l) => l !== 'en');
const personas = new Map(loadPersonas().map((p) => [p.id, p]));
const speech = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
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
  if (!speech) continue;
  const persona = personas.get(tree.persona);
  for (const l of targets) {
    const voice = voiceFor(persona, l);
    if (!voice || tree.audio[l] || !tree.translations[l]) continue;
    const name = `${tree.code}.${l}.mp3`;
    fs.writeFileSync(path.join(ROOT, 'web', 'audio', name), await speak(process.env, tree.translations[l].story, persona, voice));
    tree.audio[l] = `/audio/${name}`;
    console.log(`  ${l} narration as ${voice}`);
  }
}
saveTrees(trees);
console.log(speech ? 'Done.' : 'Done. Add Azure Speech keys to also record Spanish and Portuguese narration.');
