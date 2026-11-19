// SPDX-License-Identifier: AGPL-3.0-or-later
// Cœur métier : réservation de places, paiement, émission des billets, remboursement.
//
// Garanties :
//  * Jamais de survente : chaque réservation est un INSERT ... SELECT conditionnel (une seule instruction SQL,
//    sérialisée par D1) qui vérifie quota - (payé + réservé non expiré) >= quantité demandée.
//  * Un paiement n'émet les billets qu'une fois (UPDATE ... WHERE status = 'pending' + garde sur le nombre de billets).
//  * Numérotation des factures sans trou ni doublon, calculée dans l'UPDATE lui-même (+ index UNIQUE).
//  * Un paiement reçu après expiration de la réservation tente de re-réserver ; sinon remboursement automatique.

import type { Env, Lang } from '../env';
import { newOrderToken, newTicketCode } from '../lib/ids';
import { addMinutesIso, dayKey, nowIso } from '../lib/time';
import { audit } from './audit';
import { refundEmail, ticketsEmail } from './emails';
import { getEventById, takenSql } from './events';
import { deliver, queueMail } from './mail';
import { getProvider, providerFor, type CheckoutLine } from './payments';
import { getSettings, type Settings } from './settings';
import type {
  EventRow,
  OrderChannel,
  OrderItemNamed,
  OrderRow,
  PaymentMethod,
  TicketType,
  TicketWithType,
} from './types';
import { typeName } from './types';

/** Durée de garde des places pendant le paiement. Doit rester > durée de vie de la session Stripe (31 min). */
export const HOLD_MINUTES = 32;
const STRIPE_SESSION_MINUTES = 31; // Stripe impose ≥ 30 min
export const MAX_STAFF_ORDER_QTY = 100;

export interface Waiter {
  waitUntil(p: Promise<unknown>): void;
}

export interface CartLine {
  ticketTypeId: number;
  qty: number;
}

export interface NewOrderInput {
  event: EventRow;
  settings: Settings;
  /** Toutes les catégories de l'événement. */
  types: TicketType[];
  lines: CartLine[];
  email: string;
  name: string;
  lang: Lang;
  billing?: { name: string; vat: string; address: string };
  channel?: OrderChannel;
  paymentMethod?: PaymentMethod;
  createdBy?: string | null;
  ipHash?: string | null;
  now?: Date;
}

