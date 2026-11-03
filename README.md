# NFSU2 Savegame Editor

A browser-based career save editor for Need for Speed: Underground 2 (`SPEED2.EXE` saves, 54,966-byte `20CM` files). Everything runs locally in the browser. Nothing is uploaded.

The live site is deployed to GitHub Pages from `main`. See [doc.md](doc.md) for what we know about the save format.

## Features

- Edit driver name and money, with checksums recalculated on download.
- View each car slot's make and model, read from the car type hash.
- Replace or add a car in a slot. Tuning is kept.
- Edit mapped performance parts and separate unique-performance flags.
- Dyno: simulate peak power and torque, 0–60, 0–100, quarter mile and top speed per setup (metric and imperial side by side), and auto-tune the ECU and turbo curves (needs your game's `GLOBALB.BUN`).
- Swap slots (experimental) and unlock all slots.

## Development

Requirements: Node.js 24 or newer.

```
npm ci
npm run build    # compiles src/ to dist/ and copies static files
npm test         # build, then run the test suite
npm run clean    # remove dist/
```

Each build stamps the header with the package version and a UTC build number (`YYYYMMDDhhmmss`). The splash label lives in `index.html`; update it for the next feature milestone.

The source layout is:

- `src/model/`: save parsing and editing logic, with no DOM access.
- `src/data/`: static tables (performance parts, unlock ranges).
- `src/controller/`: the AngularJS controller, scope types, and file-input directive.
- `src/main.ts`: AngularJS bootstrap.
- `src/test/`: tests.

AngularJS 1.8.2 is loaded from a CDN in `index.html`.

## Running locally

The editor fetches `car-donors.json`, so it must be served over HTTP rather than opened from disk. After `npm run build`, serve `dist/`:

```
cd dist
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/index.html`.

## Deployment

`.github/workflows/deploy.yml` runs the tests and builds on every push to `main`, then deploys `dist/` to GitHub Pages. In the repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions** once.

## Usage

1. Choose a career save (for example `treav0r`). Files are read in the browser and never uploaded.
2. Edit the driver name and money, then click **Apply profile**.
3. Filled car slots show their make and model, identified by the car type hash at slot offset `+0x014`. Hashes absent from the donor list show as unknown; locked/open slots hide the car name.
4. **Replace car** (or **Add car** for an empty slot) writes a donor car's slot blocks. Tuning is kept.
5. Tune performance parts, install or stock a slot, or swap two slots.
6. Click **Download edited save**. Checksums are recalculated on download.

1. Choose a career save (for example `treav0r`). Files are read in the browser and never uploaded.
2. Edit the driver name and money, then click **Apply profile**.
3. Filled car slots show their make and model, identified by the car type hash at slot offset `+0x014`. Hashes absent from the donor list show as unknown; locked/open slots hide the car name.
4. **Replace car** (or **Add car** for an empty slot) writes a donor car's slot blocks. Tuning is kept.
5. Tune performance parts, install or stock a slot, or swap two slots.
6. Click **Download edited save**. Checksums are recalculated on download.

## Notes

- `car-donors.json` is a copy of the donor table from GabriLex's `nfsu2profilemaster`. It contains each car's per-slot blocks, plus save-wide blocks that the editor ignores.
- **Replace car** writes only the slot's own blocks (`+0x000`, `+0x0E0`, `+0x2B0`). Save-wide blocks are not touched. Filling an empty slot copies the used-slot header from another slot, which is unverified. Test in game before relying on it.
- Variants with the same car type hash (base, sponsor and intro versions) show the first name listed. The separate `+0x2BC` model key is not used for names: different cars such as Sentra, Golf and Tiburon share it.
- **Swap (experimental)** copies a whole car slot block. It has not been tested in-game.
- **Tuning** shows performance part names and ordinary packages, without internal keys, offsets, prices or purchase-bit details. Inactive parts are disabled and visual-related flags are not shown. Technical mappings are recorded in [technical.md](technical.md).
- **MAX OUT** (in the tuning dialog header) enables the 54 active performance bytes, including mutually exclusive parts, and sets the nine unique flags; the game's own apply routine does not do this. It does not change the visual-related flags, purchase bookkeeping or inactive IDs. Only the muffler (15) and cold air intake (16) edits are confirmed by in-game save diffs.
- **Unique** controls edit separate per-car category flags without a confirmation prompt. They do not emulate the unique shop's event-status update or full reward process. See [technical.md](technical.md) for the code trace and evidence limits.
- **Unlock all** sets the 420 bytes that NFSU2-ProfileCreator writes as `0xFF` in each car slot (ranges in [src/data/unlock-table.ts](src/data/unlock-table.ts), offsets `+0x462` to `+0x7E1`). It only writes those bytes. The byte-to-part mapping and the in-game effect are not verified yet.
- **Dyno** (in the tuning dialog) reads car data from `GLOBAL\GLOBALB.BUN` in your NFSU2 folder; the file is read locally and not shipped with the editor. A car needs a tunable ECU, turbo or transmission package installed. By default, **Auto-tune ECU & turbo** writes only the 18 curve bytes of the selected setup. Times come from the game's own dyno simulation and are not yet checked against the in-game screen. See [technical.md](technical.md).
- **Optimize gearing** is unchecked by default. Enable it to include unlocked final-drive and forward-gear settings in time/speed optimization. Apply saves those settings alongside the curves, leaving other setups and unrelated bytes unchanged. Locked and unused gears are preserved. Gearing does not affect engine peak power/torque, so those goals leave it unchanged even when checked. The game's adjacent-gear constraints and byte normalization are included; see [technical.md](technical.md#gearing-trace).
- Auto-tune goals: quickest quarter mile, 0–60 mph or 0–100 mph; highest top speed; maximum peak horsepower or torque. Power and torque goals maximize the displayed peaks (hp/kW and N·m/lb-ft), not average output across the rpm range.

## Tests

```
npm test
```

Fixture tests read `testfile/treav0r` and skip when that file is missing. `testfile/` is gitignored. Dyno tests also need `GLOBALB.BUN`; they use the default install path or `NFSU2_GLOBALB`, and skip when it is missing.
