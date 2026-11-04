import {
  PERF_PARTS, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS, type PerfPart,
} from '../data/perf-parts.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import { checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName } from '../model/save-file.js';
import { PERF_OFF, PROFILE_SIZE, UNIQUE_PERF_OFF, slotCount } from '../model/layout.js';
import { GARAGE_MAGIC, buildGarage, findBackupProfiles, mergeGarage, type BackupProfile } from '../model/nfsu2-web.js';
import { dosDateTime, isZip, readZip, writeZip, type ZipArchive } from '../model/zip.js';
import { getCarKey, getCarTypeHash, isCarBought, isSlotLocked, isSlotUsed, setSlotCar, setSlotLocked, slotState, swapSlots as swapCarSlots } from '../model/slots.js';
import {
  getPerfFlag, getPerfPurchased, getUniquePerfValue, perfOffset, perfPurchaseOffset,
  setPerfFlag, setPerfFlags, setUniquePerfFlag, uniquePerfOffset, UNIQUE_PERF_COUNT,
} from '../model/perf.js';
import { countUnlocked, setUnlocks, UNLOCK_COUNT } from '../model/unlocks.js';
import { TRAFFIC_CARS } from '../data/traffic-cars.js';
import { setSlotTrafficCar } from '../model/slots.js';
import { colorPalettes, isVisualColorSlot, parseVisualData, readVisual, VISUAL_SLOTS, VisualCatalog } from '../model/visual.js';
import {
  CURVE_POINTS, DynoModel, ECU_OFF, findCar, KW_TO_HP, MPH_TO_KMH, NEUTRAL_BYTE, NM_TO_LBFT, optimizeDynoSetup, parseGameData,
  readSlotDyno, setSetupTuning, SETUP_NAMES, SETUP_SIZE, TURBO_OFF,
  type CurveKind, type CurvePoint, type DynoEvent, type DynoResult, type GameData, type Gearing, type ScalarRow, type TuningBand,
} from '../model/dyno.js';
import type {
  CategoryView, CurveChart, DynoCell, DynoRow, DynoTab, EditorScope, GearChart, PartView, SlotView, Status, TuningTab, UniquePartView, VisualRow,
} from './editor-scope.js';

const partsByIndex = new Map<number, PerfPart>(PERF_PARTS.map((p) => [p.index, p]));
const tuningPerfIndexSet = new Set(TUNING_PERF_INDICES);
const CURVE_TABS: { kind: DynoTab; label: string }[] = [
  { kind: 'ecu', label: 'ECU' }, { kind: 'turbo', label: 'Turbo' }, { kind: 'drive', label: 'Drivetrain' },
  { kind: 'suspension', label: 'Suspension' }, { kind: 'aerodynamics', label: 'Aerodynamics' },
  { kind: 'tires-brakes', label: 'Tires & brakes' }, { kind: 'nitrous', label: 'Nitrous' },
];
/** Speed scale of the game's gear ratio bars. */
const GEAR_SCALE_KMH = 420;

