// Checks farm.mjs outside FourFold. Run: node .check/farm.check.mjs
import assert from 'node:assert/strict';
import {
  RANKED_MS, RATED_MS, addLive, areaName, createLiveTracker, liveStep, loadTotals, prefix, prune, ranking, reset
} from '../farm.mjs';

const SEC = 1000;
const MIN = 60000;
const start = Date.UTC(2026, 9, 6, 12, 0);
const DUNGEON = 'westhills_b2_dungeon_01';
// Feeds live events to a fresh tracker, each with the class given, and adds what counted into fresh totals.
const live = (...events) => {
  const tracker = createLiveTracker();
  const totals = {};
  for (const event of events) {
    const counted = liveStep(tracker, { className: 'Bandit', ...event, at: start + event.at });
    if (counted) addLive(totals, 'a', counted);
  }
  return { tracker, totals, area: scene => totals.a?.Bandit?.[scene] };
};
const enter = (at, scene) => ({ type: 'location', at, scene, inBattle: false });
const fight = (at, scene = 'westhills_b2_battle_01') => ({ type: 'location', at, scene, inBattle: true });
const begin = at => ({ type: 'start', at });
const result = (at, xp, silver, className) => ({ type: 'result', at, xp, silver, ...(className ? { className } : {}) });

// An area counts from its first fight, walking between fights included; the walk there and the town don't count.
// The fight's scene belongs to the area it was entered from.
{
  const { area } = live(
    enter(0, 'westhills_b2'),
    enter(20 * SEC, DUNGEON),
    fight(30 * SEC), begin(30 * SEC),
    result(50 * SEC, 40, 15),
    enter(52 * SEC, DUNGEON),
    fight(70 * SEC), begin(70 * SEC),
    result(90 * SEC, 104, 42),
    { type: 'tick', at: 100 * SEC });
  assert.deepEqual(area(DUNGEON), { ms: 70 * SEC, xp: 144, silver: 57, battles: 2 });
  assert.equal(area('westhills_b2'), undefined);
  assert.equal(area('westhills_b2_battle_01'), undefined);
}

// Leaving for another area stops the clock on the first; the new one starts at its own first fight.
{
  const { area } = live(
    enter(0, DUNGEON), begin(0), result(30 * SEC, 10, 1),
    enter(40 * SEC, 'coldwoods_arena'),
    { type: 'tick', at: 100 * SEC },
    begin(120 * SEC), result(150 * SEC, 20, 2));
  assert.equal(area(DUNGEON).ms, 40 * SEC);
  assert.deepEqual(area('coldwoods_arena'), { ms: 30 * SEC, xp: 20, silver: 2, battles: 1 });
}

// The idle rule: five quiet minutes still count, then the clock pauses until the next fight.
{
  const quiet = [1, 2, 3, 4, 5, 6, 7, 8].map(minute => ({ type: 'tick', at: 30 * SEC + minute * MIN }));
  const { area } = live(enter(0, DUNGEON), begin(0), result(30 * SEC, 10, 1), ...quiet, begin(30 * SEC + 9 * MIN),
    result(30 * SEC + 9 * MIN + 20 * SEC, 10, 1));
  // 0:00-0:30 (the fight), then five quiet minutes to 5:30, then paused until the fight at 9:30, which runs 20 s.
  assert.equal(area(DUNGEON).ms, 30 * SEC + 5 * MIN + 20 * SEC);
  assert.equal(area(DUNGEON).battles, 2);
}

// A gap of more than three minutes between events (the app was asleep) adds no time. The reward still counts: the
// feed reports it exactly.
{
  const { area } = live(enter(0, DUNGEON), begin(0), result(4 * MIN, 50, 5));
  assert.deepEqual(area(DUNGEON), { ms: 0, xp: 50, silver: 5, battles: 1 });
}

// A reload pauses the clock. After the re-login the game resumes the fight, and its reward counts for the same area.
{
  const { area } = live(
    enter(0, DUNGEON), begin(0),
    { type: 'disconnect', at: 20 * SEC },
    fight(50 * SEC), begin(50 * SEC),
    result(60 * SEC, 88, 11));
  assert.deepEqual(area(DUNGEON), { ms: 30 * SEC, xp: 88, silver: 11, battles: 1 });
}

