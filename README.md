# Farm report

A plugin for [FourFold Account Manager](https://github.com/CodySimonds65/FourFoldAccountManager). It measures the XP and
silver an account earns per hour in every dungeon or arena it fights in, and ranks those areas for each class, so you
can see which one pays best.

It is listed on the [plugin hub](https://github.com/CodySimonds65/FourFoldAccountManager-plugin-hub), so FourFold
users install it from the plugin list: the wrench in the plugin strip, then **Plugin hub**.

## What it needs

FourFold's live game feed (plugin API 3), switched on in FourFold's Settings. The feed reads each of your own game
panels as you play: it names the exact area an account is in and reports every fight's reward the moment the fight
ends. An older FourFold doesn't offer Farm report 2.0.

## How to use it

There is nothing to set up. Open your accounts and fight; each account's block lists the areas it has fought in, with
its XP and silver per hour there, the time counted and the number of fights. The area it's in now is highlighted.

- A rate shows once an area has a minute counted, marked *early* until it has five. Areas with five minutes rank
  above early ones.
- Results are kept per account and class, because what an area pays depends on who is fighting there. The class is
  read from each fight's reward, so switching class splits the totals at the next fight.
- **×** resets one area, and **Reset** under the list resets the class.
- The overlay card shows the current area, its rates, and the class's best area.

## How it counts

- An area's clock starts at its first fight there and includes walking between fights, so an area that needs more
  re-entering scores lower, as it should. A fight's own scene counts toward the dungeon or arena it was entered from.
- Five quiet minutes still count; then the clock pauses until the next fight.
- A reload or a closed panel stops the clock. A fight the game resumes after the re-login still counts for its area.
- A fight's reward has no gold, so Farm report counts XP and silver only.

Farm report 1.x had you pick the location and counted from one-minute profile reads. Those totals can't be turned into
areas, so 2.0 deletes them the first time it starts.

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

then open `http://localhost:8765/.check/preview.html` in a window about 250 pixels wide (add `?nolive` to see the
message a FourFold without the live game feed gets). `.check/` is left out of the hub's package, because its name
starts with a dot.

## License

[Apache 2.0](LICENSE).
