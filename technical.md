# Technical notes: performance tuning

## Three separate kinds of state

For zero-based garage index `i=0..4`, the editor uses `S(i) = 0x5870 + i * 0x7F2`. This is eight bytes after the actual serialized record boundary (`0x5868 + i * 0x7F2`).

| State | Absolute file address | Format | GUI operation |
|---|---|---|---|
| Installed item | `S(i) + 0x310 + itemId` | One byte per ID | Raw edit for non-visual IDs |
| Purchased/owned part | `S(i) + 0x586 + (itemId >> 3)` | Bit mask `1 << (itemId & 7)` | Read-only |
| Unique performance category | `S(i) + 0x2E8 + categoryIndex * 4` | Four-byte little-endian integer | Flag-only edit (confirmed working in game) |

Installing, owning and receiving a unique are **not interchangeable**. The editor does not simulate purchases or complete rewards.

## Names, IDs and ordinary packages

- The EXE's 68-entry name-pointer table is at file `0x403570`; keys begin with `PERF_PART_`. ID positions match [perf-parts.ts](src/data/perf-parts.ts), including the full nitrous names (`DRY_SHOT_OF_NITROUS`, `WET_SHOT_OF_NITROUS`, `DIRECT_PORT_NITROUS_OXIDE`).
- `FUN_00500000` loads active records from `GLOBALB.BUN` child chunk `0x34A15`: 30 groups of `0x17C` bytes, containing item records of `0x5C` bytes. Each item supplies its ID, label hash, price, five conflict IDs and two prerequisite IDs.
- This build has **66 active IDs: 54 non-aero plus 12 aero/body**. IDs 33 (tie bars) and 34 (bushings) have names but no active records. Their positions must not be removed or subsequent IDs renumbered.
- Levels 1/2/3 are displayed as Street/Pro/Extreme for the ordinary performance categories. They are not uniques. ID 36 (camber kit) is level 2 even though ID 35 is level 3.
- `FUN_005A6320` changes installed byte `performanceSubobject + 0x50 + itemId` and clears listed conflicts. For example, nitrous IDs 12/13/14 exclude each other; muffler 15 and cat-back 19 exclude each other. The editor's raw controls do not enforce these exclusions.
- Ordinary purchase routine `FUN_00521B00` deducts money, sets ownership through `FUN_00503E10`, increases an accumulator (saved at `S(i)+0x6BE`) and appends a companion value at `S(i)+0x6CA`. That companion value's full meaning remains unknown. Installed-byte edits do none of this.
- Ownership readers `FUN_005155A0` / `FUN_00530350` use the bit formula above. IDs 64-67 address a ninth byte, `S(i)+0x58E`; whether visual purchases use those bits remains unverified.

## Visual-derived group-9 flags

The executable keeps the twelve AE IDs in the same internal installed-item array, but `FUN_006399D0` derives them from visual parts during a car refresh. `FUN_00639CE0(0, ...)` invokes this path for a car whose ID is not `-1`, and the reconstruction is gated by the byte at `0x7FC290`. Its initialized value in this EXE is `1`; its value in every possible runtime state has not been verified.

In the ordinary branch, `FUN_005A6450(9)` clears the group-9 item flags. The routine then reads visual-part pointers at `car+0x590+visualSlot*4`; for a non-null pointer, the top three bits of `part+5` give a level, capped at 3. A nonzero level selects the corresponding ID, and `FUN_00599680` / `FUN_005A6320` sets its installed flag and applies item conflicts:

| Visual slot | Part | IDs for levels 1, 2, 3 | First record's corresponding bytes |
|---:|---|---|---|
| `1` | Front bumper | 56, 57, 58 | `0x5BB8`-`0x5BBA` |
| `2` | Rear bumper | 62, 63, 64 | `0x5BBE`-`0x5BC0` |
| `0x0B` | Sideskirts | 59, 60, 61 | `0x5BBB`-`0x5BBD` |
| `0x0C` | Spoiler | 65, 66, 67 | `0x5BC1`-`0x5BC3` |

For slot `i`, add `i * 0x7F2` to those file offsets. When the descriptor in visual slot 6 has a nonzero level, a separate branch instead calls `FUN_005A64A0(3, 9)`, clearing and applying group-9 items by level; the meaning of that visual slot is not established. In a synthetic execution with the examined archive table, this branch left IDs 58, 61, 64 and 67 set after conflicts were applied.

