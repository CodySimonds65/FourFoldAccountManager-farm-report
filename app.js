// Farm report: XP and silver per hour for every dungeon or arena each account fights in, from FourFold's live game
// feed. Nothing to pick: the feed names the exact area and reports every fight's reward. The counting rules are in
// farm.mjs.
import { addLive, areaName, createLiveTracker, liveStep, loadTotals, prefix, prune, ranking, reset } from './farm.mjs';

const container = document.getElementById('accounts');
const empty = document.getElementById('empty');
const statusLine = document.getElementById('status');

// The live game feed is FourFold's plugin API 3. plugin.json asks for it, so an older FourFold doesn't load this
// plugin at all; the check is for a FourFold that loads it anyway.
const hasFeed = typeof fourfold.location?.onChanged === 'function';
let totals = {}; // what has been counted, by account, class and area; saved
let saveTotals = false;
let feed = { state: null, reason: null }; // the live game feed's status as FourFold reports it
const trackers = new Map(); // account id -> live tracker; open accounts only
// account id -> the class the last fight was fought as. Before an account's first fight, the class the last read saw.
const classOf = new Map();
const blocks = new Map(); // account id -> that account's elements in the panel
const shown = new Map(); // account id -> { label }: the open accounts the last refresh saw
const classChoice = new Map(); // account id -> the class the user chose to look at, when it isn't the current one
let sortKey = 'xp';
let confirming = null; // the one control showing "Yes / No" right now, as "<account id>|<what>"

