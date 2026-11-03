import {
  PERF_PARTS, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS, type PerfPart,
} from '../data/perf-parts.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import { checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName } from '../model/save-file.js';
import { PERF_OFF, SLOT_COUNT, UNIQUE_PERF_OFF } from '../model/layout.js';
import { getCarKey, getCarTypeHash, isCarBought, isSlotLocked, isSlotUsed, setSlotCar, setSlotLocked, slotState, swapSlots as swapCarSlots } from '../model/slots.js';
import {
  getPerfFlag, getPerfPurchased, getUniquePerfValue, perfOffset, perfPurchaseOffset,
  setPerfFlag, setPerfFlags, setUniquePerfFlag, uniquePerfOffset, UNIQUE_PERF_COUNT,
} from '../model/perf.js';
import { countUnlocked, setUnlocks, UNLOCK_COUNT } from '../model/unlocks.js';
import { TRAFFIC_CARS } from '../data/traffic-cars.js';
import { setSlotTrafficCar } from '../model/slots.js';
import {
  DynoModel, findCar, KW_TO_HP, MPH_TO_KMH, NM_TO_LBFT, optimizeDynoSetup, parseGameData, readSlotDyno, setSetupTuning, SETUP_NAMES,
  type DynoResult, type GameData,
} from '../model/dyno.js';
import type {
  CategoryView, DynoCell, DynoRow, EditorScope, PartView, SlotView, Status, TuningTab, UniquePartView,
} from './editor-scope.js';

const partsByIndex = new Map<number, PerfPart>(PERF_PARTS.map((p) => [p.index, p]));
const tuningPerfIndexSet = new Set(TUNING_PERF_INDICES);

/** Top-level tuning tabs use the creator's category names. Only PERF has its part table mapped. */
const TUNING_TABS: TuningTab[] = [
  { code: 'PERF', label: 'PERFORMANCE' },
  { code: 'BODY', label: 'BODY PARTS' },
  { code: 'GRAPHICS', label: 'GRAPHICS' },
  { code: 'SPECIALTIES', label: 'SPECIALTIES' },
  { code: 'DYNO', label: 'DYNO' },
];

/**
 * AngularJS controller for the editor page. Holds the loaded save bytes
 * and translates UI actions into model calls.
 * @param $scope Injected scope, typed by {@link EditorScope}.
 */
