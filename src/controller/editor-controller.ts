import {
  PERF_PARTS, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS, type PerfPart,
} from '../data/perf-parts.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import { checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName } from '../model/save-file.js';
import { PERF_OFF, SLOT_COUNT, UNIQUE_PERF_OFF } from '../model/layout.js';
import { getCarKey, isCarBought, isSlotLocked, isSlotUsed, setSlotCar, setSlotLocked, slotState, swapSlots as swapCarSlots } from '../model/slots.js';
import {
  getPerfFlag, getPerfPurchased, getUniquePerfValue, perfOffset, perfPurchaseOffset,
  setPerfFlag, setPerfFlags, setUniquePerfFlag, uniquePerfOffset, UNIQUE_PERF_COUNT,
} from '../model/perf.js';
import { countUnlocked, setUnlocks, UNLOCK_COUNT } from '../model/unlocks.js';
import type { CategoryView, EditorScope, PartView, SlotView, Status, TuningTab, UniquePartView } from './editor-scope.js';

const partsByIndex = new Map<number, PerfPart>(PERF_PARTS.map((p) => [p.index, p]));
const tuningPerfIndexSet = new Set(TUNING_PERF_INDICES);

/** Top-level tuning tabs use the creator's category names. Only PERF has its part table mapped. */
const TUNING_TABS: TuningTab[] = [
  { code: 'PERF', label: 'PERFORMANCE' },
  { code: 'BODY', label: 'BODY PARTS' },
  { code: 'GRAPHICS', label: 'GRAPHICS' },
  { code: 'SPECIALTIES', label: 'SPECIALTIES' },
];

/**
 * AngularJS controller for the editor page. Holds the loaded save bytes
 * and translates UI actions into model calls.
 * @param $scope Injected scope, typed by {@link EditorScope}.
 */
export function EditorController($scope: EditorScope): void {
  let data: Uint8Array | null = null;
  let donors: Donor[] = [];
  let donorIndex = new Map<string, Donor>();

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
  $scope.tuning = {
    open: false,
    slot: 0,
    tabs: TUNING_TABS,
    tab: 'PERF',
    sub: TUNING_PERF_CATEGORIES[0].code,
    categories: [],
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
        car: identifyCar(donorIndex, key),
        perfCount: TUNING_PERF_INDICES.filter((i) => getPerfFlag(bytes, index, i)).length,
        uniqueCount: UNIQUE_PERF_PARTS.filter((p) => getUniquePerfValue(bytes, index, p.index) !== 0).length,
        unlocked: countUnlocked(bytes, index),
      };
    });
    if ($scope.tuning.open) rebuildTuning();
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

  /** Replaces the working bytes and re-renders. */
  function applyResult(next: Uint8Array): void {
    data = next;
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
    rebuildTuning();
  };

  $scope.selectTab = function (code: string): void {
    $scope.tuning.tab = code;
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
    if (!confirm(`${part.on ? 'Enable' : 'Disable'} unique ${part.label}?\n\nExperimental flag-only edit, not a complete reward. Keep a backup.`)) {
      rebuildTuning();
      return;
    }
    try {
      applyResult(setUniquePerfFlag(data, $scope.tuning.slot, part.index, part.on));
      setStatus('success', `Unique ${part.label} flag updated. Download to save.`);
    } catch (err) {
      rebuildTuning();
      setStatus('error', errorMessage(err));
    }
  };

  $scope.setCategory = function (cat: CategoryView, on: boolean): void {
    if (!data) return;
    const category = TUNING_PERF_CATEGORIES.find((item) => item.code === cat.code);
    if (!category) {
      rebuildTuning();
      setStatus('error', 'This category is not available in performance tuning; its bytes were left unchanged.');
      return;
    }
    if (on && !confirm(`Set all active ${category.label} raw flags, including conflicting parts?`)) {
      return;
    }
    applyResult(setPerfFlags(data, $scope.tuning.slot, category.indices.filter((index) => tuningPerfIndexSet.has(index)), on));
  };

  $scope.installAll = function (slot: number, on: boolean): void {
    if (!data) return;
    if (on && !confirm(`Set all ${TUNING_PERF_INDICES.length} active performance part flags on this car? Superseded parts (for example the upgrade muffler under a full catback) will also be set, which the game does not do. Only muffler and cold air intake are verified in-game. Purchase bits, inactive IDs and unique dwords stay unchanged.`)) {
      return;
    }
    applyResult(setPerfFlags(data, slot, TUNING_PERF_INDICES, on));
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
