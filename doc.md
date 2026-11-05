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
| `0x04` | 2 | Total file length, uint16 LE |
| `0x06` | 2 | Unknown header bytes |
| `0x08` | 4 | Block A length |
| `0x0C` | 4 | Block B length |
| `0x10` | 4 | CRC of block A |
| `0x14` | 4 | CRC of block B |
| `0x18` | 4 | CRC of the header (bytes `0x00`–`0x17`) |
| `0xA16A` | 4 | Money, int32 (max `0x7FFFFFFF`) |
| `0xA175` | 1 | Garage count, capped at 6 |
| `0xD225` | 32 | Driver name, Latin-1, at most 31 characters |
| `0xD6B5` | 1 | Unknown final byte; `0xD226` is inside the driver-name field, not a separate checksum |

## Checksums

- CRC-32, MSB-first, polynomial `0x04C11DB7`, with input and output inverted.
- The implementation is `nfsu2Crc` in [src/model/checksum.ts](src/model/checksum.ts).
- Each save write must recalculate all three CRCs. The editor does this on download.

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
- Confirmed in game: with the flag cleared on records 1–4 of `treav1r`, all 5 slots show unlocked and cars work. Setting only the garage count (`0xA175`) did not change the lock.
- The garage count is written by `setSlotCar` but is not read by the lock check. Its effect in game is unverified.
- The byte at `+0x429` is `hasCarBought` (strong evidence, not yet confirmed by an editor write in game). `isCarBought` reads it. `1` means a car is bought. Owned cars in `treav0r` and `Jane` all have `01` there.
- Slot state shown in the UI (`slotState`): locked takes priority. Otherwise a bought car is `filled`, and an unlocked slot with no bought car is `open` (free for a sponsor car).
- `setSlotCar` clears the lock flag and sets the bought flag on the slot it writes.

## Editor behaviour

| Operation | What it writes |
| --- | --- |
| Replace car | Clears visual hashes, writes donor blocks 1–3, clears vinyls/colours, decal textures and neon/frame. Performance flags are zeroed; dyno setups are retained. No appearance is copied from a neighboring slot. Clears the lock flag and sets the bought flag. Raises the career garage count to at most 6 |
| Swap slots | Exchanges bytes from the shifted slot base to the native record end, preserving each record's first eight bytes and handle (**experimental**, untested in game) |
| Set money / name | Only the target field. Input values are never mutated |

## Module map

- `src/model/`: pure functions over a `DataView`. No DOM access.
- `src/data/`: static tables for performance parts and unlock ranges.
- `src/controller/`: the AngularJS controller and the file-input directive.
- `src/test/`: `node:test` tests. Fixture tests skip when `testfile/` is missing.
