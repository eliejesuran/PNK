// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DICTS, pickLang, t } from '../src/i18n';
import { fr } from '../src/i18n/fr';
import { formatTicketCode, newOrderToken, newTicketCode, normalizeTicketCode, qrPayload, timingSafeEqual } from '../src/lib/ids';
import { centsToInput, formatRate, parseEuroToCents, parseRatePercentToBp, splitVat } from '../src/lib/money';
import { qrMatrix, qrPng, qrSvgPath } from '../src/lib/qr';
import { clampInt, clean, cleanMultiline, csvCell, isEmail, parseMailbox, slugify, toCsv, cleanHttpUrl } from '../src/lib/text';
import { dayKey, localInputToUtcIso, utcIsoToLocalInput } from '../src/lib/time';
import { formEncode, verifyStripeSignature } from '../src/services/payments/stripe';
import { hmacHex } from '../src/lib/ids';

describe('codes de billets', () => {
  it('génère 16 caractères Crockford, uniques', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = newTicketCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
  });
  it('normalise ce que le scanner ou le clavier renvoie', () => {
    const c = newTicketCode();
    expect(normalizeTicketCode(qrPayload(c))).toBe(c);
    expect(normalizeTicketCode(formatTicketCode(c).toLowerCase())).toBe(c);
    expect(normalizeTicketCode(`  pnk: ${formatTicketCode(c)} `)).toBe(c);
  });
  it('corrige O/I/L et refuse le reste', () => {
    expect(normalizeTicketCode('OOOO-IIII-LLLL-0011')).toBe('0000111111110011');
    expect(normalizeTicketCode('')).toBeNull();
    expect(normalizeTicketCode('PNK:ABC')).toBeNull();
    expect(normalizeTicketCode('https://evil.example/' + 'A'.repeat(16))).toBeNull();
    expect(normalizeTicketCode('UUUUUUUUUUUUUUUU')).toBeNull(); // U n'existe pas en Crockford
  });
  it('jetons de commande : 32 caractères base64url', () => {
    expect(newOrderToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
  it('comparaison en temps constant', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('argent et TVA', () => {
  it('découpe le TTC en HT + TVA sans perdre un centime', () => {
    for (const [gross, bp] of [[1500, 600], [3000, 2100], [999, 600], [1, 2100], [0, 600], [12345, 550]] as const) {
      const r = splitVat(gross, bp);
      expect(r.net + r.vat).toBe(gross);
    }
    expect(splitVat(1060, 600)).toEqual({ net: 1000, vat: 60, gross: 1060 });
    expect(splitVat(1210, 2100)).toEqual({ net: 1000, vat: 210, gross: 1210 });
  });
  it('parse les prix saisis', () => {
    expect(parseEuroToCents('12')).toBe(1200);
    expect(parseEuroToCents('12,50')).toBe(1250);
    expect(parseEuroToCents(' 8.5 € ')).toBe(850);
    expect(parseEuroToCents('0')).toBe(0);
    expect(parseEuroToCents('-3')).toBeNull();
    expect(parseEuroToCents('abc')).toBeNull();
    expect(parseEuroToCents('12.345')).toBeNull();
    expect(parseEuroToCents('999999999')).toBeNull();
    expect(centsToInput(1250)).toBe('12.50');
  });
  it('parse les taux de TVA', () => {
    expect(parseRatePercentToBp('6')).toBe(600);
    expect(parseRatePercentToBp('5,5')).toBe(550);
    expect(parseRatePercentToBp('21 %')).toBe(2100);
    expect(parseRatePercentToBp('99')).toBeNull();
    expect(formatRate(600)).toBe('6 %');
    expect(formatRate(550)).toBe('5.5 %');
  });
});

describe('fuseaux horaires', () => {
  it('convertit heure locale <-> UTC avec heure d’été et d’hiver (Bruxelles)', () => {
    expect(localInputToUtcIso('2026-07-15T20:00', 'Europe/Brussels')).toBe('2026-07-15T18:00:00.000Z');
    expect(localInputToUtcIso('2026-12-15T20:00', 'Europe/Brussels')).toBe('2026-12-15T19:00:00.000Z');
    expect(utcIsoToLocalInput('2026-07-15T18:00:00.000Z', 'Europe/Brussels')).toBe('2026-07-15T20:00');
    expect(utcIsoToLocalInput('2026-12-15T19:00:00.000Z', 'Europe/Brussels')).toBe('2026-12-15T20:00');
  });
  it('aller-retour stable le jour du changement d’heure', () => {
    for (const local of ['2026-03-29T01:30', '2026-03-29T03:30', '2026-10-25T01:30', '2026-10-25T23:59']) {
      const utc = localInputToUtcIso(local, 'Europe/Brussels')!;
      expect(utcIsoToLocalInput(utc, 'Europe/Brussels')).toBe(local);
    }
  });
  it('refuse les dates invalides', () => {
    expect(localInputToUtcIso('2026-02-31T20:00', 'Europe/Brussels')).toBeNull();
    expect(localInputToUtcIso('n’importe quoi', 'Europe/Brussels')).toBeNull();
    expect(localInputToUtcIso('2026-01-01T25:00', 'Europe/Brussels')).toBeNull();
  });
  it('jour local pour les stats', () => {
    expect(dayKey('2026-07-15T22:30:00.000Z', 'Europe/Brussels')).toBe('2026-07-16');
  });
});

describe('QR codes', () => {
  it('matrice carrée et déterministe', () => {
    const m = qrMatrix('PNK:7K3M9QX2VD4TH8NB');
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((r) => r.length === m.length)).toBe(true);
    expect(qrMatrix('PNK:7K3M9QX2VD4TH8NB')).toEqual(m);
  });
  it('SVG : chemin non vide, viewBox avec zone de silence', () => {
    const r = qrSvgPath('PNK:7K3M9QX2VD4TH8NB');
    expect(r.d.startsWith('M')).toBe(true);
    expect(r.size).toBe(qrMatrix('PNK:7K3M9QX2VD4TH8NB').length + 8);
  });
  it('PNG : signature, en-tête IHDR 1 bit et IEND valides', () => {
    const png = qrPng('PNK:7K3M9QX2VD4TH8NB', 4);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new TextDecoder().decode(png.slice(12, 16))).toBe('IHDR');
    expect(png[24]).toBe(1); // profondeur de bits
    expect(new TextDecoder().decode(png.slice(png.length - 8, png.length - 4))).toBe('IEND');
  });
});

describe('texte', () => {
  it('slugify', () => {
    expect(slugify('Les Sales Gosses & Bruit Blanc !')).toBe('les-sales-gosses-et-bruit-blanc');
    expect(slugify('Été à Liège')).toBe('ete-a-liege');
    expect(slugify('   ')).toBe('');
  });
  it('emails', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('a b@c.de')).toBe(false);
    expect(isEmail('<x>@y.zz')).toBe(false);
    expect(parseMailbox('PNK <billets@x.org>')).toEqual({ name: 'PNK', email: 'billets@x.org' });
    expect(parseMailbox('billets@x.org')).toEqual({ email: 'billets@x.org' });
  });
  it('CSV neutralise les formules et échappe', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+33')).toBe("'+33");
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('simple')).toBe('simple');
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('﻿a;b\r\n1;2\r\n');
  });
  it('URLs d’affiche : http(s) seulement', () => {
    expect(cleanHttpUrl('https://x.org/a.jpg')).toBe('https://x.org/a.jpg');
    expect(cleanHttpUrl('javascript:alert(1)')).toBe('');
    expect(cleanHttpUrl('data:text/html,hi')).toBe('');
    expect(cleanHttpUrl('')).toBe('');
  });
  it('clean aplatit retours à la ligne et tabulations ; cleanMultiline les garde', () => {
    expect(clean('Jean\r\nBcc: x\t!')).toBe('Jean Bcc: x !');
    expect(cleanMultiline('1 rue X\r\n1000 Bruxelles')).toBe('1 rue X\n1000 Bruxelles');
  });
  it('clampInt', () => {
    expect(clampInt('5', 0, 10, 1)).toBe(5);
    expect(clampInt('50', 0, 10, 1)).toBe(10);
    expect(clampInt('-4', 0, 10, 1)).toBe(0);
    expect(clampInt('x', 0, 10, 1)).toBe(1);
  });
});

