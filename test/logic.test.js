import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, planRoute } from '../server/lib/geo.js';
import { flagStatus, treeHealth } from '../server/lib/vouch.js';
import { totalPoints, visitPoints } from '../server/lib/points.js';
import { analyzePhoto } from '../server/lib/vision.js';
import { contentProblems, loadTrees, loadPersonas } from '../server/lib/trees.js';
import { ssml } from '../scripts/azure.js';

test('distance between two nearby campus points is sensible', () => {
  const d = distanceMeters({ lat: 40.742, lng: -74.179 }, { lat: 40.743, lng: -74.179 });
  assert.ok(d > 105 && d < 117, `got ${d}`);
  assert.equal(distanceMeters({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);
});

test('route visits every stop, nearest first', () => {
  const stops = [{ code: 'far', lat: 40.75, lng: -74.18 }, { code: 'near', lat: 40.7421, lng: -74.179 }];
  const r = planRoute({ lat: 40.742, lng: -74.179 }, stops);
  assert.deepEqual(r.map((s) => s.code), ['near', 'far']);
});

test('a flag needs 5 different people to be confirmed', () => {
  const reports = [];
  const add = (who, flagType = 'pest', photoUrl = '/p.jpg') => reports.push({ treeCode: 'T1', flagType, reporterHash: who, photoUrl });
  for (let i = 0; i < 6; i++) add('same-person');
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'possible');
  assert.equal(flagStatus(reports, 'T1', 'pest').reporters, 1);
  ['b', 'c', 'd'].forEach((w) => add(w));
  add('e', 'damage'); // different flag does not count toward pest
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'possible');
  add('f', 'pest', ''); // no photo: noted, but doesn't count toward confirming
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'possible');
  assert.equal(flagStatus(reports, 'T1', 'pest').withoutPhoto, 1);
  add('e');
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'confirmed');
  assert.equal(flagStatus(reports, 'T2', 'pest').status, 'possible'); // other tree untouched
  assert.equal(flagStatus(reports, 'T1', 'none'), null);
});

test('tree health summarises flags and species votes', () => {
  const h = treeHealth([
    { treeCode: 'T1', flagType: 'none', reporterHash: 'a', speciesGuess: 'Pin Oak', confidence: 0.8, speciesFeedback: 'agree', timestamp: '2026-10-03T10:00:00Z' },
    { treeCode: 'T1', flagType: 'pest', reporterHash: 'b', speciesGuess: 'Pin Oak', confidence: 0.6, timestamp: '2026-10-03T11:00:00Z' },
    { treeCode: 'T1', flagType: 'none', reporterHash: 'c', speciesGuess: 'Red Maple', confidence: 0.9, timestamp: '2026-10-03T09:00:00Z', season: 'color-change' },
  ], 'T1');
  assert.equal(h.reportCount, 3);
  assert.equal(h.lastReportAt, '2026-10-03T11:00:00Z');
  assert.deepEqual(Object.keys(h.flags), ['pest']);
  assert.equal(h.species[0].name, 'Pin Oak');
  assert.equal(h.species[0].agreed, 1);
  assert.ok(Math.abs(h.species[0].avgConfidence - 0.7) < 1e-9);
  assert.deepEqual(h.season, { season: 'color-change', timestamp: '2026-10-03T09:00:00Z' });
});

test('points: once per tree, summed per player', () => {
  assert.equal(visitPoints(false), 10);
  assert.equal(visitPoints(true), 0);
  assert.equal(totalPoints([{ points: 10 }, { points: 10 }, {}]), 20);
});

