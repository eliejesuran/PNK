// SPDX-License-Identifier: AGPL-3.0-or-later
// En-têtes de sécurité, anti-CSRF, empreinte d'IP, vérification Turnstile.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import { hmacHex } from './ids';

export const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com',
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PRIVATE_PREFIXES = ['/admin', '/o/', '/scan', '/api/', '/pay/'];

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  const set = (k: string, v: string) => {
    if (!h.has(k)) h.set(k, v);
  };
  set('Content-Security-Policy', CSP);
  set('X-Content-Type-Options', 'nosniff');
  set('Referrer-Policy', 'same-origin');
  set('X-Frame-Options', 'DENY');
  set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(self)');
  set('Cross-Origin-Opener-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  set('Cache-Control', 'no-store');
  if (PRIVATE_PREFIXES.some((p) => c.req.path === p.replace(/\/$/, '') || c.req.path.startsWith(p))) {
    set('X-Robots-Tag', 'noindex, nofollow');
  }
};

/**
 * Anti-CSRF : toute requête qui modifie quelque chose doit venir de notre propre origine.
 * (Les webhooks de paiement sont authentifiés par signature, pas par origine.)
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (c.req.path.startsWith('/webhooks/')) return next();
  const origin = c.req.header('origin');
  if (origin) {
    if (origin === new URL(c.req.url).origin) return next();
    return c.text('Forbidden (origin)', 403);
  }
  const site = c.req.header('sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return next();
  return c.text('Forbidden (cross-site request)', 403);
};

/** Empreinte (HMAC) de l'IP : sert à limiter les abus sans stocker l'adresse en clair. */
export async function ipHash(env: Env, req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  return (await hmacHex(env.HASH_SECRET ?? 'pnk-unsalted', `ip:${ip}`)).slice(0, 32);
}

export function baseUrlOf(env: Env, req: Request): string {
  const configured = (env.BASE_URL ?? '').replace(/\/+$/, '');
  return configured || new URL(req.url).origin;
}

/** Vérifie un jeton Turnstile. Si Turnstile n'est pas configuré, la vérification est ignorée. */
export async function verifyTurnstile(env: Env, token: string | null, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