/** Top-level tuning tabs use the creator's category names. */
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
  let visuals: VisualCatalog | null = null;
  let visualDraft: Uint8Array | null = null;
  /** Unapplied dyno setups by `slot:setup`; Auto-tune and graph edits both change them. */
  const drafts = new Map<string, { bytes: Uint8Array; band: TuningBand }>();
  let backup: { zip: ZipArchive; profiles: BackupProfile[]; work: Map<number, Uint8Array>; current: number } | null = null;
  let loadToken = 0;

  $scope.loaded = false;
  $scope.fileName = '';
  $scope.fileSize = 0;
  $scope.checks = null;
  $scope.backup = null;
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
    visual: { blocked: '', hasProposal: false, category: '', colorSlot: 63, groups: [] },
    dyno: {
      gameName: '', gameError: '', setup: 1, setupNames: SETUP_NAMES, strategy: '', optimizeGearing: false,
      carName: '', blocked: '', busy: false, rows: [], hasProposal: false,
      curveTabs: [], curve: 'ecu', cheat: false, point: 0, chart: null, gear: 0, drive: null, scalars: [],
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
    $scope.slots = Array.from({ length: slotCount(bytes) }, (_, index): SlotView => {
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
      rebuildVisual();
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

  function rebuildVisual(): void {
    const view = $scope.tuning.visual;
    view.groups = [];
    view.hasProposal = !!visualDraft;
    view.blocked = '';
    if (!data || !visuals) {
      view.blocked = 'Load GLOBAL\\GLOBALB.BUN to list the parts for this car.';
      return;
    }
    const slot = $scope.tuning.slot, bytes = visualDraft ?? data, car = getCarTypeHash(bytes, slot);
    const refs = readVisual(bytes, slot);
    const groups = new Map<string, VisualRow[]>();
    for (const spec of VISUAL_SLOTS.filter((s) => s.tab === $scope.tuning.tab)) {
      if (visuals.hidden(refs, car, spec.id)) continue;
      const options = visuals.selectableOptions(car, spec.id);
      if (!options.length && !refs[spec.id]) continue;
      const current = visuals.part(car, spec.id, refs[spec.id]);
      const retained = refs[spec.id] !== 0 && !options.some((p) => p.hash === refs[spec.id]);
      const choices = options.map((p) => ({
        hash: p.hash, label: p.name.replaceAll('_', ' '),
        group: p.level === 0 ? 'Stock / shared' : `Level ${p.level}`,
      }));
      if (retained) choices.unshift({
        hash: refs[spec.id], label: `${current?.name ?? `Unknown installed part (${hex(refs[spec.id], 8)})`} - retained`, group: 'Installed',
      });
      choices.unshift({ hash: 0, label: 'Default / none (resolved by game)', group: 'Default' });
      const rows = groups.get(spec.category) ?? [];
      rows.push({
        id: spec.id, label: spec.label, value: refs[spec.id], color: current?.color ?? '', options: choices,
        colorPicker: isVisualColorSlot(spec.id), palettes: isVisualColorSlot(spec.id) ? colorPalettes(options) : [],
        selectedLabel: current?.name ?? (refs[spec.id] ? `Unknown installed part (${hex(refs[spec.id], 8)})` : 'Default / none'),
        retained,
      });
      groups.set(spec.category, rows);
    }
    view.groups = [...groups].map(([label, rows]) => ({ label, rows }));
    if (!groups.has(view.category)) view.category = view.groups[0]?.label ?? '';
    if (!view.groups.length) view.blocked = 'No compatible parts in this game database for this car and menu.';
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
    if (!model.ecuTunable && !model.turboTunable && !model.gearingParameters.length && !model.scalarTuning(sd.setups[0]).length) {
      return { reason: `${car.name}: install tunable performance or body parts to unlock dyno tuning.` };
    }
    return { model, setups: sd.setups };
  }

  function draftKey(): string {
    return `${$scope.tuning.slot}:${$scope.tuning.dyno.setup}`;
  }

  /** Draft of the selected setup, or its saved bytes. */
  function currentSetup(built: { setups: Uint8Array[] }): Uint8Array {
    return drafts.get(draftKey())?.bytes ?? built.setups[$scope.tuning.dyno.setup];
  }

  function currentPoints(): CurvePoint[] | null {
    const built = dynoModel(), kind = $scope.tuning.dyno.curve;
    return 'reason' in built || (kind !== 'ecu' && kind !== 'turbo') ? null : built.model.curve(currentSetup(built), kind);
  }

  function currentGearing(): { model: DynoModel; gearing: Gearing; bytes: Uint8Array } | null {
    const built = dynoModel();
    if ('reason' in built) return null;
    const bytes = currentSetup(built), gearing = built.model.gearing(bytes);
    return gearing ? { model: built.model, gearing, bytes } : null;
  }

  /** Replaces the selected setup's draft with edited bytes and re-renders. */
  function editSetup(edit: (bytes: Uint8Array, model: DynoModel) => Uint8Array): void {
    const built = dynoModel();
    if ('reason' in built || $scope.tuning.dyno.busy) return;
    const current = currentSetup(built);
    const band = drafts.get(draftKey())?.band ?? built.model.tuningBand(current, $scope.tuning.dyno.setup);
    const bytes = edit(current.slice(), built.model);
    if (sameBytes(bytes, current)) return;
    if (sameBytes(bytes, built.setups[$scope.tuning.dyno.setup])) drafts.delete(draftKey());
    else drafts.set(draftKey(), { bytes, band });
    rebuildDyno();
  }

  /** Edits the selected curve's bytes. */
  function editPoints(edit: (bytes: Uint8Array, off: number) => void): void {
    const kind = $scope.tuning.dyno.curve;
    if (kind !== 'ecu' && kind !== 'turbo') return;
    editSetup((bytes) => { edit(bytes, kind === 'ecu' ? ECU_OFF : TURBO_OFF); return bytes; });
  }

  /**
   * Sets a curve point to a byte: independently with cheat limits, else like the game's tuning screen, where
   * neighbours absorb the change.
   */
  function setCurvePoint(index: number, point: CurvePoint, byte: number): void {
    const kind = $scope.tuning.dyno.curve;
    if (kind !== 'ecu' && kind !== 'turbo') return;
    if (byte === point.byte) { rebuildDyno(); return; }
    if ($scope.tuning.dyno.cheat) editPoints((bytes, off) => { bytes[off + index] = byte; });
    else editSetup((bytes, model) => model.withCurvePoint(bytes, kind, index, DynoModel.curveValue(point, byte)));
  }

  function setGearRatio(param: number, ratio: number): void {
    editSetup((bytes, model) => model.withGearRatio(bytes, param, ratio));
  }

  function rebuildDyno(): void {
    const view = $scope.tuning.dyno;
    view.rows = [];
    view.carName = '';
    view.hasProposal = false;
    view.curveTabs = [];
    view.chart = null;
    view.drive = null;
    view.scalars = [];
    const built = dynoModel();
    if ('reason' in built) {
      view.blocked = built.reason;
      return;
    }
    view.blocked = '';
    view.carName = built.model.car.name;
    const saved = built.setups[view.setup], bytes = currentSetup(built);
    const band = drafts.get(draftKey())?.band ?? built.model.tuningBand(bytes, view.setup);
    view.strategy = `${band.description} Target ${Math.round(band.minRpm).toLocaleString('en-US')}–${Math.round(band.maxRpm).toLocaleString('en-US')} rpm.`;
    view.hasProposal = !sameBytes(saved, bytes);
    view.rows = dynoRows(built.model.evaluate(saved), view.hasProposal ? built.model.evaluate(bytes) : null);
    const beforePower = built.model.usablePower(saved, band), afterPower = built.model.usablePower(bytes, band);
    const powerCell = (kw: number): DynoCell => ({
      metric: `${kw.toFixed(1)} kW`, imperial: `${(kw * KW_TO_HP).toFixed(1)} hp`, rpm: '',
    });
    view.rows.unshift({
      label: 'Usable band power', sub: 'Geometric mean of 3 RPM regions',
      before: powerCell(beforePower), after: view.hasProposal ? powerCell(afterPower) : null,
      better: view.hasProposal && afterPower > beforePower,
    });
    const gearing = built.model.gearing(bytes);
    const curves = { ecu: built.model.curve(bytes, 'ecu'), turbo: built.model.curve(bytes, 'turbo') };
    const scalars = built.model.scalarTuning(bytes);
    view.curveTabs = CURVE_TABS.filter(({ kind }) => kind === 'drive' ? gearing :
      kind === 'ecu' || kind === 'turbo' ? curves[kind] : scalars.some((row) => row.category === kind));
    if (view.curveTabs.length && !view.curveTabs.some((tab) => tab.kind === view.curve)) view.curve = view.curveTabs[0].kind;
    if (view.curve === 'drive') {
      if (gearing) {
        view.gear = Math.min(Math.max(view.gear, 0), gearing.rows.length - 1);
        view.drive = gearChart(gearing, view.gear);
      }
    } else if (view.curve === 'ecu' || view.curve === 'turbo') {
      const points = curves[view.curve];
      view.chart = points ? curveChart(points, view.point) : null;
    } else view.scalars = scalars.filter((row) => row.category === view.curve);
  }

  /** Career part of the working bytes; a 10-slot nfsu2-web buffer also contains GARAGE.DAT records. */
  function careerBytes(bytes: Uint8Array): Uint8Array {
    return slotCount(bytes) > 5 ? bytes.subarray(0, PROFILE_SIZE) : bytes;
  }

  function resetEditor(): void {
    drafts.clear();
    visualDraft = null;
    $scope.tuning.open = false;
    $scope.swapTarget = {};
    $scope.replaceTarget = {};
  }

  function showLoaded(bytes: Uint8Array, prefix = 'Loaded.'): void {
    drafts.clear();
    visualDraft = null;
    data = bytes;
    const checks = verifyChecksums(careerBytes(bytes));
    $scope.checks = checks;
    $scope.loaded = true;
    syncForm(bytes);
    refresh();
    const valid = Object.values(checks).every(Boolean);
    setStatus(
      valid ? 'success' : 'error',
      valid ? `${prefix} Checksums are valid.` : `${prefix} Checksums do not match; they will be recalculated on download.`,
    );
  }

  function backupView(): void {
    if (!backup) {
      $scope.backup = null;
      return;
    }
    const profile = backup.profiles[backup.current];
    $scope.backup = {
      current: backup.current,
      note: profile.note,
      profiles: backup.profiles.map((p, index) => ({
        index,
        label: `${p.name} (${p.garageState === 'loaded' ? '10 slots' : '5 slots'})`,
      })),
    };
  }

  function openBackupProfile(index: number): void {
    if (!backup) return;
    const profile = backup.profiles[index];
    let bytes = backup.work.get(index);
    if (!bytes) {
      const career = backup.zip.entries[profile.careerEntry].data;
      bytes = profile.garageState === 'loaded' ? mergeGarage(career, backup.zip.entries[profile.garageEntry].data) : career.slice();
      backup.work.set(index, bytes);
    }
    backup.current = index;
    resetEditor();
    backupView();
    showLoaded(bytes, `Loaded nfsu2-web profile ${profile.name}${profile.garageState === 'loaded' ? ' with slots 6-10' : ''}.`);
  }

  function rejectFile(text: string): void {
    data = null;
    backup = null;
    $scope.backup = null;
    $scope.loaded = false;
    $scope.checks = null;
    $scope.slots = [];
    resetEditor();
    setStatus('error', text);
  }

  /** Replaces the working bytes and re-renders. Other save edits discard unapplied dyno drafts. */
  function applyResult(next: Uint8Array, keepDrafts = false): void {
    data = next;
    visualDraft = null;
    if (backup) backup.work.set(backup.current, next);
    if (!keepDrafts) {
      drafts.clear();
    }
    refresh();
  }

  $scope.loadFile = function (file: File | null): void {
    if (!file) return;
    const token = ++loadToken;
    const reader = new FileReader();
    reader.onload = () => {
      $scope.$apply(() => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        $scope.fileName = file.name;
        $scope.fileSize = bytes.length;
        if (isZip(bytes)) {
          data = null;
          backup = null;
          $scope.backup = null;
          $scope.loaded = false;
          setStatus('', 'Reading nfsu2-web backup ZIP…');
          readZip(bytes)
            .then((zip) => {
              $scope.$evalAsync(() => {
                if (token !== loadToken) return;
                const profiles = findBackupProfiles(zip.entries);
                if (!profiles.length) {
                  rejectFile('This ZIP has no nfsu2-web career profile (expected a folder with a file of the same name).');
                  return;
                }
                backup = { zip, profiles, work: new Map(), current: 0 };
                openBackupProfile(0);
              });
            })
            .catch((err: unknown) => {
              $scope.$evalAsync(() => {
                if (token === loadToken) rejectFile(`Could not read the ZIP: ${errorMessage(err)}`);
              });
            });
          return;
        }
        if (GARAGE_MAGIC.every((byte, i) => bytes[i] === byte)) {
          rejectFile('This is an nfsu2-web GARAGE.DAT. Load the backup ZIP so it can be paired with its career profile.');
          return;
        }
        const check = checkSave(bytes);
        if (!check.ok) {
          rejectFile(check.error ?? 'Not a valid save file.');
          return;
        }
        if (backup || $scope.tuning.slot >= slotCount(bytes)) resetEditor();
        backup = null;
        $scope.backup = null;
        showLoaded(bytes);
      });
    };
    reader.onerror = () => $scope.$apply(() => setStatus('error', 'Could not read the file.'));
    reader.readAsArrayBuffer(file);
  };

  $scope.selectProfile = function (index: number): void {
    if (!backup || !Number.isInteger(index) || index < 0 || index >= backup.profiles.length) return;
    openBackupProfile(index);
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
    $scope.tuning.dyno.point = 0;
    drafts.clear();
    visualDraft = null;
    rebuildTuning();
    rebuildDyno();
    rebuildVisual();
  };

  $scope.selectTab = function (code: string): void {
    $scope.tuning.tab = code;
    if (code === 'DYNO') rebuildDyno();
    rebuildVisual();
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
    if (!confirm(`Swap car slot ${slot + 1} with slot ${target + 1}? This is experimental and exchanges car data while each slot keeps its own handle.`)) {
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
    if (!confirm(`${verb}\n\nOnly this slot changes. Appearance is reset; vinyls, decals and neon are cleared. Installed parts are reset to stock. Dyno tuning is kept.`)) {
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
          const bytes = new Uint8Array(reader.result as ArrayBuffer);
          const nextGame = parseGameData(bytes);
          const nextVisuals = parseVisualData(bytes, nextGame.cars);
          game = nextGame;
          visuals = nextVisuals;
          $scope.tuning.dyno.gameName = file.name;
          $scope.tuning.dyno.gameError = '';
        } catch (err) {
          game = null;
          visuals = null;
          $scope.tuning.dyno.gameName = '';
          $scope.tuning.dyno.gameError = errorMessage(err);
        }
        drafts.clear();
        visualDraft = null;
        rebuildDyno();
        rebuildVisual();
      });
    };
    reader.onerror = () => $scope.$apply(() => { $scope.tuning.dyno.gameError = 'Could not read the file.'; });
    reader.readAsArrayBuffer(file);
  };

  $scope.editVisual = function (row: VisualRow): void {
    if (!data || !visuals) return;
    try {
      const next = visuals.edit(visualDraft ?? data, $scope.tuning.slot, row.id, row.value);
      visualDraft = sameBytes(next, data) ? null : next;
      rebuildVisual();
    } catch (err) {
      setStatus('error', errorMessage(err));
      rebuildVisual();
    }
  };

  $scope.applyVisual = function (): void {
    if (!visualDraft) return;
    const next = visualDraft;
    visualDraft = null;
    applyResult(next);
    setStatus('success', 'Visual parts applied. Download to save; test in game with a backup.');
  };

  $scope.discardVisual = function (): void {
    visualDraft = null;
    rebuildVisual();
  };

  $scope.editScalar = function (row: ScalarRow, byte: number): void {
    try {
      if (!Number.isFinite(byte)) throw new RangeError('Enter a finite tuning value.');
      const value = row.stock + (byte - 100) * (row.max - row.min) / 100;
      editSetup((bytes, model) => model.withScalarValue(bytes, row.param, value));
    } catch (err) {
      setStatus('error', errorMessage(err));
      rebuildDyno();
    }
  };

  $scope.resetScalar = function (param: number): void {
    const row = $scope.tuning.dyno.scalars.find((r) => r.param === param);
    if (!row) return;
    try {
      editSetup((bytes, model) => model.withScalarValue(bytes, param, row.stock));
    } catch (err) {
      setStatus('error', errorMessage(err));
    }
  };

  $scope.selectSetup = function (setup: DynoEvent): void {
    $scope.tuning.dyno.setup = setup;
    rebuildDyno();
  };

  $scope.optimizeDyno = function (): void {
    const view = $scope.tuning.dyno;
    const built = dynoModel();
    if ('reason' in built || view.busy) return;
    const key = draftKey(), event = view.setup, gearing = view.optimizeGearing;
    const start = currentSetup(built);
    view.busy = true;
    // Let the page paint the busy state before the search blocks the thread.
    setTimeout(() => {
      $scope.$apply(() => {
        try {
          const result = optimizeDynoSetup(built.model, start, event, gearing);
          if (view.optimizeGearing === gearing && draftKey() === key) {
            drafts.set(key, { bytes: result.setup, band: result.band });
            if (sameBytes(result.setup, start)) setStatus('success', 'Auto-tune found no better setup.');
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
    const built = dynoModel();
    const key = draftKey(), bytes = drafts.get(key)?.bytes;
    if (!data || !bytes || 'reason' in built) return;
    const slot = $scope.tuning.slot, setup = $scope.tuning.dyno.setup, saved = built.setups[setup];
    const changed = (from: number, to: number) => !sameBytes(bytes.subarray(from, to), saved.subarray(from, to));
    const gearing = changed(9, 16);
    const scalars = changed(0, 9) || changed(16, 23);
    const parts = [changed(ECU_OFF, TURBO_OFF) && 'ECU', changed(TURBO_OFF, SETUP_SIZE) && 'turbo', gearing && 'gearing',
      scalars && 'scalar tuning']
      .filter(Boolean).join(', ');
    drafts.delete(key);
    applyResult(setSetupTuning(data, slot, setup, bytes, gearing, scalars), true);
    setStatus('success', `Slot ${slot + 1}: ${SETUP_NAMES[setup]} ${parts || 'setup'} saved. Download to keep the changes.`);
  };

  $scope.discardDyno = function (): void {
    drafts.delete(draftKey());
    rebuildDyno();
  };

  $scope.selectCurve = function (kind: DynoTab): void {
    $scope.tuning.dyno.curve = kind;
    rebuildDyno();
  };

  $scope.selectPoint = function (index: number): void {
    $scope.tuning.dyno.point = Math.min(Math.max(index, 0), CURVE_POINTS - 1);
    rebuildDyno();
  };

  $scope.stepPoint = function (delta: number): void {
    const point = currentPoints()?.[$scope.tuning.dyno.point];
    if (!point) return;
    const from = Math.min(Math.max(point.byte, point.minByte), point.maxByte);
    setCurvePoint($scope.tuning.dyno.point, point, Math.min(Math.max(from + delta, point.minByte), point.maxByte));
  };

  $scope.resetCurve = function (): void {
    if ($scope.tuning.dyno.curve === 'drive') {
      const current = currentGearing();
      if (current) editSetup((bytes) => { for (const row of current.gearing.rows) bytes[row.param] = NEUTRAL_BYTE; return bytes; });
      return;
    }
    editPoints((bytes, off) => bytes.fill(NEUTRAL_BYTE, off, off + CURVE_POINTS));
  };

  $scope.selectGear = function (index: number): void {
    $scope.tuning.dyno.gear = Math.max(index, 0);
    rebuildDyno();
  };

  $scope.stepGear = function (delta: number): void {
    const current = currentGearing();
    const row = current?.gearing.rows[$scope.tuning.dyno.gear];
    if (!row) return;
    const span = row.max - row.min;
    const byte = Math.round(100 + 100 * (row.ratio - row.stock) / span) + (row.speed === null ? delta : -delta);
    setGearRatio(row.param, row.stock + span * (byte - 100) / 100);
  };

  $scope.gearPointer = function (event: MouseEvent, index: number, start: boolean): void {
    const current = currentGearing(), row = current?.gearing.rows[index];
    if (!current || !row || $scope.tuning.dyno.busy || (!start && ((event.buttons & 1) === 0 || index !== $scope.tuning.dyno.gear))) return;
    if (start) event.preventDefault();
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    if (!rect.width) return;
    const f = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    $scope.tuning.dyno.gear = index;
    if (row.speed === null) setGearRatio(row.param, row.min + f * (row.max - row.min));
    else setGearRatio(row.param, current.gearing.speedFactor / Math.max(f * GEAR_SCALE_KMH, 1));
  };

  $scope.gearKey = function (event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 1;
    const actions: Record<string, () => void> = {
      ArrowUp: () => $scope.selectGear($scope.tuning.dyno.gear - 1),
      ArrowDown: () => $scope.selectGear($scope.tuning.dyno.gear + 1),
      ArrowLeft: () => $scope.stepGear(-step),
      ArrowRight: () => $scope.stepGear(step),
    };
    const action = actions[event.key];
    if (!action || $scope.tuning.dyno.busy) return;
    event.preventDefault();
    action();
  };

  $scope.curvePointer = function (event: MouseEvent, start: boolean): void {
    const view = $scope.tuning.dyno, chart = view.chart, points = currentPoints();
    if (!chart || !points || view.busy || (!start && (event.buttons & 1) === 0)) return;
    if (start) event.preventDefault();
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * chart.width;
    const y = (event.clientY - rect.top) / rect.height * chart.height;
    const columnWidth = chart.columns[0].width;
    const index = Math.min(Math.max(Math.floor((x - chart.left) / columnWidth), 0), CURVE_POINTS - 1);
    const nm = (chart.bottom - y) / (chart.bottom - chart.top) * chart.yMax;
    view.point = index;
    setCurvePoint(index, points[index], DynoModel.curveByte(points[index], nm));
  };

  $scope.curveKey = function (event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 1;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => $scope.selectPoint($scope.tuning.dyno.point - 1),
      ArrowRight: () => $scope.selectPoint($scope.tuning.dyno.point + 1),
      ArrowUp: () => $scope.stepPoint(step),
      ArrowDown: () => $scope.stepPoint(-step),
    };
    const action = actions[event.key];
    if (!action || $scope.tuning.dyno.busy) return;
    event.preventDefault();
    action();
  };

  $scope.download = function (): void {
    if (!data) return;
    let out: Uint8Array;
    let name = $scope.fileName || 'career';
    let message = 'Downloaded with recalculated checksums.';
    if (backup) {
      const entries = backup.zip.entries.map((entry) => ({ ...entry }));
      const stamp = dosDateTime();
      const replace = (index: number, bytes: Uint8Array): void => {
        const entry = entries[index];
        if (entry.data.length === bytes.length && entry.data.every((byte, i) => byte === bytes[i])) return;
        entries[index] = { ...entry, data: bytes, ...stamp };
      };
      for (const [index, working] of backup.work) {
        const profile = backup.profiles[index];
        const career = recalculateChecksums(careerBytes(working));
        replace(profile.careerEntry, career);
        if (profile.garageState === 'loaded') {
          replace(profile.garageEntry, buildGarage(backup.zip.entries[profile.garageEntry].data, working, career));
        }
      }
      out = writeZip({ entries, comment: backup.zip.comment });
      if (!/\.zip$/i.test(name)) name += '.zip';
      message = 'Downloaded nfsu2-web backup ZIP with recalculated save checksums and GARAGE.DAT fingerprints.';
    } else {
      out = recalculateChecksums(data);
    }
    const url = URL.createObjectURL(new Blob([out as Uint8Array<ArrayBuffer>], { type: backup ? 'application/zip' : 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('success', message);
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * SVG geometry of the game-style ECU/turbo graph.
 * @param points Curve points in N·m.
 * @param selected Selected column.
 */
export function curveChart(points: CurvePoint[], selected: number): CurveChart {
  const width = 560, height = 270, left = 44, right = 8, top = 10, bottom = 236;
  const highest = Math.max(...points.flatMap((p) => [p.max, p.value, p.effective, p.stock]), 1);
  const step = [10, 20, 25, 50, 100, 200, 250, 500].find((s) => highest / s <= 6) ?? 1000;
  const yMax = Math.ceil(highest / step) * step;
  const y = (nm: number) => bottom - Math.min(Math.max(nm, 0), yMax) / yMax * (bottom - top);
  const columnWidth = (width - left - right) / points.length;
  const num = (v: number) => Math.round(v).toLocaleString('en-US');
  const columns = points.map((p, index) => {
    const valueY = y(p.value);
    return {
      index, x: left + index * columnWidth, width: columnWidth,
      rangeY: y(p.max), rangeH: Math.max(y(p.min) - y(p.max), 1),
      stockY: y(Math.min(Math.max(p.stock, p.min), p.max)),
      valueY, valueH: bottom - valueY, effY: y(p.effective),
      rpmLabel: `${(p.rpm / 1000).toFixed(1)}k`,
    };
  });
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => ({ y: y(i * step), label: num(i * step) }));
  const p = points[Math.min(Math.max(selected, 0), points.length - 1)];
  const stock = Math.min(Math.max(p.stock, p.min), p.max);
  const diff = p.value - stock;
  const shifted = Math.round(p.effective) !== Math.round(p.value);
  return {
    width, height, left, top, bottom, yMax, ticks, columns,
    selected: {
      rpm: `${num(p.rpm)} rpm`, value: `${num(p.value)} N·m`, stock: `${num(stock)} N·m`,
      range: `${num(p.min)}–${num(p.max)} N·m`,
      change: Math.round(diff) === 0 ? 'At stock' : `${diff > 0 ? '+' : '−'}${num(Math.abs(diff))} N·m vs stock`,
      canDown: p.byte > p.minByte, canUp: p.byte < p.maxByte,
      effective: shifted ? `${num(p.effective)} N·m` : '',
      beyond: p.effective > p.max + 0.5 || p.effective < p.min - 0.5,
    },
  };
}

/**
 * Bars of the game-style drivetrain screen. Gear bars use the game's fixed 0–420 km/h scale; final drive runs
 * from Top Speed (low ratio) to Acceleration (high ratio).
 * @param gearing Drivetrain of the setup.
 * @param selected Selected row.
 */
export function gearChart(gearing: Gearing, selected: number): GearChart {
  const pct = (kmh: number) => Math.min(Math.max(kmh / GEAR_SCALE_KMH * 100, 0), 100);
  const kmh = (v: number) => `${v.toFixed(1)} km/h`;
  const rows = gearing.rows.map((r) => {
    if (r.speed === null) {
      const at = (v: number) => (v - r.min) / (r.max - r.min) * 100;
      return { param: r.param, label: r.label, value: r.ratio.toFixed(2), sub: 'ratio', final: true, lo: 0, hi: 100, at: at(r.ratio), stock: at(r.stock) };
    }
    return {
      param: r.param, label: r.label, value: kmh(r.speed), sub: `${(r.speed / MPH_TO_KMH).toFixed(1)} mph`, final: false,
      lo: pct(r.minSpeed as number), hi: pct(r.maxSpeed as number), at: pct(r.speed), stock: pct(gearing.speedFactor / r.stock),
    };
  });
  const r = gearing.rows[Math.min(Math.max(selected, 0), gearing.rows.length - 1)];
  const eps = 1e-6;
  const lower = r.ratio > r.min + eps, higher = r.ratio < r.max - eps;
  const selectedView = r.speed === null
    ? {
      label: r.label, value: r.ratio.toFixed(2), stock: r.stock.toFixed(2), range: `${r.min.toFixed(2)}–${r.max.toFixed(2)}`,
      downLabel: 'Top speed', upLabel: 'Acceleration', canDown: lower, canUp: higher,
    }
    : {
      label: r.label, value: `${kmh(r.speed)} (ratio ${r.ratio.toFixed(2)})`, stock: kmh(gearing.speedFactor / r.stock),
      range: `${(r.minSpeed as number).toFixed(1)}–${kmh(r.maxSpeed as number)}`,
      downLabel: 'Slower', upLabel: 'Faster', canDown: higher, canUp: lower,
    };
  const ticks = Array.from({ length: GEAR_SCALE_KMH / 60 + 1 }, (_, i) => ({ at: pct(i * 60), label: String(i * 60) }));
  return { rows, ticks, selected: selectedView };
}

/**
 * Dyno table rows with metric and imperial values side by side; `after` is null without an edited draft.
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
