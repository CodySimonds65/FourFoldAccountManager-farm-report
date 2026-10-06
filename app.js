// Farm report: XP, silver and gold per hour by where each account is fighting. The game never names the arena, so
// the user picks it. Where FourFold has the live game feed, each account also gets Live areas, counted from the exact
// scene and every fight's reward. The counting rules are in farm.mjs.
import {
  BUILT_IN, UNLABELLED, absorb, addLive, addLocation, addTo, areaName, createLiveTracker, createTracker, isFighting,
  liveStep, loadCustom, loadTotals, merged, prefix, prune, ranking, removeLocation, reset, step, toRead, waitingMs
} from './farm.mjs';

const container = document.getElementById('accounts');
const empty = document.getElementById('empty');
const customList = document.getElementById('custom');
const ADD = '+add';

let totals = {}; // what has been counted, by account, class and location; saved
let custom = []; // the user's own locations; saved
let saveTotals = false;
let saveCustom = false;
// What open accounts have fought with nothing picked, in the same shape as totals. In memory only, so it can only
// ever join a location picked in the same session.
const unlabelled = {};
const picks = new Map(); // account id -> location id. In memory only: a forgotten pick must not outlive the session.
const pickedAt = new Map(); // account id -> when its pick last changed
// A pick takes the unlabelled minutes for good only once it has stood this long. Until then they are shown under it
// but not moved: arrow keys pass through every option on the way, and a mis-click gets corrected.
const SETTLE_MS = 30000;
const trackers = new Map(); // account id -> tracker; open accounts only
const blocks = new Map(); // account id -> that account's elements in the panel
const shown = new Map(); // account id -> { label, className, fighting }: what the last refresh saw
const classChoice = new Map(); // account id -> the class the user chose to look at, when it isn't the active one
let sortKey = 'xp';
let confirming = null; // the one control showing "Yes / No" right now, as "<account id>|<what>"

// Live areas. The live game feed is FourFold's plugin API 3; on an older FourFold these namespaces don't exist and
// none of this runs, so the plugin works there exactly as before.
const live = typeof fourfold.location?.onChanged === 'function';
let liveTotals = {}; // what live areas have counted, by account, class and scene; saved
let saveLive = false;
let liveState = null; // 'active', 'off' or 'unavailable', as FourFold reports the feed
const liveTrackers = new Map(); // account id -> live tracker; open accounts only