`FUN_00503880` reconstructs visual pointers from a stored car configuration, copies its performance subobject, and refreshes that car. `FUN_00503950` can copy its installed bytes back to a runtime garage record, and the serializer maps those bytes to the offsets above. The inspected visual-selection path `FUN_0055C230` changes the configuration at `manager+0x940` and passes it to `FUN_00503950`. Its call to `FUN_004D8EC0` can also refresh a separate display copy via `FUN_004D8C70` and `FUN_004D8030`, conditional on a display object being available; that copy is not the source passed to this writer. Similar setter/writer sequences occur in `FUN_0055F080`, `FUN_00563D00`, `FUN_00567A50` and `FUN_00569670`. This trace confirms a conditional visual-to-flag reconstruction, **not** that every visual purchase immediately saves the reconstructed flags. No before/after in-game visual-purchase save diff has verified that final step. `FUN_0050E790` supplies category-label hashes only for indices 0-8, consistent with treating group 9 separately, but does not establish that no other game screen ever uses it.

Synthetic x86 execution used the original EXE instructions and archive item table with synthetic car/part data. It checked 36 refresh cases (including all four visual slots, levels 0-7, the disabled gate and the slot-6 branch) and 60 combinations of the 12 IDs and five garage slots through `FUN_00503950` and the relevant copy at the start of `FUN_00516620`. No game helpers were stubbed in those executed paths; execution stopped after the relevant refresh or serializer copy, not after a complete save or purchase.

## Unique category mapping

`FUN_0050E790` returns the `PERF_CATEGORY_*` label hashes, matched through `LANGUAGES\Labels.bin`. The browser offers a category when its dword is zero; selection writes `1` (`01 00 00 00`).

| Index | Category key suffix | Editor-relative | First garage record |
|---:|---|---:|---:|
| 0 | `WEIGHT_REDUCTION` | `+0x2E8` | `0x5B58` |
| 1 | `TRANSMISSION` | `+0x2EC` | `0x5B5C` |
| 2 | `NOS` | `+0x2F0` | `0x5B60` |
| 3 | `ENGINE` | `+0x2F4` | `0x5B64` |
| 4 | `TURBO` | `+0x2F8` | `0x5B68` |
| 5 | `SUSPENSION` | `+0x2FC` | `0x5B6C` |
| 6 | `BRAKE` | `+0x300` | `0x5B70` |
| 7 | `ECU` | `+0x304` | `0x5B74` |
| 8 | `TIRES` | `+0x308` | `0x5B78` |

For any garage record: **`0x5B58 + i * 0x7F2 + categoryIndex * 4`**. The following dword at `S(i)+0x30C` is unknown, not an established tenth/aero unique.

## What the unique shop actually does

The performance branch of browser handler `FUN_00561720`:

1. Calls `FUN_00521430`, which stores `1` at `tempCar+0x318+categoryIndex*4`.
2. Refreshes the car through `FUN_00639CE0` and `FUN_004D8EC0`, then copies its configuration back through `FUN_00503950`. Runtime garage `+0x2F4` becomes editor-relative `+0x2E8` through serializer `FUN_00516620`; `FUN_00516850` restores it. Copying the configuration can write more than the selected dword.
3. Calls `FUN_00525610`, queuing code `9` through `FUN_005111F0`. The complete queue semantics remain unverified.
4. Calls `FUN_005419C0`, finding/creating an event-name-hash entry via `FUN_00512F10` and setting entry byte `+6` to `1`. The saved count is at `0xA179`, entries start at `0xA17D` with stride 8, and the status byte is **`0xA183 + entryIndex*8`**. A particular event has no universal fixed entry index.

This is a different branch from the ordinary price/ownership-bit purchase routine. Changing only the per-car unique dword does not reproduce the event-status change or prove equivalence to a legitimate reward.

## Read-only savefile cross-check (2026-11-02)

The repository's `testfile/treav0r` and four saves extracted under the local `Downloads\nfs8` directory were checked without modifying them. All four NFS8 files were byte-identical to their entries in the original ZIP. Its readme describes externally edited tuning and most cars having all performance uniques, with transmission exceptions; these are useful positive fixtures, not proof of an unmodified in-game reward sequence.

