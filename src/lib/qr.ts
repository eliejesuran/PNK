// SPDX-License-Identifier: AGPL-3.0-or-later
// QR codes : matrice (via qrcode-generator, MIT), rendu SVG et PNG 1 bit.

import qrcode from 'qrcode-generator';

/** Matrice du QR (true = module noir). Correction d'erreur "Q" : lisible même froissé / mal imprimé. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'Q');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

const QUIET = 4; // zone de silence réglementaire, en modules

/** Chemin SVG (une ligne de modules noirs consécutifs = un rectangle) + taille du viewBox. */
export function qrSvgPath(text: string): { d: string; size: number } {
  const m = qrMatrix(text);
  const n = m.length;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (m[y]![x]) {
        let len = 1;
        while (x + len < n && m[y]![x + len]) len++;
        d += `M${x + QUIET} ${y + QUIET}h${len}v1h-${len}z`;
        x += len;
      } else x++;
    }
  }
  return { d, size: n + QUIET * 2 };
}

// ---------- PNG 1 bit, sans compression (blocs "stored" zlib) ----------

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(8 + data.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

/** QR en PNG noir et blanc (utile pour les emails, où le SVG n'est pas supporté). */
export function qrPng(text: string, scale = 8): Uint8Array {
  const m = qrMatrix(text);
  const modules = m.length + QUIET * 2;
  const px = modules * scale;
  const rowBytes = Math.ceil(px / 8);
  const raw = new Uint8Array((rowBytes + 1) * px); // 1 octet de filtre (0) par ligne
  for (let y = 0; y < px; y++) {
    const my = Math.floor(y / scale) - QUIET;
    const off = y * (rowBytes + 1);
    raw[off] = 0;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - QUIET;
      const dark = my >= 0 && my < m.length && mx >= 0 && mx < m.length && m[my]![mx];
      if (!dark) raw[off + 1 + (x >> 3)]! |= 0x80 >> (x & 7); // 1 = blanc
    }
  }
  // zlib : en-tête + blocs stored (≤ 65535 octets) + adler32
  const blocks: number[][] = [];
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.subarray(i, Math.min(i + 65535, raw.length));
    const final = i + 65535 >= raw.length ? 1 : 0;
    const len = slice.length;
    blocks.push([final, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]);
    parts.push(new Uint8Array([final, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]), slice);
  }
  parts.push(new Uint8Array(u32(adler32(raw))));
  const zlib = concat(parts);

  const ihdr = new Uint8Array([...u32(px), ...u32(px), 1, 0, 0, 0, 0]); // 1 bit, niveaux de gris
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
