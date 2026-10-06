// The Farm report's counting rules, totals and locations. Nothing here touches the page or window.fourfold, so
// .check/farm.check.mjs can run it with Node.

const HOUR_MS = 3600000;
// Reads are a minute apart. A longer gap means reads were missed, and what happened in it is unknown.
const MAX_INTERVAL_MS = 3 * 60000;
// With no gain for this long, counting pauses until the next one.
const IDLE_MS = 5 * 60000;
// A location is ranked once it has this much time counted. One-minute data makes a shorter run unreliable.
export const RANKED_MS = 10 * 60000;
// The name fighting with nothing picked is counted under. It waits apart from the saved totals, for the session
// only, until the user picks a location (it joins that one) or discards it.
export const UNLABELLED = 'unlabelled';

// The profile page never names the arena: it says Arena in every hub, Dungeon inside one, and Battle in a fight.
const FIGHTING = ['arena', 'dungeon', 'battle'];

// The ids are what is saved, so a location can be renamed here without losing its data.
export const BUILT_IN = [
  { id: 'bellroot-arena', name: 'Bellroot Arena', kind: 'arena' },
  { id: 'bleakwoods-arena', name: 'Bleakwoods Arena', kind: 'arena' },
  { id: 'coldwoods-arena', name: 'Coldwoods Arena', kind: 'arena' },
  { id: 'deafields-arena', name: 'Deafields Arena', kind: 'arena' },
  { id: 'summerville-arena', name: 'Summerville Arena', kind: 'arena' },
  { id: 'westhills-arena', name: 'Westhills Arena', kind: 'arena' },
  { id: 'underworld-arena', name: 'Underworld Arena', kind: 'arena' },
  { id: 'plagued-grounds-arena', name: 'Plagued Grounds Arena', kind: 'arena' },
  { id: 'death-dunes-arena', name: 'Death Dunes Arena', kind: 'arena' },
  { id: 'bellroot-g1', name: 'Bellroot G1', kind: 'dungeon' }
];

export const isFighting = location => typeof location === 'string' && FIGHTING.includes(location.trim().toLowerCase());

// One answer pair from fourfold.xp.get and fourfold.profile.get, cut down to what counting needs. Null when it
// isn't a read: the account is closed or stale, or has no active class to count for.
export function toRead(xp, profile) {
  const at = typeof xp.updatedAt === 'string' ? Date.parse(xp.updatedAt) : NaN;
  if (xp.isStale || Number.isNaN(at) || typeof xp.className !== 'string') return null;
  return {
    at,
    className: xp.className,
    level: xp.level,
    currentXp: xp.currentXp,
    nextLevelXp: xp.nextLevelXp,
    silver: profile.silver,
    gold: profile.gold,
    location: profile.location
  };
}

// Earned only: a drop is spending, and a missing value is no gain.
const increase = (before, after) => (Number.isFinite(before) && Number.isFinite(after) ? Math.max(0, after - before) : 0);

// The active class's progress between two reads of the same class. Across a level-up it is what was left of the old
// level plus the progress into the new one; the levels between, when more than one was gained, aren't known.
function xpGained(before, after) {
  if (!Number.isFinite(before.level) || !Number.isFinite(after.level)) return 0;
  if (after.level === before.level) return increase(before.currentXp, after.currentXp);
  if (after.level < before.level || !Number.isFinite(after.currentXp)) return 0;
  return increase(before.currentXp, before.nextLevelXp) + after.currentXp;
}

// One account's place in the stream of reads. Kept in memory only: a closed account starts over.
export function createTracker() {
  return { last: null, lastGainAt: null };
}

// Takes one read. Returns what the interval since the previous read adds ({ className, ms, xp, silver, gold }), or
// null when that interval doesn't count.
export function step(tracker, read) {
  const previous = tracker.last;
  // The same read again: xp.onUpdated also fires for changes that aren't a new read.
  if (previous && read.at <= previous.at) return null;
  tracker.last = read;
  if (!previous) {
    tracker.lastGainAt = read.at;
    return null;
  }

  const ms = read.at - previous.at;
  const sameClass = previous.className === read.className;
  const gain = {
    xp: sameClass ? xpGained(previous, read) : 0,
    silver: increase(previous.silver, read.silver),
    gold: increase(previous.gold, read.gold)
  };
  const gained = gain.xp > 0 || gain.silver > 0 || gain.gold > 0;
  const wasIdle = previous.at - tracker.lastGainAt >= IDLE_MS;
  // A gain wakes an idle account, and so does one that arrived somewhere in a gap. A gap with nothing gained doesn't.
  if (gained) tracker.lastGainAt = read.at;
  // What happened across a gap is unknown, so it isn't counted, gain and all.
  if (ms > MAX_INTERVAL_MS) return null;

  // By where the interval started: the minute that ends back in town still holds the last battle's reward, and the
  // minute spent walking to the arena holds none.
  if (!sameClass || !isFighting(previous.location) || (wasIdle && !gained)) return null;
  return { className: read.className, ms, ...gain };
}

