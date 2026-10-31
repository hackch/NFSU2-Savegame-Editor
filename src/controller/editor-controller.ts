import { PERF_CATEGORIES, PERF_PARTS, type PerfPart } from '../data/perf-parts.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import { checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName } from '../model/save-file.js';
import { SLOT_COUNT } from '../model/layout.js';
import { getCarKey, isSlotUsed, setSlotCar, swapSlots as swapCarSlots, unlockAllSlots as unlockAllCarSlots } from '../model/slots.js';
import { getPerfFlag, setPerfFlag, setPerfFlags, PERF_COUNT } from '../model/perf.js';
import { countUnlocked, setUnlocks, UNLOCK_COUNT } from '../model/unlocks.js';
import type { CategoryView, EditorScope, PartView, SlotView, Status, TuningTab } from './editor-scope.js';

const partsByIndex = new Map<number, PerfPart>(PERF_PARTS.map((p) => [p.index, p]));
const ALL_INDICES = PERF_PARTS.map((p) => p.index);

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
  $scope.perfTotal = PERF_COUNT;
  $scope.unlockTotal = UNLOCK_COUNT;
  $scope.swapTarget = {};
  $scope.replaceTarget = {};
  $scope.donors = [];
  $scope.tuning = {
    open: false,
    slot: 0,
    tabs: TUNING_TABS,
    tab: 'PERF',
    sub: PERF_CATEGORIES[0].code,
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
        key,
        car: identifyCar(donorIndex, key),
        perfCount: ALL_INDICES.filter((i) => getPerfFlag(bytes, index, i)).length,
        unlocked: countUnlocked(bytes, index),
      };
    });
    if ($scope.tuning.open) rebuildTuning();
  }

  function rebuildTuning(): void {
    if (!data) return;
    const bytes = data;
    const slot = $scope.tuning.slot;
    $scope.tuning.categories = PERF_CATEGORIES.map((cat): CategoryView => {
      const parts = cat.indices.map((index): PartView => {
        const part = partsByIndex.get(index);
        if (!part) throw new Error(`Unknown performance part index ${index}`);
        return { index, label: part.label, verified: part.verified, on: getPerfFlag(bytes, slot, index) };
      });
      return { code: cat.code, label: cat.label, parts, onCount: parts.filter((p) => p.on).length };
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
    return $scope.slots.filter((s) => s.used).length;
  };

  $scope.otherSlots = function (slot: number): SlotView[] {
    return $scope.slots.filter((s) => s.index !== slot);
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
    $scope.tuning.sub = PERF_CATEGORIES[0].code;
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

  $scope.unlockAllSlots = function (): void {
    if (!data) return;
    if (!confirm('Set the garage count to 6 and link all five car slots? Car contents are not changed. Its effect in-game is not verified.')) {
      return;
    }
    applyResult(unlockAllCarSlots(data));
    setStatus('success', 'Garage count set to 6 and all car slots linked.');
  };

  $scope.closeTuning = function (): void {
    $scope.tuning.open = false;
  };

  $scope.togglePart = function (part: PartView): void {
    if (!data) return;
    applyResult(setPerfFlag(data, $scope.tuning.slot, part.index, part.on));
  };

  $scope.setCategory = function (cat: CategoryView, on: boolean): void {
    if (!data) return;
    applyResult(setPerfFlags(data, $scope.tuning.slot, cat.parts.map((p) => p.index), on));
  };

  $scope.installAll = function (slot: number, on: boolean): void {
    if (!data) return;
    if (on && !confirm('Install every part flag on this car? Only muffler and cold air intake are verified in-game.')) {
      return;
    }
    applyResult(setPerfFlags(data, slot, ALL_INDICES, on));
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
