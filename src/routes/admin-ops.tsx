// SPDX-License-Identifier: AGPL-3.0-or-later
// Back-office (2/2) : commandes, caisse / invités, rapports et exports, réglages, équipe, journal, scanner.

import { Hono } from 'hono';
import type { AppEnv, Role } from '../env';
import { hasRole } from '../lib/auth';
import { formatTicketCode, normalizeTicketCode } from '../lib/ids';
import { formatRate, parseRatePercentToBp } from '../lib/money';
import { baseUrlOf } from '../lib/security';
import { clean, cleanHttpUrl, cleanMultiline, isEmail, toCsv } from '../lib/text';
import { isValidTimeZone } from '../lib/time';
import { audit } from '../services/audit';
import { getEventById, listAllEvents, ticketTypesWithStock } from '../services/events';
import {
  createOrder,
  fulfillOrder,
  getOrderById,
  getOrderItems,
  getOrderTickets,
  refundOrder,
  resendTicketsEmail,
} from '../services/orders';
import { getSettings, saveSettings, type Settings } from '../services/settings';
import { dashboard, doorCount, typeStats } from '../services/stats';
import type { OrderRow } from '../services/types';
import { DoorView, OrderDetailView, OrdersView, ReportsView } from '../views/admin';
import { AuditView, ScanView, SettingsView, StaffView } from '../views/admin2';
import { adminCtx, back } from './admin';

export const opsRoutes = new Hono<AppEnv>();

type Body = Record<string, string | File | (string | File)[]>;
const str = (b: Body, k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');
const ROLES: Role[] = ['owner', 'manager', 'scanner'];

const eventOptions = async (db: D1Database) => (await listAllEvents(db)).map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at }));

// ---------- Commandes ----------

