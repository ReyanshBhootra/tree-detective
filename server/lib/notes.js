// Short notes people leave for a tree, shown to the next visitors.
// Kept simple and safe: no links, no contact details, a small word filter,
// and anything flagged twice disappears.
export const NOTE_MAX = 200;
export const HIDE_AFTER_FLAGS = 2;

const BLOCKED = /\b(fuck|shit|bitch|cunt|nigg|fag|retard|whore|slut|kill yourself|kys)\w*/i;
const LINKISH = /(https?:\/\/|www\.|\.(com|net|org|io|ly|gg)\b|@\w{2,}|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)/i;

export function checkNote(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return { ok: false, error: 'Write a little something first.' };
  if (t.length > NOTE_MAX) return { ok: false, error: `Keep it under ${NOTE_MAX} characters.` };
  if (BLOCKED.test(t)) return { ok: false, error: 'Let\'s keep notes kind.' };
  if (LINKISH.test(t)) return { ok: false, error: 'No links, handles or phone numbers in notes.' };
  return { ok: true, text: t };
}

export function cleanName(name) {
  const n = String(name ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 24);
  return n && !BLOCKED.test(n) ? n : '';
}
