# Technical notes: save layout and tuning

## First 4 KiB trace (2026-11-05)

Scope: file offsets **`[0x0000, 0x1000)`**, not executable addresses. This pass used REA/Ghidra 12.1.4 on the same `SPEED2.EXE` SHA-256 recorded below, the local `GLOBALB.BUN`, and the unchanged repository reference save. It establishes field routing and selected semantics, not safe editing of every field or exhaustive in-game behavior.

### Container and compatibility descriptor

| File range, end exclusive | Encoding and meaning | Native evidence |
|---|---|---|
| `0x0000`–`0x0004` | Magic `20CM` | `FUN_006FC226` writes `0x4D433032` |
| `0x0004`–`0x0008` | Total file length, **uint32 LE** | `FUN_006FCE82` passes `lenA + 0x1C + lenB` to `FUN_006FC226`; the native loader compares the full field |
| `0x0008`–`0x0010` | Two uint32 LE block lengths: 8 and `0xD692` | Container writer and loader |
| `0x0010`–`0x001C` | Block A, block B, header CRCs | `FUN_006FCE82`; header CRC covers `[0, 0x18)` |
| `0x001C`–`0x0020` | Compatibility tag `0x10D`, uint32 LE | `FUN_004D9B80` writes it; `FUN_004A9850` requires this exact value before dispatching the body loader |
| `0x0020`–`0x0024` | Repeated body size `0xD692`, uint32 LE | Same writer and compatibility check; must equal the allocated/read body size |

The editor currently validates the low uint16 of the file length; this trace does not change its behavior. Bytes `0x06`–`0x07` are not independent unknown bytes. The compatibility tag is not the save size, CRC, player level, or a proven human-readable version number.

### Stock catalogue: `0x0024`–`0x04A4`

`FUN_0052A450` adds `0x10` to ECX, then jumps to `FUN_0052A280`. The latter passes profile `+0x3B0` to `FUN_005166B0`; for the observed profile base `0x83A9E0`, this collection is at `0x83AD90`.

The collection begins with **48 runtime records of `0x1C` bytes**. The serializer omits each first dword (its vtable pointer) and saves the following six dwords, giving **48 x `0x18` = `0x480` bytes**. Record `i` is at `0x24 + i * 0x18`; all offsets below are relative to that serialized record, not a garage slot.

| Serialized offset | Runtime offset | Meaning | Coverage decision |
|---|---|---|---|
| `+0x00` | `+0x04` | Common-header value; zero in the reference catalogue | Amber: initialization alone does not identify its meaning |
| `+0x04` | `+0x08` | Lookup handle, hash of `STOCK_<internal car name>` | Green: written by `FUN_00516500` through format/hash helper `FUN_0050B990`; matched all 31 populated entries against local BUN names |
| `+0x08` | `+0x0C` | Common-header scalar; populated values look like float32 scores | Amber: do not infer its units, exact score meaning, or cache policy from plausible float values |
| `+0x0C` | `+0x10` | Enumeration-enabled dword: nonzero permits enumeration | Green: `FUN_005162D0` tests it; this is not proof of career purchase/unlock status |
| `+0x10` | `+0x14` | Record-type bit mask; stock = 1, generic configuration = 2, career = 4, sponsor = 8, special = 16 | Green: constructors/reset paths and masked enumeration in `FUN_005162D0` |
| `+0x14` | `+0x18` | BUN car-record index, int32; unassigned = -1 | Green: `FUN_00516500` writes the index while walking `0x890`-byte BUN records; stock virtual accessor at `0x503A30` reads it |

`0x04A4`–`0x04A8` stores the active catalogue count (uint32 LE), copied from collection `+0x540`. **31** entries are active in the reference; their indices are exactly 0–30. The remaining 17 records have zero handles and index -1, but retain the type-mask value 1. They are real serialized records, not padding.

Stock handles are not raw car identity hashes: for example, `STOCK_350Z` and `350Z` hash differently. `FUN_00503550` searches stock handles at runtime `+8`, whereas the stock vtable's `+4` method returns the car-record index. The existing donor list alone cannot decode this catalogue's handles.

`FUN_00516500` builds the catalogue from BUN car records with a geometry path and record flag bit `+0xDA & 2`. It normally accepts class 0; class 2 also needs runtime gate `DAT_00838470`. The reference's 31 records do not prove every build or runtime always has 31.

### Generic saved configurations beginning at `0x04A8`

The next collection is **20 x `0x430` serialized bytes**, ending at `0x5868`, where the five career garage records begin. Runtime configuration records have stride `0x434`; again their vtable dword is not saved. `FUN_005035C0` searches this collection before the garage collection. Calling these the career slots would therefore be incorrect.

Record `i` is at **`C(i) = 0x04A8 + i * 0x430`**. Its first five serialized dwords have the same common header as above, except the final stock index is replaced by configuration payload:

| Relative to `C(i)` | Size | Meaning and evidence |
|---|---:|---|
| `+0x000` | 4 | Unresolved common-header value |
| `+0x004` | 4 | Lookup handle at runtime record `+8`; `FUN_005035C0` ignores zero handles |
| `+0x008` | 4 | Unresolved common-header scalar; `FUN_00516B90` stores a float from `FUN_005B6990`, but its full score/cache semantics remain open |
| `+0x00C` | 4 | Enumeration-enabled dword |
| `+0x010` | 4 | Type mask; generic = 2 |
| `+0x014` | 4 | Configuration initialized marker: reset to 0 by `FUN_00516A60`, set to 1 by `FUN_00503950` |
| `+0x018` | 4 | Unresolved configuration field |
| `+0x01C` | 4 | Car identity hash, uint32 LE; `FUN_00503950` hashes the BUN car name |
| `+0x020` | 680 | 170 visual hashes, uint32 LE; `FUN_00503880` resolves them, `FUN_00503950` writes them |
| `+0x2C8` | 40 | Unresolved dwords preceding the mapped nine unique fields |
| `+0x2F0` | 36 | Nine unique-performance dwords; the same configuration subobject copied to/from the garage records |
| `+0x314` | 4 | Unresolved following dword, not an established tenth unique |
| `+0x318` | 68 | Installed-item byte positions |
| `+0x35C` | 205 | Five 41-byte dyno setups, ending at `+0x429` exclusive |
| `+0x429` | 7 | Three trailing payload bytes and a final dword; meanings unresolved |

`FUN_005166B0` writes runtime record `+4..+0x17`, copies `0x418` bytes from `+0x18`, then writes runtime `+0x430`. The payload begins at runtime record `+0x18`, but serialized `+0x14`. `FUN_00516B90` explicitly passes runtime record `+0x18` to `FUN_00503950`; its assembly resets setups starting at record `+0x360`. `FUN_00516AC0` reconstructs a car and copies a selected 41-byte setup. These establish the offsets without assuming a contiguous runtime dump.

Within this pass, configuration 0 occupies `0x04A8`–`0x08D8`, configuration 1 `0x08D8`–`0x0D08`, and configuration 2 starts at `0x0D08`. The requested boundary cuts configuration 2 at relative `+0x2F8`: it includes only its first **two** unique dwords, not its installed flags or dyno setups.

The reference's first configuration has identity `0x000AC6D1` (350Z), while the next two have zero identities. Zero-filled fields in those records still have established encodings; untraced gaps remain amber regardless of their contents. No claim is made here that a generic record is a particular player's currently selected quick-race car without tracing its consumers.

### Validation and remaining work