test('Pl@ntNet species guess, Custom Vision health check, HEIC refused politely', async () => {
  const env = { PLANTNET_API_KEY: 'pk', CUSTOM_VISION_ENDPOINT: 'https://cv', CUSTOM_VISION_KEY: 'k', CUSTOM_VISION_HEALTH_PROJECT_ID: 'hp' };
  const urls = [];
  const fakeFetch = async (url, opts) => {
    urls.push(url);
    if (url.includes('plantnet')) {
      assert.ok(opts.body instanceof FormData);
      return { ok: true, status: 200, json: async () => ({ results: [
        { score: 0.82, species: { scientificNameWithoutAuthor: 'Quercus palustris', commonNames: ['Pin oak'] } },
        { score: 0.05, species: { scientificNameWithoutAuthor: 'Quercus rubra', commonNames: [] } },
      ] }) };
    }
    return { ok: true, json: async () => ({ predictions: [{ tagName: 'damage', probability: 0.9 }] }) };
  };
  const r = await analyzePhoto(Buffer.from('x'), env, fakeFetch, 'image/jpeg');
  assert.equal(r.provider, 'Pl@ntNet');
  assert.equal(r.speciesGuess, 'Pin oak (Quercus palustris)');
  assert.equal(r.confidence, 0.82);
  assert.equal(r.alternatives[0].name, 'Quercus rubra');
  assert.equal(r.suggestedFlag, 'damage');
  assert.match(urls[0], /my-api\.plantnet\.org\/v2\/identify\/all\?api-key=pk/);
  const heic = await analyzePhoto(Buffer.from('x'), env, fakeFetch, 'image/heic');
  assert.equal(heic.available, false);
  assert.match(heic.error, /HEIC/);
  const none = await analyzePhoto(Buffer.from('x'), env, async (u) => (u.includes('plantnet') ? { ok: false, status: 404 } : fakeFetch(u)), 'image/jpeg');
  assert.equal(none.speciesGuess, null);
  assert.match(none.error, /no tree recognised/);
});

test('Custom Vision: species + health flag, and unconfigured fallback', async () => {
  assert.equal((await analyzePhoto(Buffer.from('x'), {})).available, false);
  const env = {
    CUSTOM_VISION_ENDPOINT: 'https://cv.example/', CUSTOM_VISION_KEY: 'k',
    CUSTOM_VISION_SPECIES_PROJECT_ID: 'sp', CUSTOM_VISION_SPECIES_ITERATION: 'v1',
    CUSTOM_VISION_HEALTH_PROJECT_ID: 'hp', CUSTOM_VISION_HEALTH_ITERATION: 'v1',
  };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, key: opts.headers['Prediction-Key'] });
    const predictions = url.includes('/sp/')
      ? [{ tagName: 'Red Maple', probability: 0.2 }, { tagName: 'Pin Oak', probability: 0.71 }]
      : [{ tagName: 'healthy', probability: 0.3 }, { tagName: 'pest', probability: 0.65 }];
    return { ok: true, json: async () => ({ predictions }) };
  };
  const r = await analyzePhoto(Buffer.from('img'), env, fakeFetch);
  assert.equal(r.speciesGuess, 'Pin Oak');
  assert.equal(r.confidence, 0.71);
  assert.equal(r.suggestedFlag, 'pest');
  assert.equal(calls[0].url, 'https://cv.example/customvision/v3.0/Prediction/sp/classify/iterations/v1/image');
  assert.equal(calls[0].key, 'k');
});

test('weak health predictions do not raise a flag', async () => {
  const env = { CUSTOM_VISION_ENDPOINT: 'https://cv', CUSTOM_VISION_KEY: 'k', CUSTOM_VISION_SPECIES_PROJECT_ID: 'sp', CUSTOM_VISION_HEALTH_PROJECT_ID: 'hp' };
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => ({ predictions: url.includes('/hp/') ? [{ tagName: 'dying', probability: 0.4 }] : [{ tagName: 'Elm', probability: 0.5 }] }),
  });
  assert.equal((await analyzePhoto(Buffer.from('x'), env, fakeFetch)).suggestedFlag, null);
});

test('shipped tree data is well formed', () => {
  const personas = loadPersonas();
  assert.ok(personas.length >= 8 && personas.length <= 9, 'doc asks for 8 or 9 personas');
  const trees = loadTrees();
  const codes = new Set();
  for (const t of trees) {
    assert.ok(!codes.has(t.code), `duplicate ${t.code}`);
    codes.add(t.code);
    const structural = contentProblems(t, personas).filter((p) => !/verified|sourceUrl|generated image|narration/.test(p));
    assert.deepEqual(structural, [], `${t.code}: ${structural.join(', ')}`);
  }
});

