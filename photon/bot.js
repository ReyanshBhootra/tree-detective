// The Tree Detective iMessage bot. Everything works from iMessage alone:
// wake trees by sending a photo of their QR tag, hear their stories as voice
// notes, ask them questions, report problems with photos, switch language.
// Pure logic around an `api` function, so it can be tested without Photon.
import {
  parse, reply, findTree, storyText, LANG_WORDS,
  HELP, MORE, WELCOME, NO_TAG, NOT_LINKED, wakeText, askTip, reportText, signed,
} from './commands.js';

import { locationFromText } from '../server/lib/geocode.js';

const LOCATION_FRESH_MS = 45 * 60 * 1000;
const LANG_NAMES = { en: 'English', es: 'Español', zh: '中文', hi: 'हिन्दी', gu: 'ગુજરાતી' };
const REPORT_WINDOW_MS = 10 * 60 * 1000;

export const say = (text) => ({ type: 'text', text });
export const sound = (buffer, mimeType = 'audio/mpeg', name = 'Tree Detective') => ({ type: 'voice', buffer, mimeType, name });
export const file = (buffer, mimeType, name) => ({ type: 'file', buffer, mimeType, name });
// One iMessage made of a text plus voice notes or photos, so they arrive together.
export const together = (...items) => ({ type: 'group', items: items.filter(Boolean) });

