# Developer notes: NFSU2 career save structure

This file records what we know about the `SPEED2.EXE` career save (`20CM` magic, 54,966 bytes / `0xD6B6`). Items marked **unverified** have not been confirmed in game.

## Sources

- The save bytes were compared against `testfile/treav0r` (a real career save).
- `SPEED2.EXE` was analysed with Ghidra and REA. The checksum table sits at file offset `0x4145E0`.
- The user's `NFSU2SaveE-v1.0.1` build was decompiled and used to check the findings.
- Unlock categories were mapped by making one-category sandbox saves and diffing them.
- `car-donors.json` comes from GabriLex's `nfsu2profilemaster`.

## File layout

| Offset | Size | Meaning |
| --- | --- | --- |
| `0x00` | 4 | Magic `20CM` |
| `0x04` | 4 | Total file length, uint32 LE in the native writer/loader (the editor currently checks the low uint16) |
| `0x08` | 4 | Block A length |
| `0x0C` | 4 | Block B length |
| `0x10` | 4 | CRC of block A |
| `0x14` | 4 | CRC of block B |
| `0x18` | 4 | CRC of the header (bytes `0x00`–`0x17`) |
| `0x1C` | 4 | Body compatibility tag `0x10D`; required by the examined native load path |
| `0x20` | 4 | Body size repeated in the compatibility descriptor |
| `0x24` | `0x480` | 48 stock-car catalogue records, `0x18` bytes each |
| `0x4A4` | 4 | Active stock catalogue count (31 in the reference save) |
| `0x4A8` | `0x53C0` | 20 generic saved car configurations, `0x430` bytes each; not the five career garage records |
| `0x5868` | `0x27BA` | Five native career car records, `0x7F2` bytes each |
| `0x8022` | 4 | Garage-record count, uint32 LE |
| `0x8026` | `0x1938` | Six special configurations, `0x434` bytes each; type mask 16, not the runtime sponsor catalogue |
| `0x995E` | 4 | Special-configuration count, uint32 LE |
| `0x9962` | `0x808` | Eight stage records, `0x101` bytes each |
| `0xA16A` | 4 | Money, int32 (max `0x7FFFFFFF`) |
| `0xA175` | 4 | **Current career-stage index**, uint32 LE; the old garage-count label was incorrect |
| `0xA179` | 4 | Active event-entry count, uint32 LE |
| `0xA17D` | `0xC00` | Fixed array of 384 eight-byte event records; 137 active in the reference |
| `0xAE9A` | `0x1409` | 256 twenty-byte SMS records, two count dwords and one control byte |
| `0xC2A3` | `0x1A4` | Career tail, including transient dwords cleared on load |
| `0xC447` | `0xDDE` | Profile spans copied in a non-runtime-order sequence; semantics mostly unresolved |
| `0xD225` | 32 | Driver name, Latin-1, at most 31 characters |
| `0xD245` | `0x33` | Auxiliary object: eight reserved zero bytes, three bytes, two twenty-byte spans |
| `0xD278` | `0x43E` | Six identity-matched runtime-state records, `0xB5` bytes each |