test('SSML escapes story text and applies persona voice', () => {
  const x = ssml('Rock & roll <3', { voice: 'en-GB-RyanNeural', prosody: { rate: '-5%', pitch: '+2%' } });
  assert.match(x, /xml:lang="en-GB"/);
  assert.match(x, /<voice name="en-GB-RyanNeural"><prosody rate="-5%" pitch="\+2%">Rock &amp; roll &lt;3<\/prosody>/);
});

test('signed tags: key checks out, wrong key or no key fails, no secret means dev mode', async () => {
  const { treeKey, verifyTreeKey, treeLink, typedCode } = await import('../server/lib/qr.js');
  const k = treeKey('TD-001', 's3cret');
  assert.match(k, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.notEqual(k, treeKey('TD-002', 's3cret'));
  assert.equal(verifyTreeKey('TD-001', k.toLowerCase(), 's3cret'), true);
  assert.equal(verifyTreeKey('TD-001', 'AAAAAA', 's3cret'), false);
  assert.equal(verifyTreeKey('TD-001', '', 's3cret'), false);
  assert.equal(verifyTreeKey('TD-001', '', ''), true);
  assert.equal(treeLink('https://td.example/', 'TD-001', 's3cret'), `https://td.example/?tree=TD-001&k=${k}`);
  assert.equal(typedCode('TD-001', 's3cret'), `TD-001-${k}`);
});

test('the browser reads every kind of tag', async () => {
  const { parseTag } = await import('../web/js/scanner.js');
  assert.deepEqual(parseTag('https://td.example/?tree=td-001&k=7k3qxz'), { code: 'TD-001', key: '7K3QXZ' });
  assert.deepEqual(parseTag('TD-001-7K3QXZ'), { code: 'TD-001', key: '7K3QXZ' });
  assert.deepEqual(parseTag('td-001 7k3qxz'), { code: 'TD-001', key: '7K3QXZ' });
  assert.deepEqual(parseTag('TD-001'), { code: 'TD-001', key: '' });
  assert.equal(parseTag('https://example.com/'), null);
  assert.equal(parseTag('!!'), null);
});

test('rate limiter', async () => {
  const { rateLimiter } = await import('../server/lib/ratelimit.js');
  const allow = rateLimiter(2, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), false);
  assert.equal(allow('b', 20), true);
  assert.equal(allow('a', 1500), true);
});

test('book badges come from the summary', async () => {
  const { bookCounts, BADGES } = await import('../web/js/book.js');
  const trees = [{ code: 'A', persona: 'elder' }, { code: 'B', persona: 'sprout' }];
  const late = new Date(); late.setHours(22, 0, 0, 0);
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const c = bookCounts({ visited: [{ code: 'A', timestamp: late.toISOString() }, { code: 'B', timestamp: noon.toISOString() }], reportsSent: 1, seasonsLogged: 0 }, trees, (t) => t.persona);
  assert.deepEqual(c, { woken: 2, total: 2, personas: 2, nightVisits: 1, reports: 1, seasons: 0, pestReports: 0, rescues: 0 });
  const got = BADGES.filter((b) => b.test(c)).map((b) => b.id);
  assert.deepEqual(got, ['first', 'whole', 'owl', 'doctor']);
});

test('1930 aerial helpers', async () => {
  const { pickLayer, bbox } = await import('../server/lib/historic.js');
  const xml = '<Layer><Title>x</Title><Layer queryable="1"><Name>0</Name></Layer><Layer><Name>BlackWhite1930</Name></Layer></Layer>';
  assert.equal(pickLayer(xml).layer, 'BlackWhite1930');
  assert.equal(pickLayer(xml, '0').layer, '0');
  const [w, s, e, n] = bbox(40.742, -74.179).split(',').map(Number);
  assert.ok(w < -74.179 && e > -74.179 && s < 40.742 && n > 40.742);
  const wide = distanceMeters({ lat: 40.742, lng: w }, { lat: 40.742, lng: e });
  assert.ok(wide > 210 && wide < 230, `width ${wide}`);
});

