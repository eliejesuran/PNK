// SPDX-License-Identifier: AGPL-3.0-or-later
// Back-office (1/2) : tableau de bord, concerts, catégories de places, salles.
// Toutes ces routes exigent au minimum le rôle "manager" (voir src/index.tsx).

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { envGaps } from '../lib/auth';
import { setFlash, takeFlash } from '../lib/flash';
import { parseEuroToCents, parseRatePercentToBp } from '../lib/money';
import { baseUrlOf } from '../lib/security';
import { clampInt, clean, cleanHttpUrl, cleanMultiline, slugify } from '../lib/text';
import { localInputToUtcIso } from '../lib/time';
import { audit } from '../services/audit';
import { getEventById, getVenue, listAllEvents, listVenues, ticketTypesWithStock, uniqueSlug } from '../services/events';
import { setupGaps } from '../services/settings';
import { dashboard, eventStats, typeStats } from '../services/stats';
import type { OrderRow } from '../services/types';
import {
  DashboardView,
  EventEditView,
  EventNewView,
  EventsListView,
  VenueEditView,
  VenuesView,
  emptyEventForm,
  eventToForm,
  type A,
  type EventFormValues,
} from '../views/admin';

export const adminRoutes = new Hono<AppEnv>();

type Body = Record<string, string | File | (string | File)[]>;
const str = (b: Body, k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');

export function adminCtx(c: Context<AppEnv>): A {
  const s = c.get('settings');
  return { staff: c.get('staff')!, path: c.req.path, orgName: s.org_name, flash: takeFlash(c), tz: s.timezone, currency: s.currency };
}

export function back(c: Context<AppEnv>, path: string, kind: 'ok' | 'err' | 'info', text: string): Response {
  setFlash(c, kind, text);
  return c.redirect(path, 303);
}

const idParam = (c: Context<AppEnv>, name = 'id'): number | null => {
  const n = Number(c.req.param(name));
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ---------- Tableau de bord ----------

const RANGES: Record<string, number | null> = { '7': 7, '30': 30, '90': 90, '365': 365, all: null };

adminRoutes.get('/admin', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const range = c.req.query('range') && c.req.query('range')! in RANGES ? c.req.query('range')! : '30';
  const eventId = Number.parseInt(c.req.query('event') ?? '', 10) || null;
  const now = new Date();
  const days = RANGES[range] ?? null;
  const sinceIso = days ? new Date(now.getTime() - days * 86400_000).toISOString() : null;

  const d = await dashboard(db, { sinceIso, eventId, tz: s.timezone, nowIso: now.toISOString(), defaultDays: days ?? 90 });
  const events = await eventStats(db, new Date(now.getTime() - 12 * 3600_000).toISOString(), eventId);
  const types = eventId ? await typeStats(db, eventId) : [];
  const recent = await db
    .prepare(
      `SELECT o.*, e.title AS event_title FROM orders o JOIN events e ON e.id = o.event_id
       ${eventId ? 'WHERE o.event_id = ?1' : ''} ORDER BY o.id DESC LIMIT 10`,
    )
    .bind(...(eventId ? [eventId] : []))
    .all<OrderRow & { event_title: string }>();
  const eventOptions = (await listAllEvents(db)).map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at }));
  return c.html(
    <DashboardView
      a={adminCtx(c)}
      d={d}
      events={events}
      types={types}
      recent={recent.results}
      range={range}
      eventId={eventId}
      eventOptions={eventOptions}
      gaps={setupGaps(s)}
      envGaps={envGaps(c.env)}
    />,
  );
});

// ---------- Concerts ----------

adminRoutes.get('/admin/events', async (c) => {
  const db = c.env.DB;
  const events = await listAllEvents(db);
  const stats = new Map((await eventStats(db, '0000')).map((x) => [x.id, x]));
  return c.html(
    <EventsListView a={adminCtx(c)} events={events.map((e) => ({ ...e, sold: stats.get(e.id)?.sold ?? 0, quota: stats.get(e.id)?.quota ?? 0 }))} />,
  );
});

interface ParsedEvent {
  title: string;
  subtitle: string;
  slug: string;
  venueId: number;
  startsAt: string;
  doorsAt: string | null;
  salesOpenAt: string | null;
  salesCloseAt: string | null;
  maxPerOrder: number;
  imageUrl: string;
  vatBp: number | null;
  descFr: string;
  descEn: string;
  descNl: string;
}

