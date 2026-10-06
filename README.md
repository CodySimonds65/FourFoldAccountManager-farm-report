# Farm report

A plugin for [FourFold Account Manager](https://github.com/CodySimonds65/FourFoldAccountManager). It measures the XP,
silver and gold an account earns per hour by where it is fighting, and ranks the locations for each class, so you can
see which arena or dungeon pays best.

It is listed on the [plugin hub](https://github.com/CodySimonds65/FourFoldAccountManager-plugin-hub), so FourFold
users install it from the plugin list: the wrench in the plugin strip, then **Plugin hub**.

## How to use it

The game doesn't say which arena a character is in: its profile reads "Arena" in every hub, "Dungeon" inside one and
"Battle" in a fight. So you tell the plugin: pick the location in the account's **Farming** list before you go in.
The list has the game's arenas and dungeons, and **Add location…** adds your own.

- Fighting with nothing picked shows as **Unlabelled**. Pick the location and those minutes show under it at once.
  For the next half minute they follow the pick if you change it; after that they stay where they are. If they were
  fought somewhere else, discard them first. Unlabelled is kept until the account closes.
- A pick lasts until the account closes or FourFold restarts. It isn't remembered, so that a forgotten pick ends up
  in Unlabelled, where you can fix it, and not under the wrong location.
- A location is ranked once it has 10 minutes counted. Until then it shows "Collecting".
- The overlay card shows the pick, its rates, and the class's best location.

## How it counts

FourFold reads an account about once a minute, and only while its game is open. Each minute between two reads counts
toward the pick when:

- the account was in Arena, Dungeon or Battle at the start of it. The hub counts, so a location that needs more
  re-entering scores lower, as it should;
- the active class was the same at both ends;
- the account isn't idle: after 5 minutes with no XP, silver or gold gained, counting pauses until the next gain.

Silver and gold count what was earned: spending doesn't lower a rate. Results are kept per account and class, because
what a location pays depends on who is fighting there.

Two limits follow from one-minute data. A short run is coarse, which is why 10 minutes are needed. And gaining more
than one level inside a single minute undercounts XP.

## For plugin authors

The counting rules are in `farm.mjs`, which touches neither the page nor `window.fourfold`, so they can be checked
outside FourFold. `app.js` reads the API and draws. To start your own plugin, use the
[plugin template](https://github.com/CodySimonds65/FourFoldAccountManager-plugin-template); the API is documented in
[PLUGIN_AUTHORS.md](https://github.com/CodySimonds65/FourFoldAccountManager/blob/main/PLUGIN_AUTHORS.md).

## Run it from source

1. In FourFold, open the plugin list (the wrench in the plugin strip), switch on **Developer mode**, and press
   **Open dev plugins folder**.
2. Clone this repository into that folder.

While developer mode is on, the copy in the dev folder runs instead of the one installed from the hub. It uses the
same saved data, so what you count or reset there is changed for the installed plugin too.

## Checks

All need Node.js.

```bash
node .check/farm.check.mjs
```

```bash
npx -p typescript tsc -p jsconfig.json
```

The first checks the counting rules. The second checks the scripts against `fourfold.d.ts`, which comes from the
plugin template along with `jsconfig.json`.

To look at the panel without FourFold, on made-up data:

```bash
python -m http.server 8765
```

then open `http://localhost:8765/.check/preview.html` in a window about 250 pixels wide. `.check/` is left out of the
hub's package, because its name starts with a dot.

## License

[Apache 2.0](LICENSE).