test('ask prompt keeps the tree to its own facts', async () => {
  const { buildAskMessages } = await import('../server/lib/ask.js');
  const m = buildAskMessages(
    { name: 'Old Oakley', story: 'Hello.', species: 'Pin oak' },
    { name: 'The Elder', style: 'Slow.' },
    { label: 'Local Legend', facts: [{ text: 'A well stood here.', sourceUrl: 'https://src' }] },
    'what was here?',
  );
  assert.match(m[0].content, /Use ONLY the information below/);
  assert.match(m[0].content, /A well stood here\./);
  assert.match(m[0].content, /Local Legend is a legend/);
  assert.equal(m[1].content, 'what was here?');
});

test('languages: voices follow the persona', async () => {
  const { voiceFor, isLanguage } = await import('../server/lib/languages.js');
  assert.equal(voiceFor({ voice: 'en-US-DavisNeural', gender: 'male' }, 'es'), 'es-US-AlonsoNeural');
  assert.equal(voiceFor({ voice: 'en-US-JaneNeural', gender: 'female' }, 'hi'), 'hi-IN-SwaraNeural');
  assert.equal(voiceFor({ voice: 'en-US-JaneNeural', gender: 'female' }, 'en'), 'en-US-JaneNeural');
  assert.equal(voiceFor({ voice: 'en-US-JaneNeural', gender: 'female' }, 'pt'), null);
  assert.equal(isLanguage('gu'), true);
  assert.equal(isLanguage('pt'), false);
  assert.equal(isLanguage('toString'), false);
  const personas = loadPersonas();
  assert.ok(personas.every((p) => p.gender === 'male' || p.gender === 'female'));
});