export function EditorController($scope: EditorScope): void {
  let data: Uint8Array | null = null;
  let donors: Donor[] = [];
  let donorIndex = new Map<number, Donor>();
  let game: GameData | null = null;
  let proposal: { slot: number; setup: number; gearing: boolean; bytes: Uint8Array; before: DynoResult; after: DynoResult } | null = null;

  $scope.loaded = false;
  $scope.fileName = '';
  $scope.fileSize = 0;
  $scope.checks = null;
  $scope.status = { type: '', text: '' };
  $scope.form = { name: '', money: 0 };
  $scope.slots = [];
  $scope.perfTotal = TUNING_PERF_INDICES.length;
  $scope.uniqueTotal = UNIQUE_PERF_COUNT;
  $scope.unlockTotal = UNLOCK_COUNT;
  $scope.swapTarget = {};
  $scope.replaceTarget = {};
  $scope.donors = [];
  const trafficChoices = TRAFFIC_CARS.map((car) => ({
    id: `traffic:${car.hash}`, name: `${car.name} (experimental)`,
    group: 'Traffic cars (experimental)', experimental: true,
  }));
  $scope.replacementCars = trafficChoices;
  $scope.tuning = {
    open: false,
    slot: 0,
    tabs: TUNING_TABS,
    tab: 'PERF',
    sub: TUNING_PERF_CATEGORIES[0].code,
    categories: [],
    dyno: {
      gameName: '', gameError: '', setup: 1, setupNames: SETUP_NAMES, goal: 1, optimizeGearing: false,
      carName: '', blocked: '', busy: false, rows: [], hasProposal: false,
    },
  };

  fetch('./car-donors.json')
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    })
    .then((raw) => {
      const parsed = parseCarDatabase(raw);
      $scope.$evalAsync(() => {
        donors = parsed;
        $scope.donors = parsed;
        $scope.replacementCars = [
          ...parsed.map((car) => ({ id: car.id, name: car.name, group: 'Cars', experimental: false })),
          ...trafficChoices,
        ];
        donorIndex = buildCarIndex(parsed);
        if (data) refresh();
      });
    })
    .catch(() => {
      $scope.$evalAsync(() => setStatus('error', 'Could not load car-donors.json. Serve the folder over http (GitHub Pages or a local server); car replacement is disabled.'));
    });

  function setStatus(type: Status['type'], text: string): void {
    $scope.status = { type, text };
  }

  function syncForm(bytes: Uint8Array): void {
    $scope.form.name = getName(bytes);
    $scope.form.money = getMoney(bytes);
  }

  function refresh(): void {
    if (!data) return;
    const bytes = data;
    $scope.slots = Array.from({ length: SLOT_COUNT }, (_, index): SlotView => {
      const key = getCarKey(bytes, index);
      return {
        index,
        used: isSlotUsed(bytes, index),
        locked: isSlotLocked(bytes, index),
        bought: isCarBought(bytes, index),
        state: slotState(bytes, index),
        key,
        car: identifyCar(donorIndex, getCarTypeHash(bytes, index)),
        trafficName: TRAFFIC_CARS.find((car) => car.hash === getCarTypeHash(bytes, index))?.name ?? '',
        perfCount: TUNING_PERF_INDICES.filter((i) => getPerfFlag(bytes, index, i)).length,
        uniqueCount: UNIQUE_PERF_PARTS.filter((p) => getUniquePerfValue(bytes, index, p.index) !== 0).length,
        unlocked: countUnlocked(bytes, index),
      };
    });
    if ($scope.tuning.open) {
      rebuildTuning();
      rebuildDyno();
    }
  }

  function rebuildTuning(): void {
    if (!data) return;
    const bytes = data;
    const slot = $scope.tuning.slot;
    $scope.tuning.categories = TUNING_PERF_CATEGORIES.map((cat): CategoryView => {
      const parts = cat.indices.map((index): PartView => {
        const part = partsByIndex.get(index);
        if (!part) throw new Error(`Unknown performance part index ${index}`);
        return {
          ...part,
          on: getPerfFlag(bytes, slot, index),
          offset: hex(perfOffset(slot, index)),
          relativeOffset: hex(PERF_OFF + index),
          packageLabel: part.level === null ? 'Not in active table' : ['Street', 'Pro', 'Extreme'][part.level - 1],
          purchased: getPerfPurchased(bytes, slot, index),
          purchaseOffset: hex(perfPurchaseOffset(slot, index)),
          purchaseMask: hex(1 << (index & 7), 2),
        };
      });
      const uniquePart = UNIQUE_PERF_PARTS.find((part) => part.category === cat.code);
      let unique: UniquePartView | null = null;
      if (uniquePart) {
        const value = getUniquePerfValue(bytes, slot, uniquePart.index);
        unique = {
          ...uniquePart, value, on: value !== 0, hexValue: hex(value, 8),
          offset: hex(uniquePerfOffset(slot, uniquePart.index)),
          relativeOffset: hex(UNIQUE_PERF_OFF + uniquePart.index * 4),
        };
      }
      return {
        code: cat.code, label: cat.label, parts, unique,
        onCount: parts.filter((p) => p.active && p.on).length,
        activeCount: parts.filter((p) => p.active).length,
      };
    });
  }

  /** Builds the dyno model of the open tuning slot, or explains why there is none. */
  function dynoModel(): { model: DynoModel; setups: Uint8Array[] } | { reason: string } {
    if (!data) return { reason: 'Load a save first.' };
    const sd = readSlotDyno(data, $scope.tuning.slot);
    if (TRAFFIC_CARS.some((car) => car.hash === sd.hash)) {
      return { reason: 'DYNO is unavailable for experimental traffic vehicles.' };
    }
    if (!game) return { reason: '' };
    const car = findCar(game, sd.hash);
    if (!car) return { reason: 'This car is not in the loaded game data.' };
    const model = new DynoModel(game, car, sd.installed, sd.uniques);
    if (!model.ecuTunable && !model.turboTunable && !model.gearingParameters.length) {
      return { reason: `${car.name}: install a tunable ECU, turbo or transmission package to unlock dyno tuning.` };
    }
    return { model, setups: sd.setups };
  }

  function rebuildDyno(): void {
    const view = $scope.tuning.dyno;
    view.rows = [];
    view.carName = '';
    view.hasProposal = false;
    const built = dynoModel();
    if ('reason' in built) {
      view.blocked = built.reason;
      return;
    }
    view.blocked = '';
    view.carName = built.model.car.name;
    const before = built.model.evaluate(built.setups[view.setup]);
    const prop = proposal && proposal.slot === $scope.tuning.slot && proposal.setup === view.setup ? proposal : null;
    view.hasProposal = prop !== null;
    view.rows = dynoRows(before, prop ? prop.after : null);
  }

  /** Replaces the working bytes and re-renders. */
  function applyResult(next: Uint8Array): void {
    data = next;
    proposal = null;
    refresh();
  }

  $scope.loadFile = function (file: File | null): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $scope.$apply(() => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        const check = checkSave(bytes);
        if (!check.ok) {
          data = null;
          $scope.loaded = false;
          setStatus('error', check.error ?? 'Not a valid save file.');
          return;
        }
        data = bytes;
        $scope.fileName = file.name;
        $scope.fileSize = bytes.length;
        const checks = verifyChecksums(bytes);
        $scope.checks = checks;
        $scope.loaded = true;
        syncForm(bytes);
        refresh();
        const valid = Object.values(checks).every(Boolean);
        setStatus(
          valid ? 'success' : 'error',
          valid
            ? 'Loaded. Checksums are valid.'
            : 'Loaded. Checksums do not match; they will be recalculated on download.',
        );
      });
    };
    reader.onerror = () => $scope.$apply(() => setStatus('error', 'Could not read the file.'));
    reader.readAsArrayBuffer(file);
  };

  $scope.checksumText = function (): string {
    if (!$scope.checks) return '';
    return Object.values($scope.checks).every(Boolean) ? 'valid' : 'mismatch (fixed on download)';
  };

  $scope.usedCount = function (): number {
    return $scope.slots.filter((s) => s.state === 'filled').length;
  };

  $scope.applyProfile = function (): void {
    if (!data) return;
    try {
      let next = setMoney(data, $scope.form.money);
      next = setName(next, $scope.form.name);
      applyResult(next);
      setStatus('success', 'Profile applied. Download to save the file.');
    } catch (err) {
      setStatus('error', errorMessage(err));
    }
  };

  $scope.openTuning = function (slot: number): void {
    $scope.tuning.slot = slot;
    $scope.tuning.open = true;
    $scope.tuning.tab = 'PERF';
    $scope.tuning.sub = TUNING_PERF_CATEGORIES[0].code;
    proposal = null;
    rebuildTuning();
    rebuildDyno();
  };

  $scope.selectTab = function (code: string): void {
    $scope.tuning.tab = code;
    if (code === 'DYNO') rebuildDyno();
  };

  $scope.selectSub = function (code: string): void {
    $scope.tuning.sub = code;
  };

  $scope.activeTabLabel = function (): string {
    const tab = TUNING_TABS.find((t) => t.code === $scope.tuning.tab);
    return tab ? tab.label.charAt(0) + tab.label.slice(1).toLowerCase() : '';
  };

  $scope.toggleUnlocks = function (slot: number): void {
    if (!data) return;
    const on = $scope.slots[slot].unlocked !== UNLOCK_COUNT;
    const verb = on ? 'Unlock' : 'Lock';
    if (!confirm(`${verb} everything in car slot ${slot + 1}? This sets the creator's unlock table for this slot. Its effect in-game is not verified.`)) {
      return;
    }
    applyResult(setUnlocks(data, slot, on));
    setStatus('success', `Slot ${slot + 1}: ${on ? 'unlock table set to all unlocked' : 'unlock table cleared'}.`);
  };

  $scope.toggleLock = function (slot: number): void {
    if (!data) return;
    const locked = !isSlotLocked(data, slot);
    applyResult(setSlotLocked(data, slot, locked));
    setStatus('success', `Slot ${slot + 1} ${locked ? 'locked' : 'unlocked'}.`);
  };

  $scope.closeTuning = function (): void {
    $scope.tuning.open = false;
  };

  $scope.togglePart = function (part: PartView): void {
    if (!data) return;
    if (!partsByIndex.get(part.index)?.active) {
      rebuildTuning();
      setStatus('error', 'This ID is absent from the examined active item table; its bytes were left unchanged.');
      return;
    }
    if (!tuningPerfIndexSet.has(part.index)) {
      rebuildTuning();
      setStatus('error', 'This ID is not available in performance tuning; its bytes were left unchanged.');
      return;
    }
    applyResult(setPerfFlag(data, $scope.tuning.slot, part.index, part.on));
  };

  $scope.toggleUnique = function (part: UniquePartView): void {
    if (!data) return;
    try {
      applyResult(setUniquePerfFlag(data, $scope.tuning.slot, part.index, part.on));
      setStatus('success', `Unique ${part.label} flag updated. Download to save.`);
    } catch (err) {
      rebuildTuning();
      setStatus('error', errorMessage(err));
    }
  };

  $scope.maxOut = function (slot: number): void {
    if (!data) return;
    let next = setPerfFlags(data, slot, TUNING_PERF_INDICES, true);
    for (const part of UNIQUE_PERF_PARTS) {
      next = setUniquePerfFlag(next, slot, part.index, true);
    }
    applyResult(next);
    setStatus('success', `All ${TUNING_PERF_INDICES.length} performance flags and ${UNIQUE_PERF_PARTS.length} unique flags set on car slot ${slot + 1}. Download to save.`);
  };

  $scope.swapSlots = function (slot: number): void {
    if (!data) return;
    const raw = $scope.swapTarget[slot];
    if (raw === undefined || raw === '') return;
    const target = Number(raw);
    if (!confirm(`Swap car slot ${slot + 1} with slot ${target + 1}? This is experimental and copies whole slot blocks.`)) {
      return;
    }
    $scope.tuning.open = false;
    applyResult(swapCarSlots(data, slot, target));
    $scope.swapTarget[slot] = '';
    setStatus('success', `Swapped slots ${slot + 1} and ${target + 1}.`);
  };

  $scope.replaceCar = function (slot: number): void {
    if (!data) return;
    const raw = $scope.replaceTarget[slot];
    if (raw === undefined || raw === '') return;
    const traffic = TRAFFIC_CARS.find((car) => raw === `traffic:${car.hash}`);
    if (traffic) {
      replaceTrafficCar(slot, traffic.hash);
      return;
    }
    const donor = donors[Number(raw)];
    if (!donor) return;
    const current = $scope.slots[slot].car ? $scope.slots[slot].car?.name : 'an unknown car';
    const verb = $scope.slots[slot].used
      ? `Replace ${current} in slot ${slot + 1} with ${donor.name}?`
      : `Put ${donor.name} in empty slot ${slot + 1}?`;
    if (!confirm(`${verb}\n\nOnly this slot's car blocks change. Installed parts are reset to stock. Empty slots use an unverified header.`)) {
      return;
    }
    try {
      applyResult(setSlotCar(data, slot, donor));
      $scope.replaceTarget[slot] = '';
      setStatus('success', `Slot ${slot + 1} is now ${donor.name}. Test in game before relying on it.`);
    } catch (err) {
      setStatus('error', errorMessage(err));
    }
  };

  function replaceTrafficCar(slot: number, hash: number): void {
    if (!data) return;
    const car = TRAFFIC_CARS.find((car) => car.hash === hash);
    if (!car) {
      setStatus('error', 'Select a traffic vehicle first.');
      return;
    }
    try {
      $scope.tuning.open = false;
      applyResult(setSlotTrafficCar(data, slot, car.hash));
      $scope.replaceTarget[slot] = '';
      setStatus('success', `Experimental ${car.name} identity set in slot ${slot + 1}. Conversion is incomplete; test only with a backup.`);
    } catch (err) {
      setStatus('error', errorMessage(err));
    }
  }

  $scope.loadGameData = function (file: File | null): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $scope.$apply(() => {
        try {
          game = parseGameData(new Uint8Array(reader.result as ArrayBuffer));
          $scope.tuning.dyno.gameName = file.name;
          $scope.tuning.dyno.gameError = '';
        } catch (err) {
          game = null;
          $scope.tuning.dyno.gameName = '';
          $scope.tuning.dyno.gameError = errorMessage(err);
        }
        proposal = null;
        rebuildDyno();
      });
    };
    reader.onerror = () => $scope.$apply(() => { $scope.tuning.dyno.gameError = 'Could not read the file.'; });
    reader.readAsArrayBuffer(file);
  };

  $scope.selectSetup = function (setup: number): void {
    $scope.tuning.dyno.setup = setup;
    rebuildDyno();
  };

  $scope.setGoal = function (): void {
    proposal = null;
    rebuildDyno();
  };

  $scope.optimizeDyno = function (): void {
    const view = $scope.tuning.dyno;
    const built = dynoModel();
    if ('reason' in built || view.busy) return;
    const slot = $scope.tuning.slot, setup = view.setup, goal = view.goal, gearing = view.optimizeGearing;
    view.busy = true;
    // Let the page paint the busy state before the search blocks the thread.
    setTimeout(() => {
      $scope.$apply(() => {
        try {
          const result = optimizeDynoSetup(built.model, built.setups[setup], goal, gearing);
          if (view.goal === goal && view.optimizeGearing === gearing) {
            proposal = { slot, setup, gearing, bytes: result.setup, before: result.before, after: result.after };
          }
        } catch (err) {
          setStatus('error', errorMessage(err));
        }
        view.busy = false;
        rebuildDyno();
      });
    }, 30);
  };

  $scope.applyDyno = function (): void {
    if (!data || !proposal) return;
    const { slot, setup, bytes, gearing } = proposal;
    applyResult(setSetupTuning(data, slot, setup, bytes, gearing));
    setStatus('success', `Slot ${slot + 1}: ${SETUP_NAMES[setup]} ECU and turbo${gearing ? ' and gearing' : ''} tuned. Download to save.`);
  };

  $scope.download = function (): void {
    if (!data) return;
    const out = recalculateChecksums(data);
    const url = URL.createObjectURL(new Blob([out as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = $scope.fileName || 'career';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('success', 'Downloaded with recalculated checksums.');
  };
}

/**
 * Reads a message from an unknown thrown value.
 * @param err Anything thrown by the model.
 * @returns The message text.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hex(value: number, digits = 4): string {
  return `0x${value.toString(16).toUpperCase().padStart(digits, '0')}`;
}

/**
 * Dyno table rows with metric and imperial values side by side; `after` is null without a proposal.
 * @param before Results of the current setup.
 * @param after Results of the optimized setup, if any.
 * @returns Display rows.
 */
function dynoRows(before: DynoResult, after: DynoResult | null): DynoRow[] {
  const num = (v: number, digits = 0) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const time = (v: number): DynoCell => ({ metric: Number.isFinite(v) ? `${num(v, 2)} s` : '–', imperial: '', rpm: '' });
  const speed = (mph: number): DynoCell => ({ metric: `${num(mph * MPH_TO_KMH)} km/h`, imperial: `${num(mph)} mph`, rpm: '' });
  type Spec = [string, string, (r: DynoResult) => number, (r: DynoResult) => DynoCell, boolean];
  const specs: Spec[] = [
    ['Peak power', '', (r) => r.peakPower,
      (r) => ({ metric: `${num(r.peakPower)} kW`, imperial: `${num(r.peakPower * KW_TO_HP)} hp`, rpm: `${num(r.peakPowerRpm)} rpm` }), true],
    ['Peak torque', '', (r) => r.peakTorque,
      (r) => ({ metric: `${num(r.peakTorque)} N·m`, imperial: `${num(r.peakTorque * NM_TO_LBFT)} lb-ft`, rpm: `${num(r.peakTorqueRpm)} rpm` }), true],
    ['0–60 mph', '0–97 km/h', (r) => r.t60, (r) => time(r.t60), false],
    ['0–100 mph', '0–161 km/h', (r) => r.t100, (r) => time(r.t100), false],
    ['Quarter mile', '402 m', (r) => r.quarterMile, (r) => time(r.quarterMile), false],
    ['Trap speed', '', (r) => r.trapSpeed, (r) => speed(r.trapSpeed), true],
    ['Top speed', '', (r) => r.topSpeed, (r) => speed(r.topSpeed), true],
  ];
  return specs.map(([label, sub, value, cell, higher]) => {
    const b = cell(before), a = after ? cell(after) : null;
    const changed = a !== null && (a.metric !== b.metric || a.imperial !== b.imperial);
    return {
      label, sub, before: b, after: a,
      better: changed && after !== null && (higher ? value(after) > value(before) : value(after) < value(before)),
    };
  });
}