opsRoutes.get('/admin/orders', async (c) => {
  const db = c.env.DB;
  const q = clean(c.req.query('q') ?? '', 100);
  const status = ['paid', 'pending', 'expired', 'cancelled', 'refunded'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : '';
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const page = Math.max(1, Math.min(10000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push('o.status = ?');
    binds.push(status);
  }
  if (eventId) {
    where.push('o.event_id = ?');
    binds.push(eventId);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const idMatch = /^#?(\d{1,9})$/.exec(q);
    const code = normalizeTicketCode(q);
    const parts = ["o.email LIKE ? ESCAPE '\\'", "o.name LIKE ? ESCAPE '\\'", "o.billing_name LIKE ? ESCAPE '\\'"];
    binds.push(like, like, like);
    if (idMatch) {
      parts.push('o.id = ?');
      binds.push(Number(idMatch[1]));
    }
    if (code) {
      parts.push('EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.code = ?)');
      binds.push(code);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const rows = await db
    .prepare(
      `SELECT o.*, e.title AS event_title FROM orders o JOIN events e ON e.id = o.event_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 51 OFFSET ?`,
    )
    .bind(...binds, (page - 1) * 50)
    .all<OrderRow & { event_title: string }>();
  return c.html(
    <OrdersView
      a={adminCtx(c)}
      orders={rows.results.slice(0, 50)}
      q={q}
      status={status}
      eventId={eventId}
      eventOptions={await eventOptions(db)}
      page={page}
      hasMore={rows.results.length > 50}
    />,
  );
});

opsRoutes.get('/admin/orders/:id', async (c) => {
  const db = c.env.DB;
  const id = Number.parseInt(c.req.param('id'), 10);
  const order = Number.isInteger(id) ? await getOrderById(db, id) : null;
  if (!order) return c.notFound();
  const event = await getEventById(db, order.event_id);
  if (!event) return c.notFound();
  const [items, tickets] = await Promise.all([getOrderItems(db, id), getOrderTickets(db, id)]);
  return c.html(<OrderDetailView a={adminCtx(c)} order={order} event={event} items={items} tickets={tickets} invoicePrefix={c.get('settings').invoice_prefix} />);
});

opsRoutes.post('/admin/orders/:id/resend', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const order = Number.isInteger(id) ? await getOrderById(c.env.DB, id) : null;
  if (!order) return c.notFound();
  const ok = await resendTicketsEmail(c.env, order, baseUrlOf(c.env, c.req.raw));
  if (ok) await audit(c.env.DB, c.get('staff')!.email, 'order.resend', 'order', id);
  return back(c, `/admin/orders/${id}`, ok ? 'ok' : 'err', ok ? `Email renvoyé à ${order.email}.` : 'Rien à renvoyer (commande non payée ou sans email).');
});

opsRoutes.post('/admin/orders/:id/refund', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const order = Number.isInteger(id) ? await getOrderById(c.env.DB, id) : null;
  if (!order) return c.notFound();
  const r = await refundOrder(c.env, order, c.get('staff')!.email, { waiter: c.executionCtx });
  if (!r.ok) return back(c, `/admin/orders/${id}`, 'err', r.error);
  const extra = r.warnCheckedIn ? ` Attention : ${r.warnCheckedIn} billet(s) étaient déjà entrés.` : '';
  return back(c, `/admin/orders/${id}`, 'ok', `Commande remboursée, billets invalidés.${extra}`);
});

// ---------- Caisse / invités ----------

opsRoutes.get('/admin/door', async (c) => {
  const db = c.env.DB;
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 12 * 3600_000).toISOString();
  const { results: events } = await db
    .prepare("SELECT id, title, starts_at FROM events WHERE status = 'published' AND starts_at >= ?1 ORDER BY starts_at")
    .bind(cutoff)
    .all<{ id: number; title: string; starts_at: string }>();
  const types = (await Promise.all(events.map(async (e) => (await ticketTypesWithStock(db, e.id, now)).map((t) => ({ ...t, event_title: e.title }))))).flat();
  return c.html(<DoorView a={adminCtx(c)} events={events} types={types} errors={[]} />);
});

opsRoutes.post('/admin/door', async (c) => {
  const env = c.env;
  const db = env.DB;
  const settings = c.get('settings');
  const staff = c.get('staff')!;
  const body = (await c.req.parseBody()) as Body;
  const typeId = Number.parseInt(str(body, 'type_id'), 10);
  const qty = Number.parseInt(str(body, 'qty'), 10);
  const mode = str(body, 'mode');
  const name = clean(str(body, 'name'), 120);
  const email = clean(str(body, 'email'), 254).toLowerCase();

  const fail = async (msg: string, status: 400 | 409 = 400) => {
    const now = new Date().toISOString();
    const { results: events } = await db
      .prepare("SELECT id, title, starts_at FROM events WHERE status = 'published' AND starts_at >= ?1 ORDER BY starts_at")
      .bind(new Date(Date.now() - 12 * 3600_000).toISOString())
      .all<{ id: number; title: string; starts_at: string }>();
    const types = (await Promise.all(events.map(async (e) => (await ticketTypesWithStock(db, e.id, now)).map((t) => ({ ...t, event_title: e.title }))))).flat();
    return c.html(<DoorView a={adminCtx(c)} events={events} types={types} errors={[msg]} />, status);
  };

  if (!['cash', 'terminal', 'guest'].includes(mode)) return fail('Mode invalide.');
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) return fail('Quantité invalide (1 à 100).');
  if (email && !isEmail(email)) return fail('Email invalide.');
  const tt = Number.isInteger(typeId) ? await db.prepare('SELECT event_id FROM ticket_types WHERE id = ?1').bind(typeId).first<{ event_id: number }>() : null;
  if (!tt) return fail('Catégorie introuvable.');
  const event = await getEventById(db, tt.event_id);
  if (!event || event.status !== 'published') return fail('Ce concert n’est pas publié.');
  const types = await db.prepare('SELECT * FROM ticket_types WHERE event_id = ?1').bind(event.id).all();

  const res = await createOrder(db, {
    event,
    settings,
    types: types.results as never,
    lines: [{ ticketTypeId: typeId, qty }],
    email,
    name,
    lang: settings.default_lang,
    channel: mode === 'guest' ? 'guest' : 'door',
    paymentMethod: mode === 'guest' ? 'free' : (mode as 'cash' | 'terminal'),
    createdBy: staff.email,
  });
  if (!res.ok) {
    if (res.reason === 'soldout') return fail(`Plus assez de places pour « ${res.typeName} ».`, 409);
    return fail('Commande impossible.');
  }
  const out = await fulfillOrder(env, res.order.id, { baseUrl: baseUrlOf(env, c.req.raw), waiter: c.executionCtx });
  if (out.kind !== 'paid' && out.kind !== 'already') return fail('Les billets n’ont pas pu être émis.');
  await audit(db, staff.email, mode === 'guest' ? 'guest.issue' : 'door.sale', 'order', res.order.id, { qty, mode, event: event.id });
  return c.redirect(`/o/${res.order.token}?print=1`, 303);
});