export type NewOrderResult =
  | { ok: true; order: OrderRow; items: { type: TicketType; qty: number; unitCents: number }[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'soldout' | 'invalid'; typeName?: string; max?: number };

/** Réserve les places et crée la commande (statut "pending"). Ne touche pas au paiement. */
export async function createOrder(db: D1Database, input: NewOrderInput): Promise<NewOrderResult> {
  const channel = input.channel ?? 'online';
  const now = input.now ?? new Date();
  const staff = channel !== 'online';

  // Fusionne les lignes par catégorie et valide.
  const merged = new Map<number, number>();
  for (const l of input.lines) {
    if (!Number.isInteger(l.ticketTypeId) || !Number.isInteger(l.qty) || l.qty < 0) return { ok: false, reason: 'invalid' };
    if (l.qty > 0) merged.set(l.ticketTypeId, (merged.get(l.ticketTypeId) ?? 0) + l.qty);
  }
  if (merged.size === 0) return { ok: false, reason: 'empty' };

  const items: { type: TicketType; qty: number; unitCents: number }[] = [];
  let totalQty = 0;
  for (const [id, qty] of merged) {
    const type = input.types.find((x) => x.id === id && x.event_id === input.event.id);
    if (!type || (!staff && !type.online)) return { ok: false, reason: 'invalid' };
    items.push({ type, qty, unitCents: channel === 'guest' ? 0 : type.price_cents });
    totalQty += qty;
  }
  const maxQty = staff ? MAX_STAFF_ORDER_QTY : input.event.max_per_order;
  if (totalQty > maxQty) return { ok: false, reason: 'too_many', max: maxQty };

  const total = items.reduce((s, i) => s + i.qty * i.unitCents, 0);
  const vatBp = input.event.vat_rate_bp ?? input.settings.default_vat_bp;
  const method: PaymentMethod = input.paymentMethod ?? (total === 0 ? 'free' : 'online');
  const holdMinutes = staff ? 5 : HOLD_MINUTES;
  const nowStr = nowIso(now);
  const token = newOrderToken();

  const ins = await db
    .prepare(
      `INSERT INTO orders (token, event_id, status, channel, payment_method, email, name, lang,
         billing_name, billing_vat, billing_address, total_cents, vat_rate_bp, currency, created_by, ip_hash, expires_at, created_at)
       VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    )
    .bind(
      token,
      input.event.id,
      channel,
      method,
      input.email,
      input.name,
      input.lang,
      input.billing?.name ?? '',
      input.billing?.vat ?? '',
      input.billing?.address ?? '',
      total,
      vatBp,
      input.settings.currency,
      input.createdBy ?? null,
      input.ipHash ?? null,
      addMinutesIso(nowStr, holdMinutes),
      nowStr,
    )
    .run();
  const orderId = Number(ins.meta.last_row_id);

  // Réservation atomique de chaque ligne : n'insère que s'il reste assez de places.
  const holdSql = `INSERT INTO order_items (order_id, ticket_type_id, qty, unit_price_cents)
    SELECT ?1, tt.id, ?3, ?4 FROM ticket_types tt
    WHERE tt.id = ?2 AND tt.event_id = ?5 AND tt.price_cents = ?6
      AND tt.quota - ${takenSql('tt.id', '?7', '?1')} >= ?3`;
  const results = await db.batch(
    items.map((i) => db.prepare(holdSql).bind(orderId, i.type.id, i.qty, i.unitCents, input.event.id, i.type.price_cents, nowStr)),
  );
  const failed = results.findIndex((r) => r.meta.changes !== 1);
  if (failed !== -1) {
    await db.batch([
      db.prepare('DELETE FROM order_items WHERE order_id = ?1').bind(orderId),
      db.prepare("DELETE FROM orders WHERE id = ?1 AND status = 'pending'").bind(orderId),
    ]);
    return { ok: false, reason: 'soldout', typeName: typeName(items[failed]!.type, input.lang) };
  }

  const order = await getOrderById(db, orderId);
  if (!order) throw new Error('order vanished after insert');
  return { ok: true, order, items };
}

// ---------- Lecture ----------

export async function getOrderById(db: D1Database, id: number): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first<OrderRow>();
}

export async function getOrderByToken(db: D1Database, token: string): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE token = ?1').bind(token).first<OrderRow>();
}

export async function getOrderItems(db: D1Database, orderId: number): Promise<OrderItemNamed[]> {
  const { results } = await db
    .prepare(
      `SELECT oi.*, tt.name_fr, tt.name_en, tt.name_nl FROM order_items oi
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ?1 ORDER BY tt.sort, tt.id`,
    )
    .bind(orderId)
    .all<OrderItemNamed>();
  return results;
}

export async function getOrderTickets(db: D1Database, orderId: number): Promise<TicketWithType[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*, tt.name_fr, tt.name_en, tt.name_nl FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = ?1 ORDER BY tt.sort, t.id`,
    )
    .bind(orderId)
    .all<TicketWithType>();
  return results;
}

// ---------- Paiement ----------

export type CheckoutResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'paid'; order: OrderRow }
  | { kind: 'unavailable' };

