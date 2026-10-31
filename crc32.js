// NFSU2 block checksum: MSB-first CRC-32 (poly 0x04C11DB7, no reflection).
// The register is inverted on entry and exit. Equivalent to the table at
// SPEED2.EXE file offset 0x4145E0.
const POLY = 0x04c11db7;

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ POLY : c << 1;
  TABLE[i] = c >>> 0;
}

export function nfsu2Crc(data, start = 0, end = data.length) {
  if (end - start < 4) return 0;
  const first = (data[start] << 24) | (data[start + 1] << 16) | (data[start + 2] << 8) | data[start + 3];
  let r = ~first >>> 0;
  for (let i = start + 4; i < end; i++) {
    r = (((r << 8) | data[i]) ^ TABLE[r >>> 24]) >>> 0;
  }
  return ~r >>> 0;
}
