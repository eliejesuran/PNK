// SPDX-License-Identifier: AGPL-3.0-or-later
// Bindings Cloudflare et variables d'environnement de PNK.

import type { Settings } from './services/settings';

/** Sous-ensemble du binding Cloudflare Email Service utilisé par PNK. */
export interface EmailSender {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface Env {
  DB: D1Database;

  /** "development" active l'auth locale et le paiement factice. Toute autre valeur = production. */
  ENVIRONMENT?: string;
  /** URL publique sans slash final, ex. https://billets.exemple.org */
  BASE_URL?: string;

  PAYMENT_PROVIDER?: string; // "mollie" (défaut) | "stripe" | "mock" (mock refusé hors développement)
  /** Clé API Mollie : test_… (essais) puis live_… (vrais paiements). */
  MOLLIE_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  MAIL_DRIVER?: string; // "cloudflare" | "resend" | "log"
  /** Binding Cloudflare Email Service (send_email). */
  EMAIL?: EmailSender;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;

  /** Cloudflare Access : domaine d'équipe (xxx.cloudflareaccess.com) et audience (AUD) de l'application. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Emails séparés par des virgules, promus "owner" à leur première connexion. */
  BOOTSTRAP_OWNERS?: string;
  /** Local uniquement : email utilisé comme identité admin quand ENVIRONMENT=development. */
  DEV_USER_EMAIL?: string;

  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;

  /** Secret pour hacher les IP (anti-abus) sans les stocker en clair. */
  HASH_SECRET?: string;
}

export type Lang = 'fr' | 'en' | 'nl';
export const LANGS: readonly Lang[] = ['fr', 'en', 'nl'] as const;

export type Role = 'owner' | 'manager' | 'scanner';

export interface Staff {
  email: string;
  role: Role;
}

/** Variables Hono partagées entre middlewares et routes. */
export interface Vars {
  lang: Lang;
  settings: Settings;
  staff?: Staff;
  nonce?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: Vars;
}

export function isDev(env: Env): boolean {
  return env.ENVIRONMENT === 'development';
}
