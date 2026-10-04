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
  if (/\b(point|score)s?\b/.test(lower)) return { intent: 'points' };
  if (/^(map|website|site|link)\b/.test(lower)) return { intent: 'map' };
  if (/\b(route|path|walk)\b/.test(lower)) return { intent: 'route' };
  // Kept narrow so questions for a tree ("where did you come from?") reach the tree.
  if (/^next\b|\bnext tree\b|\bshould i (find|go|visit)\b|\bwhere (should|do) i go\b/.test(lower)) return { intent: 'next' };
  if (/\b(visited|my trees|which trees|my book|badges?)\b|^book$/.test(lower)) return { intent: 'visited' };
  if (/^(help|menu|commands|options|hi|hello|hey|yo|\?)\b/.test(lower) || lower === '?') return { intent: 'help' };
  return { intent: 'chat', text };
}

export const HELP =
  'Tree Detective here 🌳 No app needed, it all works right here:\n' +
  '📷 Send a photo of a tree\'s QR tag to wake it (or type the code under the QR)\n' +
  '💬 Then just text the tree a question\n' +
  '🚩 "report pest", "report damage" or "report dying", then send a photo\n' +
  '🌍 "spanish", "chinese", "hindi", "gujarati" or "english"\n' +
  '⭐ "points", "visited", "next", "route", "story", "talk to <tree>"\n' +
  'Text "stop" to pause reminders.';

export const WELCOME =
  'Hi, explorer! I\'m Tree Detective. The trees around campus are asleep, and each one has a true story. ' +
  'Find a tree with a QR tag and send me a photo of the tag to wake it up. No app or sign-in needed.';

export const NO_TAG =
  'I couldn\'t find a tree tag in that photo. Get close so the QR code fills most of the picture, or type the code printed under it (like TD-001-AB12CD).';

export function wakeText(tree, result) {
  const n = result.visited?.length ?? 0;
  return result.firstVisit
    ? `✨ You woke ${tree.name}! +${result.pointsEarned} points. ${n} of ${result.totalTrees} trees awake.`
    : `${tree.name} is already awake and happy to see you again. ${n} of ${result.totalTrees} trees awake.`;
}

export function askTip(tree) {
  const q = tree.questions?.[0];
  return `Text me anything and ${tree.name} will answer${q ? `. Try: "${q}"` : '.'}`;
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