// ---------- Rapports et exports ----------

opsRoutes.get('/admin/reports', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const now = new Date();
  const d = await dashboard(db, { sinceIso: new Date(now.getTime() - 30 * 86400_000).toISOString(), eventId, tz: s.timezone, nowIso: now.toISOString(), defaultDays: 30 });
  return c.html(<ReportsView a={adminCtx(c)} d={d} types={eventId ? await typeStats(db, eventId) : []} eventId={eventId} eventOptions={await eventOptions(db)} />);
});

const money = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

function csvResponse(name: string, rows: unknown[][]): Response {
  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

opsRoutes.get('/admin/export/orders.csv', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const { results } = await db
    .prepare(
      `SELECT o.*, e.title AS event_title, COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = o.id), 0) AS qty
       FROM orders o JOIN events e ON e.id = o.event_id ${eventId ? 'WHERE o.event_id = ?1' : ''} ORDER BY o.id`,
    )
    .bind(...(eventId ? [eventId] : []))
    .all<OrderRow & { event_title: string; qty: number }>();
  await audit(db, c.get('staff')!.email, 'export.orders', 'event', eventId ?? 'all', { rows: results.length });
  return csvResponse('commandes', [
    ['Commande', 'Concert', 'Statut', 'Canal', 'Paiement', 'Créée (UTC)', 'Payée (UTC)', 'Nom', 'Email', 'Billets', 'Total TTC', 'TVA %', 'Facture', 'Société', 'N° TVA client'],
    ...results.map((o) => [
      o.id, o.event_title, o.status, o.channel, o.payment_method, o.created_at, o.paid_at ?? '', o.name, o.email, o.qty, money(o.total_cents),
      formatRate(o.vat_rate_bp), o.invoice_seq !== null ? `${s.invoice_prefix}-${o.invoice_year}-${String(o.invoice_seq).padStart(5, '0')}` : '', o.billing_name, o.billing_vat,
    ]),
  ]);
});

opsRoutes.get('/admin/export/attendees.csv', async (c) => {
  const db = c.env.DB;
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const { results } = await db
    .prepare(
      `SELECT t.code, e.title, tt.name_fr AS type, o.name, o.email, t.status, t.checked_in_at, o.id AS order_id, o.status AS order_status
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
       ${eventId ? 'WHERE t.event_id = ?1' : ''} ORDER BY e.starts_at, o.name, t.id`,
    )
    .bind(...(eventId ? [eventId] : []))
    .all<{ code: string; title: string; type: string; name: string; email: string; status: string; checked_in_at: string | null; order_id: number; order_status: string }>();
  await audit(db, c.get('staff')!.email, 'export.attendees', 'event', eventId ?? 'all', { rows: results.length });
  return csvResponse('billets', [
    ['Code', 'Concert', 'Catégorie', 'Nom', 'Email', 'État du billet', 'Entré le (UTC)', 'Commande', 'Statut commande'],
    ...results.map((r) => [formatTicketCode(r.code), r.title, r.type, r.name, r.email, r.status, r.checked_in_at ?? '', r.order_id, r.order_status]),
  ]);
});