### Unique-performance fields

All 225 dwords (five saves, five garage slots, nine categories) were read through the editor model and checked at the formula above. Every value was either 0 or 1:

| Save | Set unique fields by garage slot, 1-5 | Exceptions |
|---|---|---|
| `treav0r` | 0, 0, 0, 0, 0 | All nine fields are zero, including the empty fifth slot |
| `ecutn1b` / `ecutn1w` | 8, 9, 8, 9, 9 | Transmission alone is zero in slots 1 and 3 |
| `ecutn2b` / `ecutn2w` | 9, 9, 9, 9, 9 | None |

The first pair's slots 1 and 3 have identical category values `1,0,1,1,1,1,1,1,1` in the mapped index order. This independently agrees with the archive readme's transmission exceptions for the Corolla and 240SX. These observations support the unique-field location and transmission index, but do not independently distinguish the other eight category names, since their positive values are identical. Their names still rely on the executable's category-label mapping.

### Body/spoiler selections versus installed flags

Stored visual-part hashes are at **`S(i) + 0x18 + visualSlot * 4`**, not at the installed-flag addresses. This follows the garage-header serializer and the configuration copy: the serialized configuration starts at `S(i)+0x0C`, and its hash array at configuration `+0x0C`. Each occupied car's hashes for slots 1, 2, 6, 11 and 12 resolved uniquely by hash and slot in archive chunk `0x34604` (payload `0x70C54C`, size `0x29964`, 12,167 fourteen-byte descriptors and two zero padding bytes). This checks 120 descriptors across 24 occupied cars.

All occupied cars in these saves have descriptor level zero in visual slot 6, so the ordinary refresh branch applies when enabled. The compared twelve-byte patterns below are grouped as front bumper / sideskirts / rear bumper / spoiler; each triplet is levels 1, 2, 3, with each digit representing a complete 0/1 byte:

| Save / garage slot | Descriptor levels: front, skirts, rear, spoiler | Expected refresh flags | Actual saved flags |
|---|---|---|---|
| All four NFS8 saves, all five slots | 3, 3, 3, 4 | `001 / 001 / 001 / 001` | Exact match |
| `treav0r`, slots 1, 2 and 4 | 2, 2, 2, 3 | `010 / 010 / 010 / 001` | `111 / 111 / 111 / 111` |
| `treav0r`, slot 3 | 1, 1, 1, 4 | `100 / 100 / 100 / 001` | `111 / 111 / 111 / 111` |
| `treav0r`, empty slot 5 | No occupied-car descriptor check | All zero | All zero |

The spoiler descriptor level 4 is capped to 3 by the traced routine; it is not a fourth performance-byte level. All 240 NFS8 visual-related bytes agree with the mapping. The baseline's 48 occupied-car bytes do **not** represent the reconstructed one-level-per-part state: 32 differ from the expected refresh result. A bulk edit or stale snapshot could explain this, but its cause is not established. Do not normalize these bytes merely on load, and do not treat them as unique-performance flags.

All five files pass the editor's structural checks. `treav0r` and both `ecutn2` saves pass all three checksum checks. Both `ecutn1` saves already have a block-B checksum mismatch in the original ZIP; their block-A and header checks pass. No checksum was rewritten.

Fixture SHA-256 identities:

| Save | SHA-256 |
|---|---|
| `treav0r` | `c4b585474f9cd5c4655915029e92d6cfa37a814cf194c6c38c8e19f6c2533d00` |
| `ecutn1b` | `35269ab996192e20b94f81e75ba67bf5a67b453836a7f4e266faa24d2af6357b` |
| `ecutn1w` | `adf35c7cc9f17ac7a0b26b4e40b3b06828c19faf5f248fa25ee4b33a2e9736d4` |
| `ecutn2b` | `17f227c0450137d778d07f66b36b876bdcd322a335e217d769adfb10b16c9478` |
| `ecutn2w` | `1ff4371518791838a4a8de8bbaf65e09964703ee35134d10680afdac987972de` |

## Dyno tuning (2026-11-03)

Traced from `SPEED2.EXE`; ported in `src/model/dyno.ts`. The original port matched the Python reference model to 1e-13 on all 45 fixture setups. The gearing load was subsequently corrected and checked separately against native code as described below. There is no in-game ground truth for the simulated times yet.

