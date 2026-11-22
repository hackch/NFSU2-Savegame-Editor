# Final-drive range companion mod

This is a companion **GLOBALB.BUN game-data mod**, not a save-file edit. The game clamps drivetrain values to ranges built from the installed transmission parts, so a save-editor-only slider change cannot extend the in-game range.

## Create a modded BUN

1. Back up your game's original `GLOBALB.BUN`.
2. Keep a copy of the exact BUN from your game installation.
3. Install Node.js 24 or newer.
4. From the repository folder, run one of these commands:

```powershell
node scripts/patch-final-drive.mjs "C:\path\to\GLOBALB.BUN" "C:\path\to\GLOBALB-FD-3.0.BUN" --min 3.0
node scripts/patch-final-drive.mjs "C:\path\to\GLOBALB.BUN" "C:\path\to\GLOBALB-FD-2.0-EXPERIMENTAL.BUN" --min 2.0
```

The script never overwrites the input file. It checks the BUN chunk layout, patches the 31 player-car records, and patches both duplicate final-drive tuning tables for differential, LSD, and six-speed transmission. It preserves the stock final-drive values and all other bytes.

## Modes

- **3.0**: intended normal mode; lower final-drive limit is 3.000.
- **2.0 experimental**: much wider range; test separately and expect unusual gearing/handling.

## Important compatibility notes

- Use a BUN from the same game installation/version as the one being tested.
- This changes game data globally, not just one career save. Restore the original BUN to uninstall.
- Back up career saves too. Do not test on your only save.
- The 2.0 variant is experimental and is not represented as verified in-game.
- A successful script run confirms binary structure and patch placement only; it does not replace in-game testing.
