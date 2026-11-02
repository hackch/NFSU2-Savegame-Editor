/**
 * Installed-byte IDs from SPEED2.EXE's 68-entry name table (file 0x403570).
 * Active items, levels, prices and exclusions come from GLOBALB.BUN chunk 0x34A15.
 * The examined table omits IDs 33/34. Unique upgrades use separate dwords.
 */

/** A category as it appears in the name table. */
export interface PerfCategory {
  /** Short code from the name table, e.g. `EN` for engine. */
  code: string;
  /** Human-readable category label. */
  label: string;
  /** Global part indices (into {@link PERF_PARTS}) that belong to this category. */
  indices: number[];
}

/** One performance part flag in a car slot. */
export interface PerfPart {
  /** Position in the flag block at slot+0x310. */
  index: number;
  /** Table key, e.g. `EN_MUFFLER`. */
  key: string;
  /** Human readable name derived from the key. */
  label: string;
  /** Owning category code. */
  category: string;
  /** True when a save diff confirmed the flag in-game. */
  verified: boolean;
  /** Present in the examined archive's active item table. */
  active: boolean;
  /** Ordinary package level; null for absent item records. */
  level: 1 | 2 | 3 | null;
  /** Archive price, not a charge made by this editor. */
  price: number | null;
  /** IDs disabled by the game's apply routine when this item is enabled. */
  conflicts: number[];
}

export interface UniquePerfPart {
  index: number;
  category: string;
  key: string;
  label: string;
}

const CATEGORIES: { code: string; label: string; parts: string[] }[] = [
  { code: 'WT', label: 'Weight reduction', parts: ['REMOVE_REAR_SEATS', 'REMOVE_INTERIOR_PANELS', 'LIGHTWEIGHT_WINDOWS', 'LIGHTWEIGHT_SEATS', 'LIGHTWEIGHT_DOORS', 'FOAM_FILLED_INTERIOR'] },
  { code: 'TR', label: 'Transmission', parts: ['SHORT_THROW_SHIFT_KIT', 'LIGHT_FLYWHEEL', 'DIFFERENTIAL', 'LIMITED_SLIP_DIFFERENTIAL', 'HIGH_PERFORMANCE_CLUTCH', '6_SPEED_TRANSMISSION'] },
  { code: 'NO', label: 'Nitrous', parts: ['DRY_SHOT_OF_NITROUS', 'WET_SHOT_OF_NITROUS', 'DIRECT_PORT_NITROUS_OXIDE'] },
  { code: 'EN', label: 'Engine', parts: ['MUFFLER', 'COLD_AIR_INTAKE_SYSTEM', 'REPLACE_HEADERS', 'MILD_CAMSHAFT_AND_CAM_GEARS', 'CAT_BACK_EXHAUST_SYSTEM', 'HIGH_FLOW_INTAKE_MANIFOLD', 'LARGER_DIAMETER_DOWNPIPE', 'RACING_CAMSHAFT_AND_GEARS', 'PORT_AND_POLISH_HEADS', 'BLUEPRINT_THE_BLOCK', 'HIGH_FLOW_HEADERS'] },
  { code: 'TU', label: 'Turbo', parts: ['STAGE_1_TURBO_KIT', 'STAGE_2_TURBO_KIT', 'STAGE_3_TURBO_KIT'] },
  { code: 'SU', label: 'Suspension', parts: ['SPORT_SPRINGS_AND_SHOCKS', 'STRUT_TOWER_BAR', 'PERFORMANCE_SPRINGS_AND_SHOCKS', 'FRONT_AND_REAR_SWAY_BARS', 'FRONT_AND_REAR_TIE_BARS', 'UPGRADE_BUSHINGS', 'COIL_OVER_SUSPENSION_SYSTEM', 'CAMBER_KIT', 'LARGE_DIAMETER_SWAY_BARS'] },
  { code: 'BR', label: 'Brakes', parts: ['STREET_COMPOUND_BRAKE_PADS', 'STEEL_BRAIDED_BRAKE_LINES', 'CROSS_DRILLED_ROTORS', 'LARGE_DIAMETER_ROTORS', 'RACE_COMPOUND_BRAKE_PADS', 'CROSS_DRILLED_AND_SLOTTED_ROTORS', '6_PISTON_RACING_CALIPERS'] },
  { code: 'EC', label: 'Engine control & fuel', parts: ['REMOVE_SPEED_LIMITER', 'PERFORMANCE_CHIP', 'HIGH_FLOW_FUEL_PUMP', 'FUEL_PRESSURE_REGULATOR', 'FUEL_RAIL', 'FUEL_FILTER', 'ENGINE_MANAGEMENT_UNIT', 'FUEL_INJECTORS'] },
  { code: 'TI', label: 'Tires', parts: ['STREET_PERFORMANCE_TIRES', 'PRO_PERFORMANCE_TIRES', 'EXTREME_PERFORMANCE_TIRES'] },
  { code: 'AE', label: 'Aero & body', parts: ['FRONT_BUMPER_L1', 'FRONT_BUMPER_L2', 'FRONT_BUMPER_L3', 'SIDESKIRTS_L1', 'SIDESKIRTS_L2', 'SIDESKIRTS_L3', 'REAR_BUMPER_L1', 'REAR_BUMPER_L2', 'REAR_BUMPER_L3', 'SPOILER_L1', 'SPOILER_L2', 'SPOILER_L3'] },
];

