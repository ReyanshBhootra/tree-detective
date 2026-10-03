// npm run qr
// Writes print/qr-tags.html: one printable tag per tree, plus a PNG per tree.
// Each QR is a plain link (PUBLIC_URL/?tree=CODE), so any phone camera opens it.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { loadEnv, ROOT } from '../server/config.js';
import { loadTrees } from '../server/lib/trees.js';

loadEnv();
const base = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
if (/localhost|127\.0\.0\.1/.test(base)) console.warn(`Warning: PUBLIC_URL is ${base}. Phones can't open that, set the real site URL before printing.`);
const outDir = path.join(ROOT, 'print');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tags = [];
for (const tree of loadTrees()) {
  const url = `${base}/?tree=${encodeURIComponent(tree.code)}`;
  const opts = { errorCorrectionLevel: 'Q', margin: 1, width: 600, color: { dark: '#1b2b22', light: '#ffffff' } };
  await QRCode.toFile(path.join(outDir, `${tree.code}.png`), url, opts);
  tags.push(`<div class="tag"><p class="hi">Psst. I'm awake if you scan me.</p><img src="${await QRCode.toDataURL(url, opts)}" alt="QR code for ${esc(tree.name)}"><p class="name">${esc(tree.name)}</p><p class="code">${esc(tree.code)} · Tree Detective</p></div>`);
}

fs.writeFileSync(path.join(outDir, 'qr-tags.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Tree Detective tags</title>
<style>
  @page { margin: 12mm; }
  body { font-family: system-ui, sans-serif; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10mm; }
  .tag { border: 2px dashed #9a8; border-radius: 6mm; padding: 6mm; text-align: center; break-inside: avoid; }
  .tag img { width: 60mm; height: 60mm; }
  .hi { margin: 0 0 3mm; font-style: italic; }
  .name { font-size: 18pt; font-weight: 700; margin: 2mm 0 0; }
  .code { margin: 1mm 0 0; color: #555; }
</style></head><body><div class="grid">${tags.join('\n')}</div></body></html>`);
console.log(`Wrote ${tags.length} tags to print/qr-tags.html (open it and print). Links point at ${base}.`);
