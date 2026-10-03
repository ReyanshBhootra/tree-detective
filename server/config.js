import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader so the project has no dotenv dependency.
// Real environment variables always win over the file.
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export const POINTS_PER_TREE = 10;
// How close the phone must be to the tree's saved location to count as "really there".
export const LOCATION_RADIUS_METERS = 75;
// Independent matching reports needed to flip a flag from "possible" to "confirmed".
export const CONFIRM_THRESHOLD = 5;
export const FLAG_TYPES = ['none', 'pest', 'damage', 'dying'];
// Per network address, per hour. Generous because a whole campus can share one address.
export const REPORT_LIMIT_PER_HOUR = 30;
export const ASK_LIMIT_PER_HOUR = 40;
export const SEASONS = ['buds', 'first-leaves', 'full-leaf', 'flowers-fruit', 'color-change', 'dropping', 'bare'];
export const PEST_REPORT_URL = 'https://www.nj.gov/agriculture/divisions/pi/prog/pests-diseases/spotted-lanternfly/#reporting-tool';
export const PEST_HOTLINE = '1-833-223-2840';