- Executed the **original x86 instructions** in Unicorn: loader `0x516850` up to (excluding) `0x516920`, then writer `0x5166B0` up to (excluding) `0x516797`. These prefixes cover all 48 stock records, their count, and all 20 generic configurations.
- The real fixture plus eight seeded random payloads each round-tripped **22,596 bytes (`0x5844`) exactly**. Checked every record's file-to-runtime mapping, preserved all 68 omitted vtable dwords, verified the returned buffer position, and checked the output-end sentinel. No game helpers were hooked or stubbed; execution stopped before the career-record phase. This validates routing, not gameplay meaning.
- Independently matched all 31 populated stock handles to `hash("STOCK_" + BUN car name)` and confirmed the 0–30 indices. The first populated configuration's identity resolves to the local BUN 350Z record.
- The source save was not modified; structure and all three CRCs remain valid.
- **First 4 KiB coverage:** 3,534 deciphered bytes (**86.28%**), 562 located-but-incomplete bytes (**13.72%**), no unlocated bytes. The initial pass credited only bytes below `0x1000`; the subsequent whole-file pass below extends the repeating evidence.
- Remaining in this slice: the common-header value/scalar, configuration `+0x18`, the ten dwords before the unique fields, and the trailing gaps. `0x1000` is still inside configuration 2; it is not the start of a new record.

## Whole-file first pass (2026-11-05)

REA/Ghidra traces of the original body writer `FUN_0052A280` and inverse `FUN_005344D0`, with native-instruction checks described below, locate **all 54,966 bytes**. This is a structural first pass, not a claim that copied opaque fields are understood or safe to edit. That pass yielded **35,649 deciphered bytes (64.86%)**. The completion trace below decodes another 1,576 bytes (49 result hashes and one completion byte in each of eight stage records): current coverage is **37,225 deciphered (67.72%)**, **17,741 incomplete (32.28%)**, and no unlocated bytes. The first-4-KiB totals are unchanged. Shop discovery at event `+4` is not extrapolated across every mixed event record.

### Complete boundary ledger

Ranges are absolute file offsets with exclusive ends. Runtime offsets are relative to the collection, career object or profile identified in the first trace.

| File range | Size | Native routing |
|---|---:|---|
| `0x0000`–`0x001C` | `0x1C` | Container header |
| `0x001C`–`0x0024` | 8 | Compatibility descriptor |
| `0x0024`–`0x04A4` | `0x480` | 48 stock records, runtime stride `0x1C`, saved stride `0x18` |
| `0x04A4`–`0x04A8` | 4 | Collection `+0x540`: active stock count |
| `0x04A8`–`0x5868` | `0x53C0` | 20 generic configurations, runtime stride `0x434`, saved stride `0x430` |
| `0x5868`–`0x8022` | `0x27BA` | Five career cars, runtime collection `+0x5954`, stride `0x7F8`; saved stride `0x7F2` |
| `0x8022`–`0x8026` | 4 | Collection `+0x812C`: garage-record count |
| `0x8026`–`0x995E` | `0x1938` | Six special configurations, runtime collection `+0x8130`, stride `0x438`; saved stride `0x434` |
| `0x995E`–`0x9962` | 4 | Collection `+0x9A80`: special-configuration count |
| `0x9962`–`0xA16A` | `0x808` | Eight stage records, runtime career `+0x72D8`, stride `0x104`; saved stride `0x101` |
| `0xA16A`–`0xAE9A` | `0xD30` | Career scalars and the full event array |
| `0xAE9A`–`0xC2A3` | `0x1409` | 256 SMS records x `0x14`, then nine control bytes |
| `0xC2A3`–`0xC447` | `0x1A4` | Career tail |
| `0xC447`–`0xC51F` | `0xD8` | Profile `+0x2D8` |
| `0xC51F`–`0xC55B` | `0x3C` | Profile `+0x48` |
| `0xC55B`–`0xC56B` | `0x10` | Profile `+0x38` |
| `0xC56B`–`0xC5BB` | `0x50` | Profile `+0x84` |
| `0xC5BB`–`0xC5CB` | `0x10` | Profile `+0x28` |
| `0xC5CB`–`0xC747` | `0x17C` | Profile `+0xD4` |
| `0xC747`–`0xC74F` | 8 | Profile dwords `+0x250`, `+0x254` |
| `0xC74F`–`0xC755` | 6 | Profile bytes `+0xA0F9`, `+0xA0F8`, then dword `+0xA0F4` |
| `0xC755`–`0xD1A5` | `0xA50` | Profile `+0xA0FC` |
| `0xD1A5`–`0xD225` | `0x80` | Profile `+0x258` |
| `0xD225`–`0xD245` | `0x20` | Profile `+0`: driver name |
| `0xD245`–`0xD278` | `0x33` | `FUN_00515BF0`, auxiliary runtime object `0x850080` |
| `0xD278`–`0xD6B6` | `0x43E` | `FUN_005B9420`, six fixed `0xB5` records |

### Repeating cars and the purchased subobject

The generic payload table above applies to all 20 generic records and to the first `0x430` bytes of each special record. The special record adds a dword at serialized `+0x430` (runtime `+0x434`), whose full meaning remains amber. `FUN_0052A7F0` initializes those six records from preset triples, calls `FUN_00516B90`, and sets their common type mask to **16**. They are not the separate **12-record runtime sponsor catalogue**, constructed by `FUN_005163C0` with type mask 8. All collection vtable dwords are omitted from the save.

The career configuration uses the same mapped fields, eight bytes before the editor-relative `S(i)` base. Its common enumeration/type/initialization fields are therefore at `S(i)+4`, `+8`, `+0xC`. `FUN_00516620` also writes runtime `+0x7F4` and `+0x7F5` as the separate lock/bought bytes, then serializes the purchased subobject via `FUN_00503F00`. These are not the common enumeration flag.

The purchased subobject starts at serialized native car record `+0x432`, or editor base **`S(i)+0x42A`**. It is `0x3C0` bytes, but is **not** a contiguous runtime dump:

| Serialized subobject range | Runtime subobject range |
|---|---|
| `+0x000`–`+0x294` | `+0x000`–`+0x294` |
| `+0x294`–`+0x298` | `+0x3BC`–`+0x3C0` |
| `+0x298`–`+0x2A0` | `+0x294`–`+0x29C` |
| `+0x2A0`–`+0x3B0` | `+0x2AC`–`+0x3BC` |
| `+0x3B0`–`+0x3C0` | `+0x29C`–`+0x2AC` |

`FUN_00504040` reverses this permutation. The dword at **`S(i)+0x6BE`** is the ordinary purchase-price accumulator: `FUN_00521B00` adds the purchased item's price to career runtime record `+0x7F0`, i.e. purchased subobject `+0x3BC`. The **68 companion dwords** at `S(i)+0x6CA` are structurally mapped, but their exact per-item semantics remain unresolved. The existing sparse unlock edits do not overlap the accumulator.

### Stage records and career scalars

Each saved stage at `0x9962+i*0x101` routes through `FUN_00500FA0` / `FUN_00514400`:

- `[+0,+0xE8)` copies the runtime prefix. The completion trace establishes event-name hash sets at `+0` (35 ordinary races), `+0x8C` (four URLs) and `+0x9C` (ten sponsor races), zero for empty entries. Other prefix fields remain incomplete.
- `+0xDC` is a uint32 stage outcome counter: `FUN_00541320` increments it for a nonzero outcome in career mode. This alone does **not** establish that it counts only Outrun wins.
- `+0xE8..+0xFC` contains five uint32 name hashes, replacing runtime pointers to BUN `0x34A19` records (stride `0x10`). `FUN_00512990` resolves them via names in the BUN string blob `0x34A1D`; do not confuse them with unique-event records in `0x34A1B`.
- `+0xFC` is the stage-completion byte: `FUN_00500C00` reads it; `FUN_00532C60` sets it to 1 when stage requirements pass.
- `+0xFD` is an int32 **sign-extension of the first byte** of the runtime `+0x100` pointed BUN stage-table record. The inverse searches `0x50`-byte records by that ID; `FUN_00512A70` installs the `0x34A18` table. It is not a serialized pointer.

