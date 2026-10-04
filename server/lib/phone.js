// Phone numbers as iMessage sees them (+15551234567), or an Apple ID email.
export function normalizePhone(input) {
  const s = String(input ?? '').trim().replace(/^(tel|sms|imessage):/i, '');
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return s.toLowerCase();
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (s.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

export function samePhone(a, b) {
  const x = normalizePhone(a);
  return Boolean(x) && x === normalizePhone(b);
}

export function maskPhone(p) {
  if (!p) return '';
  return p.includes('@') ? p.replace(/^(.).*(@.*)$/, '$1•••$2') : `•••• ${p.slice(-4)}`;
}