// A reward that arrives without its fight start (the panel opened mid-fight) still counts for the area it came from.
// Events out of order, or with no class yet, count nothing.
{
  const { area } = live(enter(0, DUNGEON), result(30 * SEC, 9, 3), result(20 * SEC, 500, 500));
  assert.deepEqual(area(DUNGEON), { ms: 0, xp: 9, silver: 3, battles: 1 });
  const tracker = createLiveTracker();
  liveStep(tracker, { type: 'location', at: start, scene: DUNGEON, inBattle: false, className: null });
  assert.equal(liveStep(tracker, { type: 'result', at: start + SEC, xp: 9, silver: 3, className: null }), null);
}

// Each fight counts for the class its reward names: a class switch between fights splits the totals.
{
  const { totals } = live(
    enter(0, DUNGEON), begin(0), result(20 * SEC, 10, 1),
    begin(30 * SEC), result(50 * SEC, 30, 3, 'Mage'));
  assert.deepEqual(Object.keys(totals.a).sort(), ['Bandit', 'Mage']);
  assert.equal(totals.a.Mage[DUNGEON].xp, 30);
  assert.equal(totals.a.Bandit[DUNGEON].xp, 10);
}

// The ranking: a rate shows after a minute, marked early until five; trusted areas come first, then early ones, then
// those with no rate yet.
{
  const totals = {};
  addLive(totals, 'a', { area: DUNGEON, className: 'Bandit', ms: 20 * MIN, xp: 1000, silver: 300, battles: 30 });
  addLive(totals, 'a', { area: 'coldwoods_arena', className: 'Bandit', ms: RANKED_MS - 1, xp: 9999, silver: 9999, battles: 9 });
  addLive(totals, 'a', { area: 'bellroot_a2_dungeon_01', className: 'Bandit', ms: RATED_MS - 1, xp: 99999, silver: 0, battles: 1 });
  const ranked = ranking(totals, 'a', 'Bandit', 'xp');
  assert.deepEqual(ranked.map(row => [row.id, row.rated, row.ranked]), [
    [DUNGEON, true, true], ['coldwoods_arena', true, false], ['bellroot_a2_dungeon_01', false, false]]);
  assert.equal(ranked[0].xp, 3000);
  assert.equal(ranked[0].silver, 900);
  assert.equal(ranked[0].battles, 30);
  assert.deepEqual(ranking(totals, 'nobody', 'Bandit', 'xp'), []);
}

// Resetting one area or a whole class, and forgetting accounts that are gone.
{
  const totals = {};
  for (const account of ['a', 'b']) {
    addLive(totals, account, { area: DUNGEON, className: 'Bandit', ms: MIN, xp: 1, silver: 1, battles: 1 });
    addLive(totals, account, { area: 'coldwoods_arena', className: 'Bandit', ms: MIN, xp: 1, silver: 1, battles: 1 });
    addLive(totals, account, { area: DUNGEON, className: 'Mage', ms: MIN, xp: 1, silver: 1, battles: 1 });
  }
  reset(totals, 'a', 'Bandit', DUNGEON);
  assert.deepEqual(Object.keys(totals.a.Bandit), ['coldwoods_arena']);
  reset(totals, 'a', 'Mage');
  assert.deepEqual(Object.keys(totals.a), ['Bandit']);
  prune(totals, new Set(['a']));
  assert.deepEqual(Object.keys(totals), ['a']);
}

// Scene names as the panel shows them.
{
  assert.equal(areaName('westhills_b2_dungeon_01'), 'Westhills B2 · Dungeon 1');
  assert.equal(areaName('coldwoods_arena'), 'Coldwoods Arena');
  assert.equal(areaName('bellroot_a2'), 'Bellroot A2');
  assert.equal(areaName('death_dunes_arena'), 'Death Dunes Arena');
  assert.equal(areaName('plagued_grounds_c10_dungeon_12'), 'Plagued Grounds C10 · Dungeon 12');
  assert.equal(areaName(''), 'Unknown area');
}

// A cut never lands in the middle of an emoji, which would leave half a character a card refuses; saved data that
// isn't what the plugin wrote starts empty.
{
  assert.equal(prefix('ab😀cd', 3), 'ab');
  assert.equal(prefix('ab😀cd', 4), 'ab😀');
  assert.equal(prefix('abc', 10), 'abc');
  assert.deepEqual(loadTotals(['junk']), {});
  assert.deepEqual(loadTotals({ a: {} }), { a: {} });
}

console.log('farm.mjs: all checks passed');
