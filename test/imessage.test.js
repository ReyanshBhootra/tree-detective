// The iMessage bot end to end: a real API server and a pretend phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createApp } from '../server/app.js';
import { JsonStore } from '../server/lib/store.js';
import { treeLink, typedCode } from '../server/lib/qr.js';
import { readTag } from '../server/lib/qrread.js';
import { createBot } from '../photon/bot.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-im-'));
const env = { PUBLIC_URL: 'https://td.example', PHOTON_API_KEY: 'bot-key-123', REPORT_SALT: 's', QR_SECRET: 'tag-secret', UPLOAD_DIR: path.join(tmp, 'up') };
const trees = [
  { code: 'TD-001', name: 'Old Oakley', persona: 'elder', lat: 40.742, lng: -74.179, story: 'Well now. I stand by a castle. It was an orphanage once.', label: 'Fact', verified: true, questions: ['Why do you look like a castle?'],
    timelapse: [{ era: 'aerial-1930', year: 1930, imageUrl: '/historic/TD-001-1930.jpg', real: true }, { era: '1857', year: 1857, imageUrl: '/timelapse/TD-001-2-1857.png', caption: 'A new castle.' }] },
  { code: 'TD-002', name: 'Whisper', persona: 'gossip', lat: 40.7425, lng: -74.178, story: 'Psst. Come closer.', label: 'Fact', verified: true, timelapse: [] },
];
const asked = [];
const app = createApp({
  env, trees, personas: [{ id: 'elder', name: 'The Elder', emoji: '🌳', texting: 'Texts like a grandparent, signs off ~ O.' }, { id: 'gossip', name: 'The Gossip' }],
  store: new JsonStore(path.join(tmp, 'data')),
  photos: { kind: 'local', dir: env.UPLOAD_DIR, save: async (name) => `/uploads/${name}` },
  vision: async () => ({ available: true, speciesGuess: 'Pin oak', confidence: 0.81, alternatives: [], suggestedFlag: null }),
  askEnabled: true,
  askModel: async (messages) => { asked.push(messages); return 'The castle was built in 1857.'; },
  facts: () => null,
  weather: async () => null,
  timeline: async () => ({ stops: [] }),
  translator: async (text, langs) => Object.fromEntries(langs.map((l) => [l, `[${l}] ${text}`])),
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function api(p, { method = 'GET', body, form, raw } = {}) {
  const headers = { 'x-photon-key': env.PHOTON_API_KEY };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  if (raw) return { status: res.status, ok: res.ok, buffer: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
  return { status: res.status, ok: res.ok, json: await res.json().catch(() => ({})) };
}

// A phone photo: the QR tag small in a bigger, slightly grey scene, saved as JPEG.
async function tagPhoto(code) {
  const qr = PNG.sync.read(await QRCode.toBuffer(treeLink('https://td.example', code, env.QR_SECRET), { width: 360, margin: 2 }));
  const W = 1600, H = 1200, data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const g = 150 + ((i * 7919) % 60); data.writeUInt32BE(((g << 24) | (g << 16) | (g << 8) | 255) >>> 0, i * 4); }
  for (let y = 0; y < qr.height; y++) for (let x = 0; x < qr.width; x++) {
    const s = (y * qr.width + x) * 4, d = ((y + 500) * W + (x + 700)) * 4;
    data[d] = qr.data[s]; data[d + 1] = qr.data[s + 1]; data[d + 2] = qr.data[s + 2]; data[d + 3] = 255;
  }
  return jpeg.encode({ data, width: W, height: H }, 85).data;
}

const bot = createBot({ api, readTag: (b, m) => readTag(b, m), publicUrl: 'https://td.example' });
const flat = (parts) => parts.flatMap((p) => (p.type === 'group' ? p.items : [p]));
const texts = (parts) => flat(parts).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const PHONE = '+15551234567';
const send = (...contents) => bot.handle({ senderId: PHONE, spaceId: 'sp1', contents });

test('a brand-new texter gets a welcome, no website needed', async () => {
  const out = await send({ type: 'text', text: 'hi' });
  assert.equal(out.length, 1, 'one short message, not a wall of text');
  assert.match(texts(out), /^Hi! I'm Tree Detective/);
  assert.match(texts(out), /photo of a tree's QR tag/);
  assert.match(texts(await send({ type: 'text', text: 'more' })), /"points" or "next"/);
});

test('a photo of the QR tag wakes the tree and it starts talking', async () => {
  const out = await send({ type: 'image', buffer: await tagPhoto('TD-001'), mimeType: 'image/jpeg' });
  const t = texts(out);
  assert.match(t, /You woke Old Oakley! \+10 points\. 1 of 2/);
  assert.match(t, /I stand by a castle/);
  assert.match(t, /Why do you look like a castle\?/);
});

test('then any text is a question for that tree, with memory', async () => {
  let out = await send({ type: 'text', text: 'Why do you look like a castle?' });
  assert.match(texts(out), /^🌳 Old Oakley\nThe castle was built in 1857\./);
  out = await send({ type: 'text', text: 'who built it?' });
  const last = asked.at(-1);
  assert.equal(last.at(-1).content, 'who built it?');
  assert.ok(last.some((m) => m.role === 'assistant'), 'remembers the last answer');
});

test('report a problem, then a photo goes to the grounds team', async () => {
  let out = await send({ type: 'text', text: 'report pest' });
  assert.match(texts(out), /Send me a photo of Old Oakley showing the problem/);
  out = await send({ type: 'image', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' });
  assert.match(texts(out), /went to the grounds team.*Pin oak \(81% sure\).*possible pests/);
});

test('typed tag codes, points, language and talk-to', async () => {
  let out = await send({ type: 'text', text: 'TD-002-WRONG1' });
  assert.match(texts(out), /doesn't match/);
  out = await send({ type: 'text', text: typedCode('TD-002', env.QR_SECRET) });
  assert.match(texts(out), /You woke Whisper/);
  out = await send({ type: 'text', text: 'points' });
  assert.equal(texts(out), 'You have 20 points from 2 of 2 trees.');
  out = await send({ type: 'text', text: 'spanish' });
  assert.match(texts(out), /Español/);
  out = await send({ type: 'text', text: 'talk to old oakley' });
  assert.match(texts(out), /Old Oakley is listening/);
  out = await send({ type: 'text', text: 'story' });
  assert.match(texts(out), /\[es\] Well now/);
  out = await send({ type: 'text', text: 'map' });
  assert.match(texts(out), /td\.example\/\?player=imsg-/);
  out = await send({ type: 'text', text: 'thanks' }); // a six-letter word, not a link code
  assert.match(texts(out), /^🌳 Old Oakley\n/);
});

test('a photo with no tag and no tree yet gets a helpful answer', async () => {
  const other = await bot.handle({ senderId: '+15550000000', spaceId: 'sp2', contents: [{ type: 'image', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }] });
  assert.match(texts(other), /can't see a tag/);
});

test('a tilted photo of the tag on a screen, with glare, still wakes the tree fast', async () => {
  const { readTag: rt } = await import('../server/lib/qrread.js');
  const qr = PNG.sync.read(await QRCode.toBuffer(treeLink('https://td.example', 'TD-002', env.QR_SECRET), { width: 700, margin: 2 }));
  const W = 1512, H = 2016, data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - 750, dy = y - 1000;
    const sx = Math.round(Math.cos(0.12) * dx + Math.sin(0.12) * dy + qr.width / 2);
    const sy = Math.round(-Math.sin(0.12) * dx + Math.cos(0.12) * dy + qr.height / 2);
    let v = sx >= 0 && sy >= 0 && sx < qr.width && sy < qr.height ? (qr.data[(sy * qr.width + sx) * 4] ? 225 : 40) : 30;
    if (y % 4 === 0) v *= 0.82;
    const g = Math.max(0, 1 - Math.hypot(x - 930, y - 750) / 210);
    v += (255 - v) * g * 0.85;
    const d = (y * W + x) * 4; data[d] = data[d + 1] = data[d + 2] = Math.min(255, v); data[d + 3] = 255;
  }
  const t = Date.now();
  const tag = await rt(jpeg.encode({ data, width: W, height: H }, 80).data, 'image/jpeg');
  assert.equal(tag?.code, 'TD-002');
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('the "you woke it" message goes out before the story is ready', async () => {
  const early = [];
  const out = await bot.handle({ senderId: '+15559990000', spaceId: 'sp3', contents: [{ type: 'text', text: typedCode('TD-001', env.QR_SECRET) }], emit: (p) => early.push(p) });
  assert.match(early[0].text, /You woke Old Oakley/);
  assert.doesNotMatch(texts(out), /You woke/);
  assert.match(texts(out), /castle/);
});

test('trees text in their own style and can send their pictures', async () => {
  await send({ type: 'text', text: 'talk to old oakley' });
  await send({ type: 'text', text: 'how old are you?' });
  const sys = asked.at(-1)[0].content;
  assert.match(sys, /texting this person in iMessage/);
  assert.match(sys, /signs off ~ O\./);
  const out = await send({ type: 'text', text: 'I am bored can I see some pictures' });
  const items = flat(out);
  const photos = items.filter((p) => p.type === 'file');
  assert.equal(photos.length, 2);
  assert.ok(photos.every((p) => p.buffer.length > 1000));
  assert.match(texts(out), /c\. 1930 \(real photo\)/);
  assert.equal(out.length, 1, 'text and photos arrive as one message');
});
