// npm run prepare-demo
// Makes everything the demo needs, in order, and keeps going if one step fails:
// 1930 aerial photos, real reference photos, time-lapse pictures, translations + voices, English
// voices, and the fact search index. Safe to run again: finished work is skipped.
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../server/config.js';

loadEnv();
const steps = [
  ['1930 aerial photos', 'fetch-historic.js', []],
  ['Real photos of each spot (Wikimedia Commons)', 'fetch-reference.js', []],
  ['Time-lapse pictures (Gemini, a few minutes)', 'generate-timelapse.js', []],
  ['Translations and voices', 'translate-stories.js', []],
  ['English voices', 'generate-audio.js', []],
  ['Fact search (TigerData)', 'index-facts.js', []],
];
const results = [];
for (const [name, file, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [`scripts/${file}`, ...args], { stdio: 'inherit' });
  results.push([name, r.status === 0]);
}
console.log('\n=== Summary ===');
for (const [name, ok] of results) console.log(`${ok ? '✔' : '✘'}  ${name}`);
console.log('\nThen run "npm run check-content" to see what each tree still needs.');
