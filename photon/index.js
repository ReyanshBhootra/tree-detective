// Photon companion: a small always-on Node service (fine on Azure App Service).
// It reads iMessages through Photon's Spectrum SDK, answers from the Tree
// Detective API, and sends a gentle "go explore" nudge to linked players.
//
//   npm run photon              run the chat loop + daily nudges
//   npm run photon:nudge        send any due nudges once and exit
import { loadEnv } from '../server/config.js';
import { parse, reply, nudgeText, dueForNudge, alertText, NOT_LINKED } from './commands.js';

loadEnv();
const API = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const KEY = process.env.PHOTON_API_KEY;
const INTERVAL_H = Number(process.env.NUDGE_INTERVAL_HOURS || 24);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-photon-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

export async function handleText(text, senderId, spaceId, trees) {
  const intent = parse(text);
  if (intent.intent === 'link') {
    const r = await api('/api/photon/link', { method: 'POST', body: { code: intent.code, senderId, spaceId } });
    if (!r.ok) return 'That code didn\'t work. Codes last 30 minutes, so grab a fresh one from the website.';
    return `Linked! You have ${r.json.totalPoints} points so far. Text "help" any time to see what I can do.`;
  }
  if (intent.intent === 'nudges-off' || intent.intent === 'nudges-on') {
    const r = await api(`/api/photon/links/${encodeURIComponent(senderId)}/prefs`, {
      method: 'POST', body: { nudges: intent.intent === 'nudges-on' },
    });
    if (!r.ok) return NOT_LINKED;
    return r.json.nudges ? 'Reminders are back on.' : 'Okay, no more reminders. Text "start" to turn them back on.';
  }
  if (intent.intent === 'help') return reply(intent, null, trees);
  const r = await api(`/api/photon/players/${encodeURIComponent(senderId)}`);
  if (r.status === 404) return NOT_LINKED;
  if (!r.ok) return 'The grove is a little sleepy right now. Try again in a minute.';
  return reply(intent, r.json, trees);
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

async function main() {
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) {
    console.error('Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET (from app.photon.codes) first.');
    process.exit(1);
  }
  if (!KEY) {
    console.error('Set PHOTON_API_KEY to the same value the API server uses.');
    process.exit(1);
  }
  const { Spectrum, text } = await import('spectrum-ts');
  const { imessage } = await import('spectrum-ts/providers/imessage');
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

  const trees = await (await fetch(`${API}/api/trees`)).json();
  setInterval(() => sendNudges(spectrum, imessage, text).catch((e) => console.warn(e.message)), 60 * 60 * 1000);
  // Confirmed problems go out within a minute.
  setInterval(() => sendAlerts(spectrum, imessage, text).catch((e) => console.warn(e.message)), 60 * 1000);
  if (GROUNDS.length) console.log(`Grounds alerts go to ${GROUNDS.length} contact(s).`);
  console.log('Photon companion listening for iMessages.');

  for await (const [space, message] of spectrum.messages) {
    if (message.direction !== 'inbound' || message.content?.type !== 'text' || !message.sender) continue;
    await space.responding(async () => {
      try {
        await message.reply(await handleText(message.content.text, message.sender.id, space.id, trees));
      } catch (e) {
        console.warn('reply failed:', e.message);
      }
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