const FORM_KEYS: (keyof EventFormValues)[] = [
  'title', 'subtitle', 'slug', 'venue_id', 'starts', 'doors', 'sales_open', 'sales_close', 'max_per_order', 'image_url', 'vat',
  'description_fr', 'description_en', 'description_nl', 'std_price', 'std_quota', 'std_note', 'nip_price', 'nip_quota', 'nip_note',
];

function parseEventBody(b: Body, tz: string): { values: EventFormValues; errors: string[]; data: ParsedEvent | null } {
  const values = Object.fromEntries(FORM_KEYS.map((k) => [k, str(b, k)])) as unknown as EventFormValues;
  const errors: string[] = [];

  const title = clean(values.title, 120);
  if (!title) errors.push('Le titre est obligatoire.');
  const venueId = Number.parseInt(values.venue_id, 10);
  if (!Number.isInteger(venueId)) errors.push('Choisis une salle.');
  const startsAt = localInputToUtcIso(values.starts, tz);
  if (!startsAt) errors.push('La date de début est obligatoire (format valide).');

  const opt = (raw: string, label: string): string | null => {
    if (!raw.trim()) return null;
    const v = localInputToUtcIso(raw, tz);
    if (!v) errors.push(`${label} : date invalide.`);
    return v;
  };
  const doorsAt = opt(values.doors, 'Ouverture des portes');
  const salesOpenAt = opt(values.sales_open, 'Ouverture de la billetterie');
  const salesCloseAt = opt(values.sales_close, 'Fermeture de la billetterie');
  if (startsAt && doorsAt && doorsAt > startsAt) errors.push('Les portes ouvrent après le début du concert ?');
  if (salesOpenAt && salesCloseAt && salesOpenAt >= salesCloseAt) errors.push('La billetterie ferme avant de s’ouvrir.');

  let slug = '';
  if (values.slug.trim()) {
    slug = slugify(values.slug);
    if (!slug) errors.push('Adresse web invalide.');
  }
  let vatBp: number | null = null;
  if (values.vat.trim()) {
    vatBp = parseRatePercentToBp(values.vat);
    if (vatBp === null) errors.push('Taux de TVA invalide (0 à 30).');
  }
  const imageUrl = cleanHttpUrl(values.image_url);
  if (values.image_url.trim() && !imageUrl) errors.push('L’URL de l’affiche doit commencer par https://');

  if (errors.length || !startsAt) return { values, errors, data: null };
  return {
    values,
    errors,
    data: {
      title,
      subtitle: clean(values.subtitle, 160),
      slug,
      venueId,
      startsAt,
      doorsAt,
      salesOpenAt,
      salesCloseAt,
      maxPerOrder: clampInt(values.max_per_order, 1, 50, 6),
      imageUrl,
      vatBp,
      descFr: cleanMultiline(values.description_fr),
      descEn: cleanMultiline(values.description_en),
      descNl: cleanMultiline(values.description_nl),
    },
  };
}

adminRoutes.get('/admin/events/new', async (c) => {
  const venues = await listVenues(c.env.DB);
  return c.html(
    <EventNewView a={adminCtx(c)} v={emptyEventForm(venues[0]?.id)} venues={venues} errors={[]} defaultVat={c.get('settings').default_vat_bp} />,
  );
});

