// Checks farm.mjs outside FourFold. Run: node .check/farm.check.mjs
import assert from 'node:assert/strict';
import {
  BUILT_IN, RANKED_MS, UNLABELLED, absorb, addLocation, addTo, createTracker, loadCustom, loadTotals, merged, prefix,
  prune, ranking, removeLocation, reset, step, toRead, waitingMs
} from '../farm.mjs';

const MIN = 60000;
const start = Date.UTC(2026, 9, 5, 12, 0);
// A read at `minute`, in `location`, with the active class's XP and the balances as given.
const read = (minute, location, { xp = 0, level = 10, next = 1000, silver = 0, gold = 0, className = 'Warrior' } = {}) =>
  ({ at: start + minute * MIN, className, level, currentXp: xp, nextLevelXp: next, silver, gold, location });
// Feeds reads to a fresh tracker and returns the intervals that counted.
const run = (...reads) => {
  const tracker = createTracker();
  return reads.map(next => step(tracker, next)).filter(Boolean);
};
const sum = (counted, key) => counted.reduce((total, part) => total + part[key], 0);

// An interval counts by where it started: the walk to the arena doesn't, the minute that ends back in town does.
{
  const counted = run(
    read(0, 'Town'),
    read(1, 'Arena'),
    read(2, 'Dungeon'),
    read(3, ' battle ', { xp: 50 }),
    read(4, 'Town', { xp: 120 }),
    read(5, 'Town', { xp: 120 }));
  assert.equal(sum(counted, 'ms'), 3 * MIN);
  assert.equal(sum(counted, 'xp'), 120);
}

// The idle rule: five quiet minutes still count, then counting pauses until the next gain.
{
  const quiet = [2, 3, 4, 5, 6, 7, 8, 9].map(minute => read(minute, 'Battle', { xp: 10 }));
  const counted = run(
    read(0, 'Battle'),
    read(1, 'Battle', { xp: 10 }),
    ...quiet,
    read(10, 'Battle', { xp: 20 }),
    read(11, 'Battle', { xp: 20 }));
  // 0-1 (a gain), 1-6 (five quiet minutes), 9-10 (a gain), 10-11. Minutes 6-9 are the pause.
  assert.equal(sum(counted, 'ms'), 8 * MIN);
  assert.equal(sum(counted, 'xp'), 20);
}

// A gold gain alone keeps an account from going idle.
{
  const reads = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(minute => read(minute, 'Battle', { gold: minute }));
  assert.equal(sum(run(...reads), 'ms'), 8 * MIN);
  assert.equal(sum(run(...reads), 'gold'), 8);
}

// A gap of more than three minutes is unknown, so it is dropped, gain and all, and counting starts fresh after it.
{
  const counted = run(read(0, 'Battle'), read(4, 'Battle', { xp: 500 }), read(5, 'Battle', { xp: 500 }));
  assert.equal(sum(counted, 'ms'), MIN);
  assert.equal(sum(counted, 'xp'), 0);
}

// A gap with nothing gained across it doesn't wake an idle account. Only a gain does.
{
  const counted = run(
    read(0, 'Battle'),
    read(1, 'Battle', { xp: 10 }),
    ...[2, 3, 4, 5, 6, 7, 8, 12, 13, 14].map(minute => read(minute, 'Battle', { xp: 10 })));
  // 0-1 (a gain) and 1-6 (five quiet minutes). The gap from 8 to 12 changes nothing, so 12-14 stay paused.
  assert.equal(sum(counted, 'ms'), 6 * MIN);
}

// A class switch drops its interval; later time goes to the new class.
{
  const counted = run(
    read(0, 'Battle', { className: 'Warrior' }),
    read(1, 'Battle', { className: 'Mage', xp: 300 }),
    read(2, 'Battle', { className: 'Mage', xp: 350 }));
  assert.deepEqual(counted, [{ className: 'Mage', ms: MIN, xp: 50, silver: 0, gold: 0 }]);
}

// Spending is not a loss of earnings: a drop adds nothing and takes nothing away.
{
  const counted = run(
    read(0, 'Battle', { silver: 1000 }),
    read(1, 'Battle', { silver: 400, xp: 10 }),
    read(2, 'Battle', { silver: 900, xp: 20 }));
  assert.equal(sum(counted, 'silver'), 500);
}

// A level-up counts what was left of the old level plus the progress into the new one.
{
  const counted = run(
    read(0, 'Battle', { level: 10, xp: 900, next: 1000 }),
    read(1, 'Battle', { level: 11, xp: 50, next: 1200 }));
  assert.equal(sum(counted, 'xp'), 150);
}