/** Lance le paiement d'une commande "pending" : redirection vers le fournisseur, ou validation directe si gratuit. */
export async function startCheckout(
  env: Env,
  order: OrderRow,
  event: EventRow,
  items: { type: TicketType; qty: number; unitCents: number }[],
  baseUrl: string,
  waiter?: Waiter,
): Promise<CheckoutResult> {
  if (order.total_cents === 0) {
    const r = await fulfillOrder(env, order.id, { baseUrl, waiter });
    return r.kind === 'paid' || r.kind === 'already' ? { kind: 'paid', order: r.order } : { kind: 'unavailable' };
  }
  const provider = getProvider(env);
  if (!provider) {
    await cancelOrder(env, order, 'cancelled');
    return { kind: 'unavailable' };
  }
  const lines: CheckoutLine[] = items.map((i) => ({
    name: `${event.title} — ${typeName(i.type, order.lang)}`.slice(0, 250),
    qty: i.qty,
    unitCents: i.unitCents,
  }));
  try {
    const session = await provider.createCheckout({
      orderId: order.id,
      token: order.token,
      email: order.email,
      lang: order.lang,
      lines,
      currency: order.currency,
      baseUrl,
      expiresAtUnix: Math.floor(Date.parse(addMinutesIso(order.created_at, STRIPE_SESSION_MINUTES)) / 1000),
      description: `PNK #${order.id} — ${event.title}`.slice(0, 250),
    });
    await env.DB.prepare('UPDATE orders SET provider = ?2, provider_session_id = ?3, checkout_url = ?4 WHERE id = ?1')
      .bind(order.id, provider.name, session.sessionId, session.url)
      .run();
    return { kind: 'redirect', url: session.url };
  } catch (e) {
    console.error('createCheckout failed', order.id, e instanceof Error ? e.message : e);
    await cancelOrder(env, order, 'cancelled');
    return { kind: 'unavailable' };
  }
}

/** Libère les places d'une commande en attente (annulation par l'acheteur, ou échec technique). */
export async function cancelOrder(env: Env, order: OrderRow, status: 'cancelled' | 'expired'): Promise<void> {
  const r = await env.DB.prepare("UPDATE orders SET status = ?2 WHERE id = ?1 AND status = 'pending'")
    .bind(order.id, status)
    .run();
  if (r.meta.changes === 1 && order.provider_session_id) {
    const p = providerFor(env, order.provider);
    if (p) await p.expireSession(order.provider_session_id).catch((e) => console.error('expireSession failed', e));
  }
}

export type FulfillResult =
  | { kind: 'paid'; order: OrderRow; justPaid: boolean }
  | { kind: 'already'; order: OrderRow }
  | { kind: 'refunded'; order: OrderRow } // payé trop tard, plus de place : remboursé automatiquement
  | { kind: 'missing' };

export interface FulfillOpts {
  baseUrl: string;
  providerPaymentId?: string | null;
  waiter?: Waiter;
  now?: Date;
}

/**
 * Marque la commande payée et émet les billets. Idempotent : peut être appelé par le webhook ET par la page
 * de retour en parallèle sans doublon.
 */