opsRoutes.get('/admin/export/sales.csv', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const d = await dashboard(db, { sinceIso: null, eventId, tz: s.timezone, nowIso: new Date().toISOString(), defaultDays: 365 });
  await audit(db, c.get('staff')!.email, 'export.sales', 'event', eventId ?? 'all');
  return csvResponse('ventes-par-jour', [['Jour', 'Commandes', 'Billets', 'Recettes TTC'], ...d.byDay.map((p) => [p.day, p.orders, p.tickets, money(p.revenueCents)])]);
});

// ---------- Réglages (propriétaire) ----------

opsRoutes.get('/admin/settings', async (c) => {
  const s = c.get('settings');
  return c.html(<SettingsView a={adminCtx(c)} s={s} vatPercent={String(s.default_vat_bp / 100)} errors={[]} />);
});

opsRoutes.post('/admin/settings', async (c) => {
  const db = c.env.DB;
  const b = (await c.req.parseBody()) as Body;
  const errors: string[] = [];
  const current = c.get('settings');

  const orgName = clean(str(b, 'org_name'), 80);
  if (!orgName) errors.push('Le nom affiché est obligatoire.');
  const email = clean(str(b, 'org_email'), 254).toLowerCase();
  if (email && !isEmail(email)) errors.push('Email de contact invalide.');
  const vat = parseRatePercentToBp(str(b, 'default_vat'));
  if (vat === null) errors.push('TVA par défaut invalide (0 à 30).');
  const tz = clean(str(b, 'timezone'), 60);
  if (!isValidTimeZone(tz)) errors.push('Fuseau horaire inconnu (ex. Europe/Brussels).');
  const lang = str(b, 'default_lang');
  if (!['fr', 'en', 'nl'].includes(lang)) errors.push('Langue invalide.');
  const prefix = clean(str(b, 'invoice_prefix'), 10).replace(/[^A-Za-z0-9]/g, '');
  if (!prefix) errors.push('Le préfixe de facture doit contenir des lettres ou chiffres.');
  const website = cleanHttpUrl(str(b, 'org_website'));
  if (str(b, 'org_website').trim() && !website) errors.push('Site web : l’URL doit commencer par https://');
  const terms = cleanHttpUrl(str(b, 'terms_url'));
  if (str(b, 'terms_url').trim() && !terms) errors.push('Conditions de vente : l’URL doit commencer par https://');

  const draft: Settings = {
    ...current,
    org_name: orgName,
    org_legal_name: clean(str(b, 'org_legal_name'), 120),
    org_address: cleanMultiline(str(b, 'org_address'), 300),
    org_company_number: clean(str(b, 'org_company_number'), 40),
    org_vat_number: clean(str(b, 'org_vat_number'), 40),
    org_email: email,
    org_phone: clean(str(b, 'org_phone'), 40),
    org_website: website,
    timezone: tz,
    default_vat_bp: vat ?? current.default_vat_bp,
    default_lang: (['fr', 'en', 'nl'].includes(lang) ? lang : current.default_lang) as Settings['default_lang'],
    invoice_prefix: prefix || current.invoice_prefix,
    invoice_footer: cleanMultiline(str(b, 'invoice_footer'), 600),
    terms_url: terms,
  };
  if (errors.length) return c.html(<SettingsView a={adminCtx(c)} s={draft} vatPercent={str(b, 'default_vat')} errors={errors} />, 400);

  await saveSettings(db, {
    org_name: draft.org_name,
    org_legal_name: draft.org_legal_name,
    org_address: draft.org_address,
    org_company_number: draft.org_company_number,
    org_vat_number: draft.org_vat_number,
    org_email: draft.org_email,
    org_phone: draft.org_phone,
    org_website: draft.org_website,
    timezone: draft.timezone,
    default_vat_bp: String(draft.default_vat_bp),
    default_lang: draft.default_lang,
    invoice_prefix: draft.invoice_prefix,
    invoice_footer: draft.invoice_footer,
    terms_url: draft.terms_url,
  });
  const changed = (Object.keys(draft) as (keyof Settings)[]).filter((k) => String(draft[k]) !== String(current[k]));
  await audit(db, c.get('staff')!.email, 'settings.update', 'settings', '', { changed });
  return back(c, '/admin/settings', 'ok', 'Réglages enregistrés.');
});

