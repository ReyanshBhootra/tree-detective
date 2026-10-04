export * from '../server/lib/azure.js';

// Stops a script early with a plain message if its keys aren't in .env.
export function requireKeys(names, what) {
  const missing = names.filter((n) => !process.env[n]);
  if (!missing.length) return;
  console.error(`${what} needs ${missing.join(', ')} in .env. Add ${missing.length > 1 ? 'them' : 'it'} and run this again.`);
  process.exit(1);
}
