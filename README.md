# NFSU2-Savegame-Editor
A WiP Savegame Editor for NFSU2 (`SPEED2.EXE` career saves, 54,966-byte `20CM` files).

## Usage

Host the repo root on GitHub Pages, or serve it locally (for example `python -m http.server`), then open `index.html`. No build step is needed. Opening `index.html` directly from disk cannot load `car-donors.json`, so car replacement will be disabled.

1. Choose a career save (for example `treav0r`). Files are read in the browser and never uploaded.
2. Edit the driver name and money, then click **Apply profile**.
3. Each car slot shows its make and model, read from the model key at slot offset `+0x2BC`. Keys that are not in the donor list show as unknown.
4. **Replace car** (or **Add car** for an empty slot) writes a donor car's slot blocks. Tuning is kept.
5. Tune performance parts, install or stock a slot, or swap two slots.
6. Click **Download edited save**. Checksums are recalculated on download.

## Notes

- `car-donors.json` is a copy of the donor table from GabriLex's `nfsu2profilemaster`. It contains each car's per-slot blocks, plus save-wide blocks that the editor ignores.
- **Replace car** writes only the slot's own blocks (`+0x000`, `+0x0E0`, `+0x2B0`). Save-wide blocks are not touched. Filling an empty slot copies the used-slot header from another slot, which is unverified. Test in game before relying on it.
- Cars that share a model key (base, sponsor and intro versions) show the first name listed.
- **Swap (experimental)** copies a whole car slot block. It has not been tested in-game.
- **Install all** turns on all 68 performance-part flags. Only the muffler (15) and cold air intake (16) flags are verified in-game.
- **Unlock all** sets the 420 bytes that NFSU2-ProfileCreator writes as `0xFF` in each car slot (ranges in `unlock-table.js`, offsets `+0x462` to `+0x7E1`). It only writes those bytes. The byte-to-part mapping and the in-game effect are not verified yet.

## Tests

```
node --test
```

Fixture tests read `testfile\treav0r` and skip when that file is missing. `testfile\` is gitignored.
