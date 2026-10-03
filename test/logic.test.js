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
  const add = (who, flagType = 'pest') => reports.push({ treeCode: 'T1', flagType, reporterHash: who });
  for (let i = 0; i < 6; i++) add('same-person');
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'possible');
  assert.equal(flagStatus(reports, 'T1', 'pest').reporters, 1);
  ['b', 'c', 'd'].forEach((w) => add(w));
  add('e', 'damage'); // different flag does not count toward pest
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'possible');
  add('e');
  assert.equal(flagStatus(reports, 'T1', 'pest').status, 'confirmed');
  assert.equal(flagStatus(reports, 'T2', 'pest').status, 'possible'); // other tree untouched
  assert.equal(flagStatus(reports, 'T1', 'none'), null);
});

test('tree health summarises flags and species votes', () => {
  const h = treeHealth([
    { treeCode: 'T1', flagType: 'none', reporterHash: 'a', speciesGuess: 'Pin Oak', confidence: 0.8, speciesFeedback: 'agree', timestamp: '2026-10-03T10:00:00Z' },
    { treeCode: 'T1', flagType: 'pest', reporterHash: 'b', speciesGuess: 'Pin Oak', confidence: 0.6, timestamp: '2026-10-03T11:00:00Z' },
    { treeCode: 'T1', flagType: 'none', reporterHash: 'c', speciesGuess: 'Red Maple', confidence: 0.9, timestamp: '2026-10-03T09:00:00Z' },
  ], 'T1');
  assert.equal(h.reportCount, 3);
  assert.equal(h.lastReportAt, '2026-10-03T11:00:00Z');
  assert.deepEqual(Object.keys(h.flags), ['pest']);
  assert.equal(h.species[0].name, 'Pin Oak');
  assert.equal(h.species[0].agreed, 1);
  assert.ok(Math.abs(h.species[0].avgConfidence - 0.7) < 1e-9);
});

test('points: once per tree, summed per player', () => {
  assert.equal(visitPoints(false), 10);
  assert.equal(visitPoints(true), 0);
  assert.equal(totalPoints([{ points: 10 }, { points: 10 }, {}]), 20);
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
