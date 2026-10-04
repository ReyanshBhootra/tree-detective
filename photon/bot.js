// The Tree Detective iMessage bot. Everything works from iMessage alone:
// wake trees by sending a photo of their QR tag, hear their stories as voice
// notes, ask them questions, report problems with photos, switch language.
// Pure logic around an `api` function, so it can be tested without Photon.
import {
  parse, reply, findTree, storyText, LANG_WORDS,
  HELP, MORE, WELCOME, NO_TAG, NOT_LINKED, wakeText, askTip, reportText, signed,
} from './commands.js';

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
    const eras = (tree.timelapse ?? []).filter((e) => e.imageUrl);
    const picks = eras.filter((e) => e.era !== 'today' || !tree.referencePhoto).slice(0, 4);
    const today = tree.referencePhoto ? { year: 'Today', imageUrl: tree.referencePhoto, real: true } : null;
    if (today) picks.push(today);
    if (!picks.length) return [say(signed(tree, personaOf(tree), 'My pictures are still being painted. Ask me something instead!'))];
    const files = await Promise.all(picks.map(async (e, i) => {
      const r = await api(e.imageUrl, { raw: true });
      if (!r.ok || !r.buffer?.length) return null;
      const ext = (r.mimeType ?? '').includes('png') ? 'png' : 'jpg';
      return file(r.buffer, r.mimeType || 'image/jpeg', `${tree.name} ${e.year ?? i}.${ext}`);
    }));
    const lines = picks.map((e) => `${e.year === 'Today' ? 'Today' : `c. ${e.year}`}${e.real ? ' (real photo)' : ''}${e.caption ? `: ${e.caption}` : ''}`);
    return [together(say(signed(tree, personaOf(tree), `My spot through time 📸\n${lines.join('\n')}\n\nOld photos are real; the rest are AI paintings from historical sources.`)), ...files)];
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
    return [...early, ...(await tellStory(tree, me)), say(askTip(tree))];
  }

  async function ask(me, senderId, question) {
    let code = me.currentTree;
    if (!code && me.visited?.length) code = me.visited.at(-1).code;
    if (!code) return [say(WELCOME)];
    const tree = treeByCode(code);
    if (!tree) return [say(HELP)];
    const key = `${senderId}:${code}`;
    const past = history.get(key) ?? [];
    const r = await api(`/api/trees/${code}/ask`, {
      method: 'POST', body: { playerId: me.playerId, question, lang: me.lang, history: past, channel: 'text' },
    });
    if (r.status === 503) return [say('Trees can\'t answer questions on this server yet. Text "story" to hear my story instead.')];
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

  async function onPhoto(me, senderId, photo) {
    const tag = await readTag(photo.buffer, photo.mimeType);
    if (tag) return wake(me, senderId, tag.code, tag.key);
    if (me.currentTree) return report(me, senderId, photo);
    return [say(NO_TAG)];
  }

  async function onText(me, senderId, text) {
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
        const tree = treeByCode(me.currentTree) ?? (me.visited?.length ? treeByCode(me.visited.at(-1).code) : null);
        if (!tree) return [say('Wake a tree first and it\'ll show you its pictures. Send me a photo of a QR tag!')];
        return pictures(tree);
      }
      case 'map':
        return [say(publicUrl
          ? `Your map, with your trees awake: ${publicUrl}/?player=${encodeURIComponent(me.playerId)}`
          : 'The map lives on the Tree Detective website. Ask the team for the link!')];
      case 'points':
      case 'visited':
      case 'next':
      case 'route':
        return [say(reply(intent, me, trees))];
      case 'help':
        return [say(me.currentTree ? `${treeByCode(me.currentTree)?.name ?? 'Your tree'} is listening. Ask it anything, or text "more".` : HELP)];
      case 'more':
        return [say(MORE)];
      default:
        return ask(me, senderId, text);
    }
  }

  // content: { type: 'text', text } | { type: 'image', buffer, mimeType, name } | { type: 'voice' }
  // emit(part), if given, sends a part straight away instead of waiting for the rest.
  async function handle({ senderId, spaceId, contents, emit }) {
    if (!trees.length) await loadTrees();
    const me = { ...(await start(senderId, spaceId)), spaceId, emit };
    const out = [];
    const firstIsCode = contents.some((c) => c.type === 'text' && /^(link|wake)$/.test(parse(c.text).intent));
    if (me.isNew && !firstIsCode) out.push(say(WELCOME));
    // Text first ("report pest" + photo in one message), then photos.
    for (const c of contents.filter((x) => x.type === 'text')) {
      if (me.isNew && parse(c.text).intent === 'help') continue; // the welcome already explains
      out.push(...(await onText(me, senderId, c.text)));
    }
    for (const c of contents.filter((x) => x.type === 'image')) out.push(...(await onPhoto(me, senderId, c)));
    if (contents.some((c) => c.type === 'voice')) {
      out.push(say('I can\'t listen to voice notes yet. Type your question and the tree will answer out loud!'));
    }
    return out;
  }

  return { handle, loadTrees };
}

export { LANG_WORDS, NOT_LINKED };
