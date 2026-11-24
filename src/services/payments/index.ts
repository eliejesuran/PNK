// SPDX-License-Identifier: AGPL-3.0-or-later
import { isDev, type Env } from '../../env';
import { MockProvider } from './mock';
import { MollieProvider } from './mollie';
import { StripeProvider } from './stripe';
import type { PaymentProvider } from './types';

export * from './types';

/** Fournisseur actif, ou null si le paiement n'est pas (correctement) configuré. Échoue fermé. */
export function getProvider(env: Env): PaymentProvider | null {
  const name = env.PAYMENT_PROVIDER ?? 'mollie';
  if (name === 'mock') return isDev(env) ? new MockProvider() : null; // jamais de faux paiement en prod
  if (name === 'mollie') return env.MOLLIE_API_KEY ? new MollieProvider(env.MOLLIE_API_KEY) : null;
  if (name === 'stripe') return env.STRIPE_SECRET_KEY ? new StripeProvider(env.STRIPE_SECRET_KEY) : null;
  return null;
}

/** Retrouve le fournisseur qui a créé une commande (pour rembourser / interroger). */
export function providerFor(env: Env, providerName: string): PaymentProvider | null {
  if (providerName === 'mollie') return env.MOLLIE_API_KEY ? new MollieProvider(env.MOLLIE_API_KEY) : null;
  if (providerName === 'stripe') return env.STRIPE_SECRET_KEY ? new StripeProvider(env.STRIPE_SECRET_KEY) : null;
  if (providerName === 'mock') return isDev(env) ? new MockProvider() : null;
  return null;
}
