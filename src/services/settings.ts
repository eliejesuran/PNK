// SPDX-License-Identifier: AGPL-3.0-or-later
// Réglages de l'organisation (table `settings`, modifiables dans le back-office).

import type { Lang } from '../env';
import { isLang } from '../i18n';
import { DEFAULT_TZ, isValidTimeZone } from '../lib/time';

export interface Settings {
  org_name: string;
  org_legal_name: string;
  org_address: string;
  org_vat_number: string;
  org_email: string;
  org_phone: string;
  org_website: string;
  timezone: string;
  currency: string;
  default_vat_bp: number;
  default_lang: Lang;
  invoice_prefix: string;
  invoice_footer: string;
  terms_url: string;
}

export const SETTING_KEYS = [
  'org_name',
  'org_legal_name',
  'org_address',
  'org_vat_number',
  'org_email',
  'org_phone',
  'org_website',
  'timezone',
  'currency',
  'default_vat_bp',
  'default_lang',
  'invoice_prefix',
  'invoice_footer',
  'terms_url',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const str = (k: string, d = '') => m.get(k) ?? d;
  const tz = str('timezone', DEFAULT_TZ);
  const lang = str('default_lang', 'fr');
  const vat = Number.parseInt(str('default_vat_bp', '600'), 10);
  return {
    org_name: str('org_name', 'PNK'),
    org_legal_name: str('org_legal_name'),
    org_address: str('org_address'),
    org_vat_number: str('org_vat_number'),
    org_email: str('org_email'),
    org_phone: str('org_phone'),
    org_website: str('org_website'),
    timezone: isValidTimeZone(tz) ? tz : DEFAULT_TZ,
    currency: str('currency', 'EUR'),
    default_vat_bp: Number.isFinite(vat) ? vat : 600,
    default_lang: isLang(lang) ? lang : 'fr',
    invoice_prefix: str('invoice_prefix', 'PNK').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'PNK',
    invoice_footer: str('invoice_footer'),
    terms_url: str('terms_url'),
  };
}

export async function saveSettings(db: D1Database, values: Partial<Record<SettingKey, string>>): Promise<void> {
  const stmts = Object.entries(values)
    .filter(([k]) => (SETTING_KEYS as readonly string[]).includes(k))
    .map(([k, v]) =>
      db
        .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(k, String(v ?? '')),
    );
  if (stmts.length) await db.batch(stmts);
}

/** Ce qui manque pour pouvoir vendre en vrai (affiché en haut du tableau de bord). */
export function setupGaps(s: Settings): string[] {
  const gaps: string[] = [];
  if (!s.org_legal_name) gaps.push('Raison sociale de l’organisateur (obligatoire sur les factures)');
  if (!s.org_address) gaps.push('Adresse de l’organisateur (obligatoire sur les factures)');
  if (!s.org_vat_number) gaps.push('Numéro de TVA / d’entreprise (obligatoire sur les factures si assujetti)');
  if (!s.org_email) gaps.push('Email de contact');
  if (!s.terms_url) gaps.push('Lien vers les conditions de vente');
  return gaps;
}