// Totals are kept as totals[accountId][className][locationId] = { ms, xp, silver, gold }.
export function addTo(totals, accountId, locationId, counted) {
  const byLocation = ((totals[accountId] ??= {})[counted.className] ??= {});
  const entry = (byLocation[locationId] ??= { ms: 0, xp: 0, silver: 0, gold: 0 });
  for (const key of ['ms', 'xp', 'silver', 'gold']) entry[key] += counted[key];
}

// Removes what `select` picks from one account and class, then drops any container left empty.
function remove(totals, accountId, className, select) {
  const byClass = totals[accountId];
  const byLocation = byClass?.[className];
  if (!byLocation) return;
  for (const id of Object.keys(byLocation)) {
    if (select(id)) delete byLocation[id];
  }
  if (Object.keys(byLocation).length === 0) delete byClass[className];
  if (Object.keys(byClass).length === 0) delete totals[accountId];
}

// Clears one location for an account and class, or the whole class when no location is given.
export function reset(totals, accountId, className, locationId) {
  remove(totals, accountId, className, id => locationId === undefined || id === locationId);
}

// The user has picked a location: what the account fought unlabelled this session joins it, every class of it.
// Returns whether there was anything to move.
export function absorb(waiting, totals, accountId, locationId) {
  const byClass = waiting[accountId];
  if (!byClass) return false;
  for (const [className, byLocation] of Object.entries(byClass)) {
    if (byLocation[UNLABELLED]) addTo(totals, accountId, locationId, { className, ...byLocation[UNLABELLED] });
  }
  delete waiting[accountId];
  return true;
}

// How long an account has fought unlabelled this session, over every class: Unlabelled is one thing per account.
export function waitingMs(waiting, accountId) {
  return Object.values(waiting[accountId] ?? {}).reduce((total, byLocation) => total + (byLocation[UNLABELLED]?.ms ?? 0), 0);
}

// The account's totals as the panel shows them while a pick is settling: with its unlabelled minutes already under
// the pick, but nothing moved or saved. The pick can still change, and then they show under the new one.
export function merged(totals, waiting, accountId, locationId) {
  if (!waiting[accountId]) return totals;
  const shown = structuredClone({ [accountId]: totals[accountId] ?? {} });
  absorb(structuredClone({ [accountId]: waiting[accountId] }), shown, accountId, locationId);
  return shown;
}

// Drops a location's data from every account and class, as when the user deletes one of their own.
export function removeLocation(totals, locationId) {
  for (const accountId of Object.keys(totals)) {
    for (const className of Object.keys(totals[accountId])) reset(totals, accountId, className, locationId);
  }
}

// Drops accounts that no longer exist, so the store doesn't grow for ever.
export function prune(totals, knownAccountIds) {
  for (const accountId of Object.keys(totals)) {
    if (!knownAccountIds.has(accountId)) delete totals[accountId];
  }
}

// One account and class's locations with their rates per hour, best first by `key` ('xp', 'silver' or 'gold').
// Locations still collecting come last.
export function ranking(totals, accountId, className, key) {
  const byLocation = totals[accountId]?.[className] ?? {};
  return Object.entries(byLocation)
    .filter(([, entry]) => entry.ms > 0)
    .map(([id, entry]) => ({
      id,
      ms: entry.ms,
      ranked: entry.ms >= RANKED_MS,
      xp: entry.xp * HOUR_MS / entry.ms,
      silver: entry.silver * HOUR_MS / entry.ms,
      gold: entry.gold * HOUR_MS / entry.ms
    }))
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || b[key] - a[key]);
}

// A name as typed: without control or invisible formatting characters (a card refuses text that has them), with
// runs of spaces closed up, and at most 30 characters so it fits a card's row.
function cleanName(text) {
  return prefix(String(text).replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim(), 30).trim();
}

// The start of a text, as whole characters, in at most `max` UTF-16 units (what FourFold counts a card's 40 in):
// a cut never splits an emoji in two.
export function prefix(text, max) {
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > max) break;
    kept += character;
  }
  return kept;
}

// Adds one of the user's own locations. Returns it, or null when the name is empty or already in use.
export function addLocation(custom, text) {
  const name = cleanName(text);
  const taken = [...BUILT_IN, ...custom].some(location => location.name.toLowerCase() === name.toLowerCase());
  if (!name || taken) return null;
  const highest = custom.reduce((most, location) => Math.max(most, Number(location.id.slice('custom-'.length)) || 0), 0);
  const added = { id: `custom-${highest + 1}`, name };
  custom.push(added);
  return added;
}

