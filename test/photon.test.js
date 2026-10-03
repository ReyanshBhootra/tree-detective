import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, reply, nudgeText, dueForNudge, shortStory, HELP } from '../photon/commands.js';

const trees = [
  { code: 'TD-001', name: 'Old Oakley', story: 'Well now. Come closer. I am old. Very old indeed.', label: 'Fact', verified: true, sourceUrl: 'https://src' },
  { code: 'TD-002', name: 'Whisper', story: 'Oh hello.', label: 'Local Legend', verified: false, sourceUrl: null },
];
const summary = {
  totalPoints: 20, totalTrees: 6, remaining: 4,
  visited: [{ code: 'TD-001', name: 'Old Oakley' }, { code: 'TD-002', name: 'Whisper' }],
  next: { code: 'TD-003', name: 'Professor Plane' }, routeUrl: 'https://td.example/?route=1',
};

test('parses the five questions from the doc', () => {
  assert.equal(parse('which trees have I visited?').intent, 'visited');
  assert.equal(parse('How many points do I have').intent, 'points');
  assert.equal(parse('which route should I take next?').intent, 'route');
  assert.equal(parse('tell me Old Oakley\'s story again').intent, 'story');
  assert.equal(parse('story whisper').query, 'whisper');
  assert.equal(parse('which tree should I find next?').intent, 'next');
  assert.equal(parse('hello').intent, 'help');
});

test('link codes and reminder controls', () => {
  assert.deepEqual(parse(' k7mq2p '), { intent: 'link', code: 'K7MQ2P' });
  assert.equal(parse('KOMQ2P').intent, 'help'); // O is not in the code alphabet
  assert.equal(parse('STOP').intent, 'nudges-off');
  assert.equal(parse('start').intent, 'nudges-on');
});

test('replies are short and use real data', () => {
  assert.equal(reply({ intent: 'points' }, summary, trees), 'You have 20 points from 2 of 6 trees.');
  assert.match(reply({ intent: 'visited' }, summary, trees), /Old Oakley, Whisper/);
  assert.match(reply({ intent: 'next' }, summary, trees), /Professor Plane.*\?route=1/);
  assert.match(reply({ intent: 'route' }, summary, trees), /\?route=1/);
  assert.match(reply({ intent: 'story', query: 'oakley' }, summary, trees), /^Old Oakley: "/);
  assert.match(reply({ intent: 'story', query: 'nobody' }, summary, trees), /couldn't find/);
  assert.equal(reply({ intent: 'help' }, null, trees), HELP);
  for (const intent of ['points', 'visited', 'next', 'route']) assert.ok(reply({ intent }, summary, trees).length < 200);
});

test('short story keeps the label and flags drafts', () => {
  assert.match(shortStory(trees[0]), /\(Fact, source: https:\/\/src\)$/);
  assert.match(shortStory(trees[1]), /\(Local Legend, draft not yet source-checked\)$/);
  assert.ok(shortStory({ ...trees[0], story: 'A. '.repeat(400) }).length < 400);
});

test('explore nudge text and timing', () => {
  assert.equal(nudgeText(summary), '4 trees are still sleeping near campus. Go meet them for 40 points. Start with Professor Plane. https://td.example/?route=1');
  assert.equal(nudgeText({ ...summary, remaining: 0 }), null);
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(dueForNudge({ nudges: true, summary, lastNudgedAt: '' }, now), true);
  assert.equal(dueForNudge({ nudges: true, summary, lastNudgedAt: '2026-10-04T01:00:00Z' }, now), false);
  assert.equal(dueForNudge({ nudges: true, summary, lastNudgedAt: '2026-10-03T11:00:00Z' }, now), true);
  assert.equal(dueForNudge({ nudges: false, summary, lastNudgedAt: '' }, now), false);
});