test('weather: lines follow the real reading, NWS lookup is cached', async () => {
  const { weatherLine, createWeather } = await import('../server/lib/weather.js');
  assert.match(weatherLine({ tempF: 88, summary: 'Sunny' }), /88°F.*shade/);
  assert.match(weatherLine({ tempF: 60, summary: 'Light Rain' }), /rain/);
  assert.match(weatherLine({ tempF: 31, summary: 'Clear' }), /31°F/);
  assert.equal(weatherLine(null), null);
  let calls = 0;
  const fake = async (url, opts) => {
    calls++;
    assert.match(opts.headers['User-Agent'], /tree-detective/);
    if (url.includes('/points/')) return { ok: true, json: async () => ({ properties: { forecastHourly: 'https://api.weather.gov/x/hourly' } }) };
    return { ok: true, json: async () => ({ properties: { periods: [{ temperature: 30, temperatureUnit: 'C', shortForecast: 'Sunny', startTime: 't' }] } }) };
  };
  const get = createWeather({ lat: 40.742, lng: -74.179, fetchImpl: fake });
  assert.deepEqual(await get(), { tempF: 86, summary: 'Sunny', at: 't' });
  await get();
  assert.equal(calls, 2, 'second call comes from the cache');
  const broken = createWeather({ lat: 1, lng: 1, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(await broken(), null);
});

test('notes: kind, short, no links or phone numbers', async () => {
  const { checkNote, cleanName } = await import('../server/lib/notes.js');
  assert.deepEqual(checkNote('  thank you   for the shade '), { ok: true, text: 'thank you for the shade' });
  assert.equal(checkNote('a').ok, false);
  assert.equal(checkNote('x'.repeat(201)).ok, false);
  assert.equal(checkNote('visit www.spam.com').ok, false);
  assert.equal(checkNote('call me 201-555-0123').ok, false);
  assert.equal(checkNote('follow @someone').ok, false);
  assert.equal(checkNote('you are shit').ok, false);
  assert.equal(cleanName(' Maya <b> '), 'Maya b');
  assert.equal(cleanName('José'), 'José');
});

test('trends: weekly buckets and season firsts', async () => {
  const { computeTrends, computeSeasonTimeline, weekStart } = await import('../server/lib/trends.js');
  assert.equal(weekStart('2026-10-04T12:00:00Z'), '2026-09-28'); // Sunday belongs to the week starting Monday
  assert.equal(weekStart('2026-09-28T00:00:00Z'), '2026-09-28');
  const now = new Date('2026-10-04T12:00:00Z');
  const t = computeTrends(
    [{ timestamp: '2026-10-01T10:00:00Z' }, { timestamp: '2026-09-22T10:00:00Z' }, { timestamp: '2025-01-01T00:00:00Z' }],
    [{ timestamp: '2026-10-02T10:00:00Z', flagType: 'pest', photoUrl: '/x', season: '' },
     { timestamp: '2026-10-02T11:00:00Z', flagType: 'none', photoUrl: '', season: 'color-change' }],
    { weeks: 2, now },
  );
  assert.deepEqual(t.map((w) => w.week), ['2026-09-21', '2026-09-28']);
  assert.deepEqual(t[1], { week: '2026-09-28', visits: 1, reports: 1, seasons: 1, flags: { pest: 1, damage: 0, dying: 0 } });
  assert.equal(t[0].visits, 1);
  const s = computeSeasonTimeline([
    { treeCode: 'A', season: 'bare', timestamp: '2026-12-02T00:00:00Z' },
    { treeCode: 'A', season: 'bare', timestamp: '2026-11-20T00:00:00Z' },
    { treeCode: 'A', season: 'bare', timestamp: '2025-11-25T00:00:00Z' },
  ]);
  assert.deepEqual(s.map((x) => [x.year, x.firstSeen.slice(0, 10)]), [[2025, '2025-11-25'], [2026, '2026-11-20']]);
});

test('TigerData: schema, hypertable, vector search and event logging', async () => {
  const { createTiger, SCHEMA, toVector } = await import('../server/lib/tiger.js');
  assert.equal(createTiger({}), null);
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/vectorscale/.test(sql)) throw new Error('not installed');
      if (/time_bucket/.test(sql)) return { rows: [{ week: '2026-09-28', visits: '3', reports: '2', seasons: '1', pest: '1', damage: '0', dying: '0' }] };
      if (/FROM facts/.test(sql)) return { rows: [{ text: 'A well stood here.', label: 'Fact', source_url: 'https://src', tree_code: null }] };
      return { rows: [] };
    },
    async end() {},
  };
  const tiger = createTiger({}, { pool });
  await tiger.logEvent({ treeCode: 'TD-001', kind: 'visit' });
  assert.ok(queries.some((q) => /create_hypertable\('events'/.test(q.sql)));
  assert.ok(queries.some((q) => /USING hnsw/.test(q.sql)), 'falls back to pgvector when pgvectorscale is missing');
  assert.equal(queries.filter((q) => q.sql === SCHEMA[0]).length, 1, 'schema runs once');
  const ev = queries.find((q) => /INSERT INTO events/.test(q.sql));
  assert.deepEqual(ev.params.slice(1), ['TD-001', 'visit', null, null, false]);
  assert.deepEqual((await tiger.trends(8))[0], { week: '2026-09-28', visits: 3, reports: 2, seasons: 1, flags: { pest: 1, damage: 0, dying: 0 } });
  const hits = await tiger.searchFacts('TD-001', [0.1, 0.2], 3);
  assert.equal(hits[0].text, 'A well stood here.');
  const search = queries.find((q) => /FROM facts/.test(q.sql));
  assert.deepEqual(search.params, ['TD-001', '[0.1,0.2]', 3]);
  assert.equal(toVector([1, 2]), '[1,2]');
});

test('ask prompt includes retrieved campus facts and the chosen language', async () => {
  const { buildAskMessages } = await import('../server/lib/ask.js');
  const m = buildAskMessages({ name: 'Riddle', story: 'Hi.' }, null, null, 'q', {
    lang: 'gu', retrieved: [{ text: 'A trolley ran here.', label: 'Fact', source_url: 'https://s', tree_code: null }],
  });
  assert.match(m[0].content, /Campus fact \(Fact, source https:\/\/s\): A trolley ran here\./);
  assert.match(m[0].content, /Answer in Gujarati \(ગુજરાતી, language code gu\)/);
});

