// SPDX-License-Identifier: AGPL-3.0-or-later
// Mollie (Pays-Bas, UE) : page de paiement hébergée par Mollie, via l'API REST v2, sans SDK.
// Les moyens de paiement affichés (Bancontact, cartes, Apple Pay, Google Pay, iDEAL, Wero…) se règlent dans le tableau de bord
// Mollie : on n'envoie volontairement pas `method`, le client choisit sur la page de Mollie.
//
// Particularités de l'API :
//  * la notification (webhook) ne contient QUE l'identifiant du paiement (id=tr_xxx) et n'est pas signée : on relit toujours
//    le paiement chez Mollie avec notre clé, on ne fait jamais confiance au contenu de la requête ;
//  * `expiresAt` n'est pas réglable (15 min pour une carte, 1 h pour Bancontact) : une tâche planifiée ferme les paiements
//    des réservations expirées (voir closeExpiredProviderSessions) ;
//  * un remboursement exige le montant : on rembourse le montant restant du paiement.

import {
  PaymentError,
  type CreateCheckoutArgs,
  type PaymentProvider,
  type SessionState,
} from './types';

const API = 'https://api.mollie.com/v2';

const LOCALES = { fr: 'fr_BE', nl: 'nl_BE', en: 'en_GB' } as const;

interface MollieAmount {
  currency: string;
  value: string;
}

interface MolliePayment {
  id: string;
  status: string;
  amount: MollieAmount;
  amountRemaining?: MollieAmount;
  _links?: { checkout?: { href?: string } };
}

/** Erreur de l'API Mollie : `field` désigne le paramètre refusé (422), ex. « webhookUrl ». */
export class MollieApiError extends PaymentError {
  constructor(
    message: string,
    status: number,
    readonly field?: string,
  ) {
    super(message, status);
    this.name = 'MollieApiError';
  }
}

/** Montant Mollie : chaîne avec 2 décimales ("30.00"). */
export function mollieAmount(cents: number, currency: string): MollieAmount {
  return { currency: currency.toUpperCase(), value: (cents / 100).toFixed(2) };
}

/** Mollie refuse les webhooks vers localhost ou en http : on ne les envoie que vers une adresse publique en https. */
function publicHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'https:' && u.hostname !== 'localhost' && !u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

export class MollieProvider implements PaymentProvider {
  readonly name = 'mollie' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey && method === 'POST') headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.fetcher(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { title?: string; detail?: string; field?: string } & T;
    if (!res.ok) {
      throw new MollieApiError(`Mollie ${res.status}: ${json.title ?? ''} ${json.detail ?? 'erreur inconnue'}`.replace(/\s+/g, ' ').trim(), res.status, json.field);
    }
    return json;
  }

  async createCheckout(a: CreateCheckoutArgs): Promise<{ sessionId: string; url: string }> {
    const total = a.lines.reduce((s, l) => s + l.qty * l.unitCents, 0);
    const back = `${a.baseUrl}/o/${a.token}`;
    const body: Record<string, unknown> = {
      amount: mollieAmount(total, a.currency),
      description: a.description.slice(0, 255),
      redirectUrl: back,
      cancelUrl: `${back}?cancelled=1`,
      locale: LOCALES[a.lang],
      metadata: { order_id: a.orderId },
    };
    if (publicHttps(a.baseUrl)) body.webhookUrl = `${a.baseUrl}/webhooks/mollie`;
    const key = `pnk-checkout-${a.orderId}`;
    let p: MolliePayment;
    try {
      p = await this.call<MolliePayment>('POST', '/payments', body, key);
    } catch (e) {
      // Mollie ne peut pas joindre notre webhook (ex. site derrière Cloudflare Access pendant les essais) : on réessaie sans.
      // Le paiement est alors confirmé par la page de retour de l'acheteur. Autre clé d'idempotence : les paramètres changent.
      if (e instanceof MollieApiError && e.status === 422 && e.field === 'webhookUrl' && body.webhookUrl) {
        delete body.webhookUrl;
        p = await this.call<MolliePayment>('POST', '/payments', body, `${key}-sans-webhook`);
      } else throw e;
    }
    const url = p._links?.checkout?.href;
    if (!url) throw new PaymentError('Mollie n’a pas renvoyé d’URL de paiement');
    return { sessionId: p.id, url };
  }

  async retrieveSession(sessionId: string): Promise<SessionState> {
    const p = await this.call<MolliePayment>('GET', `/payments/${encodeURIComponent(sessionId)}`);
    return {
      paid: p.status === 'paid',
      // statuts définitifs sans paiement : la réservation peut être libérée
      expired: p.status === 'expired' || p.status === 'canceled' || p.status === 'failed',
      paymentId: p.id,
    };
  }

  async refund(paymentId: string, idempotencyKey: string): Promise<void> {
    const p = await this.call<MolliePayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
    const remaining = p.amountRemaining ?? p.amount;
    if (Number(remaining.value) <= 0) return; // déjà intégralement remboursé
    if (p.status !== 'paid') throw new PaymentError(`Mollie : le paiement n’est pas payé (statut « ${p.status} »), remboursement impossible`);
    try {
      await this.call('POST', `/payments/${encodeURIComponent(paymentId)}/refunds`, { amount: remaining, description: 'Remboursement PNK' }, idempotencyKey);
    } catch (e) {
      // 409 : la même demande vient d'être envoyée juste avant ; rien d'autre à faire.
      if (e instanceof MollieApiError && e.status === 409) return;
      throw e;
    }
  }

  async expireSession(sessionId: string): Promise<void> {
    try {
      await this.call('DELETE', `/payments/${encodeURIComponent(sessionId)}`);
    } catch (e) {
      // Introuvable, ou plus annulable (déjà payé / expiré) : rien à faire.
      if (e instanceof MollieApiError && (e.status === 404 || e.status === 422)) return;
      throw e;
    }
  }
}
