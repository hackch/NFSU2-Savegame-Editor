import { checkedSlotBase, dataView, PERF_OFF, VISUAL_OFF, VISUAL_COUNT } from './layout.js';
import { getCarTypeHash } from './slots.js';

export { VISUAL_OFF, VISUAL_COUNT } from './layout.js';

const NAMES = [
  'BASE', 'FRONT_BUMPER', 'REAR_BUMPER', 'LEFT_SIDE_MIRROR', 'RIGHT_SIDE_MIRROR', 'BODY', 'WIDE_BODY',
  'ROOF', 'TOP', 'HOOD', 'TRUNK', 'SKIRT', 'SPOILER', 'ENGINE', 'HEADLIGHT', 'BRAKELIGHT', 'EXHAUST',
  'DOOR_LEFT', 'DOOR_RIGHT', 'DOOR_PANEL_LEFT', 'DOOR_PANEL_RIGHT', 'DOOR_SILL_LEFT', 'DOOR_SILL_RIGHT',
  'FENDER', 'QUARTER', 'HOOD_UNDER', 'TRUNK_UNDER', 'FRONT_BRAKE', 'REAR_BRAKE', 'FRONT_WHEEL',
  'REAR_WHEEL', 'SPINNER', 'WING_MIRROR', 'LICENSE_PLATE', 'TRUNK_AUDIO',
  ...Array.from({ length: 12 }, (_, i) => `TRUNK_AUDIO_COMP_${i}`),
  'DAMAGE_FRONT', 'DAMAGE_REAR', 'DAMAGE_LEFT', 'DAMAGE_RIGHT', 'DAMAGE_TOP',
  'DECAL_HOOD', 'DECAL_FRONT_WINDOW', 'DECAL_REAR_WINDOW', 'DECAL_LEFT_DOOR', 'DECAL_RIGHT_DOOR',
  'DECAL_LEFT_QUARTER', 'DECAL_RIGHT_QUARTER', 'WIDEBODY_DECAL_LEFT_DOOR', 'WIDEBODY_DECAL_RIGHT_DOOR',
  'WIDEBODY_DECAL_LEFT_QUARTER', 'WIDEBODY_DECAL_RIGHT_QUARTER', 'BASE_PAINT',
  ...Array.from({ length: 4 }, (_, i) => `VINYL_LAYER${i}`),
  'PAINT_ENGINE', 'PAINT_SPOILER', 'PAINT_BRAKE', 'PAINT_EXHAUST', 'PAINT_AUDIO', 'PAINT_RIM',
  'PAINT_SPINNER', 'PAINT_ROOF', 'PAINT_MIRROR',
  ...Array.from({ length: 16 }, (_, i) => `VINYL_COLOUR${Math.floor(i / 4)}_${i % 4}`),
  'KIT_CARBON', 'HOOD_CARBON', 'DOOR_CARBON', 'TRUNK_CARBON',
  ...['HOOD', 'FRONT_WINDOW', 'REAR_WINDOW', 'LEFT_DOOR', 'RIGHT_DOOR', 'LEFT_QUARTER', 'RIGHT_QUARTER']
    .flatMap((where) => Array.from({ length: 8 }, (_, i) => `DECAL_${where}_TEX${i}`)),
  'WINDOW_TINT', 'NEON', 'NEON_ENGINE', 'NEON_CABIN', 'NEON_TRUNK', 'CABIN_NEON_FRAME',
  'HEADLIGHT_BULB', 'DOOR_STYLE', 'HYDRAULICS', 'NOS_PURGE', 'CUSTOM_HUD',
  'HUD_BACKING_COLOUR', 'HUD_NEEDLE_COLOUR', 'HUD_CHARACTER_COLOUR', 'CV', 'WHEEL_MANUFACTURER', 'MISC',
];

// SPEED2.EXE 0x802960: the save's 170 slots are not the database's 69 part types.
const TYPES = [
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,27,28,28,29,30,31,
  60,61,61,62,62,63,63,61,61,61,61,62,62,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,
  50,50,50,50,48,48,48,48,48,48,48,48,48,
  ...Array<number>(16).fill(49), 51,51,51,51, ...Array<number>(56).fill(52),
  53,54,54,54,54,55,56,57,58,59,64,65,65,65,66,67,68,
];

