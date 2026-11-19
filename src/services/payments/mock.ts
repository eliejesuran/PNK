// SPDX-License-Identifier: AGPL-3.0-or-later
// Faux fournisseur de paiement pour le développement et les tests. Refusé hors ENVIRONMENT=development.

import type { CreateCheckoutArgs, PaymentProvider, SessionState } from './types';

export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  refunds: string[] = [];

  async createCheckout(a: CreateCheckoutArgs): Promise<{ sessionId: string; url: string }> {
    return { sessionId: `mock_${a.orderId}`, url: `${a.baseUrl}/pay/mock/${a.token}` };
  }

  async retrieveSession(sessionId: string): Promise<SessionState> {
    // Le paiement factice est confirmé par la route /pay/mock, pas par interrogation.
    return { paid: false, expired: false, paymentId: `mockpay_${sessionId}` };
  }

  async refund(paymentId: string): Promise<void> {
    this.refunds.push(paymentId);
  }

  async expireSession(): Promise<void> {}
}