// The same read twice counts once, and a missing balance counts as no gain.
{
  const tracker = createTracker();
  step(tracker, read(0, 'Battle'));
  assert.equal(step(tracker, read(1, 'Battle', { xp: 5, silver: null })).silver, 0);
  assert.equal(step(tracker, read(1, 'Battle', { xp: 5 })), null);
}

// What counts as a read at all.
{
  const xp = { className: 'Warrior', level: 3, currentXp: 5, nextLevelXp: 50, updatedAt: '2026-10-05T12:00:00Z', isStale: false };
  const profile = { silver: 7, gold: 1, location: 'Arena' };
  assert.deepEqual(toRead(xp, profile), {
    at: start, className: 'Warrior', level: 3, currentXp: 5, nextLevelXp: 50, silver: 7, gold: 1, location: 'Arena'
  });
  assert.equal(toRead({ ...xp, isStale: true }, profile), null);
  assert.equal(toRead({ ...xp, updatedAt: null }, profile), null);
  assert.equal(toRead({ ...xp, className: null }, profile), null);
}

// Fighting with nothing picked waits apart from the totals, and joins the location the user picks next: every
// class of that account, whole, and no other account's.
{
  const totals = {};
  const waiting = {};
  addTo(totals, 'a', 'bellroot-arena', { className: 'Warrior', ms: MIN, xp: 10, silver: 5, gold: 1 });
  addTo(waiting, 'a', UNLABELLED, { className: 'Warrior', ms: 2 * MIN, xp: 30, silver: 0, gold: 2 });
  addTo(waiting, 'a', UNLABELLED, { className: 'Mage', ms: MIN, xp: 1, silver: 1, gold: 1 });
  addTo(waiting, 'b', UNLABELLED, { className: 'Warrior', ms: MIN, xp: 9, silver: 9, gold: 9 });
  assert.equal(absorb(waiting, totals, 'a', 'bellroot-arena'), true);
  assert.deepEqual(totals, { a: {
    Warrior: { 'bellroot-arena': { ms: 3 * MIN, xp: 40, silver: 5, gold: 3 } },
    Mage: { 'bellroot-arena': { ms: MIN, xp: 1, silver: 1, gold: 1 } }
  } });
  assert.deepEqual(Object.keys(waiting), ['b']);
  assert.equal(absorb(waiting, totals, 'a', 'bellroot-arena'), false);
}

// While a pick is still settling, the panel shows the unlabelled minutes under it without saving anything: the pick
// can change again (arrow keys pass through every option on the way), and the minutes must follow it.
{
  const totals = {};
  const waiting = {};
  addTo(totals, 'a', 'bellroot-arena', { className: 'Warrior', ms: MIN, xp: 10, silver: 5, gold: 1 });
  addTo(waiting, 'a', UNLABELLED, { className: 'Warrior', ms: 2 * MIN, xp: 30, silver: 0, gold: 2 });
  addTo(waiting, 'a', UNLABELLED, { className: 'Mage', ms: 3 * MIN, xp: 1, silver: 1, gold: 1 });
  const before = JSON.stringify([totals, waiting]);

  // Unlabelled is one thing per account, whatever class fought it.
  assert.equal(waitingMs(waiting, 'a'), 5 * MIN);
  assert.equal(waitingMs(waiting, 'nobody'), 0);

  const first = merged(totals, waiting, 'a', 'bellroot-arena');
  assert.deepEqual(first.a.Warrior, { 'bellroot-arena': { ms: 3 * MIN, xp: 40, silver: 5, gold: 3 } });
  assert.deepEqual(first.a.Mage, { 'bellroot-arena': { ms: 3 * MIN, xp: 1, silver: 1, gold: 1 } });
  const second = merged(totals, waiting, 'a', 'westhills-arena');
  assert.deepEqual(second.a.Warrior['westhills-arena'], { ms: 2 * MIN, xp: 30, silver: 0, gold: 2 });
  assert.deepEqual(second.a.Warrior['bellroot-arena'], { ms: MIN, xp: 10, silver: 5, gold: 1 });
  assert.equal(JSON.stringify([totals, waiting]), before);
  assert.equal(merged(totals, {}, 'a', 'westhills-arena'), totals);
}

