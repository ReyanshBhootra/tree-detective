import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { JsonStore } from '../server/lib/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-'));
const env = { PUBLIC_URL: 'https://td.example', PHOTON_API_KEY: 'secret-key', REPORT_SALT: 's', UPLOAD_DIR: path.join(tmp, 'up') };
const trees = [
  { code: 'TD-001', name: 'Old Oakley', persona: 'elder', lat: 40.742, lng: -74.179, story: 'Hi.', label: 'Fact', timelapse: [] },
  { code: 'TD-002', name: 'Whisper', persona: 'gossip', lat: 40.7425, lng: -74.178, story: 'Hey.', label: 'Fact', timelapse: [] },
];
let vision = async () => ({ available: true, speciesGuess: 'Pin Oak', confidence: 0.77, alternatives: [], suggestedFlag: null });
let askedWith = null;
const app = createApp({
  env, trees, personas: [{ id: 'elder', name: 'The Elder', style: 'Slow.' }], store: new JsonStore(path.join(tmp, 'data')),
  photos: { kind: 'local', dir: env.UPLOAD_DIR, save: async (name) => `/uploads/${name}` },
  vision: (b) => vision(b),
  askEnabled: true,
  askModel: async (messages) => { askedWith = messages; return 'I remember the old well. That is all I know.'; },
  facts: () => ({ label: 'Fact', facts: [{ text: 'A well stood here.', sourceUrl: 'https://src' }] }),
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = (method, url, body, headers = {}) =>
  fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

const P1 = 'player-one-0001';

test('visiting a tree pays out once and never stores location', async () => {
  let r = await json('POST', '/api/visits', { playerId: P1, treeCode: 'td-001', locationVerified: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.firstVisit, true);
  assert.equal(r.body.totalPoints, 10);
  assert.equal(r.body.next.code, 'TD-002');
  r = await json('POST', '/api/visits', { playerId: P1, treeCode: 'TD-001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pointsEarned, 0);
  assert.equal(r.body.totalPoints, 10);
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'visits.json'), 'utf8'));
  const row = Object.values(stored)[0];
  assert.equal(row.locationVerified, 'yes');
  assert.ok(!('lat' in row) && !('lng' in row));
});

test('bad input is rejected', async () => {
  assert.equal((await json('POST', '/api/visits', { playerId: 'x', treeCode: 'TD-001' })).status, 400);
  assert.equal((await json('POST', '/api/visits', { playerId: P1, treeCode: 'NOPE' })).status, 404);
  assert.equal((await json('GET', '/api/nothing')).status, 404);
});

async function report(playerId, flagType, withPhoto = false, season = '') {
  const form = new FormData();
  form.append('playerId', playerId);
  form.append('flagType', flagType);
  if (season) form.append('season', season);
  if (withPhoto) form.append('photo', new Blob([Buffer.from('fakejpeg')], { type: 'image/jpeg' }), 'tree.jpg');
  const r = await fetch(`${base}/api/trees/TD-002/reports`, { method: 'POST', body: form });
  return { status: r.status, body: await r.json() };
}

test('photo report gets a species guess with confidence', async () => {
  const r = await report(P1, 'none', true);
  assert.equal(r.status, 201);
  assert.equal(r.body.species.guess, 'Pin Oak');
  assert.equal(r.body.species.confidence, 0.77);
  assert.equal(r.body.flag, null);
  assert.ok(!('reporterHash' in r.body.report));
  const fb = await json('POST', `/api/trees/TD-002/reports/${r.body.report.id}/feedback`, { playerId: P1, feedback: 'agree' });
  assert.equal(fb.status, 200);
  const other = await json('POST', `/api/trees/TD-002/reports/${r.body.report.id}/feedback`, { playerId: 'someone-else-01', feedback: 'agree' });
  assert.equal(other.status, 403);
});

test('pest flag flips to confirmed at 5 independent reporters', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await report('repeat-reporter', 'pest', true)).body.flag.reporters, 1);
  for (let i = 2; i <= 4; i++) {
    const r = await report(`reporter-000${i}`, 'pest', true);
    assert.equal(r.body.flag.status, 'possible');
    assert.equal(r.body.flag.reporters, i);
    assert.match(r.body.pestReport.url, /nj\.gov\/agriculture/);
  }
  const noPhoto = await report('reporter-nophoto', 'pest');
  assert.equal(noPhoto.body.flag.status, 'possible', 'a report without a photo never confirms');
  assert.equal(noPhoto.body.flag.withoutPhoto, 1);

  const key = { 'x-photon-key': 'secret-key' };
  assert.deepEqual((await json('GET', '/api/photon/alerts', null, key)).body, []);
  const r = await report('reporter-0005', 'pest', true);
  assert.equal(r.body.flag.status, 'confirmed');
  assert.equal(r.body.report.status, 'confirmed');
  await report('reporter-0006', 'pest', true); // more reports don't queue a second alert
  const alerts = (await json('GET', '/api/photon/alerts', null, key)).body;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'TD-002-pest');
  assert.equal(alerts[0].treeName, 'Whisper');
  assert.equal(alerts[0].mapUrl, 'https://td.example/grounds.html');
  await json('POST', '/api/photon/alerts/TD-002-pest/sent', {}, key);
  assert.deepEqual((await json('GET', '/api/photon/alerts', null, key)).body, [], 'sent alerts are not repeated');

  const health = await json('GET', '/api/health');
  const t = health.body.trees.find((x) => x.code === 'TD-002');
  assert.equal(t.flags.pest.status, 'confirmed');
  assert.equal(t.species[0].name, 'Pin Oak');
  assert.equal(t.species[0].agreed, 1);

  const csv = await (await fetch(`${base}/api/reports.csv`)).text();
  assert.match(csv.split('\n')[0], /^treeCode,timestamp,flagType/);
  assert.equal(csv.trim().split('\n').length, 1 + 10);
  assert.ok(!csv.includes('reporter'), 'no reporter ids in the export');
  assert.match(csv, /https:\/\/td\.example\/uploads\//);
});

