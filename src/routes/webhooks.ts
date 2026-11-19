// SPDX-License-Identifier: AGPL-3.0-or-later
// Webhook Stripe : confirme les paiements (source de vérité), idempotent.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { baseUrlOf } from '../lib/security';
import { cancelOrder, fulfillOrder, getOrderById } from '../services/orders';
import { verifyStripeSignature, type StripeEvent } from '../services/payments/stripe';

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.post('/webhooks/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.text('webhook non configuré', 503);

  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header('stripe-signature'), secret))) {
    return c.text('signature invalide', 400);
  }
  let evt: StripeEvent;
  try {
    evt = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.text('JSON invalide', 400);
  }
  if (!evt.id || !evt.type) return c.text('évènement invalide', 400);

  const db = c.env.DB;
  const seen = await db.prepare("SELECT 1 AS x FROM webhook_events WHERE provider = 'stripe' AND event_id = ?1").bind(evt.id).first();
  if (seen) return c.json({ received: true, duplicate: true });

  const obj = evt.data?.object ?? {};
  const orderId = Number.parseInt(String(obj.client_reference_id ?? (obj.metadata as Record<string, string> | undefined)?.order_id ?? ''), 10);
  const baseUrl = baseUrlOf(c.env, c.req.raw);

  if (Number.isInteger(orderId)) {
    const order = await getOrderById(db, orderId);
    // Sécurité : la session de l'évènement doit être celle que nous avons créée pour cette commande.
    if (order && order.provider === 'stripe' && order.provider_session_id === obj.id) {
      const paymentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      switch (evt.type) {
        case 'checkout.session.completed':
          if (obj.payment_status === 'paid') {
            await fulfillOrder(c.env, order.id, { baseUrl, providerPaymentId: paymentId, waiter: c.executionCtx });
          }
          break; // "unpaid" = moyen de paiement différé : on attend async_payment_succeeded
        case 'checkout.session.async_payment_succeeded':
          await fulfillOrder(c.env, order.id, { baseUrl, providerPaymentId: paymentId, waiter: c.executionCtx });
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          if (order.status === 'pending') await cancelOrder(c.env, order, 'expired');
          break;
        default:
          break;
      }
    } else {
      console.warn('stripe webhook: commande inconnue ou session différente', evt.id, orderId);
    }
  }

  await db.prepare("INSERT OR IGNORE INTO webhook_events (provider, event_id) VALUES ('stripe', ?1)").bind(evt.id).run();
  return c.json({ received: true });
});