// The ranking: rates per hour, sorted by the chosen column, with locations still collecting last.
{
  const totals = {};
  addTo(totals, 'a', 'bellroot-arena', { className: 'Warrior', ms: 30 * MIN, xp: 1000, silver: 600, gold: 3 });
  addTo(totals, 'a', 'westhills-arena', { className: 'Warrior', ms: 20 * MIN, xp: 1000, silver: 100, gold: 0 });
  addTo(totals, 'a', 'coldwoods-arena', { className: 'Warrior', ms: RANKED_MS - 1, xp: 99999, silver: 0, gold: 0 });
  addTo(totals, 'a', 'bellroot-arena', { className: 'Mage', ms: 60 * MIN, xp: 7, silver: 7, gold: 7 });

  const byXp = ranking(totals, 'a', 'Warrior', 'xp');
  assert.deepEqual(byXp.map(row => row.id), ['westhills-arena', 'bellroot-arena', 'coldwoods-arena']);
  assert.deepEqual(byXp.map(row => row.ranked), [true, true, false]);
  assert.equal(byXp[0].xp, 3000);
  assert.equal(byXp[1].xp, 2000);
  assert.equal(byXp[1].silver, 1200);
  assert.equal(byXp[1].gold, 6);
  assert.deepEqual(ranking(totals, 'a', 'Warrior', 'silver').map(row => row.id),
    ['bellroot-arena', 'westhills-arena', 'coldwoods-arena']);
  assert.deepEqual(ranking(totals, 'nobody', 'Warrior', 'xp'), []);
}

// Resetting one location or a whole class, forgetting accounts that are gone, and removing a location everywhere.
{
  const totals = {};
  for (const account of ['a', 'b']) {
    addTo(totals, account, 'custom-1', { className: 'Warrior', ms: MIN, xp: 1, silver: 1, gold: 1 });
    addTo(totals, account, 'bellroot-arena', { className: 'Warrior', ms: MIN, xp: 1, silver: 1, gold: 1 });
    addTo(totals, account, 'bellroot-arena', { className: 'Mage', ms: MIN, xp: 1, silver: 1, gold: 1 });
  }
  reset(totals, 'a', 'Warrior', 'bellroot-arena');
  assert.deepEqual(Object.keys(totals.a.Warrior), ['custom-1']);
  reset(totals, 'a', 'Mage');
  assert.deepEqual(Object.keys(totals.a), ['Warrior']);
  removeLocation(totals, 'custom-1');
  assert.deepEqual(totals, { b: { Warrior: { 'bellroot-arena': { ms: MIN, xp: 1, silver: 1, gold: 1 } }, Mage: { 'bellroot-arena': { ms: MIN, xp: 1, silver: 1, gold: 1 } } } });
  prune(totals, new Set(['a']));
  assert.deepEqual(totals, {});
}

// The user's own locations: cleaned, unique against every other name, and never able to break a card.
{
  const custom = [];
  assert.deepEqual(addLocation(custom, '  North   Cave '), { id: 'custom-1', name: 'North Cave' });
  assert.equal(addLocation(custom, 'north cave'), null);
  assert.equal(addLocation(custom, 'bellroot arena'), null);
  assert.equal(addLocation(custom, '   '), null);
  assert.equal(addLocation(custom, 'Line\nbreak‮').name, 'Linebreak');
  assert.equal(addLocation(custom, 'x'.repeat(80)).name.length, 30);
  assert.deepEqual(custom.map(location => location.id), ['custom-1', 'custom-2', 'custom-3']);
  // A cut never lands in the middle of an emoji, which would leave half a character a card refuses.
  assert.equal(addLocation(custom, 'y'.repeat(29) + '😀').name, 'y'.repeat(29));
  assert.equal(prefix('ab😀cd', 3), 'ab');
  assert.equal(prefix('ab😀cd', 4), 'ab😀');
  assert.equal(prefix('abc', 10), 'abc');
}

// The built-in list, and saved data that isn't what the plugin wrote.
{
  assert.equal(BUILT_IN.length, 10);
  assert.equal(new Set(BUILT_IN.map(location => location.id)).size, 10);
  assert.deepEqual(BUILT_IN.filter(location => location.kind === 'dungeon').map(location => location.name), ['Bellroot G1']);
  assert.deepEqual(loadCustom([{ id: 'custom-2', name: 'Cave' }, { id: 'bellroot-arena', name: 'Fake' }, 'junk', null]),
    [{ id: 'custom-2', name: 'Cave' }]);
  assert.deepEqual(loadCustom('junk'), []);
  assert.deepEqual(loadTotals(['junk']), {});
  assert.deepEqual(loadTotals({ a: {} }), { a: {} });
}

console.log('farm.mjs: all checks passed');