test('voices: ElevenLabs first, Azure as backup, nothing when neither is set', async () => {
  const { createVoice } = await import('../server/lib/voice.js');
  assert.equal(createVoice({}), null);
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const v = createVoice({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ELDER: 'custom-id', AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'eastus' }, { fetchImpl: fake });
  assert.equal(v.provider, 'ElevenLabs');
  const elder = { id: 'elder', elevenVoiceId: 'default-id', voice: 'en-US-DavisNeural', gender: 'male' };
  assert.equal(v.canSpeak(elder, 'gu'), true);
  const mp3 = await v.speak('Hello', elder, 'gu');
  assert.deepEqual([...mp3], [1, 2, 3]);
  assert.match(calls[0].url, /text-to-speech\/custom-id\?output_format=mp3/);
  assert.equal(calls[0].opts.headers['xi-api-key'], 'k');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model_id, 'eleven_v3');
  assert.equal(body.language_code, 'gu');
  await v.speak('Hola', { ...elder, id: 'sprout' }, 'es');
  assert.equal(JSON.parse(calls[1].opts.body).model_id, 'eleven_multilingual_v2');
  const azure = createVoice({ AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'eastus' });
  assert.equal(azure.provider, 'Azure Speech');
  assert.equal(azure.canSpeak(elder, 'zh'), true);
  assert.equal(azure.canSpeak(elder, 'pt'), false, 'unknown language');
  assert.ok(loadPersonas().every((p) => p.elevenVoiceId));
});

test('five languages, and Translator gets its own code for Chinese', async () => {
  const { LANGUAGES, voiceFor } = await import('../server/lib/languages.js');
  assert.deepEqual(Object.keys(LANGUAGES), ['en', 'es', 'zh', 'hi', 'gu']);
  assert.equal(voiceFor({ voice: 'x', gender: 'female' }, 'gu'), 'gu-IN-DhwaniNeural');
  const { translate } = await import('../server/lib/azure.js');
  const realFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (u) => {
    url = u;
    return { ok: true, json: async () => [{ translations: [{ to: 'zh-Hans', text: '你好' }, { to: 'gu', text: 'નમસ્તે' }] }] };
  };
  try {
    const out = await translate({ AZURE_TRANSLATOR_KEY: 'k', AZURE_TRANSLATOR_REGION: 'eastus' }, 'Hello', ['zh', 'gu'], { zh: 'zh-Hans' });
    assert.match(url, /&to=zh-Hans&to=gu$/);
    assert.deepEqual(out, { zh: '你好', gu: 'નમસ્તે' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

const MODEL_LIST = { models: [
  { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
] };
const listing = (url) => url.includes('/models?pageSize') ? { ok: true, json: async () => MODEL_LIST } : null;

test('AI switch: Azure OpenAI first, Gemini fills any gap, nothing when neither is set', async () => {
  const { createAI } = await import('../server/lib/ai.js');
  assert.deepEqual(createAI({}).providers, { chat: null, embed: null, image: null });
  assert.deepEqual(createAI({ GEMINI_API_KEY: 'g' }).providers, { chat: 'Gemini', embed: 'Gemini', image: 'Gemini' });
  const mixed = createAI({ GEMINI_API_KEY: 'g', AZURE_OPENAI_ENDPOINT: 'https://a', AZURE_OPENAI_KEY: 'k', AZURE_OPENAI_CHAT_DEPLOYMENT: 'gpt' });
  assert.deepEqual(mixed.providers, { chat: 'Azure OpenAI', embed: 'Gemini', image: 'Gemini' });
  await assert.rejects(createAI({}).chat([]), /No AI set up for chat/);
});

test('Gemini: chat, embeddings and photo-based images are sent the right way', async () => {
  const { createAI } = await import('../server/lib/ai.js');
  const calls = [];
  const fake = async (url, opts) => {
    if (listing(url)) return listing(url);
    const body = JSON.parse(opts.body);
    calls.push({ url, body, key: opts.headers['x-goog-api-key'] });
    if (url.includes(':batchEmbedContents')) return { ok: true, json: async () => ({ embeddings: body.requests.map(() => ({ values: [3, 4] })) }) };
    if (url.includes('flash-image')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }] } }] }) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'I am an old oak.' }] } }] }) };
  };
  const ai = createAI({ GEMINI_API_KEY: 'g' }, { fetchImpl: fake });

  assert.equal(await ai.chat([{ role: 'system', content: 'Be a tree.' }, { role: 'user', content: 'Who are you?' }], { maxTokens: 50 }), 'I am an old oak.');
  assert.match(calls[0].url, /models\/gemini-3\.7-flash:generateContent$/, 'newest stable Flash');
  assert.equal(calls[0].key, 'g');
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: 'Be a tree.' }] });
  assert.deepEqual(calls[0].body.contents, [{ role: 'user', parts: [{ text: 'Who are you?' }] }]);
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 2048, 'room for thinking on 3.x');
  assert.equal(calls[0].body.generationConfig.thinkingConfig, undefined);

  assert.deepEqual(await ai.embed('one'), [0.6, 0.8], 'normalized');
  assert.equal((await ai.embed(['a', 'b'])).length, 2);
  assert.equal(calls[1].body.requests[0].outputDimensionality, 1536);

  const png = await ai.imageFromPhoto('Same spot in 1930', { buffer: Buffer.from('jpg'), type: 'image/jpeg', name: 'r.jpg' });
  assert.equal(png.toString(), 'png');
  const img = calls.at(-1);
  assert.match(img.url, /gemini-3\.1-flash-image:generateContent$/);
  assert.deepEqual(img.body.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') } });
  assert.deepEqual(img.body.generationConfig.responseModalities, ['IMAGE']);
});

