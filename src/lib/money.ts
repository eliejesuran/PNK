// SPDX-License-Identifier: AGPL-3.0-or-later
// Montants : toujours en centimes (entiers). TVA calculée à partir du TTC.

import type { Lang } from '../env';

const LOCALES: Record<Lang, string> = { fr: 'fr-BE', en: 'en-GB', nl: 'nl-BE' };

export function localeOf(lang: Lang): string {
  return LOCALES[lang];
}

export function formatMoney(cents: number, lang: Lang, currency = 'EUR'): string {
  return new Intl.NumberFormat(LOCALES[lang], { style: 'currency', currency }).format(cents / 100);
}

/**
 * Les prix sont TTC (vente aux particuliers). Renvoie le détail HT / TVA / TTC.
 * rateBp en points de base : 600 = 6 %, 2100 = 21 %.
 */
export function splitVat(grossCents: number, rateBp: number): { net: number; vat: number; gross: number } {
  const net = Math.round((grossCents * 10000) / (10000 + rateBp));
  return { net, vat: grossCents - net, gross: grossCents };
}

export function formatRate(rateBp: number): string {
  const pct = rateBp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')} %`;
}

const MAX_PRICE_CENTS = 100_000_00; // 100 000 € : garde-fou contre les fautes de frappe

/** "12", "12,50", "12.5", " 8 € " -> centimes ; null si invalide. */
export function parseEuroToCents(input: string): number | null {
  const s = String(input ?? '').trim().replace(/€/g, '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents <= MAX_PRICE_CENTS ? cents : null;
}

/** Centimes -> valeur d'un <input> : 1250 -> "12.50". */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Taux saisi en % ("6", "21", "5,5") -> points de base ; null si invalide. */
export function parseRatePercentToBp(input: string): number | null {
  const s = String(input ?? '').replace('%', '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(parseFloat(s) * 100);
  return bp >= 0 && bp <= 3000 ? bp : null;
}
