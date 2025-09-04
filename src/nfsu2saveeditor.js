const MAGIC = [0x32, 0x30, 0x43, 0x4D];
const MONEY_OFF = 0xA16A;
const NAME_OFF = 0xD225;
const START_IDX = 0x5AEC;
const SLOT_SIZE = 0x7F2;
const NUM_SLOTS = 5;
const PERF_OFFSET_IN_SLOT = 0x94;
const PERF_COUNT = 0x44;

let fileHandle = null;
let originalBuf = null;
let workBuf = null;
let dv = null;
let usedSlots = 0;

const $ = sel => document.querySelector(sel);
const setText = (id, txt) => { const el = $(id); el.textContent = txt; };
function readCString(u8, offset) {
    let end = offset;
    while (end < u8.length && u8[end] !== 0) end++;
    return new TextDecoder("windows-1252", { fatal: false }).decode(u8.subarray(offset, end));
}
function writeCString(u8, offset, str, maxLen = 32) {
    const bytes = new TextEncoder().encode(str);
    for (let i = 0; i < maxLen; i++) {
        u8[offset + i] = (i < bytes.length) ? bytes[i] : 0;
    }
}
function checkHeader(u8, fileSize) {
    for (let i = 0; i < 4; i++) { if (u8[i] !== MAGIC[i]) return false; }
    const fileLow16 = fileSize & 0xFFFF;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const low16 = view.getUint16(4, true);
    return low16 === fileLow16;
}
function calcUsedSlots(u8) {
    let c = 0; const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < NUM_SLOTS; i++) {
        const base = START_IDX + i * SLOT_SIZE;
        if (base + 2 <= u8.length) {
            if (view.getUint16(base, true) !== 0) c++;
        }
    }
    return c;
}
function setPerfForCar(u8, index, val) {
    if (index < 0 || index >= NUM_SLOTS) return;
    const base = START_IDX + index * SLOT_SIZE + PERF_OFFSET_IN_SLOT;
    for (let i = 0; i < PERF_COUNT; i++) {
        const p = base + i;
        if (p < u8.length) u8[p] = val;
    }
}
function isSlotLocked(u8, slotIdx) {
    const base = START_IDX + slotIdx * SLOT_SIZE;
    for (let i = 0; i < 16; i++) {
        if (u8[base + i] !== 0) return false;
    }
    return true;
}

function unlockCarSlot(u8, slotIdx) {
    const slot0Base = START_IDX;
    const targetBase = START_IDX + slotIdx * SLOT_SIZE;
    // Copy header from slot 0
    for (let i = 0; i < 16; i++) {
        u8[targetBase + i] = u8[slot0Base + i];
    }
    // Zero the rest
    for (let i = 16; i < SLOT_SIZE; i++) {
        u8[targetBase + i] = 0;
    }
}

const fileInput = $('#file');
const fileInfo = $('#fileInfo');
const headerStatus = $('#headerStatus');
const profile = $('#profile');
const moneyDisplay = $('#moneyDisplay');
const slots = $('#slots');
const summary = $('#summary');
const editor = $('#editor');
const nameField = $('#name');
const moneyField = $('#money');
const carsDiv = $('#cars');
const applyBtn = $('#apply');
const dlBtn = $('#download');
const dlBakBtn = $('#downloadBak');
const backupToggle = $('#backupToggle');
const reloadBtn = $('#reload');

function resetUI() {
    summary.hidden = true; editor.hidden = true; applyBtn.disabled = true; dlBtn.disabled = true; dlBakBtn.disabled = true;
    carsDiv.innerHTML = ''; setText('#fileInfo', 'No file selected.');
}

resetUI();

fileInput.addEventListener('change', async (e) => {
    resetUI();
    const f = e.target.files?.[0];
    if (!f) { return; }
    fileHandle = f;
    fileInfo.textContent = `${f.name} — ${f.size.toLocaleString()} bytes`;
    const ab = await f.arrayBuffer();
    originalBuf = new Uint8Array(ab);
    workBuf = new Uint8Array(ab.slice(0));
    dv = new DataView(workBuf.buffer);

    const headerOk = checkHeader(workBuf, f.size);
    headerStatus.textContent = headerOk ? 'OK' : 'Invalid';
    headerStatus.className = 'pill ' + (headerOk ? 'ok' : 'warn');
    if (!headerOk) { summary.hidden = false; return; }

    const name = readCString(workBuf, NAME_OFF) || '(empty)';
    const money = dv.getInt32(MONEY_OFF, true);
    usedSlots = calcUsedSlots(workBuf);
    setText('#profile', name);
    setText('#moneyDisplay', String(money));
    setText('#slots', String(usedSlots));
    summary.hidden = false;

    if (backupToggle.checked) { dlBakBtn.disabled = false; }

    carsDiv.innerHTML = '';
    for (let i = 0; i < NUM_SLOTS; i++) {
        const base = START_IDX + i * SLOT_SIZE;
        const inUse = i < usedSlots;
        const locked = isSlotLocked(workBuf, i);
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div><strong>Car ${i + 1}</strong> <span class="muted">${inUse ? 'IN USE' : locked ? 'locked/empty' : 'empty'}</span></div>
          <label class="muted" for="car_${i}">Change performance</label>
          <select id="car_${i}" ${inUse ? '' : 'disabled'}>
            <option value="2">No effect</option>
            <option value="0">Nill out</option>
            <option value="1">Max out</option>
          </select>
          ${(!inUse && locked) ? `<button id="unlock_${i}" style="margin-top:8px">Unlock Slot</button>` : ''}
        `;
        carsDiv.appendChild(card);

        // Add unlock button handler if needed
        if (!inUse && locked) {
            setTimeout(() => {
                const btn = document.getElementById(`unlock_${i}`);
                if (btn) {
                    btn.onclick = () => {
                        unlockCarSlot(workBuf, i);
                        // Refresh UI
                        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                        alert(`Car Slot ${i + 1} unlocked!`);
                    };
                }
            }, 0);
        }
    }

    nameField.value = '';
    moneyField.value = '-1';

    editor.hidden = false;
    applyBtn.disabled = false;
    dlBtn.disabled = false;
});

applyBtn.addEventListener('click', () => {
    if (!workBuf) return;
    const newName = nameField.value.trim();
    if (newName.length > 0) {
        writeCString(workBuf, NAME_OFF, newName, 32);
        setText('#profile', newName);
    }
    const val = parseInt(moneyField.value.trim(), 10);
    if (!Number.isNaN(val) && val !== -1 && val > 0) {
        dv.setInt32(MONEY_OFF, val, true);
        setText('#moneyDisplay', String(val));
    }
    for (let i = 0; i < usedSlots; i++) {
        const sel = document.getElementById(`car_${i}`);
        if (!sel) continue;
        const v = parseInt(sel.value, 10);
        if (v === 0 || v === 1) { setPerfForCar(workBuf, i, v); }
    }

    const blob = new Blob([workBuf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileHandle.name;
    a.click();
    URL.revokeObjectURL(url);

    applyBtn.textContent = 'Applied ✓';
    setTimeout(() => applyBtn.textContent = 'Apply Changes', 1000);
});

dlBakBtn.addEventListener('click', () => {
    if (!originalBuf || !fileHandle) return;
    const blob = new Blob([originalBuf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileHandle.name + '.bak';
    a.click();
    URL.revokeObjectURL(url);
});

reloadBtn.addEventListener('click', () => {
    if (fileHandle) {
        resetUI();
        fileInput.value = '';
        alert('To reset, select the file again.');
    }
});