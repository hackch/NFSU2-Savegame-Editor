// Performance parts in the order of the 68-entry name table in SPEED2.EXE
// (file offset 0x403570). Each car stores one flag byte per part at slot+0x310.
// Only indices 15 and 16 are verified by save diffs; the rest come from the name table.
const CATEGORIES = [
  { code: "WT", label: "Weight reduction", parts: ["REMOVE_REAR_SEATS", "REMOVE_INTERIOR_PANELS", "LIGHTWEIGHT_WINDOWS", "LIGHTWEIGHT_SEATS", "LIGHTWEIGHT_DOORS", "FOAM_FILLED_INTERIOR"] },
  { code: "TR", label: "Transmission", parts: ["SHORT_THROW_SHIFT_KIT", "LIGHT_FLYWHEEL", "DIFFERENTIAL", "LIMITED_SLIP_DIFFERENTIAL", "HIGH_PERFORMANCE_CLUTCH", "6_SPEED_TRANSMISSION"] },
  { code: "NO", label: "Nitrous", parts: ["DRY_SHOT", "WET_SHOT", "DIRECT_PORT"] },
  { code: "EN", label: "Engine", parts: ["MUFFLER", "COLD_AIR_INTAKE_SYSTEM", "REPLACE_HEADERS", "MILD_CAMSHAFT_AND_CAM_GEARS", "CAT_BACK_EXHAUST_SYSTEM", "HIGH_FLOW_INTAKE_MANIFOLD", "LARGER_DIAMETER_DOWNPIPE", "RACING_CAMSHAFT_AND_GEARS", "PORT_AND_POLISH_HEADS", "BLUEPRINT_THE_BLOCK", "HIGH_FLOW_HEADERS"] },
  { code: "TU", label: "Turbo", parts: ["STAGE_1_TURBO_KIT", "STAGE_2_TURBO_KIT", "STAGE_3_TURBO_KIT"] },
  { code: "SU", label: "Suspension", parts: ["SPORT_SPRINGS_AND_SHOCKS", "STRUT_TOWER_BAR", "PERFORMANCE_SPRINGS_AND_SHOCKS", "FRONT_AND_REAR_SWAY_BARS", "FRONT_AND_REAR_TIE_BARS", "UPGRADE_BUSHINGS", "COIL_OVER_SUSPENSION_SYSTEM", "CAMBER_KIT", "LARGE_DIAMETER_SWAY_BARS"] },
  { code: "BR", label: "Brakes", parts: ["STREET_COMPOUND_BRAKE_PADS", "STEEL_BRAIDED_BRAKE_LINES", "CROSS_DRILLED_ROTORS", "LARGE_DIAMETER_ROTORS", "RACE_COMPOUND_BRAKE_PADS", "CROSS_DRILLED_AND_SLOTTED_ROTORS", "6_PISTON_RACING_CALIPERS"] },
  { code: "EC", label: "Engine control & fuel", parts: ["REMOVE_SPEED_LIMITER", "PERFORMANCE_CHIP", "HIGH_FLOW_FUEL_PUMP", "FUEL_PRESSURE_REGULATOR", "FUEL_RAIL", "FUEL_FILTER", "ENGINE_MANAGEMENT_UNIT", "FUEL_INJECTORS"] },
  { code: "TI", label: "Tires", parts: ["STREET_PERFORMANCE_TIRES", "PRO_PERFORMANCE_TIRES", "EXTREME_PERFORMANCE_TIRES"] },
  { code: "AE", label: "Aero & body", parts: ["FRONT_BUMPER_L1", "FRONT_BUMPER_L2", "FRONT_BUMPER_L3", "SIDESKIRTS_L1", "SIDESKIRTS_L2", "SIDESKIRTS_L3", "REAR_BUMPER_L1", "REAR_BUMPER_L2", "REAR_BUMPER_L3", "SPOILER_L1", "SPOILER_L2", "SPOILER_L3"] },
];

const VERIFIED_INDICES = new Set([15, 16]);

function humanize(key) {
  return key
    .split("_")
    .map((word) => (/^l\d$/i.test(word) ? word.toUpperCase() : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(" ");
}

export const PERF_PARTS = [];
export const PERF_CATEGORIES = [];

for (const category of CATEGORIES) {
  const group = { code: category.code, label: category.label, indices: [] };
  for (const name of category.parts) {
    const index = PERF_PARTS.length;
    PERF_PARTS.push({
      index,
      key: `${category.code}_${name}`,
      label: humanize(name),
      category: category.code,
      verified: VERIFIED_INDICES.has(index),
    });
    group.indices.push(index);
  }
  PERF_CATEGORIES.push(group);
}
