// Pure text logic for the Photon companion: no network, easy to test.
// Replies stay short and plain, since they land in someone's iMessage thread.

export const LINK_CODE = /^\s*([A-HJ-NP-Z2-9]{6})\s*$/i;

// Language names people might text, in English and in the language itself.
export const LANG_WORDS = {
  en: ['english', 'inglés', 'ingles'],
  es: ['spanish', 'español', 'espanol'],
  zh: ['chinese', 'mandarin', '中文', '汉语', '普通话'],
  hi: ['hindi', 'हिन्दी', 'हिंदी'],
  gu: ['gujarati', 'ગુજરાતી'],
};

const TAG_CODE = /^\s*([A-Z]{1,4}-\d{1,4})(?:[-\s]+([A-Z0-9]{4,12}))?\s*$/i;
const FLAGS = [['pest', /pest|bug|insect|lanternfly|beetle/], ['damage', /damage|broken|branch|limb|crack|split|hurt/], ['dying', /dying|dead|sick|bare/]];

export function parse(input) {
  const text = String(input ?? '').trim();
  const lower = text.toLowerCase();
  const code = text.match(LINK_CODE);
  if (code) return { intent: 'link', code: code[1].toUpperCase(), text };
  const tag = text.match(TAG_CODE);
  if (tag) return { intent: 'wake', code: tag[1].toUpperCase(), key: tag[2]?.toUpperCase() ?? null };
  if (/^(yes|yep|yeah|yup|ya|y|yess+|confirm|it was me|that was me|si|sí|haan|ha)[!. ]*$/.test(lower)) return { intent: 'yes', text };
  const adopt = lower.match(/^(?:i(?:'ll| will| want to)? )?adopt(?: (?:this tree|the tree|me|you|this|it))?(?: (.+?))?[!.?]*$/);
  if (adopt) return { intent: 'adopt', query: adopt[1]?.replace(/^the\s+/, '') ?? null };
  if (/^(quests?|challenges?|missions?|games?|play)\b/.test(lower)) return { intent: 'quests' };
  if (/^[1-9]$/.test(lower)) return { intent: 'pick', n: Number(lower) };
  if (/^(stop|unsubscribe|quiet|mute)\b/.test(lower)) return { intent: 'nudges-off' };
  if (/^(start|resume|unmute)\b/.test(lower)) return { intent: 'nudges-on' };
  for (const [lang, words] of Object.entries(LANG_WORDS)) {
    const named = words.some((w) => lower === w || lower === `in ${w}` || new RegExp(`^(language|lang|speak|talk in|switch to)\\s+${w}$`).test(lower));
    if (named) return { intent: 'lang', lang };
  }
  if (/^(report|flag)\b/.test(lower)) {
    const flag = FLAGS.find(([, re]) => re.test(lower))?.[0] ?? 'none';
    return { intent: 'report', flag };
  }
  const talk = lower.match(/^(?:talk to|switch to|chat with|go to)\s+(.+?)[?.!]*$/);
  if (talk) return { intent: 'talk', query: talk[1].replace(/^the\s+/, '') };
  const story = lower.match(/(?:story|tell me about|tell me)\s+(?:of\s+|about\s+)?(.+?)(?:'s story)?[?.!]*$/);
  if (story && !/^(me|a story|story|your story|me your story|me a story)$/.test(story[1])) return { intent: 'story', query: story[1].replace(/^the\s+/, '') };
  if (/^(story|your story|tell me (a |your )?story)[?.!]*$/.test(lower)) return { intent: 'story', query: null };
  if (/\b(pictures?|photos?|pics?|images?|time ?lapse|then and now|what did (it|this|you) look like)\b/.test(lower)) return { intent: 'pictures' };
  if (/\b(point|score)s?\b/.test(lower)) return { intent: 'points' };
  if (/^(map|website|site|link)\b/.test(lower)) return { intent: 'map' };
  if (/\b(route|path|walk)\b/.test(lower)) return { intent: 'route' };
  // Kept narrow so questions for a tree ("where did you come from?") reach the tree.
  if (/^next\b|\bnext tree\b|\bshould i (find|go|visit)\b|\bwhere (should|do) i go\b/.test(lower)) return { intent: 'next' };
  if (/\b(visited|my trees|which trees|my book|badges?)\b|^book$/.test(lower)) return { intent: 'visited' };
  if (/^(more|menu|commands|options|what else|what can you do)\b/.test(lower)) return { intent: 'more' };
  if (/^(help|h+i+|hey+|hello+|heyo|yo+|sup|hola|namaste|good (morning|afternoon|evening))\b/.test(lower) || lower === '?') return { intent: 'help' };
  return { intent: 'chat', text };
}

// Short on purpose: one next step at a time. "more" shows the rest.
export const HELP =
  'Send me a photo of a tree\'s QR tag to wake it up 🌳 Text "more" to see what else I can do.';

export const MORE =
  'You can text me:\n' +
  '• a question for the tree you\'re with\n' +
  '• "pictures" to see the tree\'s spot through time\n' +
  '• "adopt" so your tree texts you 💚\n' +
  '• "quest" for photo challenges 📸\n' +
  '• a voice note to leave a memory at the tree 🎙️\n' +
  '• "points" or "next"\n' +
  '• "report", then a photo of a sick tree\n' +
  '• "spanish", "hindi", "gujarati", "chinese" or "english"';

export const WELCOME =
  'Hi! I\'m Tree Detective 🌳 The trees on campus are asleep. Send me a photo of a tree\'s QR tag to wake one up.';

export const NO_TAG =
  'Hmm, I can\'t see a tag in that photo. Try again up close, so the QR code fills the picture.';

export function wakeText(tree, result) {
  const n = result.visited?.length ?? 0;
  return result.firstVisit
    ? `✨ You woke ${tree.name}! +${result.pointsEarned} pts · ${n}/${result.totalTrees} trees awake`
    : `${tree.name} is already awake and happy to see you again. ${n} of ${result.totalTrees} trees awake.`;
}

export function askTip(tree) {
  const q = tree.questions?.[0];
  return `💬 ${q ? `Ask me anything, like "${q}"` : 'Ask me anything'}\n📸 "pictures"  ·  💚 "adopt"`;
}

// How a tree signs its texts, so you always know who's talking.
export function signed(tree, persona, text) {
  return `${persona?.emoji ?? '🌳'} ${tree.name}\n${text}`;
}

const FLAG_WORDS = { pest: 'pests', damage: 'damage', dying: 'a dying tree' };

export function reportText(tree, r) {
  const parts = [`Thanks! Your photo of ${tree.name} went to the grounds team.`];
  if (r.species?.guess) parts.push(`Looks like ${r.species.guess} (${Math.round((r.species.confidence ?? 0) * 100)}% sure).`);
  if (r.flag) {
    parts.push(r.flag.status === 'confirmed'
      ? `That makes ${r.flag.reporters} reports of ${FLAG_WORDS[r.flag.flagType] ?? r.flag.flagType}, so it's now confirmed and the grounds team gets a text.`
      : `Flagged as possible ${FLAG_WORDS[r.flag.flagType] ?? r.flag.flagType} (${r.flag.reporters} of ${r.flag.threshold ?? 5} reports needed to confirm).`);
  } else if (r.photoCheck) {
    parts.push(`Heads up: the photo check thinks it might show ${FLAG_WORDS[r.photoCheck.flag] ?? r.photoCheck.flag}.`);
  }
  if (r.rescueBonus) parts.push(`+${r.rescueBonus} rescue bonus for checking on a tree that needed help!`);
  if (r.pestReport?.hotline) parts.push(`Spotted lanternfly? NJ also takes reports at ${r.pestReport.hotline}.`);
  return parts.join(' ');
}


export const NOT_LINKED =
  'I don\'t know which explorer you are yet. Open the Tree Detective site, tap "Text me", and send me the 6-letter code you see.';

// The story as a text: a two-sentence teaser, then where to hear the rest and
// a short source. The voice note that comes with it tells the whole thing.
export function storyText(tree, persona, story, { withVoice = true } = {}) {
  const sentences = story.match(/[^.!?]+[.!?]+["')]?/g) ?? [story];
  let teaser = '';
  for (const s of sentences) {
    if (teaser && (teaser + s).length > 230) break;
    teaser += s;
    if (teaser.length > 120 && sentences.indexOf(s) >= 1) break;
  }
  teaser = teaser.trim();
  const more = teaser.length < story.trim().length;
  const lines = [`${persona?.emoji ?? '🌳'} ${tree.name}`, teaser];
  const extra = [];
  if (more) extra.push(withVoice ? '🎧 Play the voice note for the full story' : '…text "story" again any time');
  let host = null;
  try { host = tree.sourceUrl ? new URL(tree.sourceUrl).hostname.replace(/^www\./, '') : null; } catch { /* not a link */ }
  if (host) extra.push(`📖 ${tree.verified ? 'Source' : 'Draft, not yet checked'}: ${host}`);
  else if (tree.label === 'Local Legend') extra.push('📖 A local legend');
  return [...lines, ...(extra.length ? ['', ...extra] : [])].join('\n');
}

export function shortStory(tree, maxChars = 320) {
  const sentences = tree.story.match(/[^.!?]+[.!?]+/g) ?? [tree.story];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > maxChars) break;
    out += s;
  }
  out = (out || tree.story.slice(0, maxChars)).trim();
  const tag = tree.verified ? tree.label : `${tree.label}, draft not yet source-checked`;
  return `${tree.name}: "${out}" (${tag}${tree.sourceUrl ? `, source: ${tree.sourceUrl}` : ''})`;
}

export function findTree(trees, query) {
  const q = query.toLowerCase().trim();
  return (
    trees.find((t) => t.code.toLowerCase() === q) ??
    trees.find((t) => t.name.toLowerCase() === q) ??
    trees.find((t) => t.name.toLowerCase().includes(q) || q.includes(t.name.toLowerCase()))
  );
}

export function reply(intent, summary, trees) {
  switch (intent.intent) {
    case 'points':
      return `You have ${summary.totalPoints} points from ${summary.visited.length} of ${summary.totalTrees} trees.`;
    case 'visited':
      return summary.visited.length
        ? `You've met ${summary.visited.length}: ${summary.visited.map((v) => v.name).join(', ')}.`
        : 'You haven\'t woken any trees yet. Send me a photo of a tree\'s QR tag to start.';
    case 'next':
      return summary.next
        ? `Go find ${summary.next.name} next. ${summary.remaining} still sleeping. Map: ${summary.routeUrl}`
        : `You've woken every tree, all ${summary.totalTrees}. The grove thanks you.`;
    case 'route':
      return summary.remaining
        ? `Your walking route through the ${summary.remaining} sleeping trees: ${summary.routeUrl}`
        : 'No sleeping trees left on your route. Every tree is awake.';
    case 'story': {
      const t = findTree(trees, intent.query);
      return t ? shortStory(t) : `I couldn't find a tree called "${intent.query}". Try one of: ${trees.map((x) => x.name).join(', ')}.`;
    }
    default:
      return HELP;
  }
}

export function nudgeText(summary, pointsPerTree = 10) {
  if (!summary.remaining) return null;
  const n = summary.remaining;
  const start = summary.next ? ` Start with ${summary.next.name}.` : '';
  return `${n} tree${n === 1 ? ' is' : 's are'} still sleeping near campus. Go meet ${n === 1 ? 'it' : 'them'} for ${n * pointsPerTree} points.${start} ${summary.routeUrl}`;
}

export function dueForNudge(link, now = Date.now(), intervalHours = 24) {
  if (!link.nudges || !link.summary?.remaining) return false;
  if (!link.lastNudgedAt) return true;
  return now - Date.parse(link.lastNudgedAt) >= intervalHours * 3600 * 1000;
}

const PROBLEM = { pest: 'pests', damage: 'damage', dying: 'a dying tree' };

// Sent to the grounds team the moment a problem is confirmed.
export function alertText(alert, pestHotline) {
  const what = PROBLEM[alert.flagType] ?? alert.flagType;
  const pin = `https://www.google.com/maps?q=${alert.lat},${alert.lng}`;
  let msg = `Tree Detective: confirmed ${what} on ${alert.treeName} (${alert.treeCode}). ` +
    `${alert.reporters} different people reported it with photos. Location: ${pin} Photos: ${alert.mapUrl}`;
  if (alert.flagType === 'pest' && pestHotline) msg += ` If it's spotted lanternfly, NJ asks for reports at ${pestHotline}.`;
  return msg;
}