test('Gemini: an empty or blocked answer is an error, not a blank tree', async () => {
  const { geminiChat } = await import('../server/lib/gemini.js');
  const fake = async (u) => listing(u) ?? { ok: true, json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }) };
  await assert.rejects(geminiChat({ GEMINI_API_KEY: 'g' }, [{ role: 'user', content: 'x' }], {}, fake), /no text \(SAFETY\)/);
  const err = async (u) => listing(u) ?? { ok: false, status: 429, text: async () => 'quota' };
  await assert.rejects(geminiChat({ GEMINI_API_KEY: 'g' }, [{ role: 'user', content: 'x' }], {}, err), /429: quota/);
});

test('photo health check: Gemini flags clear problems, ignores unsure ones, never breaks species', async () => {
  const env = { GEMINI_API_KEY: 'g', PLANTNET_API_KEY: 'p' };
  let health = { label: 'pest', confidence: 0.9, reason: 'Spotted lanternfly egg masses on the trunk.' };
  let geminiBody = null;
  const fake = async (url, opts) => {
    if (listing(url)) return listing(url);
    if (url.includes('plantnet')) return { ok: true, status: 200, json: async () => ({ results: [{ score: 0.7, species: { scientificNameWithoutAuthor: 'Acer rubrum', commonNames: ['Red maple'] } }] }) };
    geminiBody = JSON.parse(opts.body);
    if (health === 'boom') return { ok: false, status: 500, text: async () => 'down' };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(health) }] } }] }) };
  };
  let r = await analyzePhoto(Buffer.from('img'), env, fake, 'image/jpeg');
  assert.equal(r.healthProvider, 'Gemini');
  assert.equal(r.suggestedFlag, 'pest');
  assert.equal(r.flagReason, 'Spotted lanternfly egg masses on the trunk.');
  assert.equal(r.speciesGuess, 'Red maple (Acer rubrum)');
  assert.equal(geminiBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(geminiBody.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');

  health = { label: 'damage', confidence: 0.4, reason: 'Maybe a crack.' };
  assert.equal((await analyzePhoto(Buffer.from('img'), env, fake)).suggestedFlag, null, 'too unsure to flag');
  health = { label: 'unclear', confidence: 0.95, reason: 'No tree in the photo.' };
  assert.equal((await analyzePhoto(Buffer.from('img'), env, fake)).suggestedFlag, null);
  health = 'boom';
  r = await analyzePhoto(Buffer.from('img'), env, fake);
  assert.equal(r.suggestedFlag, null);
  assert.equal(r.speciesGuess, 'Red maple (Acer rubrum)', 'species survives a failed health check');

  const { healthProvider } = await import('../server/lib/vision.js');
  assert.equal(healthProvider({ GEMINI_API_KEY: 'g', CUSTOM_VISION_ENDPOINT: 'e', CUSTOM_VISION_KEY: 'k', CUSTOM_VISION_HEALTH_PROJECT_ID: 'h' }), 'Azure Custom Vision', 'a trained model still wins');
});

