// SPDX-License-Identifier: AGPL-3.0-or-later
// Stripe Checkout (page de paiement hébergée par Stripe) via l'API REST, sans SDK.
// Les moyens de paiement (cartes, Apple Pay, Google Pay, Bancontact, iDEAL, …) se choisissent dans le
// tableau de bord Stripe : on ne fixe volontairement pas `payment_method_types`.

import { hmacHex, timingSafeEqual } from '../../lib/ids';
import {
  PaymentError,
  type CreateCheckoutArgs,
  type PaymentProvider,
  type SessionState,
} from './types';

const API = 'https://api.stripe.com/v1';

/** Encode un objet à plat en application/x-www-form-urlencoded (clés déjà au format Stripe : a[b][c]). */
export function formEncode(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.append(k, String(v));
  return usp.toString();
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;

  constructor(
    private readonly secretKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params?: Record<string, string | number | undefined>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers,
      body: method === 'POST' && params ? formEncode(params) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
    if (!res.ok) {
      throw new PaymentError(`Stripe ${res.status}: ${json.error?.code ?? ''} ${json.error?.message ?? 'erreur inconnue'}`.trim(), res.status);
    }
    return json;
  }

  async createCheckout(a: CreateCheckoutArgs): Promise<{ sessionId: string; url: string }> {
    const params: Record<string, string | number> = {
      mode: 'payment',
      client_reference_id: String(a.orderId),
      customer_email: a.email,
      locale: a.lang,
      success_url: `${a.baseUrl}/o/${a.token}`,
      cancel_url: `${a.baseUrl}/o/${a.token}?cancelled=1`,
      expires_at: a.expiresAtUnix,
      'metadata[order_id]': String(a.orderId),
      'payment_intent_data[metadata][order_id]': String(a.orderId),
      'payment_intent_data[description]': a.description,
    };
    a.lines.forEach((l, i) => {
      params[`line_items[${i}][quantity]`] = l.qty;
      params[`line_items[${i}][price_data][currency]`] = a.currency.toLowerCase();
      params[`line_items[${i}][price_data][unit_amount]`] = l.unitCents;
      params[`line_items[${i}][price_data][product_data][name]`] = l.name;
    });
    const s = await this.call<{ id: string; url: string }>('POST', '/checkout/sessions', params, `pnk-checkout-${a.orderId}`);
    if (!s.url) throw new PaymentError('Stripe n’a pas renvoyé d’URL de paiement');
    return { sessionId: s.id, url: s.url };
  }

  async retrieveSession(sessionId: string): Promise<SessionState> {
    const s = await this.call<{ payment_status: string; status: string; payment_intent: string | { id: string } | null }>(
      'GET',
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null);
    return { paid: s.payment_status === 'paid', expired: s.status === 'expired', paymentId: pi };
  }

  async refund(paymentId: string, idempotencyKey: string): Promise<void> {
    await this.call('POST', '/refunds', { payment_intent: paymentId }, idempotencyKey);
  }

  async expireSession(sessionId: string): Promise<void> {
    try {
      await this.call('POST', `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
    } catch (e) {
      // Déjà expirée ou payée : rien à faire.
      if (e instanceof PaymentError && e.status === 400) return;
      throw e;
    }
  }
}

// ---------- Webhooks ----------

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Vérifie l'en-tête `Stripe-Signature` ("t=...,v1=...") : HMAC-SHA256 de `${t}.${payload}`,
 * tolérance de 5 minutes contre le rejeu.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSec = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't' && v) timestamp = v;
    if (k === 'v1' && v) signatures.push(v);
  }
  const t = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}
