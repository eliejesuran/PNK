// SPDX-License-Identifier: AGPL-3.0-or-later
// Événements, salles, catégories de billets et calcul de disponibilité.

import type { EventRow, EventWithVenue, TicketType, TicketTypeStock, Venue } from './types';

const EVENT_WITH_VENUE = `
  SELECT e.*, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city, v.capacity AS venue_capacity
  FROM events e JOIN venues v ON v.id = e.venue_id`;

/**
 * Fragment SQL : nombre de places "prises" pour une catégorie (payées + réservations non expirées).
 * Utilise le paramètre numéroté ?N pour l'instant courant.
 */
export function takenSql(typeIdExpr: string, nowParam: string, excludeOrderExpr = '-1'): string {
  return `COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.ticket_type_id = ${typeIdExpr} AND o.id != ${excludeOrderExpr}
      AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > ${nowParam}))), 0)`;
}

export async function getEventBySlug(db: D1Database, slug: string): Promise<EventWithVenue | null> {
  return db.prepare(`${EVENT_WITH_VENUE} WHERE e.slug = ?1`).bind(slug).first<EventWithVenue>();
}

export async function getEventById(db: D1Database, id: number): Promise<EventWithVenue | null> {
  return db.prepare(`${EVENT_WITH_VENUE} WHERE e.id = ?1`).bind(id).first<EventWithVenue>();
}

/** Concerts publiés à venir (ou en cours : jusqu'à 6 h après le début), plus proches d'abord. */
export async function listPublicEvents(db: D1Database, nowIso: string): Promise<EventWithVenue[]> {
  const cutoff = new Date(Date.parse(nowIso) - 6 * 3600_000).toISOString();
  const { results } = await db
    .prepare(`${EVENT_WITH_VENUE} WHERE e.status IN ('published', 'cancelled') AND e.starts_at >= ?1 ORDER BY e.starts_at ASC`)
    .bind(cutoff)
    .all<EventWithVenue>();
  return results;
}

/** Stock agrégé des concerts de l'accueil en UNE requête (évite une requête par concert). */
export async function homeAvailability(db: D1Database, nowIso: string): Promise<Map<number, { soldOut: boolean; minPriceCents: number | null }>> {
  const cutoff = new Date(Date.parse(nowIso) - 6 * 3600_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT tt.event_id, tt.price_cents, MAX(0, tt.quota - ${takenSql('tt.id', '?1')}) AS available
       FROM ticket_types tt
       WHERE tt.online = 1 AND tt.event_id IN (SELECT id FROM events WHERE status IN ('published', 'cancelled') AND starts_at >= ?2)`,
    )
    .bind(nowIso, cutoff)
    .all<{ event_id: number; price_cents: number; available: number }>();
  const out = new Map<number, { soldOut: boolean; minPriceCents: number | null; any: boolean }>();
  for (const r of results) {
    const e = out.get(r.event_id) ?? { soldOut: true, minPriceCents: null, any: false };
    e.any = true;
    if (r.available > 0) {
      e.soldOut = false;
      e.minPriceCents = e.minPriceCents === null ? r.price_cents : Math.min(e.minPriceCents, r.price_cents);
    }
    out.set(r.event_id, e);
  }
  return new Map([...out].map(([k, v]) => [k, { soldOut: v.any && v.soldOut, minPriceCents: v.minPriceCents }]));
}

export async function listAllEvents(db: D1Database): Promise<EventWithVenue[]> {
  const { results } = await db.prepare(`${EVENT_WITH_VENUE} ORDER BY e.starts_at DESC`).all<EventWithVenue>();
  return results;
}

export async function ticketTypesWithStock(db: D1Database, eventId: number, nowIso: string): Promise<TicketTypeStock[]> {
  const { results } = await db
    .prepare(
      `SELECT tt.*,
        COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.ticket_type_id = tt.id AND o.status = 'paid'), 0) AS sold,
        COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.ticket_type_id = tt.id AND o.status = 'pending' AND o.expires_at > ?2), 0) AS held
       FROM ticket_types tt WHERE tt.event_id = ?1 ORDER BY tt.sort, tt.id`,
    )
    .bind(eventId, nowIso)
    .all<TicketType & { sold: number; held: number }>();
  return results.map((r) => ({ ...r, available: Math.max(0, r.quota - r.sold - r.held) }));
}

export async function listVenues(db: D1Database, includeArchived = false): Promise<Venue[]> {
  const { results } = await db
    .prepare(`SELECT * FROM venues ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`)
    .all<Venue>();
  return results;
}

export async function getVenue(db: D1Database, id: number): Promise<Venue | null> {
  return db.prepare('SELECT * FROM venues WHERE id = ?1').bind(id).first<Venue>();
}

export async function getTicketType(db: D1Database, id: number): Promise<TicketType | null> {
  return db.prepare('SELECT * FROM ticket_types WHERE id = ?1').bind(id).first<TicketType>();
}

/** Les ventes en ligne sont-elles ouvertes maintenant ? Renvoie la raison sinon. */
export function salesState(
  e: Pick<EventRow, 'status' | 'starts_at' | 'sales_open_at' | 'sales_close_at'>,
  nowIso: string,
): 'open' | 'cancelled' | 'draft' | 'not_open' | 'closed' | 'past' {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.status !== 'published') return 'draft';
  if (e.sales_open_at && nowIso < e.sales_open_at) return 'not_open';
  const closes = e.sales_close_at ?? e.starts_at;
  if (nowIso >= closes) return nowIso >= e.starts_at ? 'past' : 'closed';
  return 'open';
}

export function eventPath(slug: string): string {
  return `/e/${encodeURIComponent(slug)}`;
}

/** Trouve un slug libre : base, base-2, base-3, … */
export async function uniqueSlug(db: D1Database, base: string, exceptEventId?: number): Promise<string> {
  const root = base || 'concert';
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const row = await db
      .prepare('SELECT id FROM events WHERE slug = ?1 AND id != ?2')
      .bind(candidate, exceptEventId ?? -1)
      .first();
    if (!row) return candidate;
  }
  return `${root}-${Date.now()}`;
}