adminRoutes.post('/admin/events', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const staff = c.get('staff')!;
  const body = (await c.req.parseBody()) as Body;
  const { values, errors, data } = parseEventBody(body, s.timezone);

  const stdQuota = clampInt(values.std_quota, 0, 100000, 0);
  const nipQuota = clampInt(values.nip_quota, 0, 100000, 0);
  const stdPrice = parseEuroToCents(values.std_price || '0');
  const nipPrice = parseEuroToCents(values.nip_price || '0');
  if (stdQuota > 0 && stdPrice === null) errors.push('Prix Standard invalide.');
  if (nipQuota > 0 && nipPrice === null) errors.push('Prix NIP invalide.');

  if (data) {
    const venue = await getVenue(db, data.venueId);
    if (!venue) errors.push('Salle introuvable.');
    else if (stdQuota + nipQuota > venue.capacity) errors.push(`Les places (${stdQuota + nipQuota}) dépassent la capacité de la salle (${venue.capacity}).`);
    if (data.slug && (await db.prepare('SELECT 1 AS x FROM events WHERE slug = ?1').bind(data.slug).first())) {
      errors.push('Cette adresse web est déjà utilisée par un autre concert.');
    }
  }
  if (errors.length || !data) {
    const venues = await listVenues(db);
    return c.html(<EventNewView a={adminCtx(c)} v={values} venues={venues} errors={errors} defaultVat={s.default_vat_bp} />, 400);
  }

  const slug = data.slug || (await uniqueSlug(db, slugify(data.title) || 'concert'));
  const res = await db
    .prepare(
      `INSERT INTO events (slug, title, subtitle, description_fr, description_en, description_nl, venue_id, starts_at, doors_at, status,
         sales_open_at, sales_close_at, max_per_order, image_url, vat_rate_bp)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(slug, data.title, data.subtitle, data.descFr, data.descEn, data.descNl, data.venueId, data.startsAt, data.doorsAt, data.salesOpenAt, data.salesCloseAt, data.maxPerOrder, data.imageUrl, data.vatBp)
    .run();
  const eventId = Number(res.meta.last_row_id);
  const typeSql = 'INSERT INTO ticket_types (event_id, name_fr, name_en, name_nl, price_cents, quota, sort, note) VALUES (?1, ?2, ?2, ?2, ?3, ?4, ?5, ?6)';
  const stmts: D1PreparedStatement[] = [];
  if (stdQuota > 0) stmts.push(db.prepare(typeSql).bind(eventId, 'Standard', stdPrice, stdQuota, 0, clean(values.std_note, 80)));
  if (nipQuota > 0) stmts.push(db.prepare(typeSql).bind(eventId, 'NIP', nipPrice, nipQuota, 1, clean(values.nip_note, 80)));
  if (stmts.length) await db.batch(stmts);
  await audit(db, staff.email, 'event.create', 'event', eventId, { title: data.title, slug });
  return back(c, `/admin/events/${eventId}`, 'ok', 'Concert créé en brouillon. Vérifie les infos puis publie-le.');
});

async function renderEdit(c: Context<AppEnv>, id: number, opts: { values?: EventFormValues; errors?: string[]; status?: 200 | 400 } = {}) {
  const db = c.env.DB;
  const s = c.get('settings');
  const event = await getEventById(db, id);
  if (!event) return c.notFound();
  const [types, venues, orders] = await Promise.all([
    ticketTypesWithStock(db, id, new Date().toISOString()),
    listVenues(db, true),
    db.prepare('SELECT COUNT(*) AS n FROM orders WHERE event_id = ?1').bind(id).first<{ n: number }>(),
  ]);
  return c.html(
    <EventEditView
      a={adminCtx(c)}
      event={event}
      v={opts.values ?? eventToForm(event, s.timezone)}
      venues={venues}
      types={types}
      errors={opts.errors ?? []}
      orderCount={orders?.n ?? 0}
      publicUrl={`${baseUrlOf(c.env, c.req.raw)}/e/${event.slug}`}
      defaultVat={s.default_vat_bp}
    />,
    opts.status ?? 200,
  );
}

adminRoutes.get('/admin/events/:id', async (c) => {
  const id = idParam(c);
  return id ? renderEdit(c, id) : c.notFound();
});

adminRoutes.post('/admin/events/:id', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const body = (await c.req.parseBody()) as Body;
  const { values, errors, data } = parseEventBody(body, c.get('settings').timezone);
  if (data) {
    const venue = await getVenue(db, data.venueId);
    if (!venue) errors.push('Salle introuvable.');
    else {
      const q = await db.prepare('SELECT COALESCE(SUM(quota), 0) AS n FROM ticket_types WHERE event_id = ?1').bind(id).first<{ n: number }>();
      if ((q?.n ?? 0) > venue.capacity) errors.push(`Les quotas (${q?.n}) dépassent la capacité de cette salle (${venue.capacity}).`);
    }
    if (data.slug && (await db.prepare('SELECT 1 AS x FROM events WHERE slug = ?1 AND id != ?2').bind(data.slug, id).first())) {
      errors.push('Cette adresse web est déjà utilisée par un autre concert.');
    }
  }
  if (errors.length || !data) return renderEdit(c, id, { values, errors, status: 400 });
  const slug = data.slug || (await uniqueSlug(db, slugify(data.title) || 'concert', id));
  await db
    .prepare(
      `UPDATE events SET slug = ?2, title = ?3, subtitle = ?4, description_fr = ?5, description_en = ?6, description_nl = ?7,
         venue_id = ?8, starts_at = ?9, doors_at = ?10, sales_open_at = ?11, sales_close_at = ?12, max_per_order = ?13,
         image_url = ?14, vat_rate_bp = ?15, updated_at = ?16 WHERE id = ?1`,
    )
    .bind(id, slug, data.title, data.subtitle, data.descFr, data.descEn, data.descNl, data.venueId, data.startsAt, data.doorsAt, data.salesOpenAt, data.salesCloseAt, data.maxPerOrder, data.imageUrl, data.vatBp, new Date().toISOString())
    .run();
  await audit(db, c.get('staff')!.email, 'event.update', 'event', id, { title: data.title });
  return back(c, `/admin/events/${id}`, 'ok', 'Concert enregistré.');
});

adminRoutes.post('/admin/events/:id/status', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const status = str((await c.req.parseBody()) as Body, 'status');
  if (!['draft', 'published', 'cancelled'].includes(status)) return back(c, `/admin/events/${id}`, 'err', 'Statut invalide.');
  if (status === 'published') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM ticket_types WHERE event_id = ?1 AND online = 1').bind(id).first<{ n: number }>();
    if (!n?.n) return back(c, `/admin/events/${id}`, 'err', 'Ajoute au moins une catégorie en vente en ligne avant de publier.');
  }
  await db.prepare('UPDATE events SET status = ?2, updated_at = ?3 WHERE id = ?1').bind(id, status, new Date().toISOString()).run();
  await audit(db, c.get('staff')!.email, 'event.status', 'event', id, { status });
  return back(c, `/admin/events/${id}`, 'ok', status === 'published' ? 'Concert publié : il est visible et en vente.' : status === 'cancelled' ? 'Concert marqué comme annulé.' : 'Concert repassé en brouillon.');
});

adminRoutes.post('/admin/events/:id/duplicate', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const e = await getEventById(db, id);
  if (!e) return c.notFound();
  const slug = await uniqueSlug(db, `${e.slug}-copie`);
  const starts = new Date(Date.parse(e.starts_at) + 7 * 86400_000).toISOString();
  const doors = e.doors_at ? new Date(Date.parse(e.doors_at) + 7 * 86400_000).toISOString() : null;
  const res = await db
    .prepare(
      `INSERT INTO events (slug, title, subtitle, description_fr, description_en, description_nl, venue_id, starts_at, doors_at, status,
         max_per_order, image_url, vat_rate_bp)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?11, ?12)`,
    )
    .bind(slug, `${e.title} (copie)`, e.subtitle, e.description_fr, e.description_en, e.description_nl, e.venue_id, starts, doors, e.max_per_order, e.image_url, e.vat_rate_bp)
    .run();
  const newId = Number(res.meta.last_row_id);
  await db
    .prepare(
      `INSERT INTO ticket_types (event_id, name_fr, name_en, name_nl, price_cents, quota, sort, online, note)
       SELECT ?1, name_fr, name_en, name_nl, price_cents, quota, sort, online, note FROM ticket_types WHERE event_id = ?2`,
    )
    .bind(newId, id)
    .run();
  await audit(db, c.get('staff')!.email, 'event.duplicate', 'event', newId, { from: id });
  return back(c, `/admin/events/${newId}`, 'ok', 'Copie créée en brouillon, une semaine plus tard : ajuste la date.');
});

adminRoutes.post('/admin/events/:id/delete', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const n = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE event_id = ?1').bind(id).first<{ n: number }>();
  if (n?.n) return back(c, `/admin/events/${id}`, 'err', 'Ce concert a des commandes : il ne peut plus être supprimé (annule-le plutôt).');
  await db.batch([db.prepare('DELETE FROM ticket_types WHERE event_id = ?1').bind(id), db.prepare('DELETE FROM events WHERE id = ?1').bind(id)]);
  await audit(db, c.get('staff')!.email, 'event.delete', 'event', id);
  return back(c, '/admin/events', 'ok', 'Concert supprimé.');
});

// ---------- Catégories de places ----------

interface TypeInput {
  name_fr: string;
  name_en: string;
  name_nl: string;
  price: number;
  quota: number;
  online: number;
  note: string;
}

function parseType(b: Body): { data?: TypeInput; error?: string } {
  const name_fr = clean(str(b, 'name_fr'), 60);
  if (!name_fr) return { error: 'Le nom de la catégorie est obligatoire.' };
  const price = parseEuroToCents(str(b, 'price'));
  if (price === null) return { error: 'Prix invalide (ex. 12 ou 12,50).' };
  const quotaRaw = str(b, 'quota');
  if (!/^\d{1,6}$/.test(quotaRaw)) return { error: 'Quota invalide.' };
  return {
    data: {
      name_fr,
      name_en: clean(str(b, 'name_en'), 60) || name_fr,
      name_nl: clean(str(b, 'name_nl'), 60) || name_fr,
      price,
      quota: Number.parseInt(quotaRaw, 10),
      online: str(b, 'online') === '1' ? 1 : 0,
      note: clean(str(b, 'note'), 80),
    },
  };
}

adminRoutes.post('/admin/events/:id/types', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const e = await getEventById(db, id);
  if (!e) return c.notFound();
  const { data, error } = parseType((await c.req.parseBody()) as Body);
  if (!data) return back(c, `/admin/events/${id}`, 'err', error!);
  const q = await db.prepare('SELECT COALESCE(SUM(quota), 0) AS n, COALESCE(MAX(sort), -1) AS m FROM ticket_types WHERE event_id = ?1').bind(id).first<{ n: number; m: number }>();
  if ((q?.n ?? 0) + data.quota > e.venue_capacity) {
    return back(c, `/admin/events/${id}`, 'err', `Total des quotas (${(q?.n ?? 0) + data.quota}) supérieur à la capacité de la salle (${e.venue_capacity}).`);
  }
  const r = await db
    .prepare('INSERT INTO ticket_types (event_id, name_fr, name_en, name_nl, price_cents, quota, sort, online, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(id, data.name_fr, data.name_en, data.name_nl, data.price, data.quota, (q?.m ?? -1) + 1, data.online, data.note)
    .run();
  await audit(db, c.get('staff')!.email, 'type.create', 'ticket_type', Number(r.meta.last_row_id), { event: id, ...data });
  return back(c, `/admin/events/${id}`, 'ok', `Catégorie « ${data.name_fr} » ajoutée.`);
});

adminRoutes.post('/admin/types/:id', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const tt = await db.prepare('SELECT * FROM ticket_types WHERE id = ?1').bind(id).first<{ id: number; event_id: number }>();
  if (!tt) return c.notFound();
  const body = (await c.req.parseBody()) as Body;
  const { data, error } = parseType(body);
  const home = `/admin/events/${tt.event_id}`;
  if (!data) return back(c, home, 'err', error!);
  const now = new Date().toISOString();
  const taken = await db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty), 0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.ticket_type_id = ?1 AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > ?2))`,
    )
    .bind(id, now)
    .first<{ n: number }>();
  if (data.quota < (taken?.n ?? 0)) return back(c, home, 'err', `Impossible : ${taken?.n} places sont déjà vendues ou en cours de paiement.`);
  const e = await getEventById(db, tt.event_id);
  const others = await db.prepare('SELECT COALESCE(SUM(quota), 0) AS n FROM ticket_types WHERE event_id = ?1 AND id != ?2').bind(tt.event_id, id).first<{ n: number }>();
  if (e && (others?.n ?? 0) + data.quota > e.venue_capacity) {
    return back(c, home, 'err', `Total des quotas (${(others?.n ?? 0) + data.quota}) supérieur à la capacité de la salle (${e.venue_capacity}).`);
  }
  await db
    .prepare('UPDATE ticket_types SET name_fr = ?2, name_en = ?3, name_nl = ?4, price_cents = ?5, quota = ?6, online = ?7, sort = ?8, note = ?9 WHERE id = ?1')
    .bind(id, data.name_fr, data.name_en, data.name_nl, data.price, data.quota, data.online, clampInt(str(body, 'sort'), -1000, 1000, 0), data.note)
    .run();
  await audit(db, c.get('staff')!.email, 'type.update', 'ticket_type', id, data);
  return back(c, home, 'ok', `Catégorie « ${data.name_fr} » enregistrée.`);
});