### Save data

| Slot-relative | Content |
|---|---|
| `+0x014` u32 | Car type hash. Equals the BUN car record's name hash (`h = h*33 + c`, seed `0xFFFFFFFF`). The `+0x2BC` key is shared by several cars. |
| `+0x310` 68 bytes | Installed part flags (builder input). |
| `+0x2E8` 9 × u32 | Unique flags WT, TR, NO, EN, TU, SU, BR, EC, TI. |
| `+0x354` 5 × 41 bytes | Dyno setups. Index = dyno screen title: 0 Circuit, 1 Drag, 2 Drift, 3 Street X, 4 URL (`FUN_00549760`, language hashes `0x5AE1D9E5` …). Which setup a race loads is not traced. |

Slot-card names and DYNO both read `+0x014` through `getCarTypeHash`. Donor indexing uses this uint32 from donor block 1, not `+0x2BC`: Tiburon (`0x04FD0522`), Sentra (`0x79AEBFEC`) and Golf (`0x00163087`) share model-key bytes `FA26AF42`. The old key-based lookup mislabeled these replacements even though their written type hashes were correct. Same-type sponsor/intro variants retain the first donor's canonical name, including variants whose model key is zero. Tests cover all 49 donors across all five slots and controller replacement of the shared-key cars.

Setup bytes: 9 = final drive, 10–15 = gears, `0x17..0x1F` = ECU curve, `0x20..0x28` = turbo curve (9 rpm points each). Byte `b` maps to `t = clamp((b-100)/100, -1, 1)` and `value = clamp(default + t*(max-min), min, max)`, so 0–200 covers the full range.

### Game data (`GLOBAL\GLOBALB.BUN`)

| Chunk | Content |
|---|---|
| `0x34600` | Car records, stride `0x890` after `0x11` padding. Name at `+0`, hash at `+0xD0`, physics block `R` at `+0x110` (`0x2B0` bytes, then uniques at `R+0x2B0`, upgrade tables at `R+0x310`). |
| `0x34A15` | Upgrade packages, stride `0x17C`: category, level, sub-item count, 4 subs (`0x5C`, item id, attribute fractions at `+0x30`). |
| `0x34A1A` | Tuning records, stride `0x18`: item, level, param, range type, `f8`, `fC`. A param is tunable when an installed item has a record; the highest level wins (`FUN_0059ae40`). |

### Pipeline

1. **Builder** `FUN_005ac4f0`: per category, the installed fraction is the averaged package fractions (`FUN_005a6580`). Weight, transmission (gear set by level), engine, turbo and ECU (rpm limits by level) blend `R` toward the upgrade tables. Uniques add `R+0x2B0..` deltas (`FUN_005997e0`); the unique transmission's drive bias is never removed.
2. **Tuning load** `FUN_005b4780`: removes uniques, applies final drive and gears (with the gear spacing solver `FUN_005b2ed0`, minimum gap 0.05), then the ECU and turbo curves. Ranges come from `FUN_005b2980`; curve maxima are capped so no point exceeds the default curve's peak power. The torque sum before the curves is restored by spreading the difference evenly over the 9 points, then uniques are re-added.
3. **Dyno** `FUN_005b06a0`: 60 Hz drag run with shift pauses; 0–60 and 0–100 are scaled by per-car display factors, quarter mile at 400.5 m. **Top speed** `FUN_005b5ab0`/`FUN_005b5930`: force table in 1.341 m/s steps against drag, capped by the speed limiter (`R+0x290`) unless a limiter-removing part (45, 46, 51) is installed.
4. **Units**: the torque table is in kN·m and mass in tonnes. The dyno screen (`FUN_0054a620`) shows max torque as `T*1000` N·m or `*0.73756212` lb-ft, and max power in kW or `*1.34102209` hp. Peak power comes from `FUN_005ac980`: every 50 rpm from idle up to (not including) the redline, `T*1000*rpm*1.0471204e-4` kW. The editor samples peak torque the same way.

### Auto-tune