const UG1 = new Set([0x3455d6b,0x163087,0xdb7c,0xdc00,0xac6d1,0x150fb80,0x290c04d,0x2ca04df,
  0x72b2e513,0x3b8c48a,0x4fd0522,0x545aec60,0x7502da84,0x79aebfec,0xbe48375e]);
const UG2 = new Set([0x30236ee,0xacc9,0x453,0x6e7,0xa86e,0xdc01,0x293fad7,0x4b10070a,
  0x9d2eff6,0x2d7c9b5d,0x35165819,0xcf4458f8,0xf77c13eb]);
const SUV = new Set([0x219c94a,0x6126dd4d,0xcf704771]);

export type VisualTab = 'BODY' | 'GRAPHICS' | 'SPECIALTIES';
export interface VisualSlot { id: number; name: string; label: string; tab: VisualTab; category: string }
export interface VisualPart {
  hash: number;
  name: string;
  type: number;
  group: number;
  level: number;
  variant: number;
  attributes: ReadonlyMap<number, readonly number[]>;
  color: string;
}

export interface ColorSwatch {
  hash: number;
  name: string;
  number: string;
  color: string;
  ink: string;
}
export interface ColorPalette { name: string; swatches: ColorSwatch[] }

export function isVisualColorSlot(slot: number): boolean {
  return slot === 63 || slot >= 68 && slot <= 92 || slot >= 164 && slot <= 166;
}

/** Match the frontend's material/category filter, not just the shared PAINT descriptor type. */
function paintCategories(slot: number): readonly number[] | null {
  if ([63,69,75,76].includes(slot)) return [0x2daab07, 0x3437a52, 0x3797533];
  if (slot === 68) return [0x16bdce];
  if (slot === 70) return [0xd6640dff];
  if (slot === 71) return [0x66350f0];
  if (slot === 73 || slot === 74) return [0xda27];
  if (slot >= 77 && slot <= 92) return [0x3e871f1];
  return null;
}