// What was saved, kept only where it has the shape this plugin writes.
export function loadCustom(saved) {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(location => location && typeof location.id === 'string' && location.id.startsWith('custom-') &&
      typeof location.name === 'string')
    .map(location => ({ id: location.id, name: location.name }));
}

export function loadTotals(saved) {
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

// --- Live areas: FourFold's live game feed (plugin API 3) ---
// The feed names the exact scene an account is in and reports each fight's XP and silver as it ends, so live areas
// need no pick and aren't limited to one-minute reads. A fight's reward has no gold, so live areas count none.

// One account's place in the stream of live events. `area` is the scene it last walked into; `active` is the area
// whose clock is running, which starts at the area's first fight. Kept in memory only.
export function createLiveTracker() {
  return { at: null, area: null, active: null, lastActivityAt: null };
}

// Takes one live event: { type, at, className, ... } where type is 'location' (with scene and inBattle), 'start',
// 'result' (with xp and silver), 'disconnect', or 'tick' (time passing with nothing new). Returns what it adds
// ({ area, className, ms, xp, silver, battles }), or null when it adds nothing.
export function liveStep(tracker, event) {
  // Late or out of order: the time it would cover was already counted.
  if (tracker.at !== null && event.at < tracker.at) return null;
  const previousAt = tracker.at;
  tracker.at = event.at;

  // The time since the previous event goes to the area whose clock was running, the same way reads count: walking
  // between fights counts, five quiet minutes still count, then the clock pauses until the next fight. A gap of
  // more than three minutes means the app wasn't running, so it adds no time.
  const ms = previousAt === null ? 0 : event.at - previousAt;
  const idle = tracker.lastActivityAt === null || previousAt - tracker.lastActivityAt >= IDLE_MS;
  const counted = { area: tracker.active, className: event.className, ms: 0, xp: 0, silver: 0, battles: 0 };
  if (tracker.active !== null && !idle && ms <= MAX_INTERVAL_MS) counted.ms = ms;

  switch (event.type) {
    case 'location':
      // A fight's own scene belongs to the area it was entered from, so only the scenes outside fights move it.
      if (!event.inBattle && typeof event.scene === 'string' && event.scene !== tracker.area) {
        tracker.area = event.scene;
        tracker.active = null;
      }
      break;
    case 'start':
      if (tracker.area !== null) tracker.active = tracker.area;
      tracker.lastActivityAt = event.at;
      break;
    case 'result':
      // A reward without its fight start (the panel opened mid-fight) still belongs to the area it came from.
      tracker.active ??= tracker.area;
      tracker.lastActivityAt = event.at;
      if (tracker.active !== null) {
        counted.area = tracker.active;
        counted.xp = event.xp;
        counted.silver = event.silver;
        counted.battles = 1;
      }
      break;
    case 'disconnect':
      // A reload or a closed panel stops the clock. The area is kept: after the re-login the game resumes the fight.
      tracker.active = null;
      break;
  }

  if (counted.area === null || typeof counted.className !== 'string' || (counted.ms === 0 && counted.battles === 0)) {
    return null;
  }
  return counted;
}

// Live totals are kept as liveTotals[accountId][className][scene] = { ms, xp, silver, gold, battles }, the same shape
// as the pick totals (gold is always 0), so ranking, reset and prune work on both.
export function addLive(totals, accountId, counted) {
  const byArea = ((totals[accountId] ??= {})[counted.className] ??= {});
  const entry = (byArea[counted.area] ??= { ms: 0, xp: 0, silver: 0, gold: 0, battles: 0 });
  for (const key of ['ms', 'xp', 'silver', 'battles']) entry[key] += counted[key];
}

// A scene's name as the panel shows it: westhills_b2_dungeon_01 is "Westhills B2 · Dungeon 1", coldwoods_arena is
// "Coldwoods Arena". Built from the scene itself, so a new area in the game needs no update here.
export function areaName(scene) {
  const parts = String(scene ?? '').trim().split('_').filter(Boolean);
  if (parts.length === 0) return 'Unknown area';
  const word = part => (/^\d+$/.test(part) ? String(Number(part))
    : /^[a-z]\d+$/i.test(part) ? part.toUpperCase()
    : part[0].toUpperCase() + part.slice(1).toLowerCase());
  const inside = parts.findIndex((part, index) => index > 0 && part.toLowerCase() === 'dungeon');
  const name = inside > 0
    ? `${parts.slice(0, inside).map(word).join(' ')} · ${parts.slice(inside).map(word).join(' ')}`
    : parts.map(word).join(' ');
  // Not cut to a card's length: the panel wraps long names, and a card clips them itself.
  return name.replace(/[\p{Cc}\p{Cf}]/gu, '');
}