`optimizeSetup` searches bytes `0x17..0x28` of one setup by default. The optional fourth argument enables unlocked parameters 9–15 for time/speed goals. The GUI's **Optimize gearing** checkbox defaults to false and clears the proposal on change. `setSetupTuning` applies curves and optionally bytes 9–15 to that setup only; the optimizer preserves inactive and unused gear bytes. Gearing is excluded for peak power/torque goals because it cannot change engine output. Search uses coordinate descent over 0–200 (coarse step 10, then +/-9), seeded from current values and all-100, all-0 and all-200 on the searched parameters.

Goals: quarter mile (interpolated crossing time), 0–60 mph, 0–100 mph, top speed, peak horsepower, or peak torque. The 0–60 goal minimizes `t60`; horsepower maximizes `peakPower` in kW (hp is a constant conversion), and torque maximizes `peakTorque` in N·m. These three goals use only their selected metric, with no acceleration tie-breaker for peak figures; an unreachable acceleration target cannot invalidate a finite power/torque result. Peak figures are sampled as described above, not an average across the rpm range. Because of the sum restoration, lowering some points raises all others, so the best curves often look extreme. On the fixtures it gains 0.2–0.5 s on the quarter mile in about 0.2 s of browser time. Coordinate descent is a heuristic search, not a guarantee of the global optimum.

### Gearing trace

Gearing is an input to the dyno model and is included in time/speed Auto-tune searches when **Optimize gearing** is checked. The trace confirms seven scalar bytes per setup, not additional torque-curve points:

| Setup byte | Slot-relative, setup 0 | Meaning | Runtime physics field |
|---|---|---|---|
| 9 (`0x09`) | `+0x35D` | Final drive | Both `+0x1B8` and `+0x1BC` |
| 10 (`0x0A`) | `+0x35E` | 1st gear ratio | `+0x1D8` |
| 11 (`0x0B`) | `+0x35F` | 2nd gear ratio | `+0x1DC` |
| 12 (`0x0C`) | `+0x360` | 3rd gear ratio | `+0x1E0` |
| 13 (`0x0D`) | `+0x361` | 4th gear ratio | `+0x1E4` |
| 14 (`0x0E`) | `+0x362` | 5th gear ratio | `+0x1E8` |
| 15 (`0x0F`) | `+0x363` | 6th gear ratio | `+0x1EC` |

Add `setupIndex * 41` to the slot-relative offsets for the other setups. `FUN_0059b200` maps parameter IDs to physics fields; the final-drive setter `FUN_005b3fa0` writes both axle values.

**Unlocks and ranges.** `FUN_0059ae40` selects the highest installed tuning-record level. In the examined BUN, differential (ID 8) unlocks final drive at level 1; limited-slip differential (ID 9) at level 2; 6-speed transmission (ID 11) at level 3 and also unlocks the individual forward gears:

| Parameter | Level / type | Record `f8`, `fC` |
|---|---|---|
| Final drive | 1 / type 1 | `-0.05`, `+0.10` |
| Final drive | 2 / type 1 | `-0.10`, `+0.20` |
| Final drive | 3 / type 0 | `-0.20`, `+0.40` |
| 1st gear | 3 / type 1 | `-0.80`, `+1.00` |
| 2nd gear | 3 / type 1 | `-0.60`, `+0.80` |
| 3rd gear | 3 / type 1 | `-0.40`, `+0.60` |
| 4th gear | 3 / type 1 | `-0.30`, `+0.40` |
| 5th gear | 3 / type 1 | `-0.10`, `+0.25` |
| 6th gear | 3 / type 1 | `0.00`, `+0.10` |

These record values are **not all literal slider endpoints**. Final drive's absolute range starts from the stock and upgraded final drives (`R+0x1B8`, `R+0x3D8`), then `FUN_0059b160` adjusts it. Type 1 intersects that range with `default + [f8, fC]`. Level 3 uses type 0: `min = max(absMin, default - fC)`, `max = absMax` (`FUN_005b2980`, sign helper `FUN_0059b6c0`). Individual gears intersect `default + [f8, fC]` with ratios calculated by `FUN_0059b5c0` for speeds 111.75682 and 1.1175681 m/s, using wheel radius, drivetrain bias, engine rpm and the **current** final drive.

`FUN_0059b080` enables a gear only when `param - 8 < gearCount + 2`. Gear count comes from the car's installed transmission physics, not the item's "6-speed" name. For example, the upgraded Escalade fixture still has five forward gears. Unused forward ratios are zeroed by `FUN_005b3060`.

