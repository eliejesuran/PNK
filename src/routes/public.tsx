// SPDX-License-Identifier: AGPL-3.0-or-later
// Routes publiques : accueil, page concert, achat, commande/billets, facture, QR, faux paiement (dev).

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { isDev } from '../env';
import { isLang, t } from '../i18n';
import { isOrderToken } from '../lib/ids';
import { qrPng } from '../lib/qr';
import { baseUrlOf, ipHash, verifyTurnstile } from '../lib/security';
import { clampInt, clean, isEmail } from '../lib/text';
import { viewCtx } from '../ctx';
import { getEventById, getEventBySlug, listPublicEvents, salesState, ticketTypesWithStock } from '../services/events';
import {
  cancelOrder,
  createOrder,
  fulfillOrder,
  getOrderByToken,
  getOrderItems,
  getOrderTickets,
  rateLimited,
  startCheckout,
} from '../services/orders';
import { providerFor } from '../services/payments';
import { invoiceNumber, type EventWithVenue } from '../services/types';
import { ErrorView } from '../views/errors';
import {
  EventView,
  HomeView,
  InvoiceView,
  MockPayView,
  OrderView,
  type CheckoutValues,
  type HomeEvent,
} from '../views/public';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/healthz', (c) => c.json({ ok: true }));

// ---------- Accueil ----------

publicRoutes.get('/', async (c) => {
  const now = new Date().toISOString();
  const events = await listPublicEvents(c.env.DB, now);
  const items: HomeEvent[] = await Promise.all(
    events.map(async (event) => {
      const types = (await ticketTypesWithStock(c.env.DB, event.id, now)).filter((x) => x.online === 1);
      const soldOut = types.length > 0 && types.every((x) => x.available <= 0);
      const prices = types.filter((x) => x.available > 0).map((x) => x.price_cents);
      return { event, soldOut, minPriceCents: prices.length ? Math.min(...prices) : null };
    }),
  );
  return c.html(<HomeView {...viewCtx(c)} events={items} currency={c.get('settings').currency} />);
});

// ---------- Page concert ----------

const EMPTY_VALUES: CheckoutValues = { name: '', email: '', billing_name: '', billing_vat: '', billing_address: '', terms: false, qty: {} };

async function renderEvent(
  c: Context<AppEnv>,
  event: EventWithVenue,
  opts: { values?: CheckoutValues; error?: string; status?: 200 | 400 | 404 | 409 | 429 | 503 } = {},
) {
  const now = new Date().toISOString();
  const types = await ticketTypesWithStock(c.env.DB, event.id, now);
  return c.html(
    <EventView
      {...viewCtx(c)}
      event={event}
      types={types}
      nowIso={now}
      currency={c.get('settings').currency}
      values={opts.values ?? EMPTY_VALUES}
      error={opts.error}
      turnstileSiteKey={c.env.TURNSTILE_SITE_KEY && c.env.TURNSTILE_SECRET ? c.env.TURNSTILE_SITE_KEY : undefined}
    />,
    opts.status ?? 200,
  );
}

function notFound(c: Context<AppEnv>) {
  const lang = c.get('lang') ?? 'fr';
  return c.html(
    <ErrorView {...viewCtx(c)} code={404} title={t(lang, 'err.not_found_title')} text={t(lang, 'err.not_found_text')} />,
    404,
  );
}

publicRoutes.get('/e/:slug', async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event || event.status === 'draft') return notFound(c);
  return renderEvent(c, event);
});

publicRoutes.post('/e/:slug/checkout', async (c) => {
  const env = c.env;
  const event = await getEventBySlug(env.DB, c.req.param('slug'));
  if (!event || event.status === 'draft') return notFound(c);

  const body = await c.req.parseBody();
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const lang = isLang(str('lang')) ? (str('lang') as 'fr' | 'en' | 'nl') : c.get('lang');
  c.set('lang', lang);
  const settings = c.get('settings');
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const types = await ticketTypesWithStock(env.DB, event.id, now);
  const values: CheckoutValues = {
    name: clean(str('name'), 120),
    email: clean(str('email'), 254).toLowerCase(),
    billing_name: clean(str('billing_name'), 120),
    billing_vat: clean(str('billing_vat'), 40),
    billing_address: clean(str('billing_address'), 300),
    terms: str('terms') === '1',
    qty: {},
  };
  const lines = types
    .filter((x) => x.online === 1)
    .map((x) => {
      const qty = clampInt(str(`qty_${x.id}`), 0, 100, 0);
      values.qty[x.id] = qty;
      return { ticketTypeId: x.id, qty };
    });

  const fail = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>, status: 400 | 409 | 429 | 503 = 400) =>
    renderEvent(c, event, { values, error: t(lang, key, vars), status });

  if (salesState(event, now) !== 'open') return fail('err.closed');
  if (lines.every((l) => l.qty === 0)) return fail('err.pick');
  if (!values.name) return fail('err.name');
  if (!isEmail(values.email)) return fail('err.email');
  if (!values.terms) return fail('err.terms');

  const ip = await ipHash(env, c.req.raw);
  if (!(await verifyTurnstile(env, str('cf-turnstile-response') || null, c.req.header('cf-connecting-ip') ?? null))) {
    return fail('err.captcha');
  }
  // 12 tentatives de commande par 10 minutes et par visiteur (en plus des règles Cloudflare).
  if (await rateLimited(env.DB, `checkout:${ip}`, 12, 600, nowDate.getTime())) return fail('err.rate', undefined, 429);

  const res = await createOrder(env.DB, {
    event,
    settings,
    types,
    lines,
    email: values.email,
    name: values.name,
    lang,
    billing: { name: values.billing_name, vat: values.billing_vat, address: values.billing_address },
    ipHash: ip,
    now: nowDate,
  });
  if (!res.ok) {
    if (res.reason === 'soldout') return fail('err.soldout', { type: res.typeName ?? '' }, 409);
    if (res.reason === 'too_many') return fail('err.too_many', { n: res.max ?? event.max_per_order });
    if (res.reason === 'empty') return fail('err.pick');
    return fail('err.generic');
  }

  const out = await startCheckout(env, res.order, event, res.items, baseUrlOf(env, c.req.raw), c.executionCtx);
  if (out.kind === 'redirect') return c.redirect(out.url, 303);
  if (out.kind === 'paid') return c.redirect(`/o/${out.order.token}`, 303);
  return fail('err.payment', undefined, 503);
});

