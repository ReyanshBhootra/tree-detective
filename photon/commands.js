// Pure text logic for the Photon companion: no network, easy to test.
// Replies stay short and plain, since they land in someone's iMessage thread.

export const LINK_CODE = /^\s*([A-HJ-NP-Z2-9]{6})\s*$/i;

export function parse(input) {
  const text = String(input ?? '').trim();
  const lower = text.toLowerCase();
  const code = text.match(LINK_CODE);
  if (code) return { intent: 'link', code: code[1].toUpperCase() };
  if (/^(stop|unsubscribe|quiet|mute)\b/.test(lower)) return { intent: 'nudges-off' };
  if (/^(start|resume|unmute)\b/.test(lower)) return { intent: 'nudges-on' };
  const story = lower.match(/(?:story|tell me about|tell me)\s+(?:of\s+|about\s+)?(.+?)(?:'s story)?[?.!]*$/);
  if (story && !/^(me|a story|story)$/.test(story[1])) return { intent: 'story', query: story[1].replace(/^the\s+/, '') };
  if (/\b(point|score)s?\b/.test(lower)) return { intent: 'points' };
  if (/\b(route|path|map|walk)\b/.test(lower)) return { intent: 'route' };
  if (/\b(next|find|should i|where)\b/.test(lower)) return { intent: 'next' };
  if (/\b(visited|met|my trees|which trees|seen)\b/.test(lower)) return { intent: 'visited' };
  return { intent: 'help' };
}

export const HELP =
  'Tree Detective here. Text me: "points", "visited", "next", "route", or "story <tree name>". ' +
  'Text "stop" to pause reminders. Not linked yet? Open the website, tap "Text me", and send the 6-letter code.';

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
        : 'You haven\'t woken any trees yet. Scan a tree\'s QR code to start.';
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