test('a vision-spotted problem starts as possible', async () => {
  vision = async () => ({ available: true, speciesGuess: 'Elm', confidence: 0.5, suggestedFlag: 'damage' });
  const r = await report('vision-person-1', 'none', true);
  assert.equal(r.body.report.flagType, 'damage');
  assert.equal(r.body.report.flagSource, 'vision');
  assert.equal(r.body.flag.status, 'possible');
});

test('a broken species service never loses the report', async () => {
  vision = async () => { throw new Error('boom'); };
  const r = await report('vision-person-2', 'dying', true);
  assert.equal(r.status, 201);
  assert.equal(r.body.species, null);
  assert.equal(r.body.flag.flagType, 'dying');
});

test('an empty report is refused', async () => {
  assert.equal((await report(P1, 'none')).status, 400);
  assert.equal((await report(P1, 'sparkly')).status, 400);
  assert.equal((await report(P1, 'none', false, 'winter')).status, 400);
});

test('a season sighting on its own is a valid report and shows on the tree', async () => {
  const r = await report(P1, 'none', false, 'color-change');
  assert.equal(r.status, 201);
  assert.equal(r.body.report.season, 'color-change');
  const status = await json('GET', '/api/trees/TD-002/status');
  assert.equal(status.body.season.season, 'color-change');
  assert.equal(status.body.flags.pest.status, 'confirmed');
  const me = await json('GET', `/api/players/${P1}`);
  assert.equal(me.body.seasonsLogged, 1);
  assert.equal(me.body.reportsSent, 1);
});

test('asking a tree: only after waking it, answer comes from the model', async () => {
  assert.equal((await json('POST', '/api/trees/TD-002/ask', { playerId: P1, question: 'what was here?' })).status, 403);
  const r = await json('POST', '/api/trees/TD-001/ask', { playerId: P1, question: 'what was here?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, 'I remember the old well. That is all I know.');
  assert.equal(r.body.audio, null);
  assert.match(askedWith[0].content, /A well stood here/);
  assert.match(askedWith[0].content, /The Elder/);
  assert.equal((await json('POST', '/api/trees/TD-001/ask', { playerId: P1, question: '?' })).status, 400);
});

test('Photon: link a code, answer questions, manage nudges', async () => {
  const key = { 'x-photon-key': 'secret-key' };
  assert.equal((await json('GET', '/api/photon/links')).status, 401);
  assert.equal((await json('GET', '/api/photon/links', null, { 'x-photon-key': 'wrong-key!' })).status, 401);

  const { body: { code } } = await json('POST', '/api/link-codes', { playerId: P1 });
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  const linked = await json('POST', '/api/photon/link', { code: code.toLowerCase(), senderId: '+15550001111', spaceId: 'sp1' }, key);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.totalPoints, 10);
  assert.equal((await json('POST', '/api/photon/link', { code, senderId: '+1555' }, key)).status, 404, 'codes are single use');

  const me = await json('GET', '/api/photon/players/%2B15550001111', null, key);
  assert.equal(me.body.visited[0].name, 'Old Oakley');
  assert.equal(me.body.routeUrl, 'https://td.example/?route=1');

  let links = await json('GET', '/api/photon/links', null, key);
  assert.equal(links.body[0].nudges, true);
  await json('POST', '/api/photon/links/%2B15550001111/prefs', { nudges: false }, key);
  await json('POST', '/api/photon/links/%2B15550001111/nudged', {}, key);
  links = await json('GET', '/api/photon/links', null, key);
  assert.equal(links.body[0].nudges, false);
  assert.ok(links.body[0].lastNudgedAt);
});

test('static site and config are served', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>Tree Detective<\/title>/);
  const cfg = await json('GET', '/api/config');
  assert.equal(cfg.body.confirmThreshold, 5);
  assert.equal(cfg.body.features.speciesVision, false);
  assert.equal(cfg.body.features.ask, true);
  assert.equal(cfg.body.historic.layer, 'BlackWhite1930');
});

test('signed tags: links without the right key don\'t wake trees', async () => {
  const { treeKey } = await import('../server/lib/qr.js');
  const signed = createApp({
    env: { ...env, QR_SECRET: 'tag-secret' }, trees, personas: [],
    store: new JsonStore(path.join(tmp, 'signed')), photos: { kind: 'x', save: async () => '' },
  });
  const srv = signed.listen(0);
  const url = `http://127.0.0.1:${srv.address().port}/api/visits`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  try {
    assert.equal(await post({ playerId: P1, treeCode: 'TD-001' }), 403);
    assert.equal(await post({ playerId: P1, treeCode: 'TD-001', treeKey: 'AAAAAA' }), 403);
    assert.equal(await post({ playerId: P1, treeCode: 'TD-001', treeKey: treeKey('TD-002', 'tag-secret') }), 403);
    assert.equal(await post({ playerId: P1, treeCode: 'TD-001', treeKey: treeKey('TD-001', 'tag-secret') }), 201);
  } finally {
    srv.close();
  }
});
