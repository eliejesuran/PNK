// SPDX-License-Identifier: AGPL-3.0-or-later
// Identité et rôles du back-office.
//
// L'identité vient de Cloudflare Access (SSO / code par email devant /admin, /scan, /api) : le Worker vérifie
// la signature du jeton JWT `Cf-Access-Jwt-Assertion` (clés publiques de l'équipe, issuer et audience),
// il ne fait jamais confiance à un simple en-tête. En développement local uniquement (ENVIRONMENT=development
// ET host localhost), DEV_USER_EMAIL fait office d'identité. Si rien n'est configuré en production : accès refusé.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isDev, type Env, type Role, type Staff } from '../env';

export const ROLE_RANK: Record<Role, number> = { scanner: 1, manager: 2, owner: 3 };
export const ROLE_LABEL: Record<Role, string> = { owner: 'Propriétaire', manager: 'Gestionnaire', scanner: 'Contrôle (scanner)' };

export function hasRole(staff: Staff | undefined, min: Role): boolean {
  return !!staff && ROLE_RANK[staff.role] >= ROLE_RANK[min];
}

export type Identity = { ok: true; email: string } | { ok: false; status: 401 | 403 | 503; message: string };

type Jwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, Jwks>();

function jwksFor(team: string): Jwks {
  let j = jwksCache.get(team);
  if (!j) {
    j = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`), { cooldownDuration: 30_000 });
    jwksCache.set(team, j);
  }
  return j;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function identify(env: Env, req: Request): Promise<Identity> {
  const url = new URL(req.url);
  if (isDev(env) && env.DEV_USER_EMAIL && LOCAL_HOSTS.has(url.hostname)) {
    return { ok: true, email: env.DEV_USER_EMAIL.trim().toLowerCase() };
  }
  const team = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = (env.ACCESS_AUD ?? '').trim();
  if (!team || !aud) {
    return { ok: false, status: 503, message: 'Authentification non configurée (ACCESS_TEAM_DOMAIN / ACCESS_AUD). Accès refusé par sécurité.' };
  }
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, status: 401, message: 'Connexion requise (Cloudflare Access).' };
  try {
    const { payload } = await jwtVerify(token, jwksFor(team), { issuer: `https://${team}`, audience: aud, algorithms: ['RS256'] });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email) return { ok: false, status: 403, message: 'Le jeton ne contient pas d’email.' };
    return { ok: true, email };
  } catch {
    return { ok: false, status: 401, message: 'Jeton Cloudflare Access invalide ou expiré.' };
  }
}

function bootstrapOwners(env: Env): Set<string> {
  return new Set(
    (env.BOOTSTRAP_OWNERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Rôle d'un email : ligne `staff`, ou propriétaire initial (BOOTSTRAP_OWNERS) créé à la première connexion. */
export async function resolveStaff(env: Env, email: string, nowIso: string): Promise<Staff | null> {
  const row = await env.DB.prepare('SELECT email, role FROM staff WHERE email = ?1').bind(email).first<Staff>();
  if (row) {
    await env.DB.prepare("UPDATE staff SET last_seen_at = ?2 WHERE email = ?1 AND (last_seen_at IS NULL OR last_seen_at < ?3)")
      .bind(email, nowIso, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString())
      .run();
    return row;
  }
  // Amorçage : seulement tant qu'il n'existe AUCUN propriétaire. Sinon un propriétaire d'amorçage retiré de l'équipe
  // serait recréé « owner » à sa prochaine requête et ne pourrait plus jamais être révoqué.
  if (bootstrapOwners(env).has(email)) {
    const hasOwner = await env.DB.prepare("SELECT 1 AS x FROM staff WHERE role = 'owner' LIMIT 1").first();
    if (!hasOwner) {
      await env.DB.prepare("INSERT OR IGNORE INTO staff (email, role, last_seen_at) VALUES (?1, 'owner', ?2)").bind(email, nowIso).run();
      return { email, role: 'owner' };
    }
  }
  return null;
}

/** Ce qui manque côté configuration technique (pour la check-list du tableau de bord). */
export function envGaps(env: Env): string[] {
  const gaps: string[] = [];
  const dev = isDev(env);
  if (!dev) {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) gaps.push('Cloudflare Access (ACCESS_TEAM_DOMAIN et ACCESS_AUD)');
    const provider = env.PAYMENT_PROVIDER ?? 'mollie';
    if (provider === 'mollie') {
      if (!env.MOLLIE_API_KEY) gaps.push('Clé API Mollie (MOLLIE_API_KEY)');
      else if (env.MOLLIE_API_KEY.startsWith('test_')) gaps.push('Paiements Mollie en mode TEST (clé test_…) : aucun vrai argent ne circule ; mets la clé live_… pour vendre pour de vrai');
    } else if (provider === 'stripe') {
      if (!env.STRIPE_SECRET_KEY) gaps.push('Clé secrète Stripe (STRIPE_SECRET_KEY)');
      if (!env.STRIPE_WEBHOOK_SECRET) gaps.push('Secret du webhook Stripe (STRIPE_WEBHOOK_SECRET)');
    } else gaps.push('PAYMENT_PROVIDER doit valoir "mollie" ou "stripe" en production');
    if (!env.HASH_SECRET) gaps.push('HASH_SECRET (anti-abus)');
    if (env.BASE_URL?.includes('example.org')) gaps.push('BASE_URL (valeur d’exemple : mets l’URL publique, ou laisse vide pour utiliser l’adresse de la requête)');
    if (!env.MAIL_FROM || env.MAIL_FROM.includes('example.org')) gaps.push('MAIL_FROM (adresse d’expédition des emails)');
    if ((env.MAIL_DRIVER ?? 'cloudflare') === 'resend' && !env.RESEND_API_KEY) gaps.push('RESEND_API_KEY');
    if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) gaps.push(env.TURNSTILE_SECRET || env.TURNSTILE_SITE_KEY ? 'Turnstile à moitié configuré : il faut TURNSTILE_SITE_KEY ET TURNSTILE_SECRET (sinon il est ignoré)' : 'Turnstile (anti-robots, recommandé) : TURNSTILE_SITE_KEY et TURNSTILE_SECRET');
  }
  return gaps;
}
