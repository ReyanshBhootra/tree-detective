// npm run historic [-- TD-001] [--force]
// Saves a real 1930s aerial photo of each tree's spot (NJ Office of GIS WMS)
// and puts it at the start of that tree's time-lapse. Run it on a normal
// network before the event, so the demo never depends on the state's server.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees, saveTrees } from '../server/lib/trees.js';
import { pickLayer, bbox } from '../server/lib/historic.js';

loadEnv();
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const WMS = process.env.HISTORIC_WMS_URL && process.env.HISTORIC_WMS_URL !== 'off'
  ? process.env.HISTORIC_WMS_URL
  : 'https://img.nj.gov/imagerywms/BlackWhite1930';
const outDir = path.join(ROOT, 'web', 'historic');
fs.mkdirSync(outDir, { recursive: true });

const caps = await fetch(`${WMS}?service=WMS&request=GetCapabilities&version=1.1.1`);
if (!caps.ok) {
  console.error(`Couldn't reach ${WMS} (${caps.status}).`);
  process.exit(1);
}
const { layer, names } = pickLayer(await caps.text(), process.env.HISTORIC_WMS_LAYER);
if (!layer) {
  console.error('No layers found in the WMS capabilities.');
  process.exit(1);
}
console.log(`Using layer "${layer}" (available: ${names.join(', ')})`);
if (layer !== (process.env.HISTORIC_WMS_LAYER || 'BlackWhite1930')) {
  console.log(`Tip: set HISTORIC_WMS_LAYER=${layer} in .env so the map's time travel slider uses it too.`);
}

const trees = loadTrees();
let saved = 0;
for (const tree of trees) {
  if (only.length && !only.includes(tree.code)) continue;
  const existing = (tree.timelapse ?? []).find((e) => e.real);
  if (existing && !force) continue;
  const url = `${WMS}?service=WMS&version=1.1.1&request=GetMap&layers=${encodeURIComponent(layer)}&styles=` +
    `&srs=EPSG:4326&bbox=${bbox(tree.lat, tree.lng)}&width=800&height=600&format=image/jpeg`;
  process.stdout.write(`${tree.code} ${tree.name}… `);
  const res = await fetch(url);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) {
    console.log(`failed (${res.status} ${type}): ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const name = `${tree.code}-1930.jpg`;
  fs.writeFileSync(path.join(outDir, name), Buffer.from(await res.arrayBuffer()));
  const era = {
    era: 'aerial-1930',
    year: 1930,
    caption: 'This exact spot from the air, in the 1930s survey of New Jersey. The glowing ring is where I stand now.',
    imageUrl: `/historic/${name}`,
    real: true,
    credit: '1930s aerial photography of New Jersey, NJ Office of GIS',
  };
  tree.timelapse = [era, ...(tree.timelapse ?? []).filter((e) => !e.real)];
  saved++;
  console.log('saved');
}
saveTrees(trees);
console.log(`Saved ${saved} real 1930s photos into web/historic/.`);
