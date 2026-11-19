// SPDX-License-Identifier: AGPL-3.0-or-later
// Statistiques du tableau de bord et des rapports.

import { dayKey } from '../lib/time';
import type { OrderChannel } from './types';

export interface DayPoint {
  day: string; // YYYY-MM-DD (fuseau de la salle)
  revenueCents: number;
  tickets: number;
  orders: number;
}

export interface EventStat {
  id: number;
  title: string;
  slug: string;
  starts_at: string;
  status: string;
  quota: number;
  sold: number;
  revenueCents: number;
  checkedIn: number;
}

export interface ChannelStat {
  channel: OrderChannel;
  orders: number;
  tickets: number;
  revenueCents: number;
}

export interface TypeStat {
  name: string;
  priceCents: number;
  quota: number;
  sold: number;
  revenueCents: number;
}

export interface Dashboard {
  revenueCents: number;
  ordersPaid: number;
  ticketsSold: number;
  avgBasketCents: number;
  refundedCents: number;
  refundedOrders: number;
  pendingOrders: number;
  byDay: DayPoint[];
  byChannel: ChannelStat[];
}

export interface DashboardOpts {
  sinceIso: string | null;
  eventId: number | null;
  tz: string;
  nowIso: string;
  /** Nombre de jours affichés dans la courbe quand sinceIso est null. */
  defaultDays?: number;
}

interface PaidRow {
  total_cents: number;
  paid_at: string;
  channel: OrderChannel;
  qty: number;
}

/** Ajoute n jours à une date "YYYY-MM-DD" (arithmétique de calendrier, sans fuseau). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function dashboard(db: D1Database, o: DashboardOpts): Promise<Dashboard> {
  const evClause = o.eventId ? 'AND o.event_id = ?3' : '';
  const binds: unknown[] = [o.sinceIso ?? '0000', '9999'];
  if (o.eventId) binds.push(o.eventId);

  const paid = await db
    .prepare(
      `SELECT o.total_cents, o.paid_at, o.channel,
              COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = o.id), 0) AS qty
       FROM orders o WHERE o.status = 'paid' AND o.paid_at >= ?1 AND o.paid_at < ?2 ${evClause}`,
    )
    .bind(...binds)
    .all<PaidRow>();
  const refunded = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(o.total_cents), 0) AS cents FROM orders o
       WHERE o.status = 'refunded' AND o.paid_at >= ?1 AND o.paid_at < ?2 ${evClause}`,
    )
    .bind(...binds)
    .first<{ n: number; cents: number }>();
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o WHERE o.status = 'pending' AND o.expires_at > ?1 ${o.eventId ? 'AND o.event_id = ?2' : ''}`,
    )
    .bind(...(o.eventId ? [o.nowIso, o.eventId] : [o.nowIso]))
    .first<{ n: number }>();

  const rows = paid.results;
  const revenue = rows.reduce((s, r) => s + r.total_cents, 0);
  const tickets = rows.reduce((s, r) => s + r.qty, 0);

  // Courbe par jour : on remplit aussi les jours sans vente.
  const today = dayKey(o.nowIso, o.tz);
  const days = o.defaultDays ?? 30;
  const first = o.sinceIso ? dayKey(o.sinceIso, o.tz) : addDays(today, -(days - 1));
  const series = new Map<string, DayPoint>();
  for (let d = first, i = 0; d <= today && i < 400; d = addDays(d, 1), i++) {
    series.set(d, { day: d, revenueCents: 0, tickets: 0, orders: 0 });
  }
  for (const r of rows) {
    const p = series.get(dayKey(r.paid_at, o.tz));
    if (!p) continue;
    p.revenueCents += r.total_cents;
    p.tickets += r.qty;
    p.orders += 1;
  }

  const ch = new Map<OrderChannel, ChannelStat>();
  for (const r of rows) {
    const c = ch.get(r.channel) ?? { channel: r.channel, orders: 0, tickets: 0, revenueCents: 0 };
    c.orders += 1;
    c.tickets += r.qty;
    c.revenueCents += r.total_cents;
    ch.set(r.channel, c);
  }

  return {
    revenueCents: revenue,
    ordersPaid: rows.length,
    ticketsSold: tickets,
    avgBasketCents: rows.length ? Math.round(revenue / rows.length) : 0,
    refundedCents: refunded?.cents ?? 0,
    refundedOrders: refunded?.n ?? 0,
    pendingOrders: pending?.n ?? 0,
    byDay: [...series.values()],
    byChannel: [...ch.values()].sort((a, b) => b.revenueCents - a.revenueCents),
  };
}

/** Une ligne par concert (à venir + récents) : remplissage, recettes, entrées. */
export async function eventStats(db: D1Database, sinceIso: string, eventId: number | null = null): Promise<EventStat[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.title, e.slug, e.starts_at, e.status,
        COALESCE((SELECT SUM(quota) FROM ticket_types WHERE event_id = e.id), 0) AS quota,
        COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.event_id = e.id AND o.status = 'paid'), 0) AS sold,
        COALESCE((SELECT SUM(o.total_cents) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid'), 0) AS revenueCents,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'valid' AND t.checked_in_at IS NOT NULL) AS checkedIn
       FROM events e WHERE e.starts_at >= ?1 ${eventId ? 'AND e.id = ?2' : ''} ORDER BY e.starts_at ASC`,
    )
    .bind(...(eventId ? [sinceIso, eventId] : [sinceIso]))
    .all<EventStat>();
  return results;
}

/** Détail par catégorie de billet pour un concert. */
export async function typeStats(db: D1Database, eventId: number): Promise<TypeStat[]> {
  const { results } = await db
    .prepare(
      `SELECT tt.name_fr AS name, tt.price_cents AS priceCents, tt.quota AS quota,
        COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.ticket_type_id = tt.id AND o.status = 'paid'), 0) AS sold,
        COALESCE((SELECT SUM(oi.qty * oi.unit_price_cents) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.ticket_type_id = tt.id AND o.status = 'paid'), 0) AS revenueCents
       FROM ticket_types tt WHERE tt.event_id = ?1 ORDER BY tt.sort, tt.id`,
    )
    .bind(eventId)
    .all<TypeStat>();
  return results;
}

export async function doorCount(db: D1Database, eventId: number): Promise<{ checkedIn: number; total: number }> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN checked_in_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS checkedIn
       FROM tickets WHERE event_id = ?1 AND status = 'valid'`,
    )
    .bind(eventId)
    .first<{ total: number; checkedIn: number }>();
  return { checkedIn: r?.checkedIn ?? 0, total: r?.total ?? 0 };
}
