// npm run digest [-- --days 7]
// Weekly summary for the grounds team. Sends with Azure Communication Services
// Email when configured, otherwise writes print/digest.html to look at.
// Schedule it weekly (App Service WebJob, or any cron).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT, CONFIRM_THRESHOLD } from '../server/config.js';
import { loadTrees } from '../server/lib/trees.js';
import { createStore } from '../server/lib/store.js';
import { buildDigest } from '../server/lib/digest.js';

loadEnv();
const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 7;
const since = new Date(Date.now() - days * 86400_000).toISOString();
const site = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const LABEL = { pest: 'Pests', damage: 'Damage', dying: 'Dying' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const store = createStore();
const trees = loadTrees();
const d = buildDigest(trees, await store.list('reports'), since);

const flagLine = (f) => `${LABEL[f.flagType] ?? f.flagType} on ${f.tree.name} (${f.tree.code}): ${f.reporters} of ${CONFIRM_THRESHOLD} people with photos`;
const text = [
  `Tree Detective: the last ${days} days on campus`,
  `${d.recentCount} new community reports.`,
  '',
  `Confirmed problems (${d.confirmed.length}):`, ...d.confirmed.map((f) => `- ${flagLine(f)}`),
  '',
  `Possible problems (${d.possible.length}):`, ...d.possible.map((f) => `- ${flagLine(f)}`),
  '',
  `Full map, photos and CSV: ${site}/grounds.html`,
].join('\n');
const html = `<div style="font-family:system-ui,sans-serif;max-width:620px">
<h2 style="margin:0 0 4px">Tree Detective: the last ${days} days on campus</h2>
<p style="color:#555;margin:0 0 16px">${d.recentCount} new community reports.</p>
<h3 style="color:#b3261e">Confirmed problems (${d.confirmed.length})</h3>
<ul>${d.confirmed.map((f) => `<li>${esc(flagLine(f))}</li>`).join('') || '<li>None this week.</li>'}</ul>
<h3 style="color:#a86200">Possible problems (${d.possible.length})</h3>
<ul>${d.possible.map((f) => `<li>${esc(flagLine(f))}</li>`).join('') || '<li>None.</li>'}</ul>
<p><a href="${esc(site)}/grounds.html">Open the full map, photos and CSV</a></p>
<p style="color:#888;font-size:12px">Reports come from people playing Tree Detective. A problem is confirmed once ${CONFIRM_THRESHOLD} different people report it with photos.</p>
</div>`;

const { ACS_CONNECTION_STRING: conn, DIGEST_FROM: from, DIGEST_TO: to } = process.env;
if (conn && from && to) {
  const { EmailClient } = await import('@azure/communication-email');
  const poller = await new EmailClient(conn).beginSend({
    senderAddress: from,
    content: { subject: `Tree Detective weekly: ${d.confirmed.length} confirmed, ${d.possible.length} possible`, plainText: text, html },
    recipients: { to: to.split(',').map((address) => ({ address: address.trim() })) },
  });
  const result = await poller.pollUntilDone();
  console.log(`Digest email: ${result.status}`);
} else {
  const out = path.join(ROOT, 'print', 'digest.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`${text}\n\nNo ACS email settings, so wrote ${path.relative(ROOT, out)} instead.`);
}
