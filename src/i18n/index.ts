// SPDX-License-Identifier: AGPL-3.0-or-later
// Traductions : t(lang, clé, variables). FR est la langue de référence et de repli.

import { LANGS, type Lang } from '../env';
import { en } from './en';
import { fr, type Dict } from './fr';
import { nl } from './nl';

export const DICTS: Record<Lang, Dict> = { fr, en, nl };
export type Key = keyof Dict;

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

export function t(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? DICTS.fr[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Choisit la langue : ?lang= > cookie > Accept-Language > défaut. */
export function pickLang(opts: { query?: string | null; cookie?: string | null; accept?: string | null; fallback?: Lang }): Lang {
  if (isLang(opts.query)) return opts.query;
  if (isLang(opts.cookie)) return opts.cookie;
  if (opts.accept) {
    const ranked = opts.accept
      .split(',')
      .map((part) => {
        const [tag = '', q] = part.trim().split(';q=');
        return { code: tag.slice(0, 2).toLowerCase(), q: q ? Number.parseFloat(q) : 1 };
      })
      .filter((x) => !Number.isNaN(x.q))
      .sort((a, b) => b.q - a.q);
    for (const { code } of ranked) if (isLang(code)) return code;
  }
  return opts.fallback ?? 'fr';
}

/** Nom d'affichage de chaque langue (dans sa propre langue). */
export const LANG_NAMES: Record<Lang, string> = { fr: 'FR', en: 'EN', nl: 'NL' };

/** Choisit le texte d'un champ multilingue avec repli : langue demandée > fr > première valeur non vide. */
export function pickText(values: Record<Lang, string | null | undefined>, lang: Lang): string {
  return values[lang]?.trim() || values.fr?.trim() || values.en?.trim() || values.nl?.trim() || '';
}
