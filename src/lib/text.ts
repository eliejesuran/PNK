// SPDX-License-Identifier: AGPL-3.0-or-later
// Petits utilitaires texte : slugs, nettoyage de saisies, CSV sûr, emails.

export function slugify(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Texte brut d'un champ de formulaire : trim, retire les caractères de contrôle, borne la longueur. */
export function clean(input: unknown, max = 200): string {
  return String(input ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** Comme clean() mais garde les retours à la ligne (descriptions). */
export function cleanMultiline(input: unknown, max = 5000): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s);
}

/** URL http(s) uniquement (pour les affiches) ; renvoie '' si invalide ou vide. */
export function cleanHttpUrl(input: unknown): string {
  const s = clean(input, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/** Cellule CSV sûre : échappe les guillemets et neutralise l'injection de formules (=, +, -, @). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  // BOM UTF-8 pour qu'Excel lise bien les accents ; séparateur ";" (Excel FR/BE/NL).
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Échappe du texte pour l'insérer dans du HTML construit à la main (emails). */
export function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "PNK <billets@x.org>" -> { name, email } ; "billets@x.org" -> { email }. */
export function parseMailbox(input: string): { name?: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(input);
  if (m) return m[1]!.trim() ? { name: m[1]!.trim(), email: m[2]!.trim() } : { email: m[2]!.trim() };
  return { email: input.trim() };
}