Let `A=0xA16A`. The following ordered spans account for all `0xD30` bytes before the inbox; unknown fields stay amber even when they resemble flags or world coordinates.

| File offset relative to A | Size | Career runtime source / meaning |
|---|---:|---|
| `+0x000` | 4 | `+0x7134`: money |
| `+0x004` | 1 | `+0x8868` |
| `+0x005` | 4 | `+0x872C`: unresolved counter |
| `+0x009`, `+0x00A` | 1 each | `+0x873E`, `+0x873F` |
| `+0x00B` | 4 | `+0x7AF8`: **current career-stage index** |
| `+0x00F` | 4 | `+0x7AFC`: active event-entry count |
| `+0x013` | `0xC00` | `+0x7B00`: 384 fixed eight-byte event records |
| `+0xC13`, `+0xC14` | 1 each | `+0x873C`, `+0x873D` |
| `+0xC15` | 4 | `+0x8740` |
| `+0xC19` | 1 | `+0x8744` |
| `+0xC1A` | 16 | `+0x8750`: four unresolved dwords |
| `+0xC2A` | 2 | `+0x8760` |
| `+0xC2C` | 4 | `+0x8764` |
| `+0xC30` | `0x100` | `+0x8768`: unresolved byte table |

**Correction and editor hazard:** absolute **`0xA175` is a four-byte stage index**, reference value 4, not a one-byte garage count. The actual garage-record count is at **`0x8022`**. The initial research pass identified the legacy `GARAGE_CAR_COUNT` misinterpretation; the career-access implementation has now removed that constant and the low-byte write in `setSlotCar`. Replacement preserves the stage.

The event array is **`[0xA17D,0xAD7D)`**, not just the 137 observed entries. `FUN_00512F10` finds/creates entries by the name hash at `+0` and updates the count. Status `+6` is traced; three bytes per entry stay amber in the generic grid. Shop discovery at `+4` is confirmed below, but not treated as a universal flag for every event kind. `FUN_005419C0` writes status 1 after unique selection, while `FUN_00533BE0` writes 2 during setup: these are not established universal "completed"/"unlocked" flags.

### SMS inbox and career-tail normalization

`FUN_005014F0` saves 256 records from career runtime `+0x5D20`, each `0x14` bytes:

| Saved entry offset | Encoding / evidence |
|---|---|
| `+0` | uint32 BUN definition-name hash, replacing a pointer; inverse `FUN_00501310` searches `0x34A17` definitions via their uint16 string offsets |
| `+4` | Read flag: `FUN_00514DC0` sets it to 1 and reduces the unread count |
| `+5`, `+6`, `+7` | Copied status bytes; full gameplay meanings remain amber |
| `+8`, `+0xC`, `+0x10` | Three copied dwords; meanings unresolved |

Following the records: `0xC29A` is the entry count, `0xC29E` the unread/actionable count, and `0xC2A2` a copied control byte. Runtime inbox `+0x1408` is **not** serialized. The writer's second argument is a **remaining-length pointer**, unlike the enclosing career writer's length value.

`FUN_00514E80` is a normalizing loader: it resolves all 256 hashes, discards unresolved/null definitions, compacts surviving entries, recomputes the entry count, and counts unread entries with **`entry[4]==0 && entry[6]!=1`**. `FUN_005014C0` sets both bytes 4 and 6 to 1; byte 6's complete action semantics are not claimed. Unused destination slots depend on the initialized runtime object, so arbitrary saved bytes are not guaranteed to round-trip.

The career tail routes its first 16 bytes from runtime `+0x8869`, the next 400 bytes from `+0x887C`, then saves runtime `+0x8738` as its pointed record's `+8` identifier (or zero), not the pointer itself. `FUN_00529230` resolves that ID through `FUN_004FFC90` and explicitly clears four runtime dwords:

| Career runtime dword cleared | Corresponding file dword |
|---|---|
| `+0x8898` | `0xC2CF` |
| `+0x8984` | `0xC3BB` |
| `+0x898C` | `0xC3C3` |
| `+0x8994` | `0xC3CB` |

The exact gameplay meanings of the career tail remain amber. The fixture changes **13 individual bytes across those four dwords** under native load/write; it is incorrect to describe this whole block as a lossless raw dump.

### Profile and final objects

Profile spans in the boundary ledger are directly copied by the body writer/inverse, but their option/statistic meanings remain mostly untraced. **Only the driver-name field is green**; the large zero-filled regions are not assumed padding.

The `0x33`-byte auxiliary object uses `FUN_00515BF0` / `FUN_00515C90`. Its first **eight bytes are deliberately written as two zero dwords**, and ignored on load; these are the only newly credited reserved bytes. Saved `+8,+9,+0xA` route from runtime `+0x49,+0x4A,+0x4B`; saved `[+0xB,+0x1F)` from runtime `+0x58`; saved `[+0x1F,+0x33)` from runtime `+0x80`. Option names remain amber.

`FUN_005B9420` always emits six final `0xB5` records, based on runtime records at `0x874C40+i*0x370`:

| Saved record range | Runtime routing |
|---|---|
| `+0x00`–`+0x10` | Four-dword identity-matching key via `FUN_005B8110`, or zeros if runtime `+0x230==-1` |
| `+0x10`–`+0x34` | Nine dwords at runtime `+0x344`–`+0x368` |
| `+0x34` | Byte at runtime `+0x368` |
| `+0x35`–`+0xB5` | 32 dwords at runtime `+0x18` |

Slots outside active count `DAT_00870764` are zeroed in the output. The inverse `FUN_005B9570` applies a saved record **only to a runtime record with a matching four-dword key**; unmatched saved records are ignored. For identity mode runtime `+0x234==0x13`, the key comes directly from runtime `+0x21C..+0x22C`; other modes obtain it through a virtual call on `DAT_0086FFB4[index]`. This is not evidence that the records are padding, race results, or freely editable configuration. Their gameplay meaning stays amber through EOF.

### Native validation and limits

Executed original PE x86 instructions in Unicorn, with no edits to the EXE, BUN or source save:

- **Collection `0x516850` / `0x5166B0`:** all **39,230 bytes (`0x993E`)** from `0x24` to `0x9962` round-tripped exactly for the fixture plus eight seeded random payloads. Preserved all **79 omitted vtable dwords**. Included career purchased-subobject reorder helpers and both count fields; no game helpers were hooked.
- **Career `0x529230` / `0x514530`:** the fixture's **10,981 bytes (`0x2AE5`)** matched exactly after the four documented dwords were zeroed; a second native load/write was idempotent. All 109 SMS entries survived with unread count 0. Eight seeded random career cases also matched after those resets, with stage-reference fields constrained to fixture/BUN-valid values, the terminal career-reference ID held at zero, all 384 event records randomized, all 256 SMS hashes valid and count/unread controls canonical. Checked returned endpoints and the fixture output-end sentinel.
- **SMS normalization:** separate tests with alternating valid and null/nonzero-unknown hashes compacted **256 to 128** records exactly, retained surviving fields, recomputed unread counts and preserved the control byte. The writer consumed its remaining-length pointer to zero. Real BUN tables were mapped into emulated memory, and the original hash/resolver code executed. **Only host allocation/free services** at `0x575620` / `0x575630` were substituted; no lookup, serializer or normalizer was mocked.
- **Profile:** inverse copy fragment `[0x534514,0x534654)` and writer fragment `[0x52A2B6,0x52A41E)` round-tripped **3,582 bytes (`0xDFE`)** for the fixture plus eight random payloads. Independently checked all **14** contiguous/noncontiguous runtime spans, including the name. These fragments intentionally exclude unrelated profile initialization and post-load gameplay fixups; no hooks.
- **Auxiliary tail:** nine cases (fixture plus eight canonical random payloads) reproduced all **51 bytes**, including the mandated leading zero dwords; no hooks.
- **Final six records:** nine seeded cases reproduced all **1,086 bytes** using matching direct keys in native identity mode `0x13`; independently checked the 37-byte state and 128-byte payload mappings. Active count 0 produced all zeros. No hooks; other virtual-identity modes and in-game meaning were not tested.
- Final SHA-256 checks confirmed the reference save, EXE and BUN were unchanged. All source-save CRCs still pass. No game was launched and no real save was written.

