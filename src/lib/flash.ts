// SPDX-License-Identifier: AGPL-3.0-or-later
// Messages "flash" du back-office : posés avant une redirection, affichés une seule fois.

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';

export type Flash = { kind: 'ok' | 'err' | 'info'; text: string };

export function setFlash(c: Context<AppEnv>, kind: Flash['kind'], text: string): void {
  setCookie(c, 'pnk_flash', JSON.stringify({ kind, text: text.slice(0, 300) }), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 60,
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

export function takeFlash(c: Context<AppEnv>): Flash | null {
  const raw = getCookie(c, 'pnk_flash');
  if (!raw) return null;
  deleteCookie(c, 'pnk_flash', { path: '/' });
  try {
    const v = JSON.parse(raw) as Partial<Flash>;
    if ((v.kind === 'ok' || v.kind === 'err' || v.kind === 'info') && typeof v.text === 'string') return { kind: v.kind, text: v.text };
  } catch {
    /* cookie altéré : on ignore */
  }
  return null;
}
