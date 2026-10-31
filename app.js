import { PERF_PARTS, PERF_CATEGORIES } from './perf-parts.js';
import {
  checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney,
  getName, setName, isSlotUsed, getPerfFlag, setPerfFlag, setPerfFlags,
  swapSlots as swapCarSlots, getCarKey, setSlotCar, SLOT_COUNT, PERF_COUNT,
} from './save.js';
import { parseCarDatabase, buildCarIndex, identifyCar } from './cars.js';

const partsByIndex = new Map(PERF_PARTS.map((p) => [p.index, p]));
const ALL_INDICES = PERF_PARTS.map((p) => p.index);

const app = angular.module('nfsu2Editor', []);

app.directive('nfsuFileChange', function () {
  return {
    restrict: 'A',
    link(scope, element, attrs) {
      element.on('change', (event) => {
        const file = event.target.files && event.target.files[0];
        scope.$apply(() => scope[attrs.nfsuFileChange](file || null));
      });
    },
  };
});

app.controller('EditorController', ['$scope', function ($scope) {
  let data = null;

  $scope.loaded = false;
  $scope.fileName = '';
  $scope.fileSize = 0;
  $scope.checks = null;
  $scope.status = { type: '', text: '' };
  $scope.form = { name: '', money: 0 };
  $scope.slots = [];
  $scope.perfTotal = PERF_COUNT;
  $scope.swapTarget = {};
  $scope.replaceTarget = {};
  $scope.donors = [];
  let donorIndex = new Map();
  $scope.tuning = { open: false, slot: 0, categories: [], activeCode: PERF_CATEGORIES[0].code };

  fetch('./car-donors.json')
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    })
    .then((raw) => {
      const donors = parseCarDatabase(raw);
      $scope.$evalAsync(() => {
        $scope.donors = donors;
        donorIndex = buildCarIndex(donors);
        if (data) refresh();
      });
    })
    .catch(() => {
      $scope.$evalAsync(() => setStatus('error', 'Could not load car-donors.json. Serve the folder over http (GitHub Pages or a local server); car replacement is disabled.'));
    });

  function setStatus(type, text) {
    $scope.status = { type, text };
  }

  function syncForm() {
    $scope.form.name = getName(data);
    $scope.form.money = getMoney(data);
  }

  function refresh() {
    $scope.slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
      const key = getCarKey(data, index);
      return {
        index,
        used: isSlotUsed(data, index),
        key,
        car: identifyCar(donorIndex, key),
        perfCount: ALL_INDICES.filter((i) => getPerfFlag(data, index, i)).length,
      };
    });
    if ($scope.tuning.open) rebuildTuning();
  }

  function rebuildTuning() {
    const slot = $scope.tuning.slot;
    $scope.tuning.categories = PERF_CATEGORIES.map((cat) => ({
      code: cat.code,
      label: cat.label,
      parts: cat.indices.map((index) => {
        const part = partsByIndex.get(index);
        return {
          index,
          label: part.label,
          verified: part.verified,
          on: getPerfFlag(data, slot, index),
        };
      }),
    }));
  }

  function applyResult(next) {
    data = next;
    refresh();
  }

  $scope.loadFile = function (file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $scope.$apply(() => {
        const bytes = new Uint8Array(reader.result);
        const check = checkSave(bytes);
        if (!check.ok) {
          data = null;
          $scope.loaded = false;
          setStatus('error', check.error);
          return;
        }
        data = bytes;
        $scope.fileName = file.name;
        $scope.fileSize = bytes.length;
        $scope.checks = verifyChecksums(bytes);
        $scope.loaded = true;
        syncForm();
        refresh();
        const valid = Object.values($scope.checks).every(Boolean);
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

  $scope.checksumText = function () {
    if (!$scope.checks) return '';
    return Object.values($scope.checks).every(Boolean) ? 'valid' : 'mismatch (fixed on download)';
  };

  $scope.usedCount = function () {
    return $scope.slots.filter((s) => s.used).length;
  };

  $scope.otherSlots = function (slot) {
    return $scope.slots.filter((s) => s.index !== slot);
  };

  $scope.applyProfile = function () {
    try {
      let next = setMoney(data, $scope.form.money);
      next = setName(next, $scope.form.name);
      applyResult(next);
      setStatus('success', 'Profile applied. Download to save the file.');
    } catch (err) {
      setStatus('error', err.message);
    }
  };

  $scope.openTuning = function (slot) {
    $scope.tuning.slot = slot;
    $scope.tuning.open = true;
    $scope.tuning.activeCode = PERF_CATEGORIES[0].code;
    rebuildTuning();
  };

  $scope.selectTab = function (code) {
    $scope.tuning.activeCode = code;
  };

  $scope.closeTuning = function () {
    $scope.tuning.open = false;
  };

  $scope.togglePart = function (part) {
    applyResult(setPerfFlag(data, $scope.tuning.slot, part.index, part.on));
  };

  $scope.setCategory = function (cat, on) {
    applyResult(setPerfFlags(data, $scope.tuning.slot, cat.parts.map((p) => p.index), on));
  };

  $scope.installAll = function (slot, on) {
    if (on && !confirm('Install every part flag on this car? Only muffler and cold air intake are verified in-game.')) {
      return;
    }
    applyResult(setPerfFlags(data, slot, ALL_INDICES, on));
  };

  $scope.swapSlots = function (slot) {
    const target = $scope.swapTarget[slot];
    if (target === undefined || target === '') return;
    if (!confirm(`Swap car slot ${slot + 1} with slot ${target + 1}? This is experimental and copies whole slot blocks.`)) {
      return;
    }
    $scope.tuning.open = false;
    applyResult(swapCarSlots(data, slot, target));
    $scope.swapTarget[slot] = '';
    setStatus('success', `Swapped slots ${slot + 1} and ${target + 1}.`);
  };

  $scope.replaceCar = function (slot) {
    const target = $scope.replaceTarget[slot];
    if (target === undefined || target === '') return;
    const donor = $scope.donors[target];
    const current = $scope.slots[slot].car ? $scope.slots[slot].car.name : 'an unknown car';
    const verb = $scope.slots[slot].used ? `Replace ${current} in slot ${slot + 1} with ${donor.name}?` : `Put ${donor.name} in empty slot ${slot + 1}?`;
    if (!confirm(`${verb}\n\nOnly this slot's car blocks change. Tuning is kept. Empty slots use an unverified header.`)) {
      return;
    }
    try {
      applyResult(setSlotCar(data, slot, donor));
      $scope.replaceTarget[slot] = '';
      setStatus('success', `Slot ${slot + 1} is now ${donor.name}. Test in game before relying on it.`);
    } catch (err) {
      setStatus('error', err.message);
    }
  };

  $scope.download = function () {
    if (!data) return;
    const out = recalculateChecksums(data);
    const url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = $scope.fileName || 'career';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('success', 'Downloaded with recalculated checksums.');
  };
}]);
