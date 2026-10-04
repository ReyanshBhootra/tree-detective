// Photon companion: a small always-on Node service (fine on Azure App Service).
// It reads iMessages through Photon's Spectrum SDK, answers from the Tree
// Detective API, and sends a gentle "go explore" nudge to linked players.
//
//   npm run photon              run the chat loop + daily nudges
//   npm run photon:nudge        send any due nudges once and exit
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../server/config.js';
import { nudgeText, dueForNudge, alertText } from './commands.js';
import { createBot } from './bot.js';
import { readTag } from '../server/lib/qrread.js';
import { geminiReadTag } from '../server/lib/gemini.js';
import { locationFromText } from '../server/lib/geocode.js';

loadEnv();
const API = (process.env.API_BASE || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const KEY = process.env.PHOTON_API_KEY;
const INTERVAL_H = Number(process.env.NUDGE_INTERVAL_HOURS || 24);

async function api(path, { method = 'GET', body, form, raw } = {}) {
  const headers = { 'x-photon-key': KEY };
  if (body) headers['content-type'] = 'application/json';
  // Photos and memories in Azure Blob have full URLs; everything else lives on the API.
  const url = /^https?:\/\//.test(path) ? path : `${API}${path}`;
  const res = await fetch(url, { method, headers: url.startsWith(API) ? headers : {}, body: form ?? (body ? JSON.stringify(body) : undefined) });
  if (raw) {
    return { status: res.status, ok: res.ok, buffer: res.ok ? Buffer.from(await res.arrayBuffer()) : null, mimeType: res.headers.get('content-type') };
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

// QR first, then Gemini reads the printed code if the QR is blurry.
const readText = process.env.GEMINI_API_KEY ? (buf, mime) => geminiReadTag(process.env, buf, mime) : null;
const bot = createBot({
  api,
  readTag: (buf, mime) => readTag(buf, mime, { readText }),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
});

// Turns a Photon message into the plain pieces the bot understands.
async function contentsOf(content) {
  if (!content) return [];
  if (content.type === 'group') return (await Promise.all(content.items.map((m) => contentsOf(m.content)))).flat();
  if (content.type === 'text') return [{ type: 'text', text: content.text }];
  // A shared location arrives as a contact card (.loc.vcf) with a map link inside.
  if (content.type === 'contact' || (content.type === 'attachment' && /vcard|\.vcf$/i.test(`${content.mimeType} ${content.name}`))) {
    let raw = JSON.stringify(content);
    if (content.type === 'attachment') raw = (await content.read().catch(() => Buffer.from(''))).toString('utf8');
    const loc = locationFromText(raw);
    return loc ? [{ type: 'location', ...loc }] : [];
  }
  if (content.type === 'attachment' && /^image\//.test(content.mimeType ?? '')) {
    return [{ type: 'image', buffer: await content.read(), mimeType: content.mimeType, name: content.name }];
  }
  if (content.type === 'voice' || (content.type === 'attachment' && /^audio\//.test(content.mimeType ?? ''))) {
    const buffer = await content.read().catch(() => null);
    return [{ type: 'voice', buffer, mimeType: content.mimeType, name: content.name }];
  }
  return [];
}

function build(p, { text, voice, attachment }) {
  if (p.type === 'text') return text(p.text);
  if (p.type === 'voice') {
    // Photon turns this into a real iMessage voice bubble (needs ffmpeg-static).
    const ext = p.mimeType.includes('wav') ? 'wav' : 'mp3';
    return voice(p.buffer, { mimeType: p.mimeType, name: `${p.name}.${ext}` });
  }
  if (p.type === 'file') return attachment(p.buffer, { mimeType: p.mimeType, name: p.name });
  return null;
}

async function sendOne(space, p, content) {
  try {
    await space.send(build(p, content));
  } catch (e) {
    if (p.type !== 'voice') throw e;
    // No converter available: send the audio as a normal file instead.
    await space.send(content.attachment(p.buffer, { mimeType: p.mimeType, name: `${p.name}.mp3` }));
  }
}

async function sendAll(space, parts, content) {
  for (const p of parts) {
    if (p.type !== 'group') {
      await sendOne(space, p, content);
      continue;
    }
    const items = p.items.filter(Boolean);
    if (items.length === 1) {
      await sendOne(space, items[0], content);
      continue;
    }
    try {
      await space.send(content.group(...items.map((i) => build(i, content))));
    } catch (e) {
      console.warn('sending as one message failed, sending one by one:', e.message);
      for (const i of items) await sendOne(space, i, content);
    }
  }
}

async function sendNudges(spectrum, imessage, text) {
  const links = await api('/api/photon/links');
  if (!links.ok) throw new Error(`could not list links: ${links.status}`);
  const config = await (await fetch(`${API}/api/config`)).json();
  let sent = 0;
  for (const link of links.json) {
    if (!dueForNudge(link, Date.now(), INTERVAL_H)) continue;
    const msg = nudgeText(link.summary, config.pointsPerTree);
    if (!msg) continue;
    try {
      const im = imessage(spectrum);
      const space = link.spaceId ? await im.space.get(link.spaceId) : await im.space.create(link.senderId);
      await space.send(text(msg));
      await api(`/api/photon/links/${encodeURIComponent(link.senderId)}/nudged`, { method: 'POST' });
      sent++;
    } catch (e) {
      console.warn(`nudge to ${link.senderId} failed:`, e.message);
    }
  }
  console.log(`explore nudges sent: ${sent}`);
}

// Grounds team numbers or iMessage addresses, comma separated.
const GROUNDS = (process.env.GROUNDS_ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

async function sendAlerts(spectrum, imessage, text) {
  if (!GROUNDS.length) return;
  const r = await api('/api/photon/alerts');
  if (!r.ok) throw new Error(`could not list alerts: ${r.status}`);
  if (!r.json.length) return;
  const config = await (await fetch(`${API}/api/config`)).json();
  const im = imessage(spectrum);
  for (const alert of r.json) {
    const msg = alertText(alert, config.pestReport?.hotline);
    let delivered = 0;
    for (const to of GROUNDS) {
      try {
        await (await im.space.create(to)).send(text(msg));
        delivered++;
      } catch (e) {
        console.warn(`alert to ${to} failed:`, e.message);
      }
    }
    if (delivered) await api(`/api/photon/alerts/${encodeURIComponent(alert.id)}/sent`, { method: 'POST' });
    console.log(`grounds alert ${alert.id}: sent to ${delivered}/${GROUNDS.length}`);
  }
}

// Started by "npm start" (inside the website's process), or on its own with "npm run photon".
export async function startPhoton({ standalone = false } = {}) {
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) {
    throw new Error('Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET (from app.photon.codes) first.');
  }
  if (!KEY) throw new Error('Set PHOTON_API_KEY in .env (any random phrase).');
  if (standalone && !process.argv.includes('--nudge-now')) {
    const running = await fetch(`${API}/api/config`).then((r) => r.json()).then((c) => c.features?.photonInApp).catch(() => false);
    if (running) {
      console.log('The iMessage bot is already running inside "npm start". Nothing else to do!');
      return;
    }
  }
  const { Spectrum, text, voice, attachment, group } = await import('spectrum-ts');
  const { imessage } = await import('spectrum-ts/providers/imessage');
  console.log('Connecting to Photon…');
  const spectrum = await Spectrum({
    projectId: process.env.PHOTON_PROJECT_ID,
    projectSecret: process.env.PHOTON_PROJECT_SECRET,
    providers: [imessage.config()],
  });

  if (process.argv.includes('--nudge-now')) {
    await sendNudges(spectrum, imessage, text);
    await spectrum.stop();
    return;
  }

  try {
    await bot.loadTrees();
  } catch {
    throw new Error(`Can't reach the app at ${API}. Start it with "npm start".`);
  }
  setInterval(() => sendNudges(spectrum, imessage, text).catch((e) => console.warn(e.message)), 60 * 60 * 1000);
  // Confirmed problems go out within a minute.
  setInterval(() => sendAlerts(spectrum, imessage, text).catch((e) => console.warn(e.message)), 60 * 1000);
  // "Log in with iMessage": text people who asked to log in on the website.
  let loginBusy = false;
  setInterval(async () => {
    if (loginBusy) return;
    loginBusy = true;
    try {
      const r = await api('/api/photon/logins');
      for (const l of r.ok ? r.json : []) {
        try {
          const space = await imessage(spectrum).space.create(l.phone);
          await space.send(text('🌳 Tree Detective: someone is logging in on the website with your number. Was that you? Reply YES to log in.'));
          await api(`/api/photon/logins/${l.id}/sent`, { method: 'POST' });
        } catch (e) {
          console.warn(`login text to ${l.phone} failed:`, e.message);
        }
      }
    } finally {
      loginBusy = false;
    }
  }, 3000);
  // Adopted trees text their person first.
  setInterval(async () => {
    try {
      const r = await api('/api/photon/tree-texts');
      for (const t of r.ok ? r.json : []) {
        try {
          const im = imessage(spectrum);
          const space = t.spaceId ? await im.space.get(t.spaceId) : await im.space.create(t.senderId);
          await space.send(text(bot.sign(t.code, t.text)));
          console.log(`tree text (${t.reason}) sent for ${t.code}`);
        } catch (e) {
          console.warn('tree text failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('tree texts:', e.message);
    }
  }, 30 * 1000);
  if (GROUNDS.length) console.log(`Grounds alerts go to ${GROUNDS.length} contact(s).`);
  console.log('Photon companion listening for iMessages.');

  for await (const [space, message] of spectrum.messages) {
    if (message.direction !== 'inbound' || !message.sender) continue;
    // Handle each message on its own so one slow photo never blocks everyone else.
    (async () => {
      try {
        const contents = await contentsOf(message.content);
        if (!contents.length) return;
        await space.responding(async () => {
          const content = { text, voice, attachment, group };
          const emit = (part) => sendAll(space, [part], content);
          const parts = await bot.handle({ senderId: message.sender.id, spaceId: space.id, contents, emit });
          await sendAll(space, parts, content);
        });
      } catch (e) {
        console.warn('reply failed:', e.message);
        await space.send(text('The grove is a little sleepy right now. Try again in a minute.')).catch(() => {});
      }
    })();
  }
}

// Run only when started directly (works on Windows paths too).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPhoton({ standalone: true }).catch((e) => {
    console.error('Photon companion stopped:', e.message);
    process.exit(1);
  });
}
