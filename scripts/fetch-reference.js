// npm run reference [-- TD-001] [--force]
// Downloads one real, freely licensed photo of each tree's spot from Wikimedia
// Commons (using data/reference-sources.json), saves who took it and the
// license, and sets it as the tree's reference photo. Time-lapse eras are then
// drawn from this photo so every era shows the same place from the same angle.
// Your own photos win: drop web/reference/TD-001.jpg in and it is kept.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees } from '../server/lib/trees.js';
import { findPhoto } from '../server/lib/reference.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference-sources.json'), 'utf8'));
const outDir = path.join(ROOT, 'web', 'reference');
fs.mkdirSync(outDir, { recursive: true });

const trees = loadTrees();
let saved = 0;
let changed = false;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  const file = path.join(outDir, `${tree.code}.jpg`);
  // You deleted a photo you didn't like: forget it so a new one can be found.
  if (tree.referencePhoto && !fs.existsSync(path.join(ROOT, 'web', tree.referencePhoto.replace(/^\/+/, '')))) {
    delete tree.referencePhoto;
    delete tree.referenceCredit;
    delete tree.referenceSource;
    changed = true;
  }
  if (fs.existsSync(file) && !tree.referenceCredit && !force) {
    console.log(`${tree.code}: your own photo is already there, keeping it`);
    tree.referencePhoto = `/reference/${tree.code}.jpg`;
    tree.referenceCredit = 'Photo: Tree Detective team';
    changed = true;
    continue;
  }
  if (tree.referencePhoto && !force) {
    console.log(`${tree.code}: already has a reference photo`);
    continue;
  }
  const src = sources[tree.code] ?? {};
  process.stdout.write(`${tree.code} ${tree.name}… `);
  try {
    const { photo: pick, tried } = await findPhoto(src);
    if (!pick) {
      console.log(`no free photo found (tried ${tried.join(', ')}).`);
      console.log(`   Take one on campus and save it as web/reference/${tree.code}.jpg`);
      continue;
    }
    const img = await fetch(pick.url, { headers: { 'User-Agent': 'TreeDetective/1.0 (https://github.com/ReyanshBhootra/tree-detective)' } });
    if (!img.ok) throw new Error(`download ${img.status}`);
    fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    tree.referencePhoto = `/reference/${tree.code}.jpg`;
    tree.referenceCredit = `Photo: ${pick.author}, ${pick.license}, via Wikimedia Commons`;
    tree.referenceSource = pick.page;
    saved++;
    console.log(`saved "${pick.title.replace(/^File:/, '')}" (${pick.license})`);
  } catch (e) {
    console.log(`failed: ${e.message}`);
    process.exitCode = 1;
  }
  await new Promise((r) => setTimeout(r, 1500)); // be gentle with Wikimedia
}
if (saved || changed) saveTrees(trees);
console.log(`Saved ${saved} reference photos into web/reference/.`);
console.log('Tip: your own campus photos are better. Save one as web/reference/TD-00X.jpg, taken from where people will stand.');