const exact = value => Math.round(value).toLocaleString('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
// The panel is narrow, so a big number is shown compact. Its exact value is on hover.
const short = value => (Math.abs(value) >= 100000 ? compact.format(value) : exact(value));
// A card's text can be at most 40 characters, and FourFold refuses a longer line, so clip it.
const fit = text => (text.length > 40 ? `${prefix(text, 39)}…` : text);
// A location's name with what follows it, in a card's 40 characters. When they don't fit, the name gives way, so
// the number and its unit are never the part that is cut.
const named = (name, rest) => (name.length + rest.length > 40 ? `${prefix(name, 39 - rest.length)}…${rest}` : `${name}${rest}`);
const nameOf = id => [...BUILT_IN, ...custom].find(location => location.id === id)?.name ?? 'Removed location';
const warn = error => console.warn(error.code ?? error.message);

function span(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, className, text) {
  const created = document.createElement(tag);
  if (className) created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function button(text, className, onClick) {
  const created = element('button', className, text);
  created.type = 'button';
  created.addEventListener('click', onClick);
  return created;
}

function option(value, text) {
  const created = element('option', '', text);
  created.value = value;
  return created;
}

// The locations as option groups: arenas, dungeons, then the user's own.
function locationOptions() {
  const groups = [
    { label: 'Arenas', locations: BUILT_IN.filter(location => location.kind === 'arena') },
    { label: 'Dungeons', locations: BUILT_IN.filter(location => location.kind === 'dungeon') },
    { label: 'Your locations', locations: custom }
  ];
  return groups.filter(group => group.locations.length > 0).map(group => {
    const created = element('optgroup');
    created.label = group.label;
    created.append(...group.locations.map(location => option(location.id, location.name)));
    return created;
  });
}

// A control that asks "Yes / No" in its own place before it acts, because confirm() does nothing in a plugin page.
function confirmed(key, text, title, act) {
  if (confirming !== key) {
    const ask = button(text, 'quiet', () => {
      confirming = key;
      redraw(true);
    });
    ask.title = title;
    return ask;
  }
  const box = element('span', 'confirm', `${title}? `);
  box.append(
    button('Yes', 'quiet', () => {
      confirming = null;
      act();
      redraw(true);
      render();
    }),
    button('No', 'quiet', () => {
      confirming = null;
      redraw(true);
    }));
  return box;
}

// Sets what an account is farming. What it fought unlabelled this session shows under the pick at once, and is
// moved there for good by settle().
function pick(id, locationId) {
  picks.set(id, locationId);
  pickedAt.set(id, Date.now());
}

// Moves an account's unlabelled minutes into its pick and marks the totals for saving.
function settle(id) {
  if (picks.has(id) && absorb(unlabelled, totals, id, picks.get(id))) saveTotals = true;
}

// An account's totals as the panel and card show them: with unlabelled minutes under the pick while it settles.
const shownTotals = id => (picks.has(id) ? merged(totals, unlabelled, id, picks.get(id)) : totals);

// One account's block, built once. Its handlers look the account up by id, so they never hold stale data.
function createBlock(id) {
  const root = element('div', 'account');
  const parts = { root, title: element('h2'), pick: element('select'), add: element('div', 'add'), body: element('div') };
  const label = element('label', '', 'Farming');
  label.append(parts.pick);
  const input = element('input');
  input.type = 'text';
  input.maxLength = 30;
  input.placeholder = 'Location name';
  const problem = element('p', 'problem');
  parts.add.hidden = true;

  const close = () => {
    parts.add.hidden = true;
    input.value = '';
    problem.textContent = '';
  };
  const add = () => {
    const added = addLocation(custom, input.value);
    if (!added) {
      problem.textContent = 'Enter a name that isn\'t in the list yet.';
      return;
    }
    saveCustom = true;
    pick(id, added.id);
    close();
    redraw(true);
    render();
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') add();
    if (event.key === 'Escape') close();
  });
  parts.add.append(input, button('Add', '', add), button('Cancel', 'quiet', close), problem);

  parts.pick.addEventListener('change', () => {
    if (parts.pick.value === ADD) {
      // "Add location…" is a command, not a pick: put the pick back and open the box.
      parts.pick.value = picks.get(id) ?? '';
      parts.add.hidden = false;
      input.focus();
      return;
    }
    if (parts.pick.value) pick(id, parts.pick.value);
    else picks.delete(id);
    redraw(true);
    render();
  });

  root.append(parts.title, label, parts.add, parts.body);
  return parts;
}

// Feeds one live event to an account's tracker and adds what it counts. Nothing is counted while the feed isn't
// active. A fight's reward names its class; any other event takes the class the last read saw.
function liveEvent(id, event) {
  if (liveState !== 'active') return false;
  let tracker = liveTrackers.get(id);
  if (!tracker) liveTrackers.set(id, (tracker = createLiveTracker()));
  const counted = liveStep(tracker, { ...event, className: event.className ?? shown.get(id)?.className ?? null });
  if (!counted) return false;
  addLive(liveTotals, id, counted);
  saveLive = true;
  return true;
}

// The Live areas part of an account's block: its class's areas, ranked like the picks, XP and silver only.
function liveRows(id, className) {
  /** @type {HTMLElement[]} */
  const rows = [element('p', 'live-head', 'Live areas')];
  if (liveState !== 'active') {
    rows.push(element('p', 'muted', liveState === 'off'
      ? 'The live game feed is off in FourFold\'s Settings.'
      : 'The live game feed isn\'t available right now.'));
  }
  // A fight's reward has no gold, so a gold sort ranks live areas by XP.
  const ranked = ranking(liveTotals, id, className, sortKey === 'gold' ? 'xp' : sortKey);
  const current = liveTrackers.get(id)?.active;
  for (const entry of ranked) {
    const battles = liveTotals[id][className][entry.id].battles;
    const row = element('div', entry.id === current ? 'row current' : 'row');
    const head = element('p', 'name', `${areaName(entry.id)} · ${span(entry.ms)} · ${battles} ${battles === 1 ? 'fight' : 'fights'}`);
    head.append(confirmed(`${id}|live|${entry.id}`, '×', 'Reset', () => {
      reset(liveTotals, id, className, entry.id);
      saveLive = true;
    }));
    row.append(head);
    if (entry.ranked) {
      const rates = element('p', 'rates', `${short(entry.xp)} XP · ${short(entry.silver)} silver /hr`);
      rates.title = `${exact(entry.xp)} XP and ${exact(entry.silver)} silver per hour`;
      row.append(rates);
    } else {
      row.append(element('p', 'rates muted', 'Collecting'));
    }
    rows.push(row);
  }
  if (ranked.length === 0) {
    rows.push(element('p', 'muted', 'Fight in a dungeon or arena and it shows here, no pick needed.'));
  } else {
    rows.push(confirmed(`${id}|live-class`, 'Reset live', `Reset live areas for ${className}`, () => {
      reset(liveTotals, id, className);
      saveLive = true;
    }));
  }
  return rows;
}

// The body of one account's block: its class's ranking, the resets, and Unlabelled while nothing is picked.
function body(id, className) {
  const rows = [];
  const view = shownTotals(id);
  const classes = Object.keys(view[id] ?? {});
  if (!classes.includes(className)) classes.unshift(className);
  if (classes.length > 1) {
    const choose = element('select', 'class');
    choose.append(...classes.map(name => option(name, name)));
    choose.value = className;
    choose.addEventListener('change', () => {
      classChoice.set(id, choose.value);
      redraw(true);
    });
    rows.push(choose);
  }

  // Only while nothing is picked: once there is a pick, these minutes show under it. One row for the account,
  // whatever class fought them, because the next pick takes them all.
  const waiting = picks.has(id) ? 0 : waitingMs(unlabelled, id);
  if (waiting > 0) {
    const row = element('div', 'row unlabelled');
    const head = element('p', 'name', `Unlabelled · ${span(waiting)}`);
    head.append(confirmed(`${id}|discard`, 'Discard', 'Discard', () => { delete unlabelled[id]; }));
    row.append(head, element('p', 'rates muted', 'Pick a location above to count it there.'));
    rows.push(row);
  }

  const ranked = ranking(view, id, className, sortKey);
  if (ranked.length > 0) {
    const sort = element('p', 'sort', 'Best by ');
    for (const [key, text] of [['xp', 'XP'], ['silver', 'Silver'], ['gold', 'Gold']]) {
      sort.append(button(text, key === sortKey ? 'quiet chosen' : 'quiet', () => {
        sortKey = key;
        redraw(true);
      }));
    }
    rows.push(sort);
  }
  for (const entry of ranked) {
    const row = element('div', picks.get(id) === entry.id ? 'row current' : 'row');
    const head = element('p', 'name', `${nameOf(entry.id)} · ${span(entry.ms)}`);
    head.append(confirmed(`${id}|${entry.id}`, '×', 'Reset', () => {
      // What is on show is what gets reset, so minutes still settling under the pick are moved in first.
      settle(id);
      reset(totals, id, className, entry.id);
      saveTotals = true;
    }));
    row.append(head);
    if (entry.ranked) {
      const rates = element('p', 'rates', `${short(entry.xp)} XP · ${short(entry.silver)} silver · ${short(entry.gold)} gold /hr`);
      rates.title = `${exact(entry.xp)} XP, ${exact(entry.silver)} silver and ${exact(entry.gold)} gold per hour`;
      row.append(rates);
    } else {
      row.append(element('p', 'rates muted', 'Collecting'));
    }
    rows.push(row);
  }

  if (ranked.length === 0 && waiting === 0) rows.push(element('p', 'muted', `Nothing counted for ${className} yet.`));
  if (ranked.length > 0) rows.push(confirmed(`${id}|class`, `Reset ${className}`, `Reset all of ${className}`, () => {
    settle(id);
    reset(totals, id, className);
    saveTotals = true;
  }));
  if (live) rows.push(...liveRows(id, className));
  return rows;
}

// Draws everything from what the last refresh saw. A refresh leaves alone whatever the user is in the middle of
// using; `force` is for when the user has just acted and must see the result.
function redraw(force = false) {
  for (const [id, parts] of blocks) {
    if (!shown.has(id)) {
      parts.root.remove();
      blocks.delete(id);
    }
  }
  [...shown].forEach(([id, account], index) => {
    let parts = blocks.get(id);
    if (!parts) blocks.set(id, (parts = createBlock(id)));
    // Moving a block drops its focus, so only move one that is out of place.
    if (container.children[index] !== parts.root) container.insertBefore(parts.root, container.children[index] ?? null);
    parts.title.textContent = account.label;
    parts.title.title = account.label;
    parts.root.classList.toggle('unpicked', account.fighting && !picks.has(id));

    // Never rebuild a control the user is in the middle of using.
    if (force || document.activeElement !== parts.pick) {
      parts.pick.replaceChildren(option('', 'Not farming'), ...locationOptions(), option(ADD, 'Add location…'));
      parts.pick.value = picks.get(id) ?? '';
    }
    if (force || !parts.body.contains(document.activeElement)) {
      const chosen = classChoice.get(id);
      const className = chosen && shownTotals(id)[id]?.[chosen] ? chosen : account.className;
      if (className) parts.body.replaceChildren(...body(id, className));
      else parts.body.replaceChildren(element('p', 'muted', 'Waiting for this account\'s first read.'));
    }
  });
  empty.hidden = shown.size > 0;

  if (force || !customList.contains(document.activeElement)) {
    const rows = custom.map(location => {
      const row = element('p', 'name', location.name);
      row.append(confirmed(`custom|${location.id}`, '×', 'Delete, with its data', () => {
        removeLocation(totals, location.id);
        custom = custom.filter(other => other.id !== location.id);
        for (const [id, pick] of picks) {
          if (pick === location.id) picks.delete(id);
        }
        saveTotals = true;
        saveCustom = true;
      }));
      return row;
    });
    customList.replaceChildren(...(rows.length > 0 ? rows : [element('p', 'muted', 'None yet. Use "Add location…" in a Farming list.')]));
  }
}

async function setCard(id, className) {
  const pick = picks.get(id);
  const ranked = className ? ranking(shownTotals(id), id, className, 'xp') : [];
  const mine = ranked.find(entry => entry.id === pick);
  const best = ranked.find(entry => entry.ranked);
  const rows = [{ label: 'Farming', value: fit(pick ? nameOf(pick) : 'Not picked') }];
  if (pick) {
    rows.push(
      { label: 'XP/hr', value: mine?.ranked ? short(mine.xp) : 'Collecting' },
      { label: 'Silver/hr', value: mine?.ranked ? short(mine.silver) : 'Collecting' });
  }
  if (best && best.id !== pick) rows.push({ label: 'Best', value: named(nameOf(best.id), ` ${short(best.xp)}`) });
  const summary = !pick ? 'Not picked' : named(nameOf(pick), mine?.ranked ? `: ${short(mine.xp)} XP/hr` : ': collecting');
  await fourfold.cards.set('farm', id, { summary, rows });
}

async function refresh() {
  const accounts = await fourfold.accounts.list();
  const known = new Set(accounts.map(account => account.id));
  const before = Object.keys(totals).length;
  prune(totals, known);
  if (Object.keys(totals).length !== before) saveTotals = true;
  const liveBefore = Object.keys(liveTotals).length;
  prune(liveTotals, known);
  if (Object.keys(liveTotals).length !== liveBefore) saveLive = true;

  const open = accounts.filter(account => account.isOpen);
  // A closed account's session is over: its pick and its card go with it.
  for (const id of [...trackers.keys()]) {
    if (open.every(account => account.id !== id)) {
      // Its session is over: what it fought unlabelled joins the pick it closed with, or goes.
      settle(id);
      trackers.delete(id);
      liveTrackers.delete(id);
      picks.delete(id);
      pickedAt.delete(id);
      classChoice.delete(id);
      delete unlabelled[id];
      await fourfold.cards.clear('farm', id).catch(() => {});
    }
  }

  const seen = new Map();
  for (const account of open) {
    let tracker = trackers.get(account.id);
    if (!tracker) trackers.set(account.id, (tracker = createTracker()));
    const xp = await fourfold.xp.get(account.id);
    const profile = await fourfold.profile.get(account.id);
    // FourFold has started this account's tracking over (its profile was edited, say). The reads before and after
    // may not even be of the same player, so nothing is measured across the restart.
    if (xp.updatedAt === null) trackers.set(account.id, (tracker = createTracker()));
    // Both answers come from one read. If a new read landed between the two calls, wait for the next refresh.
    const read = xp.updatedAt === profile.updatedAt ? toRead(xp, profile) : null;
    const counted = read ? step(tracker, read) : null;
    if (counted && picks.has(account.id)) {
      addTo(totals, account.id, picks.get(account.id), counted);
      saveTotals = true;
    } else if (counted) {
      addTo(unlabelled, account.id, UNLABELLED, counted);
    }
    if (picks.has(account.id) && Date.now() - pickedAt.get(account.id) >= SETTLE_MS) settle(account.id);
    const className = tracker.last?.className ?? null;
    // A choice of which class to look at doesn't outlive a change of the class being played.
    if (shown.get(account.id)?.className !== className) classChoice.delete(account.id);
    seen.set(account.id, { label: account.label, className, fighting: isFighting(tracker.last?.location) });
    // Time passing between fights: keeps a live area's clock current, and lets the idle rule pause it.
    if (live) liveEvent(account.id, { type: 'tick', at: Date.now() });
  }
  // Swapped in whole, so a click that lands while the reads are still coming in finds every block in place.
  shown.clear();
  for (const [id, account] of seen) shown.set(id, account);

  redraw();
  for (const [id, account] of shown) {
    // A refused card must not stop the panel from updating.
    await setCard(id, account.className).catch(warn);
  }
  // A refused save is tried again at the next refresh. The locations go first, because the totals name them.
  if (saveCustom) {
    saveCustom = false;
    await fourfold.storage.set('custom', custom).catch(error => { saveCustom = true; warn(error); });
  }
  if (saveTotals) {
    saveTotals = false;
    await fourfold.storage.set('totals', totals).catch(error => { saveTotals = true; warn(error); });
  }
  if (saveLive) {
    saveLive = false;
    await fourfold.storage.set('liveTotals', liveTotals).catch(error => { saveLive = true; warn(error); });
  }
}

// Events arrive in bursts (xp.onUpdated fires once per account). Refreshes run one after another, and a burst asks
// for one more refresh, not one each.
let queue = Promise.resolve();
let waiting = false;
function render() {
  if (waiting) return queue;
  waiting = true;
  queue = queue.then(() => {
    waiting = false;
    return refresh();
  }).catch(warn);
  return queue;
}

// Live events arrive one at a time, every few seconds while fighting. A fight's reward goes through a full refresh,
// which also saves it; the rest only need the panel redrawn.
function startLive() {
  const at = event => Date.parse(event.at);
  fourfold.live.onStatusChanged(status => {
    liveState = status.state;
    // Time can't be counted across a stretch the feed didn't see.
    if (liveState !== 'active') liveTrackers.clear();
    redraw(true);
  });
  fourfold.location.onChanged(event => {
    liveEvent(event.accountId, { type: 'location', at: at(event), scene: event.scene, inBattle: event.inBattle });
    redraw();
  });
  fourfold.battle.onStarted(event => {
    liveEvent(event.accountId, { type: 'start', at: at(event) });
    redraw();
  });
  fourfold.battle.onResult(event => {
    const counted = liveEvent(event.accountId, {
      type: 'result', at: at(event), xp: event.expGained, silver: event.silverGained, className: event.className ?? undefined
    });
    if (counted) render();
  });
  fourfold.session.onDisconnected(event => {
    liveEvent(event.accountId, { type: 'disconnect', at: at(event) });
    redraw();
  });
}

async function start() {
  totals = loadTotals(await fourfold.storage.get('totals'));
  custom = loadCustom(await fourfold.storage.get('custom'));
  if (live) {
    liveTotals = loadTotals(await fourfold.storage.get('liveTotals'));
    liveState = (await fourfold.live.getStatus().catch(() => null))?.state ?? null;
    startLive();
  }
  fourfold.accounts.onChanged(render);
  fourfold.xp.onUpdated(render);
  // A safety net for a missed event; the reads themselves change about once a minute.
  setInterval(render, 60000);
  await render();
}

start().catch(error => { container.textContent = `Farm report failed: ${error.message}`; });
