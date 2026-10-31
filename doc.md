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
| `0x08` | 4 | Block A length |
| `0x0C` | 4 | Block B length |
| `0x10` | 4 | CRC of block A |
| `0x14` | 4 | CRC of block B |
| `0x18` | 4 | CRC of the header (bytes `0x00`–`0x17`) |
| `0xA16A` | 4 | Money, int32 (max `0x7FFFFFFF`) |
| `0xA175` | 1 | Garage count, capped at 6 |
| `0xD225` | 32 | Driver name, Latin-1, at most 31 characters |
| `0xD226`, `0xD6B5` | ? | Unknown. May be checksums or headers (**unverified**) |

## Checksums

- CRC-32, MSB-first, polynomial `0x04C11DB7`, with input and output inverted.
- The implementation is `nfsu2Crc` in [src/model/checksum.ts](src/model/checksum.ts).
- Each save write must recalculate all three CRCs. The editor does this on download.

## Car slots

- Five slots start at `0x5870`, with a stride of `0x7F2`.
- Each slot has the following areas, relative to the slot base:

| Relative offset | Size | Meaning |
| --- | --- | --- |
| `+0x000` | `0xE0` | Donor block 1 (car identity and body data) |
| `+0x0E0` | `0x1D0` | Donor block 2 |
| `+0x2B0` | `0x14` | Donor block 3, end-of-car data |
| `+0x27C` | 24 | Used header. A non-zero uint16 means the slot is used |
| `+0x294` | 16 | Link block. All zero means not linked (does not decide the lock) |
| `+0x2BC` | 4 | Model key (the last 4 bytes of donor block 3) |
| `+0x310` | 68 | Performance flags, one byte each |
| `+0x462` | 420 | Unlock table, bytes `00` or `FF` |

- Donor blocks are read from absolute offsets `0x5870`, `0x5950`, and `0x5B20`.
- The model key maps to a car through the donor list in `car-donors.json`. Several cars share a key (base, sponsor, and intro versions), so the first name listed is shown.

### Performance flags

- 68 parts, one byte each, at `+0x310`.
- Only indices 15 (muffler) and 16 (cold air intake) are confirmed in game.
- Writing these flags is required for the editor to show parts as installed, but whether the game needs them too is **unverified**.

### Unlock table

- 420 bytes at `+0x462` to `+0x7E1`, split into four categories:

| Category | Bytes |
| --- | --- |
| Body parts | 220 |
| Specialities | 80 |
| Graphics | 112 |
| Performance | 8 |

- The unlock ranges are in [src/data/unlock-table.ts](src/data/unlock-table.ts).
- Setting a byte to `FF` marks it unlocked. Each byte's mapping to a specific part is **unverified**.

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
| Replace car | Donor blocks 1–3 in the slot. Performance flags are zeroed. The used header and link block are copied from another slot if the target is empty. Clears the lock flag and sets the bought flag. Raises the garage count to at most 6 |
| Swap slots | Whole slot blocks are swapped (**experimental**, untested in game) |
| Set money / name | Only the target field. Input values are never mutated |

## Module map

- `src/model/`: pure functions over a `DataView`. No DOM access.
- `src/data/`: static tables for performance parts and unlock ranges.
- `src/controller/`: the AngularJS controller and the file-input directive.
- `src/test/`: `node:test` tests. Fixture tests skip when `testfile/` is missing.