test('Gemini model picking: newest stable Flash, Flash image model, 1536-capable embeddings, .env overrides win', async () => {
  const { pickModels, geminiModels } = await import('../server/lib/gemini.js');
  const list = MODEL_LIST.models.map((m) => ({ name: m.name.replace('models/', ''), methods: m.supportedGenerationMethods }));
  assert.deepEqual(pickModels(list), { chat: 'gemini-3.7-flash', image: 'gemini-3.1-flash-image', embed: 'gemini-embedding-001' });
  assert.deepEqual(pickModels(list.filter((m) => m.name !== 'gemini-embedding-001')).embed, 'gemini-embedding-2');
  assert.equal(pickModels([{ name: 'gemini-9.0-flash-preview', methods: ['generateContent'] }]).chat, 'gemini-9.0-flash-preview');
  const m = await geminiModels({ GEMINI_API_KEY: 'other-key', GEMINI_CHAT_MODEL: 'my-model' }, async (u) => listing(u));
  assert.equal(m.chat, 'my-model');
  assert.equal(m.image, 'gemini-3.1-flash-image');
});

test('TigerData connection: sslmode=require encrypts without strict certificate checks', async () => {
  const { pgConfig } = await import('../server/lib/tiger.js');
  const req = pgConfig('postgres://u:p@abc.tsdb.cloud.timescale.com:33333/tsdb?sslmode=require');
  assert.deepEqual(req.ssl, { rejectUnauthorized: false });
  assert.doesNotMatch(req.connectionString, /sslmode/);
  assert.deepEqual(pgConfig('postgres://u:p@h/db').ssl, { rejectUnauthorized: false });
  assert.equal(pgConfig('postgres://u:p@h/db?sslmode=verify-full').ssl, undefined, 'verify-full keeps full checks');
  assert.equal(pgConfig('postgres://u:p@h/db?sslmode=disable').ssl, false);
});

test('ElevenLabs: a retired preset voice is swapped for one on the account', async () => {
  const { createVoice, pickReplacement } = await import('../server/lib/voice.js');
  const voices = [
    { voice_id: 'm1', name: 'Brian', labels: { gender: 'male', age: 'middle aged' } },
    { voice_id: 'f1', name: 'Sarah', labels: { gender: 'female', age: 'young' } },
    { voice_id: 'f2', name: 'Alice', labels: { gender: 'female', age: 'middle aged' } },
  ];
  assert.equal(pickReplacement(voices, { id: 'sprout', gender: 'female' }).voice_id, 'f1');
  assert.equal(pickReplacement(voices, { id: 'elder', gender: 'male' }).voice_id, 'm1');
  const used = [];
  const fake = async (url) => {
    if (url.endsWith('/v1/voices')) return { ok: true, json: async () => ({ voices }) };
    const id = url.match(/text-to-speech\/([^?]+)/)[1];
    used.push(id);
    if (id === 'gone') return { ok: false, status: 404, text: async () => '{"detail":{"code":"voice_not_found"}}' };
    return { ok: true, arrayBuffer: async () => new Uint8Array([7]).buffer };
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const v = createVoice({ ELEVENLABS_API_KEY: 'k' }, { fetchImpl: fake });
    const sprout = { id: 'sprout', name: 'The Sprout', gender: 'female', elevenVoiceId: 'gone' };
    assert.deepEqual([...await v.speak('Hi', sprout, 'en')], [7]);
    await v.speak('Hola', sprout, 'es');
    assert.deepEqual(used, ['gone', 'f1', 'f1'], 'remembers the replacement');
  } finally {
    console.warn = warn;
  }
});