describe('i18n', () => {
  it('EN et NL ont exactement les mêmes clés que FR, sans valeur vide', () => {
    const keys = Object.keys(fr).sort();
    for (const lang of ['en', 'nl'] as const) {
      expect(Object.keys(DICTS[lang]).sort()).toEqual(keys);
      for (const k of keys) expect((DICTS[lang] as Record<string, string>)[k], `${lang}:${k}`).toBeTruthy();
    }
  });
  it('mêmes variables {x} dans toutes les langues', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [k, v] of Object.entries(fr)) {
      for (const lang of ['en', 'nl'] as const) {
        expect(vars((DICTS[lang] as Record<string, string>)[k]!), `${lang}:${k}`).toBe(vars(v));
      }
    }
  });
  it('remplace les variables', () => {
    expect(t('fr', 'event.low', { n: 3 })).toBe('Plus que 3 !');
    expect(t('nl', 'event.low', { n: 3 })).toBe('Nog maar 3!');
  });
  it('choix de la langue', () => {
    expect(pickLang({ query: 'nl' })).toBe('nl');
    expect(pickLang({ query: 'xx', cookie: 'en' })).toBe('en');
    expect(pickLang({ accept: 'nl-BE,nl;q=0.9,en;q=0.8' })).toBe('nl');
    expect(pickLang({ accept: 'de-DE,de;q=0.9,en;q=0.8' })).toBe('en');
    expect(pickLang({ accept: 'de' })).toBe('fr');
    expect(pickLang({ accept: 'de', fallback: 'nl' })).toBe('nl');
  });
});

describe('signature des webhooks Stripe', () => {
  const secret = 'whsec_unit';
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_800_000_000_000;
  const sign = async (ts: number, body = payload) => `t=${ts},v1=${await hmacHex(secret, `${ts}.${body}`)}`;
  it('accepte une signature valide', async () => {
    expect(await verifyStripeSignature(payload, await sign(now / 1000), secret, now)).toBe(true);
  });
  it('refuse payload modifié, mauvais secret, absence d’en-tête', async () => {
    const h = await sign(now / 1000);
    expect(await verifyStripeSignature(payload + ' ', h, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, h, 'autre', now)).toBe(false);
    expect(await verifyStripeSignature(payload, null, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, 't=abc,v1=00', secret, now)).toBe(false);
  });
  it('refuse le rejeu (horodatage trop ancien ou futur)', async () => {
    expect(await verifyStripeSignature(payload, await sign(now / 1000 - 301), secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, await sign(now / 1000 + 301), secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, await sign(now / 1000 - 299), secret, now)).toBe(true);
  });
  it('accepte plusieurs v1 (rotation de secret)', async () => {
    const good = await hmacHex(secret, `${now / 1000}.${payload}`);
    expect(await verifyStripeSignature(payload, `t=${now / 1000},v1=deadbeef,v1=${good}`, secret, now)).toBe(true);
  });
  it('encode les paramètres imbriqués au format Stripe', () => {
    expect(formEncode({ 'line_items[0][quantity]': 2, mode: 'payment', skip: undefined })).toBe('line_items%5B0%5D%5Bquantity%5D=2&mode=payment');
  });
});
