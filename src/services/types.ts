// SPDX-License-Identifier: AGPL-3.0-or-later
// Types des lignes de base de données (reflet de migrations/*.sql).

import type { Lang } from '../env';

export interface Venue {
  id: number;
  name: string;
  address: string;
  city: string;
  capacity: number;
  archived: number;
  created_at: string;
}

export type EventStatus = 'draft' | 'published' | 'cancelled';

export interface EventRow {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  description_fr: string;
  description_en: string;
  description_nl: string;
  venue_id: number;
  starts_at: string;
  doors_at: string | null;
  status: EventStatus;
  sales_open_at: string | null;
  sales_close_at: string | null;
  max_per_order: number;
  image_url: string;
  vat_rate_bp: number | null;
  created_at: string;
  updated_at: string;
}

export interface EventWithVenue extends EventRow {
  venue_name: string;
  venue_address: string;
  venue_city: string;
  venue_capacity: number;
}

export interface TicketType {
  id: number;
  event_id: number;
  name_fr: string;
  name_en: string;
  name_nl: string;
  price_cents: number;
  quota: number;
  sort: number;
  online: number;
  created_at: string;
}

/** Catégorie avec les compteurs de stock calculés. */
export interface TicketTypeStock extends TicketType {
  sold: number; // commandes payées
  held: number; // réservations en cours de paiement (non expirées)
  available: number; // quota - sold - held (jamais < 0)
}

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'expired' | 'refunded';
export type OrderChannel = 'online' | 'door' | 'guest';
export type PaymentMethod = 'online' | 'cash' | 'terminal' | 'free';

export interface OrderRow {
  id: number;
  token: string;
  event_id: number;
  status: OrderStatus;
  channel: OrderChannel;
  payment_method: PaymentMethod;
  provider: string;
  provider_session_id: string | null;
  provider_payment_id: string | null;
  checkout_url: string | null;
  email: string;
  name: string;
  lang: Lang;
  billing_name: string;
  billing_vat: string;
  billing_address: string;
  total_cents: number;
  vat_rate_bp: number;
  currency: string;
  invoice_year: number | null;
  invoice_seq: number | null;
  created_by: string | null;
  ip_hash: string | null;
  expires_at: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
}

export interface OrderItem {
  id: number;
  order_id: number;
  ticket_type_id: number;
  qty: number;
  unit_price_cents: number;
}

export interface OrderItemNamed extends OrderItem {
  name_fr: string;
  name_en: string;
  name_nl: string;
}

export interface TicketRow {
  id: number;
  code: string;
  order_id: number;
  event_id: number;
  ticket_type_id: number;
  status: 'valid' | 'void';
  checked_in_at: string | null;
  checked_in_by: string | null;
  created_at: string;
}

export interface TicketWithType extends TicketRow {
  name_fr: string;
  name_en: string;
  name_nl: string;
}

export function typeName(t: { name_fr: string; name_en: string; name_nl: string }, lang: Lang): string {
  return (lang === 'en' ? t.name_en : lang === 'nl' ? t.name_nl : t.name_fr) || t.name_fr;
}

export function eventDescription(e: EventRow, lang: Lang): string {
  const by = { fr: e.description_fr, en: e.description_en, nl: e.description_nl };
  return by[lang]?.trim() || by.fr?.trim() || by.en?.trim() || by.nl?.trim() || '';
}

export function invoiceNumber(order: Pick<OrderRow, 'invoice_year' | 'invoice_seq'>, prefix: string): string | null {
  if (order.invoice_year === null || order.invoice_seq === null) return null;
  return `${prefix}-${order.invoice_year}-${String(order.invoice_seq).padStart(5, '0')}`;
}
