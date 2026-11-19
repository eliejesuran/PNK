// SPDX-License-Identifier: AGPL-3.0-or-later
// Contexte de requête : langue, réglages, infos d'organisation pour les vues.

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './env';
import { isLang, pickLang } from './i18n';
import { DEFAULT_TZ } from './lib/time';
import { getSettings } from './services/settings';
import type { Ctx } from './views/public';

const SKIP = [/^\/webhooks\//, /^\/q\//, /^\/healthz$/];

/** Charge les réglages et détermine la langue (?lang= > cookie > Accept-Language > défaut de l'organisation). */
export const appContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SKIP.some((re) => re.test(c.req.path))) return next();
  const settings = await getSettings(c.env.DB);
  const q = c.req.query('lang');
  const cookie = getCookie(c, 'pnk_lang');
  const lang = pickLang({ query: q, cookie, accept: c.req.header('accept-language'), fallback: settings.default_lang });
  c.set('settings', settings);
  c.set('lang', lang);
  if (isLang(q) && q !== cookie) {
    setCookie(c, 'pnk_lang', q, { path: '/', maxAge: 31_536_000, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:' });
  }
  return next();
};

/** Contexte commun des vues publiques (valeurs par défaut sûres si les réglages ne sont pas chargés). */
export function viewCtx(c: Context<AppEnv>): Ctx {
  const s = c.get('settings');
  return {
    lang: c.get('lang') ?? 'fr',
    url: new URL(c.req.url),
    tz: s?.timezone ?? DEFAULT_TZ,
    org: { name: s?.org_name ?? 'PNK', termsUrl: s?.terms_url ?? '', contactEmail: s?.org_email ?? '' },
  };
}