**Coupling and normalization.** `FUN_005b2ed0` clamps the requested ratio and recursively moves neighboring gears to preserve a minimum separation of `0.05000000074505806` (`0x007A1ACC`). Increasing a ratio can push the preceding gear higher; decreasing it can push the following gear lower. If a neighbor hits its range limit, the unsatisfied change propagates back to the requested gear.

`FUN_005b4780` first captures the installed default ratios, applies final drive, and applies the gear bytes in order. It then performs a second gear pass through `FUN_005b4670`. This pass re-encodes **every active gear** after each adjustment (`FUN_005b3ee0` -> `FUN_0059af80`) before the next gear byte is read:

```
ratio = clamp(default + clamp((byte - 100) / 100, -1, 1) * (max - min), min, max)
byte = clamp(trunc(100.5 + 100 * (clampedRatio - default) / (max - min)), 0, 200)
```

The writer changes the active tuning object's bytes at `this+0x14`; this trace does not establish that merely loading a setup immediately persists those normalized bytes to the career file. The TS model uses a private copy for normalization and never mutates the input save/setup. The earlier port repeated the raw bytes on the second pass and missed this feedback; it is now corrected.

**Dyno effect.** Ratios multiply torque at the wheels and determine engine rpm at each road speed. The drag simulation (`FUN_005b06a0`) includes shift interruptions, and the force/top-speed pipeline (`FUN_005b5ab0`, `FUN_005b5930`) uses the same ratios against drag and the speed limiter. Larger numerical ratios give shorter gearing, not more engine power. The game's gear display converts ratios to speed through `FUN_005b2800` / `FUN_0059b5c0`; displayed slider positions should not be mistaken for raw ratios.

**Validation.** Ghidra CLI assembly plus Unicorn execution of the actual EXE's load, recursive setter and byte writer covered 48 synthetic setups (five/six gears; neutral, minimum, maximum, conflicting and seeded random bytes). Only tuning availability/range lookups and unique-part refresh were hooked, so this verifies gearing sequencing and normalization, not the entire builder or a live game. Corrected TS ratios agree within `1.9e-7`; the old model differed by up to `0.254`. Repository tests retain native-result regressions for both gearbox sizes, inactive tuning, input immutability and both final-drive fields. Existing fixture dyno tests still pass. The gearing-enabled optimizer and isolated setup writer are also covered by repository tests, including controller Apply/download and checkbox proposal invalidation. In-game verification remains outstanding.

## Hidden / traffic vehicles

The examined `GLOBALB.BUN` car chunk contains 46 records: 31 ordinary vehicle types followed by 15 traffic types. All ordinary types already have editor donors; the remaining records are not additional normal dealership cars.

| Record index | Internal name | Car type hash (uint32) |
|---|---|---|
| 31 | TAXI | `0x001D1775` |
| 32 | 4DR_SEDAN02 | `0x90035175` |
| 33 | AMBULANCE | `0x43A98EA7` |
| 34 | TAXI02 | `0x7BC0CF17` |
| 35 | PANELVAN | `0xA69DA174` |
| 36 | COUPE | `0x0294073B` |
| 37 | FIRETRUCK | `0x83FBE66E` |
| 38 | PARCELVAN | `0xA90CA25B` |
| 39 | PICKUP | `0x72F17A0B` |
| 40 | 4DR_SEDAN | `0xF27F6A53` |
| 41 | BUS | `0x000097A9` |
| 42 | SUV | `0x0000DFFD` |
| 43 | MINIVAN | `0xEAF7FC91` |
| 44 | HATCHBACK | `0x9F4E0878` |
| 45 | HATCHBACK02 | `0xAAF20CDA` |

Hashes are numerical uint32 values, not byte-order strings. They belong to the same identity field used at career `slot+0x014`; the generic hash lookup `FUN_00610130` scans all 46 records (`+0xD0`, stride `0x890`) without a traffic-class exclusion. This establishes that traffic identities are recognized by that lookup, not that changing one save hash is sufficient for a usable career car.

### Classification and loading