// ---------- Équipe (propriétaire) ----------

opsRoutes.get('/admin/staff', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT email, role, created_at, last_seen_at FROM staff ORDER BY role, email').all<{ email: string; role: Role; created_at: string; last_seen_at: string | null }>();
  return c.html(<StaffView a={adminCtx(c)} staff={results} errors={[]} />);
});

const ownerCount = async (db: D1Database) => (await db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'").first<{ n: number }>())?.n ?? 0;

opsRoutes.post('/admin/staff', async (c) => {
  const db = c.env.DB;
  const b = (await c.req.parseBody()) as Body;
  const email = clean(str(b, 'email'), 254).toLowerCase();
  const role = str(b, 'role') as Role;
  if (!isEmail(email)) return back(c, '/admin/staff', 'err', 'Email invalide.');
  if (!ROLES.includes(role)) return back(c, '/admin/staff', 'err', 'Rôle invalide.');
  const existing = await db.prepare('SELECT role FROM staff WHERE email = ?1').bind(email).first<{ role: Role }>();
  if (existing?.role === 'owner' && role !== 'owner' && (await ownerCount(db)) <= 1) {
    return back(c, '/admin/staff', 'err', 'Il doit rester au moins un propriétaire.');
  }
  await db.prepare('INSERT INTO staff (email, role) VALUES (?1, ?2) ON CONFLICT(email) DO UPDATE SET role = excluded.role').bind(email, role).run();
  await audit(db, c.get('staff')!.email, 'staff.set', 'staff', email, { role });
  return back(c, '/admin/staff', 'ok', `${email} : ${role}. N’oublie pas de l’autoriser dans Cloudflare Access.`);
});

opsRoutes.post('/admin/staff/role', async (c) => {
  const db = c.env.DB;
  const b = (await c.req.parseBody()) as Body;
  const email = clean(str(b, 'email'), 254).toLowerCase();
  const role = str(b, 'role') as Role;
  if (!ROLES.includes(role)) return back(c, '/admin/staff', 'err', 'Rôle invalide.');
  const existing = await db.prepare('SELECT role FROM staff WHERE email = ?1').bind(email).first<{ role: Role }>();
  if (!existing) return back(c, '/admin/staff', 'err', 'Personne introuvable.');
  if (existing.role === 'owner' && role !== 'owner' && (await ownerCount(db)) <= 1) {
    return back(c, '/admin/staff', 'err', 'Il doit rester au moins un propriétaire.');
  }
  await db.prepare('UPDATE staff SET role = ?2 WHERE email = ?1').bind(email, role).run();
  await audit(db, c.get('staff')!.email, 'staff.role', 'staff', email, { role });
  return back(c, '/admin/staff', 'ok', `Rôle de ${email} modifié.`);
});

opsRoutes.post('/admin/staff/delete', async (c) => {
  const db = c.env.DB;
  const me = c.get('staff')!;
  const email = clean(str((await c.req.parseBody()) as Body, 'email'), 254).toLowerCase();
  if (email === me.email) return back(c, '/admin/staff', 'err', 'Tu ne peux pas te retirer toi-même.');
  const existing = await db.prepare('SELECT role FROM staff WHERE email = ?1').bind(email).first<{ role: Role }>();
  if (!existing) return back(c, '/admin/staff', 'err', 'Personne introuvable.');
  if (existing.role === 'owner' && (await ownerCount(db)) <= 1) return back(c, '/admin/staff', 'err', 'Il doit rester au moins un propriétaire.');
  await db.prepare('DELETE FROM staff WHERE email = ?1').bind(email).run();
  await audit(db, me.email, 'staff.remove', 'staff', email);
  return back(c, '/admin/staff', 'ok', `${email} retiré de l’équipe.`);
});

// ---------- Journal (propriétaire) ----------

opsRoutes.get('/admin/audit', async (c) => {
  const page = Math.max(1, Math.min(10000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1));
  const { results } = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 101 OFFSET ?1')
    .bind((page - 1) * 100)
    .all<{ id: number; at: string; actor: string; action: string; entity: string; entity_id: string; details: string }>();
  return c.html(<AuditView a={adminCtx(c)} rows={results.slice(0, 100)} page={page} hasMore={results.length > 100} />);
});

// ---------- Scanner d'entrée (rôle scanner et plus) ----------

opsRoutes.get('/scan', async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare("SELECT id, title, starts_at FROM events WHERE status = 'published' AND starts_at BETWEEN ?1 AND ?2 ORDER BY starts_at")
    .bind(new Date(now - 24 * 3600_000).toISOString(), new Date(now + 7 * 86400_000).toISOString())
    .all<{ id: number; title: string; starts_at: string }>();
  const staff = c.get('staff')!;
  return c.html(<ScanView events={results} email={staff.email} canManage={hasRole(staff, 'manager')} tz={c.get('settings').timezone} />);
});