adminRoutes.post('/admin/types/:id/delete', async (c) => {
  const id = idParam(c);
  if (!id) return c.notFound();
  const db = c.env.DB;
  const tt = await db.prepare('SELECT event_id FROM ticket_types WHERE id = ?1').bind(id).first<{ event_id: number }>();
  if (!tt) return c.notFound();
  const used = await db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE ticket_type_id = ?1').bind(id).first<{ n: number }>();
  if (used?.n) return back(c, `/admin/events/${tt.event_id}`, 'err', 'Cette catégorie a déjà des commandes : retire-la de la vente en ligne plutôt.');
  await db.prepare('DELETE FROM ticket_types WHERE id = ?1').bind(id).run();
  await audit(db, c.get('staff')!.email, 'type.delete', 'ticket_type', id);
  return back(c, `/admin/events/${tt.event_id}`, 'ok', 'Catégorie supprimée.');
});

// ---------- Salles ----------

function parseVenue(b: Body): { data?: { name: string; address: string; city: string; capacity: number }; errors: string[] } {
  const errors: string[] = [];
  const name = clean(str(b, 'name'), 100);
  if (!name) errors.push('Le nom est obligatoire.');
  const capRaw = str(b, 'capacity');
  const capacity = /^\d{1,6}$/.test(capRaw) ? Number.parseInt(capRaw, 10) : 0;
  if (capacity < 1) errors.push('La capacité doit être un nombre supérieur à 0.');
  if (errors.length) return { errors };
  return { data: { name, address: clean(str(b, 'address'), 160), city: clean(str(b, 'city'), 80), capacity }, errors };
}