// ---------- Commande ----------

publicRoutes.get('/o/:token', async (c) => {
  const token = c.req.param('token');
  if (!isOrderToken(token)) return notFound(c);
  const env = c.env;
  let order = await getOrderByToken(env.DB, token);
  if (!order) return notFound(c);
  const cancelled = c.req.query('cancelled') === '1';

  // Filet de sécurité : si le webhook tarde, on demande directement au fournisseur si c'est payé.
  if (order.status === 'pending' && order.provider_session_id && !cancelled) {
    const provider = providerFor(env, order.provider);
    if (provider && provider.name !== 'mock') {
      try {
        const st = await provider.retrieveSession(order.provider_session_id);
        if (st.paid) await fulfillOrder(env, order.id, { baseUrl: baseUrlOf(env, c.req.raw), providerPaymentId: st.paymentId, waiter: c.executionCtx });
        else if (st.expired) await cancelOrder(env, order, 'expired');
        order = (await getOrderByToken(env.DB, token)) ?? order;
      } catch (e) {
        console.error('retrieveSession failed', order.id, e instanceof Error ? e.message : e);
      }
    }
  }

  const event = await getEventById(env.DB, order.event_id);
  if (!event) return notFound(c);
  // La commande s'affiche dans la langue choisie par l'acheteur à l'achat (sauf si ?lang= explicite).
  if (!c.req.query('lang') && order.lang) c.set('lang', order.lang);
  const [items, tickets] = await Promise.all([getOrderItems(env.DB, order.id), getOrderTickets(env.DB, order.id)]);
  return c.html(
    <OrderView
      {...viewCtx(c)}
      order={order}
      event={event}
      items={items}
      tickets={tickets}
      currency={order.currency}
      invoiceNo={invoiceNumber(order, c.get('settings').invoice_prefix)}
      cancelled={cancelled}
      autoPrint={c.req.query('print') === '1'}
    />,
  );
});

publicRoutes.post('/o/:token/cancel', async (c) => {
  const token = c.req.param('token');
  if (!isOrderToken(token)) return notFound(c);
  const order = await getOrderByToken(c.env.DB, token);
  if (!order) return notFound(c);
  if (order.status === 'pending') await cancelOrder(c.env, order, 'cancelled');
  return c.redirect(`/o/${token}`, 303);
});

publicRoutes.get('/o/:token/invoice', async (c) => {
  const token = c.req.param('token');
  if (!isOrderToken(token)) return notFound(c);
  const order = await getOrderByToken(c.env.DB, token);
  if (!order || (order.status !== 'paid' && order.status !== 'refunded')) return notFound(c);
  const event = await getEventById(c.env.DB, order.event_id);
  if (!event) return notFound(c);
  if (!c.req.query('lang') && order.lang) c.set('lang', order.lang);
  const items = await getOrderItems(c.env.DB, order.id);
  return c.html(<InvoiceView {...viewCtx(c)} order={order} event={event} items={items} settings={c.get('settings')} />);
});

// ---------- QR code en PNG (pour les emails) ----------

publicRoutes.get('/q/:file', async (c) => {
  const m = /^([0-9A-HJKMNP-TV-Z]{16})\.png$/.exec(c.req.param('file'));
  if (!m) return c.notFound();
  const row = await c.env.DB.prepare('SELECT 1 AS ok FROM tickets WHERE code = ?1').bind(m[1]!).first();
  if (!row) return c.notFound();
  const png = qrPng(`PNK:${m[1]}`, 6);
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, immutable', 'X-Robots-Tag': 'noindex' },
  });
});

// ---------- Faux paiement (développement uniquement) ----------

publicRoutes.get('/pay/mock/:token', async (c) => {
  if (!isDev(c.env)) return c.notFound();
  const order = await getOrderByToken(c.env.DB, c.req.param('token'));
  if (!order || order.provider !== 'mock' || order.status !== 'pending') return notFound(c);
  return c.html(<MockPayView {...viewCtx(c)} order={order} currency={order.currency} />);
});

publicRoutes.post('/pay/mock/:token', async (c) => {
  if (!isDev(c.env)) return c.notFound();
  const order = await getOrderByToken(c.env.DB, c.req.param('token'));
  if (!order || order.provider !== 'mock') return notFound(c);
  const body = await c.req.parseBody();
  if (body.result === 'success') {
    await fulfillOrder(c.env, order.id, { baseUrl: baseUrlOf(c.env, c.req.raw), providerPaymentId: `mockpay_${order.id}`, waiter: c.executionCtx });
    return c.redirect(`/o/${order.token}`, 303);
  }
  await cancelOrder(c.env, order, 'cancelled');
  return c.redirect(`/o/${order.token}?cancelled=1`, 303);
});
