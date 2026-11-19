// SPDX-License-Identifier: AGPL-3.0-or-later
// Le QR généré doit être réellement lisible par un décodeur indépendant (jsQR, celui du scanner).
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { newTicketCode, qrPayload } from '../src/lib/ids';
import { qrMatrix, qrPng } from '../src/lib/qr';

function render(text: string, scale: number, quiet: number): { data: Uint8ClampedArray; size: number } {
  const m = qrMatrix(text);
  const size = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < m.length; y++)
    for (let x = 0; x < m.length; x++)
      if (m[y]![x])
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
  return { data, size };
}

describe('QR lisible', () => {
  it('50 billets aléatoires se décodent exactement', () => {
    for (let i = 0; i < 50; i++) {
      const payload = qrPayload(newTicketCode());
      const { data, size } = render(payload, 5, 4);
      expect(jsQR(data, size, size)?.data, payload).toBe(payload);
    }
  });

  it('le PNG (emails) décode pareil : on relit ses pixels', () => {
    const payload = qrPayload('7K3M9QX2VD4TH8NB');
    const png = qrPng(payload, 6);
    // décodage minimal du PNG 1 bit "stored" produit par qrPng
    const w = new DataView(png.buffer, png.byteOffset).getUint32(16);
    const idat = png.indexOf(0x49, 33); // début "IDAT"
    expect(new TextDecoder().decode(png.slice(idat, idat + 4))).toBe('IDAT');
    let p = idat + 4 + 2; // saute le type + l'en-tête zlib
    const rowBytes = Math.ceil(w / 8);
    const raw: number[] = [];
    for (;;) {
      const final = png[p]!;
      const len = png[p + 1]! | (png[p + 2]! << 8);
      for (let i = 0; i < len; i++) raw.push(png[p + 5 + i]!);
      p += 5 + len;
      if (final) break;
    }
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const bit = (raw[y * (rowBytes + 1) + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1;
        if (!bit) data[(y * w + x) * 4] = data[(y * w + x) * 4 + 1] = data[(y * w + x) * 4 + 2] = 0;
      }
    expect(jsQR(data, w, w)?.data).toBe(payload);
  });
});