const exact = value => Math.round(value).toLocaleString('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
// The panel is narrow, so a big number is shown compact. Its exact value is on hover.
const short = value => (Math.abs(value) >= 100000 ? compact.format(value) : exact(value));
// A card's text can be at most 40 characters, and FourFold refuses a longer line, so clip it.
const fit = text => (text.length > 40 ? `${prefix(text, 39)}…` : text);
// An area's name with what follows it, in a card's 40 characters. When they don't fit, the name gives way, so the
// number and its unit are never the part that is cut.
const named = (name, rest) => (name.length + rest.length > 40 ? `${prefix(name, 39 - rest.length)}…${rest}` : `${name}${rest}`);
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

// A control that asks "Yes / No" in its own place before it acts, because confirm() does nothing in a plugin page.
// `label` names a control whose text alone (×) means nothing to a screen reader.
function confirmed(key, text, title, act, label) {
  if (confirming !== key) {
    const ask = button(text, 'quiet', () => {
      confirming = key;
      redraw(true);
    });
    ask.title = title;
    if (label) ask.setAttribute('aria-label', label);
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

// Feeds one live event to an account's tracker and adds what it counts. Nothing is counted while the feed isn't
// active. A fight's reward names its class; any other event takes the account's current class.
function liveEvent(id, event) {
  if (feed.state !== 'active') return false;
  let tracker = trackers.get(id);
  if (!tracker) trackers.set(id, (tracker = createLiveTracker()));
  if (typeof event.className === 'string') classOf.set(id, event.className);
  const counted = liveStep(tracker, { ...event, className: classOf.get(id) ?? null });
  if (!counted) return false;
  addLive(totals, id, counted);
  saveTotals = true;
  return true;
}

// Where an account is now, as its block's second line says it.
function whereText(id) {
  const area = trackers.get(id)?.area;
  return area ? `In ${areaName(area)}` : 'Not seen in an area yet';
}

// One account's block, built once. Its handlers look the account up by id, so they never hold stale data.
function createBlock() {
  const root = element('div', 'account');
  const parts = { root, title: element('h2'), where: element('p', 'where muted'), body: element('div') };
  root.append(parts.title, parts.where, parts.body);
  return parts;
}

// The body of one account's block: its class's areas, ranked, and the resets.
function body(id, className) {
  /** @type {HTMLElement[]} */
  const rows = [];
  const classes = Object.keys(totals[id] ?? {});
  if (!classes.includes(className)) classes.unshift(className);
  if (classes.length > 1) {
    const choose = element('select', 'class');
    choose.setAttribute('aria-label', 'Class');
    choose.append(...classes.map(name => option(name, name)));
    choose.value = className;
    choose.addEventListener('change', () => {
      classChoice.set(id, choose.value);
      redraw(true);
    });
    rows.push(choose);
  }

  const ranked = ranking(totals, id, className, sortKey);
  if (ranked.length > 0) {
    const sort = element('p', 'sort', 'Best by ');
    for (const [key, text] of [['xp', 'XP'], ['silver', 'Silver']]) {
      const choice = button(text, key === sortKey ? 'quiet chosen' : 'quiet', () => {
        sortKey = key;
        redraw(true);
      });
      choice.setAttribute('aria-pressed', String(key === sortKey));
      sort.append(choice);
    }
    rows.push(sort);
  }

  const current = trackers.get(id)?.active;
  for (const entry of ranked) {
    const row = element('div', entry.id === current ? 'row current' : 'row');
    const fights = `${entry.battles} ${entry.battles === 1 ? 'fight' : 'fights'}`;
    const head = element('p', 'name', `${areaName(entry.id)} · ${span(entry.ms)} · ${fights}`);
    head.append(confirmed(`${id}|${entry.id}`, '×', 'Reset', () => {
      reset(totals, id, className, entry.id);
      saveTotals = true;
    }, `Reset ${areaName(entry.id)}`));
    row.append(head);
    if (entry.rated) {
      const rates = element('p', 'rates', `${short(entry.xp)} XP · ${short(entry.silver)} silver /hr`);
      rates.title = `${exact(entry.xp)} XP and ${exact(entry.silver)} silver per hour`;
      if (!entry.ranked) rates.append(element('span', 'muted', ' · early'));
      row.append(rates);
    } else {
      row.append(element('p', 'rates muted', 'Collecting'));
    }
    rows.push(row);
  }

  if (ranked.length === 0) {
    rows.push(element('p', 'muted', `Nothing counted for ${className} yet. Fight in a dungeon or arena.`));
  } else {
    rows.push(confirmed(`${id}|class`, `Reset ${className}`, `Reset all of ${className}`, () => {
      reset(totals, id, className);
      saveTotals = true;
    }));
  }
  return rows;
}

function statusText() {
  if (!hasFeed) return 'This FourFold has no live game feed. Update FourFold to use Farm report.';
  if (feed.state === 'off') return 'The live game feed is off. Switch it on in FourFold\'s Settings.';
  if (feed.state === 'unavailable') return `The live game feed isn't available: ${feed.reason ?? 'unknown reason'}`;
  return '';
}

// Draws everything from what the last refresh saw. A refresh leaves alone whatever the user is in the middle of
// using; `force` is for when the user has just acted and must see the result.
function redraw(force = false) {
  const status = statusText();
  statusLine.textContent = status;
  statusLine.hidden = status === '';

  for (const [id, parts] of blocks) {
    if (!shown.has(id)) {
      parts.root.remove();
      blocks.delete(id);
    }
  }
  [...shown].forEach(([id, account], index) => {
    let parts = blocks.get(id);
    if (!parts) blocks.set(id, (parts = createBlock()));
    // Moving a block drops its focus, so only move one that is out of place.
    if (container.children[index] !== parts.root) container.insertBefore(parts.root, container.children[index] ?? null);
    parts.title.textContent = account.label;
    parts.title.title = account.label;
    parts.where.textContent = whereText(id);
    if (force || !parts.body.contains(document.activeElement)) {
      const chosen = classChoice.get(id);
      const className = chosen && totals[id]?.[chosen] ? chosen : classOf.get(id);
      if (className) parts.body.replaceChildren(...body(id, className));
      else parts.body.replaceChildren(element('p', 'muted', 'Waiting for this account\'s class.'));
    }
  });
  empty.hidden = shown.size > 0;
}

async function setCard(id) {
  const className = classOf.get(id);
  const ranked = className ? ranking(totals, id, className, 'xp') : [];
  const area = trackers.get(id)?.active ?? trackers.get(id)?.area ?? null;
  const mine = ranked.find(entry => entry.id === area);
  const best = ranked.find(entry => entry.ranked);
  const rows = [{ label: 'Area', value: fit(area ? areaName(area) : 'Not seen yet') }];
  if (area) {
    rows.push(
      { label: 'XP/hr', value: mine?.rated ? short(mine.xp) : 'Collecting' },
      { label: 'Silver/hr', value: mine?.rated ? short(mine.silver) : 'Collecting' });
  }
  if (best && best.id !== area) rows.push({ label: 'Best', value: named(areaName(best.id), ` ${short(best.xp)}`) });
  const summary = !area ? 'Not seen yet' : named(areaName(area), mine?.rated ? `: ${short(mine.xp)} XP/hr` : ': collecting');
  await fourfold.cards.set('farm', id, { summary, rows });
}

async function refresh() {
  const accounts = await fourfold.accounts.list();
  const before = Object.keys(totals).length;
  prune(totals, new Set(accounts.map(account => account.id)));
  if (Object.keys(totals).length !== before) saveTotals = true;

  const open = accounts.filter(account => account.isOpen);
  for (const id of [...shown.keys()]) {
    if (open.every(account => account.id !== id)) {
      // A closed account's session is over: its clock and its card go with it. Its totals stay.
      trackers.delete(id);
      classOf.delete(id);
      classChoice.delete(id);
      await fourfold.cards.clear('farm', id).catch(() => {});
    }
  }

  // The status read at start failed: nothing counts until the feed's state is known, so ask again.
  if (feed.state === null) feed = await fourfold.live.getStatus().catch(() => feed);

  shown.clear();
  for (const account of open) {
    // Before an account's first fight, its class is what the last read saw.
    if (!classOf.has(account.id)) {
      const xp = await fourfold.xp.get(account.id).catch(() => null);
      if (typeof xp?.className === 'string') classOf.set(account.id, xp.className);
    }
    shown.set(account.id, { label: account.label });
    // After a restart, or the feed coming back, the area is unknown until the next scene load, and the fight under
    // way would count nothing. FourFold knows the scene now, so start from it.
    if (feed.state === 'active' && !trackers.get(account.id)?.area) {
      const where = await fourfold.location.get(account.id).catch(() => null);
      if (where?.scene) {
        liveEvent(account.id, { type: 'location', at: Date.parse(where.at), scene: where.scene, inBattle: where.inBattle });
      }
    }
    // Time passing between fights: keeps an area's clock current, and lets the idle rule pause it.
    liveEvent(account.id, { type: 'tick', at: Date.now() });
  }

  redraw();
  for (const id of shown.keys()) {
    // A refused card must not stop the panel from updating.
    await setCard(id).catch(warn);
  }
  // A refused save is tried again at the next refresh.
  if (saveTotals) {
    saveTotals = false;
    await fourfold.storage.set('liveTotals', totals).catch(error => { saveTotals = true; warn(error); });
  }
}

// Refreshes run one after another, and a burst of requests asks for one more refresh, not one each.
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

// A move or a fight start changes the card's area, which shouldn't wait for the next refresh. Its write joins the
// refresh queue, so it never races a refresh's own, and a burst of events writes each card once. It doesn't save:
// those events add no reward, and the next refresh saves any time they added.
const cardsDue = new Set();
function updateCard(id) {
  if (cardsDue.has(id)) return;
  cardsDue.add(id);
  queue = queue.then(() => {
    cardsDue.delete(id);
    // An account the last refresh didn't see open has no card to keep current.
    if (shown.has(id)) return setCard(id);
  }).catch(warn);
}

// Live events arrive one at a time, every few seconds while fighting. A fight's reward goes through a full refresh,
// which also saves it and updates the card; a move or a fight start redraws the panel and updates the card.
function listen() {
  const at = event => Date.parse(event.at);
  fourfold.live.onStatusChanged(status => {
    feed = status;
    // Time can't be counted across a stretch the feed didn't see.
    if (feed.state !== 'active') trackers.clear();
    redraw(true);
  });
  fourfold.location.onChanged(event => {
    liveEvent(event.accountId, { type: 'location', at: at(event), scene: event.scene, inBattle: event.inBattle });
    redraw();
    updateCard(event.accountId);
  });
  fourfold.battle.onStarted(event => {
    liveEvent(event.accountId, { type: 'start', at: at(event) });
    redraw();
    updateCard(event.accountId);
  });
  fourfold.battle.onResult(event => {
    liveEvent(event.accountId, {
      type: 'result', at: at(event), xp: event.expGained, silver: event.silverGained, className: event.className ?? undefined
    });
    render();
  });
  fourfold.session.onDisconnected(event => {
    liveEvent(event.accountId, { type: 'disconnect', at: at(event) });
    redraw();
  });
}

// Farm report 1.x counted picked locations from one-minute reads. Those totals can't be turned into areas, so 2.0
// deletes them, once, to free the plugin's storage.
async function dropPickData() {
  for (const key of ['totals', 'custom']) {
    if ((await fourfold.storage.get(key)) !== null) await fourfold.storage.remove(key);
  }
}

async function start() {
  if (!hasFeed) {
    redraw(true);
    return;
  }
  await dropPickData().catch(warn);
  totals = loadTotals(await fourfold.storage.get('liveTotals'));
  feed = await fourfold.live.getStatus().catch(() => feed);
  listen();
  fourfold.accounts.onChanged(render);
  // A safety net for a missed event, and the clock between fights.
  setInterval(render, 30000);
  await render();
}

start().catch(error => { container.textContent = `Farm report failed: ${error.message}`; });
