// npm run check-env            checks every .env line is filled in and looks right
// npm run check-env -- --live  also tries each key against its service
// Never prints a key or password, only ✔ / ✘ / – and what to fix,
// so the output is safe to share.
import { loadEnv } from '../server/config.js';

loadEnv();
const env = process.env;
const live = process.argv.includes('--live');
const rows = [];
const add = (status, name, note = '') => rows.push({ status, name, note });
const has = (k) => Boolean(env[k] && env[k].trim());

function check(name, keys, { optional = false, validate } = {}) {
  const missing = keys.filter((k) => !has(k));
  if (missing.length === keys.length && optional) return add('–', name, 'not set (optional)');
  if (missing.length) return add('✘', name, `missing ${missing.join(', ')}`);
  const problem = validate?.();
  if (problem) return add('✘', name, problem);
  add('✔', name);
}

const AZURE_REGION = /^[a-z]+[a-z0-9]*$/;
check('Random phrases', ['REPORT_SALT', 'QR_SECRET', 'PHOTON_API_KEY'], {
  validate: () => ['REPORT_SALT', 'PHOTON_API_KEY'].some((k) => /^change-me/.test(env[k])) ? 'still the example value, make up your own' :
    ['REPORT_SALT', 'QR_SECRET', 'PHOTON_API_KEY'].some((k) => env[k].length < 8) ? 'use at least 8 characters each' : null,
});
check('Public URL', ['PUBLIC_URL'], { validate: () => !/^https?:\/\//.test(env.PUBLIC_URL) ? 'must start with http:// or https://' : null });
check('Azure Storage', ['AZURE_STORAGE_CONNECTION_STRING'], {
  validate: () => !/AccountName=.+;AccountKey=.+/.test(env.AZURE_STORAGE_CONNECTION_STRING) ? 'doesn\'t look like a connection string (copy "Connection string", not "Key")' : null,
});
check('Azure Speech', ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], {
  optional: has('ELEVENLABS_API_KEY'),
  validate: () => !AZURE_REGION.test(env.AZURE_SPEECH_REGION) ? 'region should look like westus2 (no spaces)' : null,
});
check('Azure Translator', ['AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION'], {
  validate: () => !AZURE_REGION.test(env.AZURE_TRANSLATOR_REGION) ? 'region should look like westus2 (no spaces)' : null,
});
check('Gemini', ['GEMINI_API_KEY'], {
  validate: () => ['GEMINI_CHAT_MODEL', 'GEMINI_IMAGE_MODEL', 'GEMINI_EMBEDDING_MODEL'].some((k) => /gemini-2\.5/.test(env[k] ?? ''))
    ? 'remove the GEMINI_*_MODEL lines, Google retired those models (the app now picks current ones itself)' : null,
});
check('ElevenLabs', ['ELEVENLABS_API_KEY'], { optional: has('AZURE_SPEECH_KEY') });
check('Pl@ntNet', ['PLANTNET_API_KEY']);
check('TigerData', ['TIGER_DATABASE_URL'], {
  validate: () => !/^postgres(ql)?:\/\//.test(env.TIGER_DATABASE_URL) ? 'should start with postgres://' : null,
});
check('Azure OpenAI', ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY'], { optional: true });
check('Photon', ['PHOTON_PROJECT_ID', 'PHOTON_PROJECT_SECRET', 'PHOTON_PHONE_NUMBER'], { optional: true });
check('Grounds alert number', ['GROUNDS_ALERT_TO'], {
  optional: true,
  validate: () => env.GROUNDS_ALERT_TO.split(',').some((n) => !/^\+\d{10,15}$/.test(n.trim()) && !/@/.test(n)) ? 'use the format +12015550123' : null,
});
if (env.QR_SECRET && /localhost/.test(env.PUBLIC_URL ?? '')) add('!', 'QR tags', 'PUBLIC_URL is still localhost, set the real site address before printing tags');

async function liveChecks() {
  const t = async (name, fn) => {
    try {
      const note = await fn();
      add('✔', `${name} (live)`, note ?? '');
    } catch (e) {
      add('✘', `${name} (live)`, e.message.replace(/\s+/g, ' ').replace(/(key|secret|password)=[^&\s]+/gi, '$1=…').replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://…').slice(0, 160));
    }
  };
  const ok = async (res, what) => {
    if (!res.ok) throw new Error(`${what} said ${res.status}: ${(await res.text()).slice(0, 100)}`);
    return res;
  };
  if (has('AZURE_STORAGE_CONNECTION_STRING')) await t('Azure Storage', async () => {
    const { TableServiceClient } = await import('@azure/data-tables');
    const it = TableServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING).listTables().byPage({ maxPageSize: 1 });
    await it.next();
  });
  if (has('AZURE_SPEECH_KEY')) await t('Azure Speech', async () => {
    await ok(await fetch(`https://${env.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'Content-Length': '0' },
    }), 'Speech');
  });
  if (has('AZURE_TRANSLATOR_KEY')) await t('Azure Translator', async () => {
    const { translate } = await import('../server/lib/azure.js');
    const out = await translate(env, 'tree', ['es']);
    return `"tree" → "${out.es}"`;
  });
  if (has('GEMINI_API_KEY')) await t('Gemini', async () => {
    const { geminiChat, geminiModels } = await import('../server/lib/gemini.js');
    const m = await geminiModels(env);
    const said = (await geminiChat(env, [{ role: 'user', content: 'Reply with just the word: ready' }], { maxTokens: 10 })).slice(0, 30);
    return `said "${said}" · chat ${m.chat ?? 'none'}, images ${m.image ?? 'none'}, embeddings ${m.embed ?? 'none'}`;
  });
  if (has('ELEVENLABS_API_KEY')) await t('ElevenLabs', async () => {
    await ok(await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } }), 'ElevenLabs');
  });
  if (has('TIGER_DATABASE_URL')) await t('TigerData', async () => {
    const { default: pg } = await import('pg');
    const { pgConfig } = await import('../server/lib/tiger.js');
    const client = new pg.Client(pgConfig(env.TIGER_DATABASE_URL));
    await client.connect();
    try {
      const { rows: r } = await client.query("SELECT count(*) FILTER (WHERE name = 'timescaledb') AS ts, count(*) FILTER (WHERE name = 'vector') AS vec FROM pg_available_extensions");
      if (!Number(r[0].ts)) throw new Error('connected, but TimescaleDB isn\'t available on this database');
      return Number(r[0].vec) ? 'TimescaleDB and pgvector available' : 'TimescaleDB ok, pgvector missing';
    } finally {
      await client.end();
    }
  });
  if (has('PLANTNET_API_KEY')) add('–', 'Pl@ntNet (live)', 'needs a real photo, test it by sending a photo report in the app');
}

if (live) await liveChecks();
{
  const { createAI } = await import('../server/lib/ai.js');
  const { healthProvider, speciesProvider } = await import('../server/lib/vision.js');
  const { createVoice } = await import('../server/lib/voice.js');
  const p = createAI(env).providers;
  const azureOnNoQuota = Object.entries(p).filter(([, v]) => v === 'Azure OpenAI').map(([k]) => k);
  add(azureOnNoQuota.length ? '!' : 'i', 'Who does what',
    `writing: ${p.chat ?? 'none'} · images: ${p.image ?? 'none'} · fact search: ${p.embed ?? 'none'} · voices: ${createVoice(env)?.provider ?? 'browser'} · species: ${speciesProvider(env) ?? 'none'} · photo health: ${healthProvider(env) ?? 'none'}`);
  if (azureOnNoQuota.length) add('!', 'Azure OpenAI', `a deployment name is set for ${azureOnNoQuota.join(', ')}, so those use Azure OpenAI. Empty the AZURE_OPENAI_*_DEPLOYMENT lines if your account has no quota`);
}
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.status}  ${r.name.padEnd(w)}  ${r.note}`);
const bad = rows.filter((r) => r.status === '✘').length;
console.log(bad ? `\n${bad} thing${bad > 1 ? 's' : ''} to fix.` : `\nAll good${live ? '' : '. Run "npm run check-env -- --live" to test the keys for real'}.`);
process.exitCode = bad ? 1 : 0;
