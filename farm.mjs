// The Farm report's counting rules and totals. Nothing here touches the page or window.fourfold, so
// .check/farm.check.mjs can run it with Node.
//
// Everything is counted from FourFold's live game feed (plugin API 3): it names the exact scene an account is in and
// reports each fight's XP and silver as the fight ends. A fight's reward has no gold, so nothing here counts gold.

const HOUR_MS = 3600000;
// A gap of more than this between two events means the app wasn't running, so it adds no time.
const MAX_INTERVAL_MS = 3 * 60000;
// With no fight for this long, an area's clock pauses until the next one.
const IDLE_MS = 5 * 60000;
// An area shows a rate once it has this much time counted, marked early until it has RANKED_MS. Live rewards are
// exact, so a short run is only as noisy as the fights in it.
export const RATED_MS = 60000;
export const RANKED_MS = 5 * 60000;

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

  // The time since the previous event goes to the area whose clock was running: walking between fights counts,
  // five quiet minutes still count, then the clock pauses until the next fight.
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

// Totals are kept as totals[accountId][className][scene] = { ms, xp, silver, battles }.
export function addLive(totals, accountId, counted) {
  const byArea = ((totals[accountId] ??= {})[counted.className] ??= {});
  const entry = (byArea[counted.area] ??= { ms: 0, xp: 0, silver: 0, battles: 0 });
  for (const key of ['ms', 'xp', 'silver', 'battles']) entry[key] += counted[key] ?? 0;
}

// Removes what `select` picks from one account and class, then drops any container left empty.
function remove(totals, accountId, className, select) {
  const byClass = totals[accountId];
  const byArea = byClass?.[className];
  if (!byArea) return;
  for (const scene of Object.keys(byArea)) {
    if (select(scene)) delete byArea[scene];
  }
  if (Object.keys(byArea).length === 0) delete byClass[className];
  if (Object.keys(byClass).length === 0) delete totals[accountId];
}

// Clears one area for an account and class, or the whole class when no area is given.
export function reset(totals, accountId, className, scene) {
  remove(totals, accountId, className, id => scene === undefined || id === scene);
}

// Drops accounts that no longer exist, so the store doesn't grow for ever.
export function prune(totals, knownAccountIds) {
  for (const accountId of Object.keys(totals)) {
    if (!knownAccountIds.has(accountId)) delete totals[accountId];
  }
}

// One account and class's areas with their rates per hour, best first by `key` ('xp' or 'silver'). Areas with
// RANKED_MS counted come first, then early ones; areas still under RATED_MS have no rate yet and come last.
export function ranking(totals, accountId, className, key) {
  const byArea = totals[accountId]?.[className] ?? {};
  const tier = entry => (entry.ranked ? 2 : entry.rated ? 1 : 0);
  return Object.entries(byArea)
    .filter(([, entry]) => entry.ms > 0)
    .map(([id, entry]) => ({
      id,
      ms: entry.ms,
      battles: entry.battles ?? 0,
      rated: entry.ms >= RATED_MS,
      ranked: entry.ms >= RANKED_MS,
      xp: entry.xp * HOUR_MS / entry.ms,
      silver: entry.silver * HOUR_MS / entry.ms
    }))
    .sort((a, b) => tier(b) - tier(a) || b[key] - a[key]);
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

export function loadTotals(saved) {
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}