Next semantic targets are the car common-header/configuration gaps and purchased companion fields, the first `0xE8` bytes of each stage, unresolved career scalars, SMS status/payload fields, profile options/statistics, and the final identity-matched objects. Locating their native source is not sufficient to promote them to green.

## Career access gates and editor policy (2026-11-05)

Shop discovery deliberately preserves **both the current stage and completion history**. At the user's request, the editor also exposes separate confirmed stage editing and actual-goal 100% completion. These do not award/fabricate cars, money, collectible cash, SMS or reward ownership.

### City barriers and race markers: why they are not switches here

`FUN_00578060` selects the `BARRIERS_CAREER%d` resource using runtime `DAT_00862838` (career `+0x7AF8`); `FUN_005F54A0` uses the same stage-specific group when rebuilding barriers. That establishes the stage-to-barrier resource dependency, not a separate saved "open city" flag. The stage selector writes only this uint32 field, accepting 0–6. Resource content and full in-game district behavior have not been validated by this pass.

`FUN_00527BB0` filters race candidates by **exact stage equality**, completion, event kind and special-car eligibility. `FUN_00527AA0` supplies per-category caps from the current stage's BUN table. Filling status/discovery flags does not bypass those constraints. `FUN_005141B0` additionally excludes indexed collected rewards when building its marker list; this is not a universal race-marker list. The editor does not reset race statuses or promise simultaneous access to all stages' races.

### Standard shop discovery

The main career BUN container is `0x80034A10`; `FUN_00512C00`'s initialized guard admits the first one. The examined file also contains a later demo career container with different events and stage tables. The parser keeps these separate.

The shop table `0x34A12` has 24 records of `0xA0` bytes. Saved lookup hash is the definition dword `+0x38`, shop type `+0x50`, requires-discovery flag `+0x51`, prerequisite value `+0x74`, prerequisite kind `+0x9C`, and signed minimum-stage byte `+0x9D`. Shop model paths are inline strings at `+0x40`, **not** offsets into the career string blob. Types 1–5 are the 22 standard shops; type 0 (intro home) and type 6 (unique-reward shop, stage 10 in this BUN) are excluded.

`FUN_00513110` requires:

1. Current stage at least the definition's minimum stage.
2. If `+0x51` is nonzero, an active saved entry matching `+0x38` with **`entry[4]==1`**.
3. The additional prerequisite predicate `FUN_00512870`:

| Kind at shop `+0x9C` | Requirement |
|---|---|
| 0 | None |
| 1 | Definition `+0x74` event hash passes `FUN_00500B80`: active entry's **status `+6` is exactly 1** |
| 2 | Count of nonzero results in the definition's stage's ten-dword `+0x9C` set meets `+0x74` |
| 3 | Count in that stage's 35-dword `+0` set meets `+0x74` |
| 4 | Count in that stage's four-dword `+0x8C` set meets `+0x74` |

These counts use `FUN_00500520`, `FUN_005004D0`, `FUN_005005A0`, respectively. They are **not** the stage `+0xDC` outcome counter. UI labels these sets sponsors, races and URLs; shop-only discovery leaves the stored individual results unchanged.

`FUN_00512FF0` records shop discovery by setting the corresponding saved event's `+4` byte to 1. The editor evaluates the stage/prerequisites without the discovery requirement, then changes only this byte for eligible shops. Missing shop records are appended within the 384-entry capacity and zero-initialized; existing bytes `+5..+7`, including status, are preserved. The game can issue discovery notifications during gameplay; the editor does not synthesize SMS messages.

### Dealer cars and part progression reports

`FUN_00513C50` builds the car allow-list using the 24 records in `0x34A1F` (stride 12): car hash, prerequisite event hash for game-region branch zero, and prerequisite hash for nonzero branch. `FUN_00570A30` reads runtime region value `DAT_00864F24`; it is not taken from this save. A resolvable prerequisite must have status exactly 1. Missing definitions impose no completion restriction in the native routine. The report shows both branches rather than guessing the user's region. The car browser also checks catalogue inclusion, regional exclusions in `FUN_005022C0`, geometry and other UI conditions; **"Completion gate passed" is not a universal purchasability claim**.

The part table `0x34A1C` contains 86 `0x28`-byte item definitions, each with three 12-byte level records at `+4`, `+0x10`, `+0x1C`. These IDs are not the 68 installed-item indices. `FUN_00515360` takes **item ID in EAX and level in EDI**, choosing the level record via `FUN_00501750`.

| Level-record kind at `+4` | Predicate using its dword `+8` |
|---|---|
| 1 | Resolve the shop hash, then call `FUN_00513110` (discovery included) |
| 2 | Stage in high 16 bits; minimum 35-dword-set count in low 16 bits |
| 3 | Stage in high 16 bits; minimum ten-dword-set count in low 16 bits |
| 4 | Stage in high 16 bits; minimum four-dword-set count in low 16 bits |
| 0, 5, 6 | This native progression predicate returns true |

The report follows normal progression with runtime cheat overrides disabled. It does not claim car compatibility, shop filtering, ownership, price, unique rewards or every regional exclusion is bypassed. Shop discovery never fabricates races/results to satisfy these gates; full completion deliberately records the real BUN-defined goals instead of independently bypassing inventory checks.

### Stage advancement and actual 100% completion

`FUN_00532C60` checks a stage's BUN definition (`0x34A18`, stride `0x50`): if its `+0x28` final-event hash is zero, every main event whose stage byte `+0x37` matches must pass `FUN_005130A0`; otherwise the final event must pass `FUN_00500B80` and required photo goals must pass `FUN_00513490`. Success sets stage `+0xFC=1`, then `FUN_00528320` increments the current stage when it matches the completed stage. Thus completing stage 5 yields **stage 6**, the post-career state; this is not an invalid seventh BUN stage definition.

The game's statistic screen calls original `FUN_00528A60`. Its output `+0x68` (runtime `0x835C68`) is **the count of active saved main-BUN event definitions with status exactly 1, divided by the main BUN's event-definition count**. English/Labels tables associate the screen label hash `0xABBA6482` with `CSTATISTICS_GAME_COMPLETED` ("Game Completion Status"). No separately stored cosmetic percentage is required.

The main BUN has **224** event definitions. `FUN_00541420` marks a won event's status `+6=1`; `FUN_00512F70` records event activation `+4=1`. `FUN_00513390` inserts definition hash `+8` into a stage result set: kind `+0x34=1` into four URLs, kind 2 into ten sponsor results, kind 3 with `+0x0D!=1` into 35 ordinary results. The first empty entry is filled, duplicates encountered during the scan are not inserted, and full sets are capped exactly as in the native function. Completing every main event does not require artificially expanding these result sets.

