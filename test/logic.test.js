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
  assert.deepEqual(c, { woken: 2, total: 2, personas: 2, nightVisits: 1, reports: 1, seasons: 0 });
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

test('weekly digest sorts confirmed from possible and counts the week', async () => {
  const { buildDigest } = await import('../server/lib/digest.js');
  const trees = [{ code: 'A', name: 'Oak' }, { code: 'B', name: 'Elm' }];
  const reports = [
    ...[1, 2, 3, 4, 5].map((i) => ({ treeCode: 'A', flagType: 'pest', reporterHash: `p${i}`, photoUrl: '/x', timestamp: '2026-10-02T00:00:00Z' })),
    { treeCode: 'B', flagType: 'damage', reporterHash: 'q', photoUrl: '/y', timestamp: '2026-09-01T00:00:00Z' },
  ];
  const d = buildDigest(trees, reports, '2026-09-26T00:00:00Z');
  assert.equal(d.recentCount, 5);
  assert.deepEqual(d.confirmed.map((f) => f.tree.name), ['Oak']);
  assert.deepEqual(d.possible.map((f) => f.tree.name), ['Elm']);
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
  assert.match(m[0].content, /local legends/);
  assert.equal(m[1].content, 'what was here?');
});