export function colorPalettes(parts: readonly VisualPart[]): ColorPalette[] {
  const palettes = new Map<string, { swatch: ColorSwatch; order: number }[]>();
  for (const part of parts) {
    const match = /^(.*?)(\d+)(\D*)$/.exec(part.name);
    const name = match ? `${match[1]}##${match[3]}`.replace(/^HOSES_L3_(?:TEST|COLOR)##$/, 'HOSES_L3') : 'Colours';
    const order = match ? Number(match[2]) : palettes.get(name)?.length ?? 0;
    const rgb = /^#[0-9a-f]{6}$/i.test(part.color) ? [1,3,5].map((i) => parseInt(part.color.slice(i, i + 2), 16)) : null;
    const swatch: ColorSwatch = {
      hash: part.hash, name: part.name, number: match ? match[2].padStart(2, '0') : part.name,
      color: part.color, ink: rgb && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? '#111111' : '#ffffff',
    };
    const entries = palettes.get(name) ?? [];
    entries.push({ swatch, order });
    palettes.set(name, entries);
  }
  return [...palettes].map(([name, entries]) => ({
    name, swatches: entries.sort((a, b) => a.order - b.order).map((entry) => entry.swatch),
  }));
}

export function gameHash(name: string): number {
  let hash = 0xffffffff;
  for (const c of name.toUpperCase()) hash = (Math.imul(hash, 33) + c.charCodeAt(0)) >>> 0;
  return hash;
}

function category(id: number): [VisualTab, string] | null {
  if ([1,2,3,4,6,7,8,9,10,11,12,13,14,15,16,29,31,32].includes(id)) return ['BODY', 'Body parts'];
  if (id >= 93 && id <= 96) return ['BODY', 'Carbon fibre'];
  if (id >= 63 && id <= 76 && (id < 64 || id > 67)) return ['GRAPHICS', 'Paint'];
  if (id >= 64 && id <= 67) return ['GRAPHICS', 'Vinyl layers'];
  if (id >= 77 && id <= 92) return ['GRAPHICS', 'Vinyl colours'];
  if (id >= 105 && id <= 152) return ['GRAPHICS', 'Decals'];
  if (id === 153) return ['GRAPHICS', 'Window tint'];
  if (id >= 34 && id <= 46) return ['SPECIALTIES', 'Trunk audio'];
  if (id >= 154 && id <= 157 || id === 159) return ['SPECIALTIES', 'Lighting'];
  if (id >= 160 && id <= 162) return ['SPECIALTIES', 'Specialties'];
  if (id >= 163 && id <= 166) return ['SPECIALTIES', 'Dials'];
  return null;
}

export const VISUAL_SLOTS: VisualSlot[] = NAMES.flatMap((name, id) => {
  const cat = category(id);
  return cat ? [{ id, name, label: name.toLowerCase().replaceAll('_', ' '), tab: cat[0], category: cat[1] }] : [];
});

export class VisualCatalog {
  private readonly optionCache = new Map<string, VisualPart[]>();

  constructor(
    readonly parts: readonly VisualPart[],
    private readonly defaults: readonly number[],
    private readonly overrides: ReadonlyMap<string, readonly number[]>,
    private readonly carNames: ReadonlyMap<number, string>,
  ) {}

  options(car: number, slot: number): VisualPart[] {
    if (!Number.isInteger(slot) || slot < 0 || slot >= VISUAL_COUNT) throw new RangeError('Invalid visual slot.');
    if (!this.carNames.has(car)) return [];
    const key = `${car}:${slot}`, cached = this.optionCache.get(key);
    if (cached) return cached;
    const groups = this.overrides.get(`${car}:${slot}`) ??
      this.defaults.slice(slot * 2, slot * 2 + 2).map((g) => g === 0xffffffff ? car : g);
    const parts = groups.flatMap((group) => this.parts.filter((p) => p.group === group && p.type === TYPES[slot] &&
      !(UG1.has(p.group) && this.attribute(p, 'EXCLUDE_UG1')) &&
      !(UG2.has(p.group) && this.attribute(p, 'EXCLUDE_UG2')) &&
      !(SUV.has(p.group) && this.attribute(p, 'EXCLUDE_SUV'))));
    this.optionCache.set(key, parts);
    return parts;
  }

  attribute(part: VisualPart | undefined, name: string): number {
    return part?.attributes.get(gameHash(name))?.[0] ?? 0;
  }

  selectableOptions(car: number, slot: number): VisualPart[] {
    const categories = paintCategories(slot);
    return this.options(car, slot).filter((part) => !categories ||
      categories.includes(part.attributes.get(0xebb03e66)?.[0] ?? 0));
  }

  part(car: number, slot: number, hash: number): VisualPart | undefined {
    return this.options(car, slot).find((p) => p.hash === hash);
  }

  hidden(refs: readonly number[], car: number, slot: number): boolean {
    if (slot === 69) return false;
    if ((this.part(car, 6, refs[6])?.level ?? 0) > 0 && [1,2,5,11,23,24].includes(slot)) return true;
    const key = gameHash(NAMES[slot]);
    return refs.some((hash, i) => hash !== 0 && this.part(car, i, hash)?.attributes.get(0xe80a3b62)?.includes(key));
  }

  edit(save: Uint8Array, slot: number, visual: number, hash: number): Uint8Array {
    if (!VISUAL_SLOTS.some((s) => s.id === visual)) throw new RangeError('This visual slot is derived or not editable.');
    const car = getCarTypeHash(save, slot);
    const refs = readVisual(save, slot);
    const part = this.part(car, visual, hash);
    if (hash !== 0 && !part) throw new RangeError('This part is not compatible with this car and slot.');
    if (hash !== 0 && !this.selectableOptions(car, visual).some((p) => p.hash === hash)) {
      throw new RangeError('This colour belongs to a different paint category.');
    }
    if (this.hidden(refs, car, visual)) throw new RangeError('This slot is hidden by the installed parts.');
    refs[visual] = hash;
    if (visual === 29) refs[30] = hash;
    if (visual === 34) {
      for (let i = 35; i <= 46; i++) refs[i] = this.options(car, i).find((p) => p.level === 0)?.hash ?? 0;
    }
    if (visual === 9) {
      refs[25] = this.part(car, 25, this.attribute(part, 'HOODUNDER'))?.hash ?? this.options(car, 25)[0]?.hash ?? 0;
      if (this.attribute(part, 'CARBONFIBRE')) this.clearVinyls(refs, car, (p) => p.variant === 20);
    }
    if (visual === 6) {
      const wide = part && part.level !== 0;
      const prefix = `${this.carNames.get(car)}_`;
      const names = ['LEFT', 'RIGHT', 'PANEL_LEFT', 'PANEL_RIGHT', 'SILL_LEFT', 'SILL_RIGHT'];
      names.forEach((name, i) => {
        const wanted = wide ? gameHash(`${prefix}KITW0${part.variant}_DOOR_${name}`) : 0;
        refs[17 + i] = this.options(car, 17 + i).find((p) => !wanted || p.hash === wanted)?.hash ?? 0;
      });
      if (wide) {
        ['LEFT_DOOR','RIGHT_DOOR','LEFT_QUARTER','RIGHT_QUARTER'].forEach((name, i) => {
          refs[59 + i] = this.part(car, 59 + i, gameHash(`${prefix}WIDE${part.variant}_DECAL_${name}_RECT_MEDIUM`))?.hash ?? 0;
        });
      }
    }
    if ((visual === 6 || visual === 93) && (this.part(car, 93, refs[93])?.level ?? 0) > 0) {
      if ((this.part(car, 6, refs[6])?.level ?? 0) > 0 || visual === 6) this.clearVinyls(refs, car, (p) => p.variant !== 20);
      else this.clearVinyls(refs, car, (p) => [14,15,21,22,23,24,25,26].includes(p.variant));
    }
    const out = save.slice(), base = checkedSlotBase(out, slot) + VISUAL_OFF;
    refs.forEach((value, i) => dataView(out).setUint32(base + i * 4, value, true));
    if ([1,2,6,11,12].includes(visual)) {
      const start = checkedSlotBase(out, slot) + PERF_OFF;
      out.fill(0, start + 56, start + 68);
      const wide = (this.part(car, 6, refs[6])?.level ?? 0) > 0;
      for (const [partSlot, first] of [[1,56],[2,62],[11,59],[12,65]]) {
        const level = wide ? 3 : Math.min(this.part(car, partSlot, refs[partSlot])?.level ?? 0, 3);
        if (level) out[start + first + level - 1] = 1;
      }
    }
    return out;
  }

  private clearVinyls(refs: number[], car: number, predicate: (part: VisualPart) => boolean): void {
    for (let i = 64; i <= 67; i++) {
      const part = this.part(car, i, refs[i]);
      if (part && predicate(part)) refs[i] = 0;
    }
  }
}

export function readVisual(save: Uint8Array, slot: number): number[] {
  const base = checkedSlotBase(save, slot) + VISUAL_OFF, dv = dataView(save);
  return Array.from({ length: VISUAL_COUNT }, (_, i) => dv.getUint32(base + i * 4, true));
}

export function parseVisualData(bytes: Uint8Array, cars: readonly { hash: number; name: string }[]): VisualCatalog {
  const dv = dataView(bytes), chunks = new Map<number, Uint8Array>();
  function walk(start: number, end: number): void {
    for (let off = start; off < end;) {
      if (off + 8 > end) throw new Error('Truncated game-data chunk.');
      const id = dv.getUint32(off, true), size = dv.getUint32(off + 4, true), next = off + 8 + size;
      if (next > end) throw new Error('Game-data chunk exceeds its container.');
      if (id & 0x80000000) walk(off + 8, next);
      else if (id >= 0x34603 && id <= 0x3460c) {
        if (chunks.has(id)) throw new Error(`Multiple visual databases are not supported (chunk ${id.toString(16)}).`);
        chunks.set(id, bytes.subarray(off + 8, next));
      }
      off = next;
    }
  }
  walk(0, bytes.length);
  function chunk(id: number, stride: number): Uint8Array {
    const result = chunks.get(id);
    if (!result || !result.length || result.length % stride) throw new Error(`Missing or invalid visual chunk ${id.toString(16)}.`);
    return result;
  }
  const header = chunk(0x34603, 4), rawDescriptors = chunk(0x34604, 1);
  if (header.length !== 60) throw new Error('Invalid visual database header.');
  const descriptorSize = dataView(header).getUint32(56, true) * 14;
  if (descriptorSize === 0 || descriptorSize > rawDescriptors.length || rawDescriptors.length - descriptorSize > 3) {
    throw new Error('Invalid visual descriptor count.');
  }
  const descriptors = rawDescriptors.subarray(0, descriptorSize), strings = chunk(0x34606, 1), lists = chunk(0x3460c, 2);
  const attributes = chunk(0x34605, 8), groups = chunk(0x3460b, 4), tables = chunk(0x34607, 1);
  if (tables.length < VISUAL_COUNT * 8 || (tables.length - VISUAL_COUNT * 8) % 16) throw new Error('Invalid visual compatibility table.');
  const td = dataView(tables), dd = dataView(descriptors), ld = dataView(lists), ad = dataView(attributes), gd = dataView(groups);
  const defaults = Array.from({ length: VISUAL_COUNT * 2 }, (_, i) => td.getUint32(i * 4, true));
  const overrides = new Map<string, number[]>();
  for (let off = VISUAL_COUNT * 8; off < tables.length; off += 16) {
    const car = td.getUint32(off, true), slot = td.getUint32(off + 4, true);
    if (slot >= VISUAL_COUNT) throw new Error('Invalid visual override slot.');
    overrides.set(`${car}:${slot}`, [td.getUint32(off + 8, true), td.getUint32(off + 12, true)]);
  }
  const parts: VisualPart[] = [];
  for (let off = 0; off < descriptors.length; off += 14) {
    const nameOff = dd.getUint16(off + 8, true) * 4, nameEnd = strings.indexOf(0, nameOff);
    const groupOff = descriptors[off + 7] * 4, list = dd.getUint16(off + 10, true);
    if (nameOff >= strings.length || nameEnd < nameOff || groupOff + 4 > groups.length || descriptors[off + 4] > 68) {
      throw new Error('Invalid visual descriptor.');
    }
    const attrs = new Map<number, number[]>();
    if (list !== 0xffff) {
      const start = list * 2;
      if (start + 2 > lists.length) throw new Error('Invalid visual attribute list.');
      const count = ld.getUint16(start, true);
      if (start + 2 + count * 2 > lists.length) throw new Error('Truncated visual attribute list.');
      for (let i = 0; i < count; i++) {
        const pos = ld.getUint16(start + 2 + i * 2, true) * 8;
        if (pos + 8 > attributes.length) throw new Error('Invalid visual attribute index.');
        const key = ad.getUint32(pos, true), values = attrs.get(key) ?? [];
        values.push(ad.getUint32(pos + 4, true));
        attrs.set(key, values);
      }
    }
    const rgb = ['RED', 'GREEN', 'BLUE'].map((name) => attrs.get(gameHash(name))?.[0]);
    parts.push({
      hash: dd.getUint32(off, true), name: new TextDecoder('windows-1252').decode(strings.subarray(nameOff, nameEnd)),
      type: descriptors[off + 4], level: descriptors[off + 5] >> 5, variant: descriptors[off + 5] & 31,
      group: gd.getUint32(groupOff, true), attributes: attrs,
      color: rgb.every((n) => n !== undefined && n <= 255) ? `#${rgb.map((n) => n!.toString(16).padStart(2, '0')).join('')}` : '',
    });
  }
  return new VisualCatalog(parts, defaults, overrides, new Map(cars.map((c) => [c.hash, c.name])));
}