The **30 photo goals** in `0x34A16` (stride `0x40`) use saved hash `+0x20`, stage `+0x25`; nonzero `+0x35` marks those required by `FUN_00513490`. `FUN_00533680` records a completed photo as saved entry `+4=2, +6=1`. These goals are separate from the 224-event percentage denominator, but are completed for actual stage-goal consistency.

Full completion creates only missing known entries, preserving unrelated saved hashes and bytes `+5/+7`. It marks all main events and photo goals complete, populates the capped hash sets, sets stages 0–5 completion bytes and correctly serialized BUN stage IDs, sets current stage 6, then discovers eligible standard shops. Unknown counters, selected sponsor contracts, reward ownership, cars, cash collectibles, money and SMS are not modified. Missing capacity fails before editing; the action is idempotent. Stage editing alone retains stage-completion flags, so changing to an earlier stage is not a replay/reset.

### Verification

- Compared the TypeScript reports against **original, unhooked x86** `FUN_00512870`, `FUN_00513110` and `FUN_00515360` using actual BUN tables and save-to-runtime routing. Twelve cases covered stages **0–5**, before/after clearing and restoring shop discovery: **3,624 exact boolean comparisons passed**. Only the discovery flag was changed by the editor action; stage and existing status bytes were preserved.
- All **48** regional dealer-prerequisite lookups matched original `FUN_00500B80`. The complete geometry/region/UI car browser was not emulated.
- Executed the **complete original `FUN_00528A60`**, without hooks/stubs, on original and editor-completed real data: native percentage changed from **41.9642866% to exactly 100.0%**. All 30 photo lookups, six stage-completion lookups and, for the completed case, every stage's main-event and required-photo predicates passed. All 22 shop and 258 part predicates matched before/after completion. Starting from the unmodified fixture, 224 original `FUN_00513390` insertions produced **byte-identical capped result sets in all six stages**. On this fixture the final report has 284 active entries, 224/224 main events, 30/30 photos, 6/6 completed stages, and no remaining standard-shop, part-progression or dealer-completion gates.
- Unit tests cover exact count thresholds, status 1 versus other nonzero values, capacity exhaustion/atomic failure, idempotence, byteOffset-aware views, malformed data, exclusion of secondary/demo tables, untouched GARAGE.DAT bytes and valid download CRCs. A real-BUN controller test exercises cancel/confirm, refreshed reports, raw/ZIP download output, profile switching, untouched other archive entries and explicit invalid-BUN errors.
- Car replacement no longer alters any of the four stage bytes. Replacement tests verify only the target car record changes.
- Browser smoke test loaded the real save/BUN, rendered 22 shops, 31 active-stock dealer-car rows and 258 part-level rows, and exercised the stage selector/confirmation and full-completion binding/confirmation. It displayed **100.00%, 224/224 events, 6/6 stages and 30/30 photos**, disabled the completed action, and preserved money without JavaScript errors. The game was not launched; shop-marker rendering and complete shop purchases remain **experimental/in-game unverified**. All source artifact hashes stayed unchanged.

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

For slot `i`, add `i * 0x7F2` to those file offsets. When the descriptor in visual slot 6 (widebody, confirmed by the slot-name table and `FUN_0061BCD0`) has a nonzero level, a separate branch instead calls `FUN_005A64A0(3, 9)`, clearing and applying group-9 items by level. In a synthetic execution with the examined archive table, this branch left IDs 58, 61, 64 and 67 set after conflicts were applied.

`FUN_00503880` reconstructs visual pointers from a stored car configuration, copies its performance subobject, and refreshes that car. `FUN_00503950` can copy its installed bytes back to a runtime garage record, and the serializer maps those bytes to the offsets above. The inspected visual-selection path `FUN_0055C230` changes the configuration at `manager+0x940` and passes it to `FUN_00503950`. Its call to `FUN_004D8EC0` can also refresh a separate display copy via `FUN_004D8C70` and `FUN_004D8030`, conditional on a display object being available; that copy is not the source passed to this writer. Similar setter/writer sequences occur in `FUN_0055F080`, `FUN_00563D00`, `FUN_00567A50` and `FUN_00569670`. This trace confirms a conditional visual-to-flag reconstruction, **not** that every visual purchase immediately saves the reconstructed flags. No before/after in-game visual-purchase save diff has verified that final step. `FUN_0050E790` supplies category-label hashes only for indices 0-8, consistent with treating group 9 separately, but does not establish that no other game screen ever uses it.

Synthetic x86 execution used the original EXE instructions and archive item table with synthetic car/part data. It checked 36 refresh cases (including all four visual slots, levels 0-7, the disabled gate and the slot-6 branch) and 60 combinations of the 12 IDs and five garage slots through `FUN_00503950` and the relevant copy at the start of `FUN_00516620`. No game helpers were stubbed in those executed paths; execution stopped after the relevant refresh or serializer copy, not after a complete save or purchase.

## Visual catalogue and customization menus

The examined EXE's slot-name/index pairs at file `0x402DE8` name all 170 visual slots; the separate 170-dword table at VA `0x802960` maps these to **69 descriptor types**. These two namespaces are not interchangeable. `FUN_00503880` reconstructs them and `FUN_00503950` stores their descriptor hashes. Combined with `FUN_00516620`, the serialized layout is `S(slot)+0x18+4*visualSlot`, for 170 little-endian dwords ending at `+0x2C0` exclusive. The car identity remains at `+0x14`. The historical `+0x2BC` model key is visual slot 169, not the car identity.

Consequently, the old `SLOT_USED_OFF` (`+0x27C`) is actually the window-tint hash (153), not an occupancy flag. `isSlotUsed` now follows the canonical bought byte at `+0x429`, like `slotState`; removing tint must not make an owned car appear empty or block traffic replacement. The former empty-slot "header" (`+0x27C`, 24 bytes) and "link" (`+0x294`, 16 bytes) copies were appearance hashes (slots 153–162), not ownership/linkage. Replacement no longer copies either from another car or requires an occupied template.

Normal donor replacement clears all 170 visual hashes before applying donor blocks so gaps cannot retain the previous car's customization. After donor application it explicitly zeros vinyl layers 64–67, vinyl colours 77–92, decal textures 97–152 and neon/frame 154–158, including graphics embedded in donor variants. Donor body/paint defaults remain; dyno setups and unrelated record bytes remain unchanged. Tests cover all 49 donors in all ten slots, populated/empty slots, no-template initialization, isolated write boundaries and retained tuning. Experimental traffic replacement remains identity-only.

`FUN_006101E0` chooses the car-specific group pair; `FUN_0061B980` maps slot to type, then `FUN_0061B670` searches the first group before the second, preserving native descriptor order. Default `0xFFFFFFFF` groups mean the current car hash. The archive loader instructions at `0x636C95` onward identify chunk `0x34607` as **170 pairs of group hashes (0x550 bytes), followed by 16-byte car/slot/group/group overrides**. Chunks `0x34608/09` are different structures and must not be mistaken for this table.

Inside `0x80034602`, chunk `0x34603` is the 60-byte database header (descriptor count at +56). `0x34604` contains 14-byte descriptors, with alignment padding after the advertised count: hash +0, type +4, level in the top three bits of +5, category/variant in its low five bits, group index +7, name index +8, attribute-list index +10. `FUN_00610000` resolves the name as `0x34606 + nameIndex*4`. Group hashes are in `0x3460B`. Attribute lists (`0x3460C`) are uint16 count/index lists into the 8-byte key/value records in `0x34605`; list index `0xFFFF` means absent (`FUN_0060FEF0`). The examined local database has **12,167 descriptors and 46 car records**. Exclusions `EXCLUDE_UG1`, `EXCLUDE_UG2` and `EXCLUDE_SUV` follow `FUN_00610020`, `FUN_006100A0` and `FUN_0061B670`, respectively.