adminRoutes.get('/admin/venues', async (c) => c.html(<VenuesView a={adminCtx(c)} venues={await listVenues(c.env.DB, true)} errors={[]} />));

adminRoutes.post('/admin/venues', async (c) => {
  const db = c.env.DB;
  const { data, errors } = parseVenue((await c.req.parseBody()) as Body);
  if (!data) return c.html(<VenuesView a={adminCtx(c)} venues={await listVenues(db, true)} errors={errors} />, 400);
  const r = await db.prepare('INSERT INTO venues (name, address, city, capacity) VALUES (?1, ?2, ?3, ?4)').bind(data.name, data.address, data.city, data.capacity).run();
  await audit(db, c.get('staff')!.email, 'venue.create', 'venue', Number(r.meta.last_row_id), data);
  return back(c, '/admin/venues', 'ok', `Salle « ${data.name} » ajoutée.`);
});

adminRoutes.get('/admin/venues/:id', async (c) => {
  const id = idParam(c);
  const venue = id ? await getVenue(c.env.DB, id) : null;
  return venue ? c.html(<VenueEditView a={adminCtx(c)} venue={venue} errors={[]} />) : c.notFound();
});

adminRoutes.post('/admin/venues/:id', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const venue = id ? await getVenue(db, id) : null;
  if (!id || !venue) return c.notFound();
  const { data, errors } = parseVenue((await c.req.parseBody()) as Body);
  if (data) {
    const q = await db
      .prepare(
        `SELECT MAX(s.total) AS n FROM (SELECT SUM(tt.quota) AS total FROM ticket_types tt JOIN events e ON e.id = tt.event_id
           WHERE e.venue_id = ?1 GROUP BY e.id) s`,
      )
      .bind(id)
      .first<{ n: number | null }>();
    if ((q?.n ?? 0) > data.capacity) errors.push(`Un concert de cette salle a déjà ${q?.n} places en vente : la capacité ne peut pas être plus basse.`);
  }
  if (!data || errors.length) return c.html(<VenueEditView a={adminCtx(c)} venue={{ ...venue, ...(data ?? {}) }} errors={errors} />, 400);
  await db.prepare('UPDATE venues SET name = ?2, address = ?3, city = ?4, capacity = ?5 WHERE id = ?1').bind(id, data.name, data.address, data.city, data.capacity).run();
  await audit(db, c.get('staff')!.email, 'venue.update', 'venue', id, data);
  return back(c, '/admin/venues', 'ok', 'Salle enregistrée.');
});

adminRoutes.post('/admin/venues/:id/archive', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const venue = id ? await getVenue(db, id) : null;
  if (!id || !venue) return c.notFound();
  await db.prepare('UPDATE venues SET archived = ?2 WHERE id = ?1').bind(id, venue.archived ? 0 : 1).run();
  await audit(db, c.get('staff')!.email, venue.archived ? 'venue.unarchive' : 'venue.archive', 'venue', id);
  return back(c, '/admin/venues', 'ok', venue.archived ? 'Salle désarchivée.' : 'Salle archivée (elle n’apparaît plus dans les choix).');
});