// api(path, { method, body, form, raw }) -> { ok, status, json, buffer }
// readTag(buffer, mime) -> { code, key } | null
export function createBot({ api, readTag, publicUrl = '' }) {
  const pending = new Map(); // senderId -> { flag, until } waiting for a problem photo
  const history = new Map(); // senderId:tree -> last questions and answers
  const questMenus = new Map(); // senderId -> { list, until } after "quest"
  const questPending = new Map(); // senderId -> { quest, until } waiting for the photo
  const places = new Map(); // senderId -> { lat, lng, label, at } where they last said they were
  const askedWhere = new Map(); // senderId -> until, after we asked "where are you?"
  let trees = [];
  let personas = [];

  async function loadTrees() {
    const [r, p] = await Promise.all([api('/api/trees'), api('/api/personas')]);
    if (r.ok) trees = r.json;
    if (p.ok) personas = p.json;
    return trees;
  }
  const personaOf = (tree) => personas.find((p) => p.id === tree?.persona);
  const treeByCode = (code) => trees.find((t) => t.code === code);

  async function start(senderId, spaceId) {
    const r = await api(`/api/photon/players/${encodeURIComponent(senderId)}/start`, { method: 'POST', body: { spaceId } });
    if (!r.ok) throw new Error(`could not start player: ${r.status}`);
    return r.json;
  }
  const prefs = (senderId, body) => api(`/api/photon/links/${encodeURIComponent(senderId)}/prefs`, { method: 'POST', body });

  async function storyIn(tree, lang) {
    if (lang === 'en') return tree.story;
    const r = await api(`/api/trees/${tree.code}/story/${lang}`);
    return (r.ok && r.json.story) || tree.story;
  }

  async function storyVoice(tree, lang) {
    const r = await api(`/api/trees/${tree.code}/audio/${lang}`, { raw: true });
    if (r.ok && r.buffer?.length) return sound(r.buffer, r.mimeType || 'audio/mpeg', `${tree.name}'s story`);
    if (lang !== 'en') return storyVoice(tree, 'en');
    return null;
  }

  async function tellStory(tree, me) {
    const [text, v] = await Promise.all([storyIn(tree, me.lang), storyVoice(tree, me.lang)]);
    return [together(say(storyText(tree, personaOf(tree), text, { withVoice: Boolean(v) })), v)];
  }

  // The tree's spot through time: real aerial photo, drawn eras, real photo today.
  async function pictures(tree) {
    const eras = (tree.timelapse ?? []).filter((e) => e.imageUrl && (e.era !== 'today' || !tree.referencePhoto));
    // Oldest first; real photos are marked with a camera.
    const picks = eras.slice(0, 4).sort((a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999));
    if (tree.referencePhoto) picks.push({ year: 'Today', imageUrl: tree.referencePhoto, real: true });
    if (!picks.length) return [say(signed(tree, personaOf(tree), 'My pictures are still being painted. Ask me something instead!'))];
    const files = (await Promise.all(picks.map(async (e, i) => {
      const r = await api(e.imageUrl, { raw: true });
      if (!r.ok || !r.buffer?.length) return null;
      const ext = (r.mimeType ?? '').includes('png') ? 'png' : 'jpg';
      return file(r.buffer, r.mimeType || 'image/jpeg', `${tree.name} ${e.year ?? i}.${ext}`);
    })));
    const line = picks.map((e) => `${e.year}${e.real ? ' 📷' : ''}`).join(' → ');
    const note = picks.some((e) => e.real) && picks.some((e) => !e.real) ? '\n📷 = real photo, the rest are AI paintings' : '';
    return [together(say(signed(tree, personaOf(tree), `My spot through time 📸\n${line}${note}`)), ...files)];
  }

  async function wake(me, senderId, code, key) {
    let tree = treeByCode(code);
    if (!tree) tree = (await loadTrees()).find((t) => t.code === code);
    if (!tree) return [say(`I don't know a tree called ${code}. Check the code on the tag.`)];
    const r = await api('/api/visits', { method: 'POST', body: { playerId: me.playerId, treeCode: tree.code, treeKey: key } });
    if (r.status === 403) return [say('That code doesn\'t match the tag on the tree. Send me a photo of the QR code instead.')];
    if (!r.ok) return [say('The grove is a little sleepy right now. Try again in a minute.')];
    // Say "you woke it" right away; the story and voice note follow.
    const woke = say(wakeText(tree, r.json));
    // (wake line, then story + voice as one message, then one line on what to do next)
    const early = me.emit ? (await me.emit(woke), []) : [woke];
    await prefs(senderId, { currentTree: tree.code });
    me.currentTree = tree.code;
    if (!me.visited?.some((v) => v.code === tree.code)) me.visited = [...(me.visited ?? []), { code: tree.code, name: tree.name }];
    return [...early, ...(await tellStory(tree, me)), say(askTip(tree)), ...(await memoryAt(tree, senderId))];
  }

  async function ask(me, senderId, question) {
    // Only talk as a tree this player has actually woken.
    const awake = (c) => me.visited?.some((v) => v.code === c);
    let code = awake(me.currentTree) ? me.currentTree : me.visited?.at(-1)?.code;
    if (!code) return [say(HELP)];
    const tree = treeByCode(code);
    if (!tree) return [say(HELP)];
    const key = `${senderId}:${code}`;
    const past = history.get(key) ?? [];
    const r = await api(`/api/trees/${code}/ask`, {
      method: 'POST', body: { playerId: me.playerId, question, lang: me.lang, history: past, channel: 'text' },
    });
    if (r.status === 503) return [say('Trees can\'t answer questions on this server yet. Text "story" to hear my story instead.')];
    if (r.status === 403) return [say(HELP)];
    if (!r.ok) return [say(r.json?.error ?? 'I didn\'t catch that. Try asking again.')];
    history.set(key, [...past, { q: question, a: r.json.answer }].slice(-3));
    let v = null;
    if (r.json.audio?.startsWith('data:')) {
      const [head, b64] = r.json.audio.split(',');
      v = sound(Buffer.from(b64, 'base64'), head.match(/data:([^;]+)/)?.[1] ?? 'audio/mpeg', tree.name);
    }
    return [together(say(signed(tree, personaOf(tree), r.json.answer)), v)];
  }

  async function report(me, senderId, photo) {
    const code = me.currentTree;
    const tree = code && treeByCode(code);
    if (!tree) return [say(NO_TAG)];
    const wait = pending.get(senderId);
    const flag = wait && wait.until > Date.now() ? wait.flag : 'none';
    pending.delete(senderId);
    const form = new FormData();
    form.append('playerId', me.playerId);
    form.append('flagType', flag);
    form.append('photo', new Blob([photo.buffer], { type: photo.mimeType }), photo.name || 'tree.jpg');
    const r = await api(`/api/trees/${code}/reports`, { method: 'POST', form });
    if (!r.ok) return [say(r.json?.error ?? 'That photo didn\'t go through. Try again in a bit.')];
    return [say(reportText(tree, r.json))];
  }

  // The newest voice memory someone else left here, played after the story.
  async function memoryAt(tree, senderId) {
    const m = await api(`/api/photon/trees/${tree.code}/memory?senderId=${encodeURIComponent(senderId)}`);
    if (!m.ok) return [];
    const a = await api(m.json.audioUrl, { raw: true });
    const words = m.json.text && m.json.text !== 'A voice memory' ? `\n"${m.json.text}"` : '';
    return [together(say(`🎙️ Someone left a memory here${m.json.name ? ` (${m.json.name})` : ''}:${words}`), a.ok && a.buffer?.length ? sound(a.buffer, 'audio/mp4', 'Memory') : null)];
  }

  async function adoptTree(me, senderId, query) {
    const code = query ? findTree(trees, query)?.code : me.currentTree;
    const tree = code && treeByCode(code);
    if (!tree) return [say(query ? `I couldn't find a tree called "${query}".` : 'Wake a tree first, then text "adopt" to adopt it 💚')];
    if (!me.visited?.some((v) => v.code === tree.code)) return [say(`${tree.name} is still asleep. Wake it first, then you can adopt it.`)];
    const r = await api(`/api/photon/links/${encodeURIComponent(senderId)}/adopt`, { method: 'POST', body: { code: tree.code } });
    if (!r.ok) return [say('Adopting didn\'t work right now. Try again in a minute.')];
    me.currentTree = tree.code;
    return [
      say(`💚 You adopted ${tree.name}! It'll text you when it needs you, like on a scorching day or if someone spots a problem.`),
      say(signed(tree, personaOf(tree), r.json.text)),
    ];
  }

  async function questList(me, senderId) {
    const r = await api(`/api/quests?playerId=${encodeURIComponent(me.playerId)}`);
    const list = r.ok ? r.json : [];
    if (!list.length) return [say('No photo quests right now. Check back soon!')];
    const open = list.filter((q) => !q.done);
    if (!open.length) return [say('🏆 You finished every photo quest this season! New ones come with the next season.')];
    questMenus.set(senderId, { list: open, until: Date.now() + REPORT_WINDOW_MS });
    const lines = open.map((q, i) => `${i + 1}. ${q.emoji} ${q.title} (+${q.points})`);
    return [say(`📸 Photo quests\n${lines.join('\n')}\n\nReply with a number to start one.`)];
  }

  function pickQuest(senderId, n) {
    const menu = questMenus.get(senderId);
    const quest = menu && menu.until > Date.now() ? menu.list[n - 1] : null;
    if (!quest) return null;
    questMenus.delete(senderId);
    questPending.set(senderId, { quest, until: Date.now() + REPORT_WINDOW_MS });
    return [say(`${quest.emoji} ${quest.title}!\n${quest.hint} Send me the photo.`)];
  }

  async function questPhoto(me, senderId, photo, quest) {
    const form = new FormData();
    form.append('playerId', me.playerId);
    if (me.currentTree) form.append('treeCode', me.currentTree);
    form.append('photo', new Blob([photo.buffer], { type: photo.mimeType }), photo.name || 'quest.jpg');
    const r = await api(`/api/quests/${quest.id}`, { method: 'POST', form });
    if (r.status === 409) return [say(r.json.error)];
    if (!r.ok) return [say(r.json?.error ?? 'That photo didn\'t go through. Try again?')];
    if (!r.json.ok) return [say(`Hmm, not quite. ${r.json.reason}\nTry another photo!`)];
    questPending.delete(senderId);
    return [say(`🎉 Quest done: ${quest.emoji} ${quest.title}! +${r.json.points} pts\n${r.json.reason}\nYou have ${r.json.totalPoints} points. Text "quest" for another.`)];
  }

  async function onVoice(me, senderId, clip) {
    const tree = treeByCode(me.currentTree);
    if (!tree) return [say('Wake a tree first, then send a voice note to leave a memory there 🎙️')];
    if (!clip.buffer?.length) return [say('I couldn\'t open that voice note. Try again?')];
    const form = new FormData();
    form.append('playerId', me.playerId);
    form.append('audio', new Blob([clip.buffer], { type: clip.mimeType || 'audio/x-caf' }), clip.name || 'memory.caf');
    const r = await api(`/api/trees/${tree.code}/memories`, { method: 'POST', form });
    if (!r.ok) return [say(r.json?.error ?? 'I couldn\'t save that memory. Try again?')];
    return [say(`🎙️ Saved at ${tree.name}! The next person who wakes it will hear your memory.`)];
  }

  // ---------- routes from where you actually are ----------

  const WHERE = '📍 Where are you? Share your location (tap + then Location), or text a building, address or ZIP code.';

  async function routeReply(me, senderId, place) {
    const r = await api(`/api/photon/route?senderId=${encodeURIComponent(senderId)}&lat=${place.lat}&lng=${place.lng}`);
    if (!r.ok) return [say('I couldn\'t plan a route right now. Try again in a minute.')];
    const stops = r.json.stops;
    if (!stops.length) return [say(`You've woken every tree, all ${trees.length}. The grove thanks you 🌳`)];
    const far = r.json.metersFromCampus > 3000;
    const lines = stops.slice(0, 5).map((t, i) => `${i + 1}. ${personaOf(treeByCode(t.code))?.emoji ?? '🌳'} ${t.name} · ${t.meters} m · ${t.minutes} min`);
    const head = far
      ? `🧭 You're about ${(r.json.metersFromCampus / 1000).toFixed(1)} km from campus. Here's the order to go in:`
      : `🧭 Your route from ${place.label ?? 'where you are'}:`;
    return [say(`${head}\n${lines.join('\n')}\n\n👣 Walk to ${stops[0].name}: ${stops[0].walk}`)];
  }

  async function routeOrAsk(me, senderId) {
    const place = places.get(senderId);
    if (place && Date.now() - place.at < LOCATION_FRESH_MS) return routeReply(me, senderId, place);
    askedWhere.set(senderId, Date.now() + REPORT_WINDOW_MS);
    return [say(WHERE)];
  }

  async function gotPlace(me, senderId, place) {
    askedWhere.delete(senderId);
    places.set(senderId, { ...place, at: Date.now() });
    return routeReply(me, senderId, place);
  }

  async function onPhoto(me, senderId, photo) {
    const tag = await readTag(photo.buffer, photo.mimeType);
    if (tag) return wake(me, senderId, tag.code, tag.key);
    const q = questPending.get(senderId);
    if (q && q.until > Date.now()) return questPhoto(me, senderId, photo, q.quest);
    if (me.currentTree) return report(me, senderId, photo);
    return [say(NO_TAG)];
  }

  async function onText(me, senderId, text) {
    const shared = locationFromText(text);
    if (shared) return gotPlace(me, senderId, { ...shared, label: 'your pin' });
    let intent = parse(text);
    if (intent.intent === 'link') {
      const r = await api('/api/photon/link', { method: 'POST', body: { code: intent.code, senderId, spaceId: me.spaceId } });
      if (r.ok) return [say(`Linked to your website progress! You have ${r.json.totalPoints} points so far. Text "help" any time.`)];
      // Six-letter words like "thanks" look like link codes; treat them as normal texts.
      if (/\d/.test(intent.code)) return [say('That code didn\'t work. Codes last 30 minutes, so grab a fresh one from the website.')];
      intent = { intent: 'chat', text };
    }
    switch (intent.intent) {
      case 'wake':
        return wake(me, senderId, intent.code, intent.key);
      case 'yes': {
        const r = await api('/api/photon/logins/confirm', { method: 'POST', body: { senderId, spaceId: me.spaceId } });
        if (r.ok) return [say(`✅ You're logged in on the website! ${r.json.totalPoints} points and ${r.json.visited.length} trees, synced with this chat.`)];
        return ask(me, senderId, text);
      }
      case 'adopt':
        return adoptTree(me, senderId, intent.query);
      case 'quests':
        return questList(me, senderId);
      case 'pick':
        return pickQuest(senderId, intent.n) ?? ask(me, senderId, text);
      case 'nudges-off':
      case 'nudges-on': {
        const on = intent.intent === 'nudges-on';
        await prefs(senderId, { nudges: on });
        return [say(on ? 'Reminders are on. I\'ll let you know when trees are waiting.' : 'Okay, no more reminders. Text "start" to turn them back on.')];
      }
      case 'lang':
        await prefs(senderId, { lang: intent.lang });
        me.lang = intent.lang;
        return [say(`Okay! The trees will talk to you in ${LANG_NAMES[intent.lang]} now. Text "english" to switch back.`)];
      case 'report': {
        if (!me.currentTree) return [say('Which tree? Send a photo of its tag first, or text "talk to <tree name>".')];
        pending.set(senderId, { flag: intent.flag, until: Date.now() + REPORT_WINDOW_MS });
        const tree = treeByCode(me.currentTree);
        return [say(`Got it. Send me a photo of ${tree?.name ?? 'the tree'}${intent.flag === 'none' ? '' : ' showing the problem'} and I'll pass it to the grounds team.`)];
      }
      case 'talk': {
        const tree = findTree(trees, intent.query);
        if (!tree) return ask(me, senderId, text);
        if (!me.visited?.some((v) => v.code === tree.code)) {
          return [say(`${tree.name} is still asleep. Find its tag and send me a photo to wake it.`)];
        }
        await prefs(senderId, { currentTree: tree.code });
        me.currentTree = tree.code;
        return [say(`${tree.name} is listening. ${askTip(tree)}`)];
      }
      case 'story': {
        const tree = intent.query ? findTree(trees, intent.query) : treeByCode(me.currentTree);
        if (!tree) return intent.query && me.currentTree ? ask(me, senderId, text) : [say(reply(intent.query ? intent : { intent: 'help' }, me, trees))];
        return tellStory(tree, me);
      }
      case 'pictures': {
        const code = me.visited?.some((v) => v.code === me.currentTree) ? me.currentTree : me.visited?.at(-1)?.code;
        const tree = code && treeByCode(code);
        if (!tree) return [say('Wake a tree first and it\'ll show you its pictures. Send me a photo of a QR tag!')];
        return pictures(tree);
      }
      case 'map':
        return [say(publicUrl
          ? `Your map, with your trees awake: ${publicUrl}/?player=${encodeURIComponent(me.playerId)}`
          : 'The map lives on the Tree Detective website. Ask the team for the link!')];
      case 'next':
      case 'route':
        return routeOrAsk(me, senderId);
      case 'points':
      case 'visited':
        return [say(reply(intent, me, trees))];
      case 'help': {
        const t = me.visited?.some((v) => v.code === me.currentTree) && treeByCode(me.currentTree);
        // "Hi Whisper!!" gets a hello from Whisper itself, not a menu.
        if (t && !/^(help|\?)/i.test(text.trim())) return ask(me, senderId, text);
        return [say(t ? `${t.name} is listening. Ask it anything, or text "more".` : HELP)];
      }
      case 'more':
        return [say(MORE)];
      default: {
        // Right after "where are you?", a short answer is a place, not a question.
        if ((askedWhere.get(senderId) ?? 0) > Date.now() && !/\?$/.test(text.trim()) && text.length <= 80) {
          const r = await api(`/api/photon/geocode?q=${encodeURIComponent(text)}`);
          if (r.ok) return gotPlace(me, senderId, { lat: r.json.lat, lng: r.json.lng, label: r.json.label });
          return [say('I couldn\'t find that place. Try a building name like "Campus Center", an address, or share your location 📍')];
        }
        return ask(me, senderId, text);
      }
    }
  }

  // content: { type: 'text', text } | { type: 'image', buffer, mimeType, name } | { type: 'voice' }
  // emit(part), if given, sends a part straight away instead of waiting for the rest.
  async function handle({ senderId, spaceId, contents, emit }) {
    if (!trees.length) await loadTrees();
    const me = { ...(await start(senderId, spaceId)), spaceId, emit };
    // A tree this player hasn't woken (say, after linking a fresh website player) is never "current".
    if (!me.visited?.some((v) => v.code === me.currentTree)) me.currentTree = me.visited?.at(-1)?.code ?? null;
    const out = [];
    const firstIsCode = contents.some((c) => c.type === 'text' && /^(link|wake)$/.test(parse(c.text).intent));
    if (me.isNew && !firstIsCode) out.push(say(WELCOME));
    // Text first ("report pest" + photo in one message), then photos.
    for (const c of contents.filter((x) => x.type === 'text')) {
      if (me.isNew && parse(c.text).intent === 'help') continue; // the welcome already explains
      out.push(...(await onText(me, senderId, c.text)));
    }
    for (const c of contents.filter((x) => x.type === 'location')) out.push(...(await gotPlace(me, senderId, { lat: c.lat, lng: c.lng, label: 'your location' })));
    for (const c of contents.filter((x) => x.type === 'image')) out.push(...(await onPhoto(me, senderId, c)));
    for (const c of contents.filter((x) => x.type === 'voice')) out.push(...(await onVoice(me, senderId, c)));
    return out;
  }

  // Signs a text a tree sends on its own (adopted-tree texts).
  const sign = (code, text) => {
    const tree = treeByCode(code);
    return tree ? signed(tree, personaOf(tree), text) : text;
  };

  return { handle, loadTrees, sign };
}

export { LANG_WORDS, NOT_LINKED };