export async function fulfillOrder(env: Env, orderId: number, opts: FulfillOpts): Promise<FulfillResult> {
  const db = env.DB;
  const now = opts.now ?? new Date();
  const nowStr = nowIso(now);
  let order = await getOrderById(db, orderId);
  if (!order) return { kind: 'missing' };
  if (order.status === 'paid' || order.status === 'refunded') return { kind: 'already', order };

  // Réservation perdue (expirée/annulée) ? On tente de la reprendre si les places sont encore libres.
  const lapsed = order.status === 'expired' || order.status === 'cancelled' || (order.expires_at !== null && order.expires_at <= nowStr);
  if (lapsed) {
    const re = await db
      .prepare(
        `UPDATE orders SET status = 'pending', expires_at = ?2
         WHERE id = ?1 AND (status IN ('expired', 'cancelled') OR (status = 'pending' AND expires_at <= ?3))
           AND NOT EXISTS (
             SELECT 1 FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id
             WHERE oi.order_id = ?1 AND tt.quota - ${takenSql('tt.id', '?3', '?1')} < oi.qty)`,
      )
      .bind(orderId, addMinutesIso(nowStr, 5), nowStr)
      .run();
    if (re.meta.changes !== 1) {
      // Plus assez de places : on rembourse et on prévient.
      const paymentId = opts.providerPaymentId ?? order.provider_payment_id;
      if (paymentId && order.provider !== 'none') {
        const provider = providerFor(env, order.provider);
        if (!provider) throw new Error(`fournisseur ${order.provider} indisponible : remboursement impossible (commande ${orderId})`);
        await provider.refund(paymentId, `pnk-oversold-${orderId}`);
      }
      await db
        .prepare("UPDATE orders SET status = 'refunded', refunded_at = ?2, provider_payment_id = COALESCE(?3, provider_payment_id) WHERE id = ?1 AND status != 'paid'")
        .bind(orderId, nowStr, paymentId ?? null)
        .run();
      order = (await getOrderById(db, orderId))!;
      await notifyRefund(env, order, 'oversold', opts);
      await audit(db, 'system', 'order.auto_refund_oversold', 'order', orderId);
      return { kind: 'refunded', order };
    }
  }

  const settings = await getSettings(db);
  const year = Number(dayKey(nowStr, settings.timezone).slice(0, 4));
  const { results: items } = await db
    .prepare('SELECT ticket_type_id, qty FROM order_items WHERE order_id = ?1')
    .bind(orderId)
    .all<{ ticket_type_id: number; qty: number }>();

  const ticketSql = `INSERT INTO tickets (code, order_id, event_id, ticket_type_id)
    SELECT ?1, ?2, ?3, ?4
    WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND status = 'paid' AND paid_at = ?5)
      AND (SELECT COUNT(*) FROM tickets WHERE order_id = ?2) < (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = ?2)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE orders SET status = 'paid', paid_at = ?2,
           provider_payment_id = COALESCE(?3, provider_payment_id),
           invoice_year = CASE WHEN total_cents > 0 THEN ?4 END,
           invoice_seq = CASE WHEN total_cents > 0
             THEN (SELECT COALESCE(MAX(invoice_seq), 0) + 1 FROM orders WHERE invoice_year = ?4) END
         WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(orderId, nowStr, opts.providerPaymentId ?? null, year),
  ];
  for (const it of items) {
    for (let n = 0; n < it.qty; n++) {
      stmts.push(db.prepare(ticketSql).bind(newTicketCode(), orderId, order.event_id, it.ticket_type_id, nowStr));
    }
  }
  const res = await db.batch(stmts);
  const justPaid = res[0]!.meta.changes === 1;
  order = (await getOrderById(db, orderId))!;
  if (order.status !== 'paid') {
    // Statut inattendu (ex. remboursé entre-temps) : on ne touche à rien.
    return { kind: 'already', order };
  }
  if (justPaid) await notifyPaid(env, order, opts);
  return { kind: 'paid', order, justPaid };
}

async function notifyPaid(env: Env, order: OrderRow, opts: { baseUrl: string; waiter?: Waiter }): Promise<void> {
  if (!order.email) return;
  try {
    const [event, tickets, settings] = await Promise.all([
      getEventById(env.DB, order.event_id),
      getOrderTickets(env.DB, order.id),
      getSettings(env.DB),
    ]);
    if (!event) return;
    const mail = ticketsEmail({
      order,
      event,
      tickets,
      orgName: settings.org_name,
      timezone: settings.timezone,
      baseUrl: opts.baseUrl,
      hasInvoice: order.invoice_seq !== null,
    });
    const id = await queueMail(env.DB, { to: order.email, orderId: order.id, ...mail });
    const p = deliver(env, id);
    if (opts.waiter) opts.waiter.waitUntil(p);
    else await p;
  } catch (e) {
    // La commande est payée et les billets existent : un souci d'email ne doit jamais faire échouer ça.
    console.error('notifyPaid failed', order.id, e);
  }
}

async function notifyRefund(env: Env, order: OrderRow, reason: 'refund' | 'oversold', opts: { waiter?: Waiter }): Promise<void> {
  if (!order.email) return;
  try {
    const [event, settings] = await Promise.all([getEventById(env.DB, order.event_id), getSettings(env.DB)]);
    if (!event) return;
    const mail = refundEmail({ order, event, orgName: settings.org_name, reason });
    const id = await queueMail(env.DB, { to: order.email, orderId: order.id, ...mail });
    const p = deliver(env, id);
    if (opts.waiter) opts.waiter.waitUntil(p);
    else await p;
  } catch (e) {
    console.error('notifyRefund failed', order.id, e);
  }
}

/** Renvoie l'email de confirmation (billets + facture) à l'adresse de la commande. */
export async function resendTicketsEmail(env: Env, order: OrderRow, baseUrl: string): Promise<boolean> {
  if (order.status !== 'paid' || !order.email) return false;
  await notifyPaid(env, order, { baseUrl });
  return true;
}

export type RefundResult = { ok: true; warnCheckedIn: number } | { ok: false; error: string };

/** Rembourse une commande payée (via le fournisseur si paiement en ligne) et invalide ses billets. */
export async function refundOrder(env: Env, order: OrderRow, actor: string, opts: { waiter?: Waiter } = {}): Promise<RefundResult> {
  if (order.status !== 'paid') return { ok: false, error: 'Seule une commande payée peut être remboursée.' };
  if (order.total_cents > 0 && order.provider !== 'none' && order.payment_method === 'online') {
    if (!order.provider_payment_id) return { ok: false, error: 'Référence de paiement introuvable : rembourse depuis le tableau de bord du fournisseur.' };
    const provider = providerFor(env, order.provider);
    if (!provider) return { ok: false, error: 'Fournisseur de paiement non configuré.' };
    try {
      await provider.refund(order.provider_payment_id, `pnk-refund-${order.id}`);
    } catch (e) {
      return { ok: false, error: `Le fournisseur a refusé le remboursement : ${e instanceof Error ? e.message : e}` };
    }
  }
  const nowStr = nowIso();
  const checked = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1 AND checked_in_at IS NOT NULL')
    .bind(order.id)
    .first<{ n: number }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = 'refunded', refunded_at = ?2 WHERE id = ?1 AND status = 'paid'").bind(order.id, nowStr),
    env.DB.prepare("UPDATE tickets SET status = 'void' WHERE order_id = ?1").bind(order.id),
  ]);
  await audit(env.DB, actor, 'order.refund', 'order', order.id, { total_cents: order.total_cents });
  const fresh = (await getOrderById(env.DB, order.id))!;
  await notifyRefund(env, fresh, 'refund', opts);
  return { ok: true, warnCheckedIn: checked?.n ?? 0 };
}

/** Passe en "expired" les réservations dont le délai est dépassé. Renvoie le nombre libéré. */
export async function expireStaleOrders(db: D1Database, nowStr: string): Promise<number> {
  const r = await db
    .prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?1")
    .bind(nowStr)
    .run();
  return r.meta.changes;
}

// ---------- Anti-abus ----------

/** Compteur par fenêtre de temps. Renvoie true si la limite est dépassée. */
export async function rateLimited(db: D1Database, key: string, limit: number, windowSec: number, nowMs = Date.now()): Promise<boolean> {
  const win = Math.floor(nowMs / 1000 / windowSec);
  const row = await db
    .prepare(
      'INSERT INTO rate_limits (key, window, count) VALUES (?1, ?2, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(key, win)
    .first<{ count: number }>();
  return (row?.count ?? 1) > limit;
}

export async function purgeOldRateLimits(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - 2 * 86400_000).toISOString();
  await db.prepare('DELETE FROM rate_limits WHERE at < ?1').bind(cutoff).run();
}