The editor reads this data locally, validates structural bounds and retains unknown installed hashes. It exposes **126 editable slots**, not a generic write-any-hash interface:

- Body parts (including the customizable wing-mirror part in slot 32), carbon parts, wheels/spinners and trunk audio.
- Base/accessory paint (63, 68–76), four vinyl layers (64–67), and 16 layer colours (77–92). Paint/vinyl colours are catalogue part hashes, **not RGB bytes in the save**; `RED`, `GREEN`, `BLUE` attributes provide approximate swatches, not a rendered material preview.
- Decal texture slots 105–152, window tint 153, neons 154–157, bulbs 159, door style/hydraulics/NOS purge 160–162.
- Custom HUD/dials 163, backing colour 164, needle colour 165, character colour 166. `FUN_00563D00` explicitly applies these three colour components around the generic selection/writer path.

Paint selection needs a frontend filter in addition to descriptor type/group compatibility. `FUN_005449C0` filters the colour branch by attribute **`0xEBB03E66`**, the paint category. `FUN_0050F5B0` supplies the default category: gloss for 63/69/75/76, hoses for 68, calipers for 70, mufflers for 71, rims for 73/74, vinyl for 77–92. Body/accessory paint can select gloss/metal/pearl (`gameHash("GLOSS"/"METAL"/"PEARL")`); the dedicated slots accept only their own category. `FUN_005306E0` maps the paint categories to progression groups; the editor does not enforce progression. Slot 72 (`PAINT_AUDIO`) is in the generic, unfiltered branch, so it deliberately retains all compatible paints. Dials use their own compatible descriptors without a paint-category attribute.

`selectableOptions` and edit validation apply these restrictions, while `options`/`part` still resolve installed cross-category hashes for display and preservation. Numbered swatches group by catalogue naming family and sort the colour suffix numerically; `PEARL#_PAINT` and `CUSTOMPAINT_#` remain separate. The unusual `HOSES_L3_TEST01` joins `HOSES_L3_COLOR02`–`30` in one level-three palette. Unnumbered dial colours keep native order. RGB previews are approximate, not a reconstruction of gloss/metal/pearl shaders. Tests check category counts and swatch completeness for all 46 local cars, reject cross-category writes, and preserve installed exceptions on unrelated edits.

`FUN_00631D20` ignores slots 97–104 (hood decal textures) and treats 25 (under-hood geometry) as read-only. Other internal/derived geometry and bookkeeping slots are not offered. `FUN_0061BCD0` derives slot visibility through repeated attribute `0xE80A3B62` and the slot-name hashes, with a special exception for spoiler paint (69); widebody also hides the ordinary bumpers and skirts. It resolves `HOODUNDER`, widebody door components and widebody decal geometry. `FUN_0055C230` links wheel slots 29/30, resets audio components 35–46 through stock-part selection (`FUN_005474A0`, `FUN_0053AEA0`), and enforces carbon/vinyl exclusions (`FUN_0050EC10`, `FUN_0050EC80`, `FUN_0050ECE0`). The editor mirrors these traced dependencies, without shop eligibility, ownership, reward or money bookkeeping. Body edits rebuild IDs 56–67 for consistent dyno defaults.

Validation covers every car/menu combination in the local archive, first/last compatible selections and isolated write boundaries, known installed hashes in the supplied career fixture, raw-save/10-slot garage round trips, linked/dependent fields, unknown-value retention and Apply/Discard. This is not exhaustive in-game verification of all combinations, nor a recreation of the 3D preview or every frontend animation and progression gate.

## Remaining scalar dyno menus

All 41 setup bytes are now represented by curves, drivetrain or scalar controls. Scalars are suspension 0–8 (front/rear springs, shocks, sway bars, ride height, steering); nitrous duration/flow 16/17; brake bias 18; front/rear grip 19/20; front/rear downforce 21/22. `FUN_005ACA50`, `FUN_005B2980`, `FUN_005A79F0`, `FUN_005B4780`, `FUN_005B3FA0`, `FUN_005B3100` and `FUN_0059B200` establish installed-package defaults, tuning-record bounds/display transforms, setters and load order.

`DynoModel.scalarTuning` exposes only unlocked controls, both physics and display bounds/default/current values and valid byte bounds. Shocks/grip interpolate two components. Ride height is a negative displacement from the original wheel positions and is shown in cm. Nitrous inversely couples duration/flow and re-encodes the partner during loading: `withScalarValue` therefore writes both bytes 16/17. Invalid traffic-car bounds disable writes. These fields are present in `tuned` physics, but their effects are not added speculatively to the existing straight-line simulation or auto-tuner.

`setSetupTuning(..., gearing, scalars)` retains legacy defaults: curves always, gearing only with the fifth argument, scalars only with the sixth. The UI enables scalar writes only when they changed, preserves unrelated bytes/setups, and uses the existing per-event draft and Apply/Discard lifecycle.

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

Traced from `SPEED2.EXE`; ported in `src/model/dyno.ts`. The original port matched the Python reference model to 1e-13 on all 45 fixture setups. The gearing load was subsequently corrected and checked separately against native code as described below. Since PR #4 the dyno port is checked against the game executable itself, run in a CPU emulator (40 reference cases in `src/test/dyno-exactness.test.ts`; the emulator matched 30 of 30 values on the live in-game dyno screen). Where this section and that test disagree, the test is the evidence.

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
2. **Tuning load** `FUN_005b4780`: removes uniques, applies final drive and gears (with the gear spacing solver `FUN_005b2ed0`, minimum gap 0.05), then the ECU and turbo curves. Ranges come from `FUN_005b2980`; curve maxima are capped so no point exceeds the default curve's peak power. `FUN_005b2c00` writes a point back only when its requested change is nonzero, so a neutral byte keeps a stock point above that cap unclamped. The torque sum before the curves is restored by spreading the difference evenly over the 9 points, then uniques are re-added.
3. **Dyno** `FUN_005b06a0`: 60 Hz drag run with shift pauses, all state in float32 (the shift-recovery counter reaches 0.9999995827674866 after 40 updates, so a 41st is needed, and the cut branch requires counter > 0); 0–60 and 0–100 are scaled by per-car display factors, quarter mile at 400.5 m. **Top speed** `FUN_005b5ab0`/`FUN_005b5930`: force table in 1.341 m/s steps against drag (last force zeroed, n forces over n−1 intervals on [0, vmax], resampled to a 64-entry table, walk while `sp <= vmax`), capped by the speed limiter (`R+0x290`) unless a limiter-removing part (45, 46, 51) is installed.
4. **Units**: the torque table is in kN·m and mass in tonnes. The dyno screen (`FUN_0054a620`) shows max torque as `T*1000` N·m or `*0.73756212` lb-ft, and max power in kW or `*1.34102209` hp. Peak power comes from `FUN_005ac980`: every 50 rpm from idle up to (not including) the redline, `T*1000*rpm*1.0471204e-4` kW. The editor samples peak torque the same way.

### Auto-tune

`optimizeSetup` remains the single-stage search helper for targeted model tests. The GUI uses `optimizeDynoSetup(model, setup, event, gearing)`, where event is the selected setup index: 0 Circuit, 1 Drag, 2 Drift, 3 Street X, 4 URL. There is no goal slider. It starts from the current draft (or saved bytes) and stores the result as that draft. **Optimize gearing & shift spacing** defaults to false; changes keep existing drafts, and results whose slot/setup or gearing setting changed before completion are discarded. `setSetupTuning` applies curves, optionally gearing bytes 9–15 and optionally scalar bytes 0–8/16–22 to that setup only; inactive/unused gear bytes are preserved by editing. Search changes only curves and optional gearing, not scalars. Search uses coordinate descent over 0–200 (coarse step 10, then +/-9), up to eight sweeps per seed, seeded from current values and all-100, all-0 and all-200 on searched parameters.

