// Log in with iMessage, adopting trees, trees texting first, quests and voice memories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { JsonStore } from '../server/lib/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-social-'));
const env = { PHOTON_API_KEY: 'bot-key-123', PHOTON_PROJECT_ID: 'p', PHOTON_PROJECT_SECRET: 's', REPORT_SALT: 's', UPLOAD_DIR: path.join(tmp, 'up') };
const trees = [
  { code: 'TD-001', name: 'Old Oakley', persona: 'elder', lat: 40.742, lng: -74.179, story: 'Hi.', label: 'Fact', timelapse: [] },
  { code: 'TD-002', name: 'Whisper', persona: 'gossip', lat: 40.7425, lng: -74.178, story: 'Hey.', label: 'Fact', timelapse: [] },
];
// A fake clock in the past (10am in Newark): real report times always come after it.
let clock = new Date('2026-01-05T15:00:00Z');
let wx = { tempF: 91, summary: 'Sunny' };
let questOk = true;
const treeTextPrompts = [];
const app = createApp({
  env, trees, personas: [{ id: 'elder', name: 'The Elder', texting: 'Grandparent texts.' }, { id: 'gossip', name: 'The Gossip' }],
  store: new JsonStore(path.join(tmp, 'data')),
  photos: { kind: 'local', dir: env.UPLOAD_DIR, save: async (name) => `/uploads/${name}` },
  vision: async () => ({ available: false }),
  askEnabled: true,
  askModel: async (messages) => { treeTextPrompts.push(messages); return 'Hello from your tree!'; },
  facts: () => null,
  weather: async () => wx,
  timeline: async () => ({ stops: [] }),
  questCheck: async () => ({ match: questOk, confidence: 0.9, reason: questOk ? 'Gorgeous reds!' : 'No red leaves there.' }),
  listen: async () => ({ transcript: 'I studied under this tree all finals week.', safe: true }),
  social: { now: () => clock, convert: { toM4a: async (b) => b, toMp3: async (b) => b } },
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const call = (method, url, body, bot = false) => fetch(base + url, {
  method, headers: { 'content-type': 'application/json', ...(bot ? { 'x-photon-key': env.PHOTON_API_KEY } : {}) },
  body: body && JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const form = (url, fields, file) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append(file.field, new Blob([file.data], { type: file.type }), file.name);
  return fetch(base + url, { method: 'POST', body: f }).then(async (r) => ({ status: r.status, body: await r.json() }));
};

const WEB = 'browser-player-0001';
const PHONE = '+14155550101';

test('log in with iMessage: website asks, phone says yes, progress is kept', async () => {
  await call('POST', '/api/visits', { playerId: WEB, treeCode: 'TD-001' });
  let r = await call('POST', '/api/login', { playerId: WEB, phone: '(415) 555-0101' });
  assert.equal(r.status, 201);
  const id = r.body.loginId;
  assert.equal(r.body.phone, '•••• 0101');
  assert.equal((await call('GET', `/api/login/${id}`)).body.status, 'pending');
  // the bot picks it up and texts the phone
  const pending = (await call('GET', '/api/photon/logins', null, true)).body;
  assert.deepEqual(pending.map((p) => p.phone), [PHONE]);
  await call('POST', `/api/photon/logins/${id}/sent`, {}, true);
  // someone else's YES does nothing
  assert.equal((await call('POST', '/api/photon/logins/confirm', { senderId: '+19995550000' }, true)).status, 404);
  r = await call('POST', '/api/photon/logins/confirm', { senderId: PHONE, spaceId: 'sp' }, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.playerId, WEB);
  assert.equal(r.body.totalPoints, 10);
  r = await call('GET', `/api/login/${id}`);
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.playerId, WEB);
  r = await call('GET', `/api/players/${WEB}/account`);
  assert.deepEqual(r.body, { loggedIn: true, phone: '•••• 0101', adopted: null });
});

test('logging in on a second browser merges its trees into the phone', async () => {
  const other = 'browser-player-0002';
  await call('POST', '/api/visits', { playerId: other, treeCode: 'TD-002' });
  const { loginId } = (await call('POST', '/api/login', { playerId: other, phone: PHONE })).body;
  await call('POST', `/api/photon/logins/${loginId}/sent`, {}, true);
  const r = await call('POST', '/api/photon/logins/confirm', { senderId: PHONE }, true);
  assert.equal(r.body.playerId, WEB);
  assert.equal(r.body.totalPoints, 20, 'both trees, counted once');
});

test('adopt a tree, and it texts you first', async () => {
  assert.equal((await call('POST', '/api/trees/TD-001/adopt', { playerId: 'nobody-logged-in-1' })).status, 403);
  let r = await call('POST', '/api/trees/TD-001/adopt', { playerId: WEB });
  assert.equal(r.status, 200);
  assert.equal(r.body.adopters, 1);
  let texts = (await call('GET', '/api/photon/tree-texts', null, true)).body;
  assert.equal(texts.length, 1);
  assert.equal(texts[0].reason, 'adopted');
  assert.equal(texts[0].senderId, PHONE);
  assert.match(treeTextPrompts.at(-1)[0].content, /Grandparent texts\./);
  // nothing new: weather is hot, so the tree mentions it once that day
  texts = (await call('GET', '/api/photon/tree-texts', null, true)).body;
  assert.equal(texts[0]?.reason, 'hot');
  assert.equal((await call('GET', '/api/photon/tree-texts', null, true)).body.length, 0, 'only once a day');
  // someone else reports pests: the adopter hears about it
  clock = new Date(clock.getTime() + 60_000);
  await form('/api/trees/TD-001/reports', { playerId: 'stranger-player-1', flagType: 'pest' });
  clock = new Date(clock.getTime() + 60_000);
  texts = (await call('GET', '/api/photon/tree-texts', null, true)).body;
  assert.equal(texts[0]?.reason, 'problem');
  assert.match(treeTextPrompts.at(-1)[1].content, /reported pests/);
});

test('no texts at night', async () => {
  clock = new Date('2026-01-06T08:00:00Z'); // 3am in Newark
  wx = { tempF: 20, summary: 'Clear' };
  assert.equal((await call('GET', '/api/photon/tree-texts', null, true)).body.length, 0);
  clock = new Date('2026-01-06T15:00:00Z');
});

test('photo quests are checked, pay once, and fill the tree album', async () => {
  const quests = (await call('GET', `/api/quests?playerId=${WEB}`)).body;
  assert.ok(quests.some((q) => q.id === 'bark-detective' && !q.done));
  questOk = false;
  let r = await form('/api/quests/bark-detective', { playerId: WEB }, { field: 'photo', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), type: 'image/jpeg', name: 'a.jpg' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /No red leaves/);
  questOk = true;
  r = await form('/api/quests/bark-detective', { playerId: WEB, treeCode: 'TD-001' }, { field: 'photo', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), type: 'image/jpeg', name: 'a.jpg' });
  assert.equal(r.status, 201);
  assert.equal(r.body.points, 10);
  assert.equal(r.body.totalPoints, 30);
  r = await form('/api/quests/bark-detective', { playerId: WEB }, { field: 'photo', data: Buffer.from([0xff, 0xd8]), type: 'image/jpeg', name: 'a.jpg' });
  assert.equal(r.status, 409);
  assert.ok((await call('GET', `/api/quests?playerId=${WEB}`)).body.find((q) => q.id === 'bark-detective').done);
  const social = (await call('GET', `/api/trees/TD-001/social?playerId=${WEB}`)).body;
  assert.equal(social.adoptedByMe, true);
  assert.equal(social.album[0].quest, 'bark-detective');
});

test('voice memories are transcribed, saved, and played to the next visitor', async () => {
  const audio = { field: 'audio', data: Buffer.from('fake audio'), type: 'audio/webm', name: 'm.webm' };
  assert.equal((await form('/api/trees/TD-002/memories', { playerId: 'stranger-player-1' }, audio)).status, 403);
  const r = await form('/api/trees/TD-001/memories', { playerId: WEB, name: 'Rey' }, audio);
  assert.equal(r.status, 201);
  assert.match(r.body.text, /finals week/);
  const notes = (await call('GET', '/api/trees/TD-001/notes')).body;
  assert.ok(notes[0].audioUrl.endsWith('.m4a'));
  // the person who left it doesn't get their own memory back; someone else does
  assert.equal((await call('GET', `/api/photon/trees/TD-001/memory?senderId=${encodeURIComponent(PHONE)}`, null, true)).status, 404);
  const m = (await call('GET', '/api/photon/trees/TD-001/memory?senderId=%2B19990001111', null, true)).body;
  assert.match(m.text, /finals week/);
});