opsRoutes.get('/api/scan/stats', async (c) => {
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10);
  if (!Number.isInteger(eventId) || eventId < 1) return c.json({ error: 'event invalide' }, 400);
  return c.json(await doorCount(c.env.DB, eventId));
});

opsRoutes.post('/api/scan', async (c) => {
  const db = c.env.DB;
  const staff = c.get('staff')!;
  let payload: { code?: unknown; eventId?: unknown };
  try {
    payload = (await c.req.json()) as typeof payload;
  } catch {
    return c.json({ error: 'JSON invalide' }, 400);
  }
  const eventId = Number(payload.eventId);
  if (!Number.isInteger(eventId) || eventId < 1) return c.json({ error: 'eventId invalide' }, 400);
  const code = normalizeTicketCode(String(payload.code ?? ''));
  if (!code) return c.json({ result: 'invalid', ...(await doorCount(db, eventId)) });

  const now = new Date().toISOString();
  // Une seule instruction atomique : deux scans simultanés du même billet ne peuvent pas tous deux réussir.
  const hit = await db
    .prepare(
      `UPDATE tickets SET checked_in_at = ?1, checked_in_by = ?2
       WHERE code = ?3 AND event_id = ?4 AND status = 'valid' AND checked_in_at IS NULL
       RETURNING ticket_type_id, order_id`,
    )
    .bind(now, staff.email, code, eventId)
    .first<{ ticket_type_id: number; order_id: number }>();
  const counts = await doorCount(db, eventId);
  const fmt = formatTicketCode(code);

  if (hit) {
    const info = await db
      .prepare('SELECT tt.name_fr AS type, o.name AS holder FROM ticket_types tt, orders o WHERE tt.id = ?1 AND o.id = ?2')
      .bind(hit.ticket_type_id, hit.order_id)
      .first<{ type: string; holder: string }>();
    return c.json({ result: 'ok', code: fmt, type: info?.type, holder: info?.holder, ...counts });
  }
  const t = await db
    .prepare(
      `SELECT t.event_id, t.status, t.checked_in_at, tt.name_fr AS type, o.name AS holder, e.title AS eventTitle
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id JOIN events e ON e.id = t.event_id
       WHERE t.code = ?1`,
    )
    .bind(code)
    .first<{ event_id: number; status: string; checked_in_at: string | null; type: string; holder: string; eventTitle: string }>();
  if (!t) return c.json({ result: 'unknown', code: fmt, ...counts });
  if (t.event_id !== eventId) return c.json({ result: 'wrong_event', code: fmt, eventTitle: t.eventTitle, ...counts });
  if (t.status === 'void') return c.json({ result: 'void', code: fmt, type: t.type, holder: t.holder, ...counts });
  return c.json({ result: 'already', code: fmt, type: t.type, holder: t.holder, checkedInAt: t.checked_in_at, ...counts });
});

