# Technical notes: performance tuning

## Three separate kinds of state

For zero-based garage index `i=0..4`, the editor uses `S(i) = 0x5870 + i * 0x7F2`. This is eight bytes after the actual serialized record boundary (`0x5868 + i * 0x7F2`).

| State | Absolute file address | Format | GUI operation |
|---|---|---|---|
| Installed item | `S(i) + 0x310 + itemId` | One byte per ID | Raw edit for non-visual IDs |
| Purchased/owned part | `S(i) + 0x586 + (itemId >> 3)` | Bit mask `1 << (itemId & 7)` | Read-only |
| Unique performance category | `S(i) + 0x2E8 + categoryIndex * 4` | Four-byte little-endian integer | Experimental flag-only edit |

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

## Editor behavior and evidence limits

- The GUI shows nine performance categories with part names and ordinary package labels. Internal keys, IDs, offsets, prices, ownership bits and raw unique values are omitted from the dialog; their mappings are documented here. Inactive IDs are read-only. Visual-related IDs 56-67 are hidden; performance bulk edits affect only the 54 active non-visual bytes, never visual-related bytes, unique dwords or ownership bits.
- Unique edits require confirmation and write only one uint32 as 0/1. Merely reading a noncanonical value preserves it. Event records, purchase bookkeeping, ordinary installed bytes and the unknown following dword remain untouched.
- All 68 names and all 66 active metadata records were compared against the installed EXE/archive. Writer/copy/serializer/loader byte routing passed synthetic x86 tests for all 45 unique fields, with the refresh helpers stubbed. Model tests check exact byte isolation.
- Only ordinary IDs 15/16 have controlled in-game save-diff confirmation. The NFS8 positive fixtures support the unique fields and the visual-derived flags as detailed above, but do not verify editor writes or a legitimate reward sequence in-game; both repository fixtures have zero unique fields. Suspension's physics reader is still unidentified.
- The manager's generic lookup must resolve to the garage record for this mapping. Neither fixture has a generic/garage ID collision, but that is not a universal guarantee.
- Complete editable body/graphics/specialities mappings remain unknown; the stored visual hashes and four flag groups above are a partial mapping only. The older broad unlock-table operation covers 420 bytes across four categories; it is not a faithful item-purchase simulation.

Examined build hashes (other builds/data sets are not certified):

- `SPEED2.EXE`: `f9dd86c054878ce6276beb07c1fd61874f7a1e4bf1f241b084c65b73e24168a7`
- `GLOBALB.BUN`: `07e1c37a2e5ba4b3e6a17b257e653409c31d5f0b3f9df3464aec36adbbced9d0`
