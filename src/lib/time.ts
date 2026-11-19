// SPDX-License-Identifier: AGPL-3.0-or-later
// Dates : stockées en UTC (ISO 8601), affichées dans le fuseau de la salle (réglage "timezone").

import type { Lang } from '../env';
import { localeOf } from './money';

export const DEFAULT_TZ = 'Europe/Brussels';

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addMinutesIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Décalage (ms) du fuseau `tz` par rapport à UTC à l'instant `date`. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-11-19T20:30" (heure locale de la salle) -> ISO UTC ; null si invalide. */
export function localInputToUtcIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(naive);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  // Deux passes pour absorber les changements d'heure (été/hiver).
  let utc = naive - tzOffsetMs(new Date(naive), tz);
  utc = naive - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString();
}

/** ISO UTC -> valeur d'un <input type="datetime-local"> dans le fuseau de la salle. */
export function utcIsoToLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const local = new Date(t + tzOffsetMs(new Date(t), tz));
  return local.toISOString().slice(0, 16);
}

export function formatDate(iso: string, lang: Lang, tz: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}

export function formatDateShort(iso: string, lang: Lang, tz: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}

export function formatTime(iso: string, lang: Lang, tz: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string, lang: Lang, tz: string): string {
  return `${formatDate(iso, lang, tz)} · ${formatTime(iso, lang, tz)}`;
}

/** Jour (YYYY-MM-DD) d'un instant dans le fuseau de la salle — pour les graphiques par jour. */
export function dayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

/** Pièces de date pour le bloc "affiche" : jour, mois court, heure. */
export function dateParts(iso: string, lang: Lang, tz: string): { day: string; month: string; weekday: string; time: string } {
  const loc = localeOf(lang);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: tz, ...o }).format(new Date(iso));
  return {
    day: f({ day: 'numeric' }),
    month: f({ month: 'short' }).replace('.', ''),
    weekday: f({ weekday: 'short' }).replace('.', ''),
    time: formatTime(iso, lang, tz),
  };
}
