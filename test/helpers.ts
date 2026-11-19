// SPDX-License-Identifier: AGPL-3.0-or-later
import { env, exports } from 'cloudflare:workers';
import type { Env } from '../src/env';

export const e = env as unknown as Env;

/** Appelle le Worker comme un navigateur sur http://localhost (origine locale : auth de dev autorisée). */
export async function http(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined = init.body ?? undefined;
  const method = init.method ?? (init.form || init.json ? 'POST' : 'GET');
  if (init.form) {
    body = new URLSearchParams(init.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && method !== 'HEAD' && !('Origin' in headers) && !('origin' in headers)) headers['Origin'] = 'http://localhost';
  if (!('cf-connecting-ip' in headers)) headers['cf-connecting-ip'] = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // un visiteur différent par appel, sauf si imposé
  const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
  return worker.fetch(new Request(`http://localhost${path}`, { ...init, method, headers, body, redirect: 'manual' }));
}

const DEFAULT_SETTINGS: [string, string][] = [
  ['org_name', 'PNK'], ['org_legal_name', ''], ['org_address', ''], ['org_vat_number', ''], ['org_email', ''], ['org_phone', ''],
  ['org_website', ''], ['timezone', 'Europe/Brussels'], ['currency', 'EUR'], ['default_vat_bp', '600'], ['default_lang', 'fr'],
  ['invoice_prefix', 'PNK'], ['invoice_footer', ''], ['terms_url', ''],
];

/** Remet la base dans l'état d'une installation neuve (réglages par défaut, aucune donnée). */
export async function resetData(): Promise<void> {
  const tables = ['tickets', 'order_items', 'email_outbox', 'orders', 'ticket_types', 'events', 'venues', 'audit_log', 'rate_limits', 'webhook_events', 'staff', 'settings'];
  await e.DB.batch([
    ...tables.map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
    ...DEFAULT_SETTINGS.map(([k, v]) => e.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2)').bind(k, v)),
  ]);
}

export interface Seed {
  venueId: number;
  eventId: number;
  slug: string;
  standardId: number;
  nipId: number;
}

/** Salle + concert publié (dans 30 jours) avec catégories Standard et NIP. */
export async function seedEvent(opts: { slug?: string; standardQuota?: number; nipQuota?: number; standardCents?: number; nipCents?: number; capacity?: number; status?: string; startsInDays?: number } = {}): Promise<Seed> {
  const slug = opts.slug ?? `test-${Math.random().toString(36).slice(2, 8)}`;
  const start = new Date(Date.now() + (opts.startsInDays ?? 30) * 86400_000).toISOString();
  const venue = await e.DB.prepare("INSERT INTO venues (name, address, city, capacity) VALUES ('La Cave', '1 rue du Bruit', 'Bruxelles', ?1)")
    .bind(opts.capacity ?? 200)
    .run();
  const venueId = Number(venue.meta.last_row_id);
  const ev = await e.DB.prepare(
    "INSERT INTO events (slug, title, subtitle, description_fr, venue_id, starts_at, doors_at, status) VALUES (?1, 'Les Sales Gosses', 'avec Bruit Blanc', 'Une soirée sale.', ?2, ?3, ?4, ?5)",
  )
    .bind(slug, venueId, start, new Date(Date.parse(start) - 3600_000).toISOString(), opts.status ?? 'published')
    .run();
  const eventId = Number(ev.meta.last_row_id);
  const mk = async (fr: string, cents: number, quota: number, sort: number) =>
    Number(
      (
        await e.DB.prepare('INSERT INTO ticket_types (event_id, name_fr, name_en, name_nl, price_cents, quota, sort) VALUES (?1, ?2, ?2, ?2, ?3, ?4, ?5)')
          .bind(eventId, fr, cents, quota, sort)
          .run()
      ).meta.last_row_id,
    );
  const standardId = await mk('Standard', opts.standardCents ?? 1500, opts.standardQuota ?? 100, 0);
  const nipId = await mk('NIP', opts.nipCents ?? 3000, opts.nipQuota ?? 10, 1);
  return { venueId, eventId, slug, standardId, nipId };
}

export function formBody(seed: Seed, extra: Record<string, string> = {}): Record<string, string> {
  return {
    lang: 'fr',
    name: 'Jean Test',
    email: 'jean@example.com',
    terms: '1',
    [`qty_${seed.standardId}`]: '2',
    [`qty_${seed.nipId}`]: '0',
    ...extra,
  };
}

export const cookieOf = (res: Response) => res.headers.get('set-cookie') ?? '';
export const locationOf = (res: Response) => res.headers.get('location') ?? '';