/** Part indices confirmed by in-game save diffs. */
const VERIFIED_INDICES = new Set([15, 16]);

// Tuples retain the archive IDs: removing the two absent records must not shift later flags.
const ITEM_DETAILS: [index: number, level: 1 | 2 | 3, price: number, ...conflicts: number[]][] = [
  [0, 1, 250], [1, 1, 250], [2, 2, 1000], [3, 2, 1000], [4, 3, 3000], [5, 3, 1000],
  [6, 1, 100], [7, 1, 400], [8, 1, 500, 9, 11], [9, 2, 1000, 8, 11], [10, 2, 1500], [11, 3, 5000, 9, 8],
  [12, 1, 750, 13, 14], [13, 2, 2000, 12, 14], [14, 3, 4000, 12, 13],
  [15, 1, 500, 19], [16, 1, 250], [17, 1, 500, 25], [18, 1, 250, 22],
  [19, 2, 1000, 15], [20, 2, 500], [21, 2, 500],
  [22, 3, 500, 18], [23, 3, 1000], [24, 3, 1500], [25, 3, 500, 17],
  [26, 1, 1000, 27, 28], [27, 2, 4000, 26, 28], [28, 3, 8000, 27, 26],
  [29, 1, 500, 31, 35], [30, 1, 250], [31, 2, 2000, 29, 35], [32, 2, 1000, 37],
  [35, 3, 5000, 29, 31], [36, 2, 500], [37, 3, 2000, 32],
  [38, 1, 250, 42], [39, 1, 250], [40, 1, 500, 41, 43], [41, 2, 1500, 40, 43],
  [42, 2, 1000, 38], [43, 3, 3000, 40, 41], [44, 3, 3000],
  [45, 1, 100], [46, 2, 1000, 51], [47, 2, 500], [48, 1, 250], [49, 1, 250], [50, 1, 250],
  [51, 3, 7000, 46], [52, 3, 1000],
  [53, 1, 500, 54, 55], [54, 2, 1500, 53, 55], [55, 3, 3000, 53, 54],
  [56, 1, 0, 57, 58], [57, 2, 0, 56, 58], [58, 3, 0, 57, 56],
  [59, 1, 0, 60, 61], [60, 2, 0, 59, 61], [61, 3, 0, 60, 59],
  [62, 1, 0, 63, 64], [63, 2, 0, 62, 64], [64, 3, 0, 63, 62],
  [65, 1, 0, 66, 67], [66, 2, 0, 65, 67], [67, 3, 0, 66, 65],
];
const detailsByIndex = new Map(ITEM_DETAILS.map(([index, level, price, ...conflicts]) =>
  [index, { level, price, conflicts }],
));

/**
 * Turns `COLD_AIR_INTAKE_SYSTEM` into `Cold Air Intake System`. Level suffixes such as `L1` stay upper case.
 * @param key Table key with underscores.
 * @returns Display label.
 */
function humanize(key: string): string {
  return key
    .split('_')
    .map((word) => (/^l\d$/i.test(word) ? word.toUpperCase() : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

/** Flat list of every named flag, including visual-related IDs, in flag-block order. */
export const PERF_PARTS: PerfPart[] = [];

/** Parts grouped by category, in name-table order. */
export const PERF_CATEGORIES: PerfCategory[] = [];

for (const category of CATEGORIES) {
  const group: PerfCategory = { code: category.code, label: category.label, indices: [] };
  for (const name of category.parts) {
    const index = PERF_PARTS.length;
    const details = detailsByIndex.get(index);
    PERF_PARTS.push({
      index,
      key: `${category.code}_${name}`,
      label: humanize(name),
      category: category.code,
      verified: VERIFIED_INDICES.has(index),
      active: details !== undefined,
      level: details?.level ?? null,
      price: details?.price ?? null,
      conflicts: details?.conflicts ?? [],
    });
    group.indices.push(index);
  }
  PERF_CATEGORIES.push(group);
}

/** Performance categories shown in the tuning dialog; AE is derived from visual parts. */
export const TUNING_PERF_CATEGORIES = PERF_CATEGORIES.filter((category) => category.code !== 'AE');

/** Active performance IDs used by the tuning controls and their bulk actions. */
export const TUNING_PERF_INDICES = TUNING_PERF_CATEGORIES.flatMap((category) =>
  category.indices.filter((index) => PERF_PARTS[index].active),
);

const UNIQUE_KEYS = ['WEIGHT_REDUCTION', 'TRANSMISSION', 'NOS', 'ENGINE', 'TURBO', 'SUSPENSION', 'BRAKE', 'ECU', 'TIRES'];

/** Category dwords, not additional ordinary part IDs. AE has no established unique mapping. */
export const UNIQUE_PERF_PARTS: UniquePerfPart[] = TUNING_PERF_CATEGORIES.map((category, index) => ({
  index,
  category: category.code,
  key: `PERF_CATEGORY_${UNIQUE_KEYS[index]}`,
  label: category.label,
}));
