// SPDX-License-Identifier: AGPL-3.0-or-later
// PNK — point d'entrée du Worker : assemblage des routes, sécurité, tâches planifiées.

import { Hono } from 'hono';
import { appContext, viewCtx } from './ctx';
import type { AppEnv, Env } from './env';
import { t } from './i18n';
import { sameOriginOnly, securityHeaders } from './lib/security';
import { requireRole } from './middleware';
import { adminRoutes } from './routes/admin';
import { opsRoutes } from './routes/admin-ops';
import { publicRoutes } from './routes/public';
import { webhookRoutes } from './routes/webhooks';
import { flushOutbox } from './services/mail';
import { closeExpiredProviderSessions, expireStaleOrders, purgeOldRateLimits } from './services/orders';
import { ErrorView } from './views/errors';

const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', sameOriginOnly);
app.use('*', appContext);

app.route('/', webhookRoutes);

// Gardes d'accès (Cloudflare Access + rôle). Tout ce qui n'est pas listé ici est public.
const manager = requireRole('manager');
const owner = requireRole('owner');
const scanner = requireRole('scanner');
app.use('/admin', manager);
app.use('/admin/*', manager);
app.use('/admin/settings', owner);
app.use('/admin/staff', owner);
app.use('/admin/staff/*', owner);
app.use('/admin/audit', owner);
app.use('/scan', scanner);
app.use('/api/*', scanner);

app.route('/', adminRoutes);
app.route('/', opsRoutes);
app.route('/', publicRoutes);

app.notFound((c) => {
  const lang = c.get('lang') ?? 'fr';
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  return c.html(
    <ErrorView {...viewCtx(c)} code={404} title={t(lang, 'err.not_found_title')} text={t(lang, 'err.not_found_text')} />,
    404,
  );
});

app.onError((err, c) => {
  console.error('unhandled error', c.req.method, c.req.path, err instanceof Error ? (err.stack ?? err.message) : err);
  const lang = c.get('lang') ?? 'fr';
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'server_error' }, 500);
  try {
    return c.html(
      <ErrorView {...viewCtx(c)} code={500} title={t(lang, 'err.server_title')} text={t(lang, 'err.server_text')} />,
      500,
    );
  } catch {
    return c.text('Erreur serveur', 500);
  }
});

export async function runScheduled(env: Env): Promise<{ expired: number; mailed: number; closed: number }> {
  const now = new Date();
  const expired = await expireStaleOrders(env.DB, now.toISOString());
  const mailed = await flushOutbox(env, now.toISOString());
  const closed = await closeExpiredProviderSessions(env);
  await purgeOldRateLimits(env.DB, now.getTime());
  return { expired, mailed, closed };
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env).then((r) => console.log('cron', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
