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

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const UA = { 'User-Agent': 'TreeDetective/1.0 (hackathon project; campus tree game)' };
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference-sources.json'), 'utf8'));
const outDir = path.join(ROOT, 'web', 'reference');
fs.mkdirSync(outDir, { recursive: true });
const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function json(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Details of a Commons file: a 1280px link, author and license. Null if it isn't on Commons.
async function commonsFile(fileName) {
  const q = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1280&titles=${encodeURIComponent(`File:${fileName}`)}`;
  const page = Object.values((await json(q)).query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  return {
    url: info.thumburl ?? info.url,
    page: info.descriptionurl,
    author: strip(meta.Artist?.value) || 'Unknown author',
    license: strip(meta.LicenseShortName?.value) || 'see source',
  };
}

async function fromWikipedia(title) {
  const s = await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const src = s.originalimage?.source ?? s.thumbnail?.source;
  if (!src) return null;
  const file = decodeURIComponent(src.split('/').pop().replace(/^\d+px-/, ''));
  return commonsFile(file); // only freely licensed Commons images, never non-free ones
}

async function fromCommonsSearch(query) {
  const q = `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=8&srsearch=${encodeURIComponent(query)}`;
  const hits = (await json(q)).query?.search ?? [];
  for (const h of hits) {
    if (!/\.(jpe?g)$/i.test(h.title)) continue;
    const f = await commonsFile(h.title.replace(/^File:/, ''));
    if (f) return f;
  }
  return null;
}

const trees = loadTrees();
let saved = 0;
let changed = false;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  const file = path.join(outDir, `${tree.code}.jpg`);
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
    const pick = (src.commons && await fromCommonsSearch(src.commons)) || (src.wikipedia && await fromWikipedia(src.wikipedia));
    if (!pick) {
      console.log('no free photo found. Take one on campus and save it as web/reference/' + `${tree.code}.jpg`);
      continue;
    }
    const img = await fetch(pick.url, { headers: UA });
    if (!img.ok) throw new Error(`download ${img.status}`);
    fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    tree.referencePhoto = `/reference/${tree.code}.jpg`;
    tree.referenceCredit = `Photo: ${pick.author}, ${pick.license}, via Wikimedia Commons`;
    tree.referenceSource = pick.page;
    saved++;
    console.log(`saved (${pick.license})`);
  } catch (e) {
    console.log(`failed: ${e.message}`);
    process.exitCode = 1;
  }
}
if (saved || changed) saveTrees(trees);
console.log(`Saved ${saved} reference photos into web/reference/.`);
console.log('Tip: your own campus photos are better. Save one as web/reference/TD-00X.jpg, taken from where people will stand.');
