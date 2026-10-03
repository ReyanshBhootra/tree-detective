import crypto from 'node:crypto';

// Each printed tag carries a short key made from the tree code and a server
// secret, so typing ?tree=TD-002 at home doesn't wake a tree you never visited.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const KEY_LENGTH = 6;

export function treeKey(code, secret) {
  const mac = crypto.createHmac('sha256', secret).update(code.toUpperCase()).digest();
  let out = '';
  for (let i = 0; i < KEY_LENGTH; i++) out += ALPHABET[mac[i] % ALPHABET.length];
  return out;
}

export function verifyTreeKey(code, key, secret) {
  if (!secret) return true; // signing off (local dev)
  const want = Buffer.from(treeKey(code, secret));
  const got = Buffer.from(String(key ?? '').toUpperCase());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function treeLink(base, code, secret) {
  const url = `${base.replace(/\/+$/, '')}/?tree=${encodeURIComponent(code)}`;
  return secret ? `${url}&k=${treeKey(code, secret)}` : url;
}

// What's printed under the QR for typing in by hand.
export function typedCode(code, secret) {
  return secret ? `${code}-${treeKey(code, secret)}` : code;
}
