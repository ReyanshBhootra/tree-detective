// npm run timelapse [-- TD-001] [--force] [--dry-run]
// Pre-generates each tree's life-in-pictures with Azure OpenAI image generation.
// Every image is an impression of an era, and the site always labels it that way.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees } from '../server/lib/trees.js';
import { image } from './azure.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry-run');
const only = args.filter((a) => !a.startsWith('--'));
const outDir = path.join(ROOT, 'web', 'timelapse');
fs.mkdirSync(outDir, { recursive: true });

const STYLE =
  'Whimsical storybook illustration, soft watercolor and gouache, warm light, gentle textures, ' +
  'same fixed camera angle at ground level looking at one spot. No text, no lettering, no logos, no recognizable real people.';

export function eraPrompt(tree, era) {
  const stage = {
    before: 'The tree has not been planted yet; show the empty spot where it will one day grow.',
    sapling: 'A young sapling, recently planted, with a support stake.',
    midlife: 'The same tree, now medium-sized and established.',
    today: 'The same tree, fully grown, as it stands today.',
  }[era.era] ?? `The tree during the "${era.era}" era.`;
  return `${STYLE} Scene: a city university campus spot in Newark, New Jersey, around the year ${era.year}. ${stage} ` +
    (era.details ? `Era details from historical sources: ${era.details}. ` : '') +
    'Clothing, vehicles and buildings, if any appear, should match that period in a general way.';
}

let made = 0;
const trees = loadTrees();
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  for (const [i, era] of (tree.timelapse ?? []).entries()) {
    if (era.imageUrl && !force) continue;
    const prompt = eraPrompt(tree, era);
    if (dry) { console.log(`${tree.code} ${era.era}: ${prompt}\n`); continue; }
    process.stdout.write(`${tree.code} ${era.era} (${era.year})… `);
    try {
      const buf = await image(process.env, prompt);
      const name = `${tree.code}-${i}-${era.era}.png`;
      fs.writeFileSync(path.join(outDir, name), buf);
      era.imageUrl = `/timelapse/${name}`;
      era.generated = true;
      made++;
      saveTrees(trees); // save as we go, image calls are slow
      console.log('done');
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
}
console.log(dry ? 'Dry run, nothing generated.' : `Generated ${made} images into web/timelapse/.`);
