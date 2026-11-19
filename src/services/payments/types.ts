// SPDX-License-Identifier: AGPL-3.0-or-later
// Interface commune des fournisseurs de paiement (Stripe, mock de développement).

import type { Lang } from '../../env';

export interface CheckoutLine {
  name: string;
  qty: number;
  unitCents: number;
}

export interface CreateCheckoutArgs {
  orderId: number;
  token: string;
  email: string;
  lang: Lang;
  lines: CheckoutLine[];
  currency: string;
  baseUrl: string;
  /** Expiration de la session de paiement (timestamp Unix en secondes). */
  expiresAtUnix: number;
  description: string;
}

export interface SessionState {
  paid: boolean;
  expired: boolean;
  paymentId: string | null;
}

export interface PaymentProvider {
  readonly name: 'stripe' | 'mock';
  createCheckout(args: CreateCheckoutArgs): Promise<{ sessionId: string; url: string }>;
  /** Interroge le fournisseur pour savoir si la session est payée (filet de sécurité si le webhook tarde). */
  retrieveSession(sessionId: string): Promise<SessionState>;
  /** Rembourse intégralement un paiement. Idempotent grâce à la clé fournie. */
  refund(paymentId: string, idempotencyKey: string): Promise<void>;
  /** Ferme la session pour qu'on ne puisse plus la payer. */
  expireSession(sessionId: string): Promise<void>;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}