The [wiki](https://nfs.fandom.com/wiki/Need_for_Speed:_Underground_2/Performance_Tuning) describes ECU/turbo settings as torque per RPM interval, recommends acceleration-biased setups for shorter tracks and drift, and top-speed-biased setups for drag. It does not prescribe ECU curves or exact RPM targets. Our event bands are explicitly editor policy: let `span = redline - idle`, and `recovery` be the lowest landing RPM across the current forward shifts (fallback `idle + 0.5 * span` without shifts). Circuit/URL start at `max(idle + 0.35 * span, min(recovery, idle + 0.65 * span))` and end at redline. Drag uses 0.5 in place of 0.35. Drift uses `[idle + 0.2 * span, idle + 0.75 * span]`; Street X uses `[idle + 0.25 * span, idle + 0.85 * span]`. The reference band is frozen for the entire search so ratios cannot improve the score just by moving its target. Drafts retain this band for the UI's Saved/Edited usable-power comparison.

`usablePower` splits that band into three equal RPM regions, integrates nonnegative loaded engine power in each with trapezoids no wider than 50 rpm, and returns the geometric mean of the three averages (kW). This rewards the whole operating band instead of peak HP. First, tune curves for this score; then run two event passes minimizing `-usablePower / referencePower + 0.2 * performance`. Performance combines normalized `t60`, `t100`, exact quarter mile and negative top speed, weighted `[0.2, 0.2, 0.3, 0.3]` for Circuit/URL, `[0.05, 0.1, 0.35, 0.5]` for Drag and `[0.6, 0.25, 0.1, 0.05]` for Drift/Street X. Unreachable reference times are excluded. Both passes keep the same reference; optional gearing retains the all-shift quality constraints below. Final usable-power refinement fixes gearing and accepts candidates only when all resulting acceleration/quarter-mile times are no greater, and top/trap speeds are no lower, using unrounded values without tolerance. This guard applies to final refinement, not event tuning. These are heuristic power-band/straight-line objectives, not lap-time or drift-score simulations or guarantees of a global optimum.

### ECU/turbo graph editor

`DynoModel.curve(setup, kind)` returns the 9 points of the ECU (`+0x17`) or turbo (`+0x20`) curve, or null when that curve is not active for the installed parts. Point `i` is at `idle + (redline - idle) * i / 8` rpm. Its stock value is the default curve from the tuning load (ECU `0x200 - 0x224`, turbo `0x224`), and its min/max come from `FUN_005b2980` as above. The value is `clamp(stock + (max - min) * clamp((byte - 100) / 100, -1, 1), min, max)` in kN·m (shown ×1000 as N·m). `minByte`/`maxByte` are the bytes that reach the clamped limits: one byte is `(max - min) / 100`, so the limit is reached within one step. When `stock ± span` lies inside the range, a limit is unreachable (e.g. the RX8's turbo point at redline, stock 90 over max 89 N·m, bottoms out at 51 rather than 50 N·m). Stock may exceed max; the neutral byte then shows the clamped value, while the loaded physics (`effective`) keeps the stock value because the load does not write an unchanged point. The editor clamps edits to `[minByte, maxByte]` because bytes beyond them do not change the value; `DynoModel.curveByte` maps a pointer position to the nearest such byte. Graph edits and Auto-tune results are kept per `slot:setup` until applied or discarded; other save edits, loading game data or a save, and reopening the tuning dialog drop them.

**Game rules vs cheat limits.** The game's tuning screen sets a point with `FUN_005b2c00(value, param, point, redistribute = 1)`, while the save load (`FUN_005b4780`) calls it with `redistribute = 0`. With redistribution, the function reads the nine current values (`FUN_005a7da0`: ECU `+0x200 - +0x224`, turbo `+0x224`), clamps the edited point to its range and records `delta = value - old` (the requested change, not the clamped one). Then, while `|remaining| > 1e-7` (`0x7A0354`; `remaining` starts at `delta`), it visits the neighbours at offsets +1, −1, +2, −2, … +8, −8 and repeats. Neighbours outside 0–8 are skipped. Each valid neighbour takes the next weight from `0x7FC674`: `0.25, 0.25, −0.25 ×6`, then a ninth word, the integer 3, which is a denormal ≈0 as a float. The amount is `delta * weight`, limited towards `remaining`; from the tenth valid neighbour on, the amount is `−remaining`. The neighbour is clamped to its own range, and its actual change is added to `remaining`. The loop stops after 20 weight slots. Raising a point therefore lifts ±1 by 25% each and lowers ±2…±4 by 25% each, which keeps the sum of the nine values; clamped neighbours pass the rest on. ECU results are written as `+0x200 = value + +0x224`; turbo results update `+0x224` and shift `+0x200` by the same amount. `DynoModel.withCurvePoint` ports this and re-encodes only the points it changed, using `curveByte`; this is the editor's default. The **Cheat limits (save-only)** toggle instead writes each point's byte on its own, as only a save edit can. The load then clamps every point and `FUN_0059b3c0` adds `(sumBefore - sumAfter) / 9` to all nine total-torque `+0x200` values, never to turbo `+0x224`. Lowering some points can therefore raise others past their maximum.

**Final component display.** `CurvePoint.effective` reads final loaded physics after sum restoration and unique parts: ECU = `(+0x200 - +0x224) * 1000`, turbo = `+0x224 * 1000`. The previous `value + spread` shortcut was incorrect for turbo and omitted uniques. ECU's marks move by an equal additive offset across RPM when the load restores the sum; that is expected, not proportional scaling. The components add back to the full engine torque used by the result table. Auto-tune searches bytes independently, so it uses the cheat limits regardless of the toggle.

### Drivetrain editor and range limits

The **Drivetrain** tab mirrors the game's Gear Ratios screen. `DynoModel.gearing(setup)` lists the active forward gears (params 10–15) and the final drive (9), or returns null when no transmission part unlocks them. Each row has the ratio after the full tuning load, its stock (neutral-byte) ratio and its `[min, max]` from `FUN_005b2980`. The display speed comes from `FUN_005b2800`, which calls `FUN_0059b5c0`: `speed (m/s) = wheelRadius * redline_rpm(+0x1F4) * K / (finalDrive(+0x1B8) * ratio)`, in float32, where `K` is the float stored at `0x7A1D38` (bytes `44 77 D6 3D` = 0.10471966862678528, the float nearest 2π/60 but not exactly 2π/60), not the power factor 0.10471204. `wheelRadius` is the front (`+0x50`) or rear (`+0x80`) radius, blended by the bias at `+0x1C0` (below 0.2 front, above 0.8 rear). The editor shows this ×3.6 as km/h on the game's 0–420 scale. Gear ranges are speed limits converted through the current final drive, so a final-drive change moves every gear speed and range. `DynoModel.withGearRatio` follows the game's setter: it clamps to the range, makes the recursive 0.05 neighbour spacing for gears and re-encodes every active gear byte with the same float32 encoder as the load (`FUN_0059af80`: `trunc(frac * 100f + 100.5f)`, `frac = (ratio - stock) / (max - min)` in float32), clamped to 0..200. A double-precision encoder differs at byte boundaries (Peugeot 106, all performance parts, neutral setup: final drive 3.2168500423431396 gives byte 82 natively, 81 in double). A single step is one byte of `(max - min) / 100`.

**Unlocking the standard ranges is not possible through the save** (traced in `SPEED2.EXE`). `FUN_0059aee0` decodes a byte as `clamp((byte - 100.0) * 0.01, -1.0, 1.0)` (constants at `0x784258` = 100.0, `0x78425C` = 0.01, `0x784250` = 1.0, `0x7842A0` = -1.0), so bytes 201–255 act like 200. `FUN_005b4780` skips params without a tuning record (`FUN_0059ae40`), and `FUN_005b4670` → `FUN_005b3ee0` clamps every value to the range from `FUN_005b2980` before `FUN_0059af80` writes the byte back, clamped to 0..200. Ranges depend on the tuning records of the installed parts: final drive comes with the level 1 differential (ID 8), level 2 LSD (ID 9) and level 3 six-speed (ID 11), and the six-speed also unlocks the gears. Wider ranges would need edited tuning records (`f8`/`fC`) in `GLOBALB.BUN`, which is a game-data mod and outside this save editor.

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

**Optimizer shift quality (editor policy, not a traced game algorithm).** When individual gearing is enabled, every forward shift contributes to the objective, even if the selected acceleration target or quarter mile ends before it. Landing RPM is `shiftRPM * nextRatio / currentRatio`, using the drag model's shift threshold (`R+0x1F4 - 200`). Mean power over the landing-to-shift RPM interval is integrated with trapezoids at intervals of at most 50 RPM and normalized by the tuned engine's peak power. The objective is the existing goal score divided by its initial absolute magnitude (minimum 1), plus `0.2 * (1 - meanCoverage) + 0.4 * (1 - worstCoverage) + 0.1 * CV²(log(currentRatio/nextRatio))`. This rewards useful power across the whole recovered band and consistent percentage RPM drops, not equal numerical ratio differences. The legacy single-stage helper caps worsening of the initial goal score at 5% of its absolute magnitude (minimum 1); staged GUI tuning instead uses the weighted goal directly, as explained above. If the search cannot satisfy the shift constraints (and budget, where enabled), it reports an error rather than returning a known-bad gearbox.

Candidates must retain at least `min(neutralShiftRetention, geometricMeanNeutralRetention)` RPM on every shift (tolerance `1e-6`). This prevents a short-run improvement from creating a large hole elsewhere while allowing the naturally wider first-gear step. A neutral-gearing seed permits recovery from already uneven input. Final-drive-only tuning and ECU/turbo-only optimization keep their original scoring. These constraints use the installed transmission, actual normalized ratios and active gear count. No saved shift-RPM setting is invented or changed, and the native dyno prediction formulas remain unchanged.

**Validation.** Ghidra CLI assembly plus Unicorn execution of the actual EXE's load, recursive setter and byte writer covered 48 synthetic setups (five/six gears; neutral, minimum, maximum, conflicting and seeded random bytes). Only tuning availability/range lookups and unique-part refresh were hooked, so this verifies gearing sequencing and normalization, not the entire builder or a live game. Corrected TS ratios agree within `1.9e-7`; the old model differed by up to `0.254`. Repository tests retain native-result regressions for both gearbox sizes, inactive tuning, input immutability and both final-drive fields. The fixture dyno tests were later updated to the native evidence from PR #4 (gear-speed constant, unchanged-point writeback); the gear encoder is shared by the load and `withGearRatio` and runs in float32. The gearing-enabled optimizer and isolated setup writer are also covered by repository tests, including controller Apply/download, draft discard, manual graph edits and Drivetrain edits (step, keys, drag, reset, apply). In-game verification remains outstanding.

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

These findings were checked against the local BUN and Ghidra CLI assembly for `FUN_0041aaf0`, `FUN_00516500`, `FUN_00610130` and `FUN_005b4dc0`. The webapp now exposes these 15 hashes in the main replacement dropdown's **Traffic cars (experimental)** group, not as donor blocks. `setSlotTrafficCar` accepts only a listed hash and an unlocked, filled/used slot, and writes only the uint32 at `slot+0x014`. The UI applies traffic replacement without confirmation and labels recognized traffic identities experimental; its status warns that the conversion is incomplete and should be tested only with a backup. DYNO is blocked for them. Body/customization fields, parts, setup bytes and slot bookkeeping are deliberately preserved rather than fabricated. No in-game traffic conversion has been validated. Player driving, career persistence, customization compatibility and the minimal consistent save fields still need controlled tracing/testing before considering traffic replacement a complete or supported conversion.

### Leftover folders are not necessarily hidden cars

The inspected install also contains `CARS\NEON`, `CARS\S2000`, `CARS\LANCER` and `CARS\IMPREZA`. Each contains only `VINYLS.BIN`, with no geometry or textures, and none has a matching car record in this BUN. LANCEREVO8 and IMPREZAWRX are separate real records. These four folders are leftover assets, not evidence that a Neon, S2000 or older Lancer/Impreza is selectable through a save edit. Other installs/builds may differ.

## nfsu2-web backup ZIPs and GARAGE.DAT

Source: [`runtime/garage.c`](https://github.com/th0mk/nfsu2-web/blob/main/runtime/garage.c) and [`web/src/app/zip.ts`](https://github.com/th0mk/nfsu2-web/blob/main/web/src/app/zip.ts) in `th0mk/nfsu2-web`. Two local backups were checked against this description.

- Backups are ordinary ZIPs. Profiles are at `NFS Underground 2/<name>/<name>`. A profile may have `GARAGE.DAT` and an older, unpaired `GARAGE.OLD`. nfsu2-web writes stored entries with UTF-8 names and reads stored or deflated entries.
- The career save keeps the game's five native car records. Record `n` begins at `0x5868 + n * 0x7F2` and is 2,034 bytes. The editor's historical slot base is record `+8`. Record `+4` is the `CAREER_SLOT_<n>` handle (`bStringHash`; `0x319A8CA1` for slot 1). Lock and owned flags are at record `+0x430` and `+0x431`, which are the editor's `+0x428` and `+0x429`.
- `GARAGE.DAT` is 10,202 bytes. Its 32-byte header is eight little-endian `uint32` values: `N2GA`, version `1`, fingerprint low/high, career car handle, Quick Race car handle, stand-in handle and `0`. Five records for slots 6–10 follow, in the same 2,034-byte format as the career's records.
- The fingerprint is 64-bit FNV-1a over the profile's 39,230-byte car part at file offsets `[36, 39,266)`. If it does not match, nfsu2-web renames the garage to `GARAGE.OLD` and does not load it.
- When the career or Quick Race car is in slots 6–10, nfsu2-web stores a car from slots 1–5 as the stand-in in the career save. The handle fields in `GARAGE.DAT` restore the real car after loading. The editor keeps these fields unchanged.

In memory, the editor appends the five `GARAGE.DAT` records after the 54,966-byte career save, giving one 65,136-byte working buffer. Slots 6–10 therefore use the same slot-relative model code as slots 1–5. On download, the career part is split off and its checksums are recalculated. Its records are written back after the `GARAGE.DAT` header, and the fingerprint is calculated from the final career bytes. Unchanged ZIP entries keep their data, timestamps and attributes. Edited entries receive a new timestamp. Both local backups round-trip byte-identically through this path, and edited copies have valid checksums and matching fingerprints. In-game loading of an edited nfsu2-web backup has not yet been tested.

Native slot swap exchanges record bytes from the editor's slot base up to the record end (`+0x7EA`). It leaves record bytes `+0` to `+7`, including the slot handle, in place. The earlier swap used the 0x7F2 stride from the shifted base, so it moved the following record's first eight bytes and handle.

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
