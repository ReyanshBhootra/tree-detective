// npm run timelapse [-- TD-001] [--force] [--dry-run]
// Pre-generates each tree's life-in-pictures (Azure OpenAI or Gemini images).
// Every image is an impression of an era, and the site always labels it that way.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees } from '../server/lib/trees.js';
import { createAI, requireAI } from '../server/lib/ai.js';
import { periodLook } from '../server/lib/period.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry-run');
const ai = createAI();
if (!dry) requireAI(ai, 'image', 'Making time-lapse images');
const only = args.filter((a) => !a.startsWith('--'));
const outDir = path.join(ROOT, 'web', 'timelapse');
fs.mkdirSync(outDir, { recursive: true });

const RULES = 'Photorealistic, believable as a real archival photo. Eye-level view from the sidewalk. ' +
  'No text, no captions, no watermarks, no logos, no recognizable real people, no fantasy elements.';

export function eraPrompt(tree, era) {
  const stage = {
    before: 'The tree has not been planted yet; the spot where it will grow is empty ground.',
    sapling: 'A young sapling, recently planted, with a support stake.',
    midlife: 'The same tree, now medium-sized and established.',
    today: 'The same tree, fully grown, as it stands today.',
  }[era.era];
  const scene = era.details
    ? era.details.replace(/\.+$/, '')
    : `a city university campus spot in Newark, New Jersey. ${stage ?? ''}`;
  return `${periodLook(era.year)} of this scene in Newark, New Jersey, around ${era.year}: ${scene}. ` +
    `Clothing, vehicles, street lamps and storefronts match ${era.year} exactly. ${RULES}`;
}

// With a reference photo (a real photo of the spot), every era is redrawn from
// that same photo so the building, angle and street stay put and only time changes.
export function eraFromPhotoPrompt(era) {
  const stage = {
    before: 'before this tree was planted, so where the tree stands is empty ground',
    sapling: 'when this tree was a young sapling with a support stake',
    midlife: 'when this tree was medium-sized',
    today: 'today',
  }[era.era] ?? '';
  return `Edit this photo to show the same place around ${era.year}${stage ? `, ${stage}` : ''}. ` +
    'Keep the exact camera position, angle, framing and the shape of any building that already existed then. ' +
    'If a building in the photo was not built yet by that year, replace it with what stood there instead. ' +
    `Change cars, people's clothing, signs, street surface and trees to match ${era.year}. ` +
    `Make it look like ${periodLook(era.year)}. ${RULES}` +
    (era.details ? ` What historical sources say was here: ${era.details.replace(/\.+$/, '')}.` : '');
}

function referencePhoto(tree) {
  if (!tree.referencePhoto) return null;
  const file = path.join(ROOT, 'web', tree.referencePhoto.replace(/^\/+/, ''));
  if (!fs.existsSync(file)) {
    console.warn(`${tree.code}: referencePhoto ${tree.referencePhoto} not found, drawing without it`);
    return null;
  }
  const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { buffer: fs.readFileSync(file), type, name: path.basename(file) };
}

let made = 0;
const trees = loadTrees();
let stopped = false;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  const photo = referencePhoto(tree);
  for (const [i, era] of (tree.timelapse ?? []).entries()) {
    if (era.real || era.era === 'today' && photo) continue; // real photos stay real
    if (era.imageUrl && !force) continue;
    const prompt = photo ? eraFromPhotoPrompt(era) : eraPrompt(tree, era);
    if (dry) { console.log(`${tree.code} ${era.era}: ${prompt}\n`); continue; }
    process.stdout.write(`${tree.code} ${era.era} (${era.year})… `);
    try {
      const buf = photo ? await ai.imageFromPhoto(prompt, photo) : await ai.image(prompt);
      const name = `${tree.code}-${i}-${era.era}.png`;
      fs.writeFileSync(path.join(outDir, name), buf);
      era.imageUrl = `/timelapse/${name}`;
      era.generated = true;
      era.fromReference = Boolean(photo);
      made++;
      saveTrees(trees); // save as we go, image calls are slow
      console.log('done');
    } catch (e) {
      const msg = e.message.match(/"message":\s*"([^"]+)/)?.[1] ?? e.message;
      console.log(`failed: ${msg.split('\\n')[0].slice(0, 160)}`);
      process.exitCode = 1;
      if (/\b429\b/.test(e.message) && /quota|billing|limit: 0/i.test(e.message)) {
        console.log(`
Stopping: your ${ai.providers.image} key has no quota for image generation.
Image generation isn't in Gemini's free tier. To use your credits:
  1. aistudio.google.com -> API keys -> find this key -> "Set up billing"
     (or console.cloud.google.com/billing -> link the key's project to the
     billing account that has your credits)
  2. Wait a minute, then run "npm run timelapse" again.
Until then the app shows drawn storybook scenes, plus the real 1930 photos.`);
        stopped = true;
        break;
      }
    }
  }
  if (stopped) break;
}
console.log(dry ? 'Dry run, nothing generated.' : `Generated ${made} images into web/timelapse/.`);