- Car-record `+0x844` is 0 for all 31 ordinary records and 2 for all 15 traffic records in this data set.
- `FUN_0041aaf0` iterates the complete 46-record table and constructs traffic entries only for class 2. The manager allocates 15 entry objects (`FUN_0041aa60`). Its serializer labels identify `StreamingTrafficCar` (`FUN_0040bd40`) and `StreamingTrafficCarManager` (`FUN_00412720`).
- `FUN_00412950` uses record bytes at `+0x854` onward to decide traffic streaming counts and refreshes model resources through `FUN_0063bc70` / `FUN_0063bcd0`. All 15 records have geometry paths at record `+0x40`, and corresponding `CARS\<name>\GEOMETRY.BIN` files exist in the inspected install. Zero-length per-car texture/vinyl files for TAXI and BUS do not by themselves establish missing rendering resources; the shared-resource path remains untraced.
- Stock-car list builder `FUN_00516500` normally accepts class 0. It can also accept class 2 if runtime byte `DAT_00838470` is nonzero, but still requires a geometry path and record flag bit `(+0xDA & 2) != 0`. Only 12 traffic records pass that flag test in this BUN: PICKUP, 4DR_SEDAN and BUS have `+0xDA = 1`, so this flag alone does not include them. The other 12 have `+0xDA = 255`. Garage routine `FUN_004a79d0` clears the runtime flag and calls `FUN_0052a8a0(0x15)`; how the flag is enabled is not yet traced. It is not a proven save-file unlock.
- There are class-dependent runtime differences. `FUN_005b4dc0` performs its acceleration-dyno branch only for class 0. A vehicle setup path in the examined decompile allocates an additional helper (`FUN_0063a360`) only for class 0. Traffic should not automatically inherit the editor's ordinary-car dyno or customization assumptions; the acceleration display-factor tables also have only 31 entries.

These findings were checked against the local BUN and Ghidra CLI assembly for `FUN_0041aaf0`, `FUN_00516500`, `FUN_00610130` and `FUN_005b4dc0`. No traffic car was added to the donor list or written into a save. Player driving, career persistence, customization compatibility and the minimal consistent save fields still need controlled tracing/testing before exposing traffic replacement.

### Leftover folders are not necessarily hidden cars

The inspected install also contains `CARS\NEON`, `CARS\S2000`, `CARS\LANCER` and `CARS\IMPREZA`. Each contains only `VINYLS.BIN`, with no geometry or textures, and none has a matching car record in this BUN. LANCEREVO8 and IMPREZAWRX are separate real records. These four folders are leftover assets, not evidence that a Neon, S2000 or older Lancer/Impreza is selectable through a save edit. Other installs/builds may differ.

## Editor behavior and evidence limits

- The GUI shows nine performance categories with part names and ordinary package labels. Internal keys, IDs, offsets, prices, ownership bits and raw unique values are omitted from the dialog; their mappings are documented here. Inactive IDs are read-only. Visual-related IDs 56-67 are hidden. MAX OUT sets the 54 active non-visual performance bytes and the nine unique dwords (`0x2E8`), never visual-related bytes or ownership bits.
- Unique edits require confirmation and write only one uint32 as 0/1. Merely reading a noncanonical value preserves it. Event records, purchase bookkeeping, ordinary installed bytes and the unknown following dword remain untouched.
- All 68 names and all 66 active metadata records were compared against the installed EXE/archive. Writer/copy/serializer/loader byte routing passed synthetic x86 tests for all 45 unique fields, with the refresh helpers stubbed. Model tests check exact byte isolation.
- Only ordinary IDs 15/16 have controlled in-game save-diff confirmation. The NFS8 positive fixtures support the unique fields and the visual-derived flags as detailed above, but do not verify editor writes or a legitimate reward sequence in-game; both repository fixtures have zero unique fields. Suspension's physics reader is still unidentified.
- The manager's generic lookup must resolve to the garage record for this mapping. Neither fixture has a generic/garage ID collision, but that is not a universal guarantee.
- Complete editable body/graphics/specialities mappings remain unknown; the stored visual hashes and four flag groups above are a partial mapping only. The older broad unlock-table operation covers 420 bytes across four categories; it is not a faithful item-purchase simulation.

Examined build hashes (other builds/data sets are not certified):

- `SPEED2.EXE`: `f9dd86c054878ce6276beb07c1fd61874f7a1e4bf1f241b084c65b73e24168a7`
- `GLOBALB.BUN`: `07e1c37a2e5ba4b3e6a17b257e653409c31d5f0b3f9df3464aec36adbbced9d0`