This overview omits individual unresolved scalar fields; [the complete serializer ledger](technical.md#whole-file-first-pass-2026-11-05) accounts for every byte. The final byte belongs to the sixth tail record's dword payload; neither it nor the name's `0xD226` byte is a separate checksum.

## Checksums

- CRC-32, MSB-first, polynomial `0x04C11DB7`, with input and output inverted.
- The implementation is `nfsu2Crc` in [src/model/checksum.ts](src/model/checksum.ts).
- Each save write must recalculate all three CRCs. The editor does this on download.

The first 4 KiB and the subsequent whole-file pass are traced in [technical.md](technical.md#first-4-kib-trace-2026-11-05). The native header's bytes `0x06`–`0x07` are the upper half of its uint32 file length, not a separate unknown field. Block A is a compatibility descriptor; its tag is checked for equality with `0x10D`, but no decimal "version 269" meaning is established. Structural coverage is complete; 32.28% of bytes remain semantically incomplete after decoding stage result hashes and completion flags. The grid conservatively does not promote all mixed event entries' `+4` bytes based on shop-only discovery evidence.

## Career access

The experimental **Discover eligible shops** action uses the first career database in the user's local `GLOBALB.BUN`. The file also contains a secondary/demo career container; its tables must not overwrite the main career tables.

- Preserves the current stage, race status bytes, all existing event fields except eligible shops' `+4` discovery flags, stage-result tables, money and car records.
- Selects standard shop types 1–5 only: performance, body, paint, car dealers and specialties. Intro/unique-reward shops are excluded.
- Requires the shop's stage and additional event/result-count gates to pass already. Never fabricates completions or unlocks future-stage shops.
- If a shop has no active event entry, appends a zero-initialized eight-byte record with its hash and discovery byte 1, raising only the active event count. Fails atomically if the 384-entry table has no space.
- Shows dealer-car prerequisites for both game-region branches and part progression requirements. "Gate passed" is not a guarantee that every car/part fits every shop or car.
- Uses the existing download/checksum flow for raw career saves and nfsu2-web profiles; separate GARAGE.DAT records are untouched.

**Apply stage** writes only the uint32 current stage: 0 (intro), 1–5 (normal career), 6 (post-career). No BUN is required for that operation. It changes stage-dependent road/race gates without satisfying prerequisites or resetting prior stage-completion flags. Selecting an earlier stage is therefore not a full replay/reset operation.

**Complete career (100%)** is a separate confirmed operation requiring the six-stage main BUN. It marks all 224 main career definitions and 30 photo goals complete, populates native capped race/URL/sponsor result sets, marks stages 0–5 complete, sets stage 6 and discovers eligible standard shops. Existing unrelated event entries, unknown event bytes, money, cars, collectible cash, SMS and reward ownership remain untouched. Capacity failure is atomic. The displayed game percentage is computed from completed main career definitions, not an independently overwritten cosmetic percentage.

Full completion intentionally changes completion history and hides completed race/photo markers. It is not an all-races-visible switch and does not run the game's reward/notification effects. Exact native completion statistics, stage requirements and part predicates have been checked; actual in-game rendering/purchases remain experimental. See [native gate evidence and validation](technical.md#career-access-gates-and-editor-policy-2026-11-05).

## Car slots

- Five native records start at `0x5868`, with a stride of `0x7F2` (2,034 bytes). The editor's slot base is eight bytes later, at `0x5870`. The record's `+4` dword is its `CAREER_SLOT_<n>` handle.
- Each slot has the following areas, relative to the slot base:

| Relative offset | Size | Meaning |
| --- | --- | --- |
| `+0x000` | `0xE0` | Donor block 1 (car identity and body data) |
| `+0x014` | 4 | Car type hash (uint32 LE); used for names and GLOBALB.BUN physics |
| `+0x0E0` | `0x1D0` | Donor block 2 |
| `+0x2B0` | `0x14` | Donor block 3, end-of-car data |
| `+0x018` | 680 | 170 visual-part hashes (uint32 LE); includes window tint at `+0x27C` and visual slot 169 at `+0x2BC` |
| `+0x2E8` | 36 | Nine unique-performance uint32 fields; separate from ordinary installed flags |
| `+0x310` | 68 | Installed-item flags, including 12 visual-related bytes |
| `+0x354` | 205 | Five 41-byte dyno setups |
| `+0x428` | 1 | Slot lock flag |
| `+0x429` | 1 | Car bought flag |
| `+0x586` | 9 | Indexed performance ownership bitset; ninth byte's visual-purchase semantics remain unverified |
| `+0x6BE` | 4 | Ordinary purchase-price accumulator, serialized from purchased-subobject runtime `+0x3BC` |
| `+0x6CA` | 272 | 68 companion dwords; precise per-item meaning unresolved |
| Sparse ranges within `+0x462`–`+0x7E1` | 420 | Broad category-unlock edits; overlaps the first eight ownership bytes, not a contiguous 420-byte table |

- Donor blocks are read from absolute offsets `0x5870`, `0x5950`, and `0x5B20`.
- The car type hash at `+0x014` maps to a car through the donor list in `car-donors.json`. Variants of the same car (base, sponsor and intro) show the first name listed. The `+0x2BC` model key is not a unique car identity: Sentra, Golf and Tiburon share `FA26AF42`; Audi TT and Celica share `78ADB9AF`. Replacement already writes the type hash in donor block 1. Slot names and DYNO use the same hash reader.

### Performance flags

- 68 installed-byte positions at `slot base + 0x310 + itemId`; 66 are active in the examined archive. IDs 33/34 are retained read-only, not removed or renumbered.
- Performance tuning and its bulk actions use 54 active non-visual IDs. IDs 56-67 are hidden and left untouched by those actions; the executable derives them from visual-part levels during a conditional refresh.
- Purchase bits and nine unique-performance dwords are separate state. The GUI edits raw flags, not complete shop purchases/rewards.
- See [technical.md](technical.md) for named offsets, code traces, package metadata and evidence limits. Only ordinary IDs 15/16 have in-game save-diff confirmation.

### Unlock table

- 420 selected bytes in sparse ranges within `+0x462` to `+0x7E1`, split into four categories. Do not count every intervening byte as an unlock:

| Category | Bytes |
| --- | --- |
| Body parts | 220 |
| Specialities | 80 |
| Graphics | 112 |
| Performance | 8 |

- The unlock ranges are in [src/data/unlock-table.ts](src/data/unlock-table.ts).
- Setting a byte to `FF` marks it unlocked. Each byte's mapping to a specific part is **unverified**.
- The eight performance-category bytes are also the indexed ownership bitset at `+0x586`–`+0x58D`; individual IDs are mapped by the bit formula in [technical.md](technical.md). The other 412 selected bytes have category-level evidence only.

## Locking

- A slot is locked when its own lock flag is non-zero: `isSlotLocked` reads the byte at `slot base + 0x428`. `1` is locked, `0` is unlocked.
- Confirmed in game: with the flag cleared on records 1–4 of `treav1r`, all 5 slots show unlocked and cars work. The previous experiment changing `0xA175` did not change the lock; it was changing the low byte of the **career stage**, not a garage count.
- **Corrected editor hazard:** the legacy `setSlotCar` low-byte write at `0xA175` has been removed. Native `FUN_00514530` / `FUN_00529230` serialize this as a four-byte current-stage field; the real garage-record count is `0x8022`. Replacement now preserves all four stage bytes.
- The byte at `+0x429` is `hasCarBought` (strong evidence, not yet confirmed by an editor write in game). `isCarBought` reads it. `1` means a car is bought. Owned cars in `treav0r` and `Jane` all have `01` there.
- Slot state shown in the UI (`slotState`): locked takes priority. Otherwise a bought car is `filled`, and an unlocked slot with no bought car is `open` (free for a sponsor car).
- `setSlotCar` clears the lock flag and sets the bought flag on the slot it writes.

## Editor behaviour

| Operation | What it writes |
| --- | --- |
| Replace car | Clears visual hashes, writes donor blocks 1–3, clears vinyls/colours, decal textures and neon/frame. Performance flags are zeroed; dyno setups are retained. No appearance is copied from a neighboring slot. Clears the lock flag and sets the bought flag. **Preserves the career stage** |
| Discover eligible shops | Only eligible shop discovery bytes, newly appended shop entries and the active event count; no stage advancement or fabricated results |
| Apply stage | Only uint32 `0xA175`; stages 0–6. Keeps event history, stage flags and results |
| Complete career (100%) | BUN-defined event/photo statuses and activation bytes, capped stage result hashes, stage completion bytes/BUN stage IDs, stage 6 and eligible shop discovery. No reward ownership, money or car writes |
| Swap slots | Exchanges bytes from the shifted slot base to the native record end, preserving each record's first eight bytes and handle (**experimental**, untested in game) |
| Set money / name | Only the target field. Input values are never mutated |

## Module map

- `src/model/`: pure functions over a `DataView`. No DOM access.
- `src/data/`: static tables for performance parts and unlock ranges.
- `src/controller/`: the AngularJS controller and the file-input directive.
- `src/test/`: `node:test` tests. Fixture tests skip when `testfile/` is missing.
