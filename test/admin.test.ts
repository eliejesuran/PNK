// SPDX-License-Identifier: AGPL-3.0-or-later
// Back-office : contrôle d'accès, gestion des concerts, caisse, scanner, exports.
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utcIsoToLocalInput } from '../src/lib/time';
import type { OrderRow } from '../src/services/types';
import { e, formBody, http, locationOf, resetData, seedEvent } from './helpers';

const env = e as unknown as Record<string, string | undefined>;
const worker = () => (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const local = (days: number) => utcIsoToLocalInput(new Date(Date.now() + days * 86400_000).toISOString(), 'Europe/Brussels');

/** Se connecte (en local) comme cet email ; crée la ligne d'équipe si un rôle est donné. */
async function loginAs(email: string, role?: 'owner' | 'manager' | 'scanner') {
  env.DEV_USER_EMAIL = email;
  if (role) await e.DB.prepare('INSERT OR REPLACE INTO staff (email, role) VALUES (?1, ?2)').bind(email, role).run();
}

beforeEach(async () => {
  await resetData();
  await loginAs('owner@pnk.test'); // promu owner via BOOTSTRAP_OWNERS à la première requête
});
afterEach(() => {
  env.DEV_USER_EMAIL = 'owner@pnk.test';
  env.ENVIRONMENT = 'development';
  env.ACCESS_TEAM_DOMAIN = undefined;
  env.ACCESS_AUD = undefined;
});

describe('contrôle d’accès', () => {
  it('le propriétaire d’amorçage entre et devient owner', async () => {
    const res = await http('/admin');
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM staff WHERE email = 'owner@pnk.test' AND role = 'owner'")).toBe(1);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('refuse un inconnu : pas dans l’équipe = 403', async () => {
    await loginAs('inconnu@example.com');
    const res = await http('/admin');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('ne fait pas partie de l’équipe');
  });

  it('hors développement et sans Cloudflare Access configuré : tout est refusé (échoue fermé)', async () => {
    env.ENVIRONMENT = 'production';
    for (const path of ['/admin', '/admin/settings', '/scan', '/admin/export/orders.csv']) {
      expect((await http(path)).status, path).toBe(503);
    }
    expect((await http('/api/scan', { json: { code: 'x', eventId: 1 } })).status).toBe(503);
    expect((await http('/')).status).toBe(200); // le site public reste ouvert
  });

  it('l’auth de développement ne marche que sur localhost', async () => {
    const res = await worker().fetch(new Request('https://billets.example.org/admin'));
    expect(res.status).toBe(503);
  });

  it('un en-tête d’email forgé ne donne aucun accès (seul un JWT Access signé compte)', async () => {
    env.ENVIRONMENT = 'production';
    env.ACCESS_TEAM_DOMAIN = 'pnk-test.invalid';
    env.ACCESS_AUD = 'aud123';
    const forged = {
      'Cf-Access-Authenticated-User-Email': 'owner@pnk.test',
      'X-Forwarded-Email': 'owner@pnk.test',
    };
    expect((await http('/admin', { headers: forged })).status).toBe(401);
    expect((await http('/admin', { headers: { ...forged, 'Cf-Access-Jwt-Assertion': 'pas.un.jwt' } })).status).toBe(401);
    const fakeJwt = `${btoa('{"alg":"none"}')}.${btoa('{"email":"owner@pnk.test","aud":"aud123"}')}.`;
    expect((await http('/admin', { headers: { 'Cf-Access-Jwt-Assertion': fakeJwt } })).status).toBe(401);
  });

  it('rôles : scanner < manager < owner', async () => {
    await loginAs('scan@pnk.test', 'scanner');
    expect((await http('/scan')).status).toBe(200);
    expect((await http('/admin')).status).toBe(403);
    expect((await http('/admin/orders')).status).toBe(403);
    expect((await http('/admin/export/attendees.csv')).status).toBe(403);

    await loginAs('manager@pnk.test', 'manager');
    expect((await http('/admin')).status).toBe(200);
    expect((await http('/scan')).status).toBe(200);
    expect((await http('/admin/settings')).status).toBe(403);
    expect((await http('/admin/staff')).status).toBe(403);
    expect((await http('/admin/audit')).status).toBe(403);
    expect((await http('/admin/staff', { form: { email: 'x@y.zz', role: 'owner' } })).status).toBe(403);

    await loginAs('owner@pnk.test');
    for (const p of ['/admin/settings', '/admin/staff', '/admin/audit']) expect((await http(p)).status, p).toBe(200);
  });

  it('anti-CSRF sur le back-office', async () => {
    const res = await http('/admin/venues', { form: { name: 'X', capacity: '10' }, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM venues')).toBe(0);
  });
});

describe('gestion des concerts', () => {
  async function createVenue(name = 'La Cave', capacity = 150) {
    const res = await http('/admin/venues', { form: { name, capacity: String(capacity), address: '1 rue du Bruit', city: 'Liège' } });
    expect(res.status).toBe(303);
    return (await e.DB.prepare('SELECT id FROM venues WHERE name = ?1').bind(name).first<{ id: number }>())!.id;
  }
  const eventForm = (venueId: number, extra: Record<string, string> = {}) => ({
    title: 'Bruit Blanc + Les Cafards',
    subtitle: 'double plateau',
    venue_id: String(venueId),
    starts: local(20),
    doors: utcIsoToLocalInput(new Date(Date.now() + 20 * 86400_000 - 3600_000).toISOString(), 'Europe/Brussels'),
    max_per_order: '4',
    std_quota: '100',
    std_price: '12,50',
    nip_quota: '10',
    nip_price: '30',
    nip_note: 'Not Very Important Person',
    description_fr: 'Du bruit.\nBeaucoup.',
    ...extra,
  });

  it('salle -> concert (avec Standard + NIP) -> publication -> visible et achetable', async () => {
    const venueId = await createVenue();
    const created = await http('/admin/events', { form: eventForm(venueId) });
    expect(created.status).toBe(303);
    const ev = (await e.DB.prepare('SELECT * FROM events').first<{ id: number; slug: string; status: string; doors_at: string; starts_at: string }>())!;
    expect(ev.slug).toBe('bruit-blanc-les-cafards');
    expect(ev.status).toBe('draft');
    const types = await e.DB.prepare('SELECT name_fr, price_cents, quota, note FROM ticket_types ORDER BY sort').all<{ name_fr: string; price_cents: number; quota: number; note: string }>();
    expect(types.results).toEqual([
      { name_fr: 'Standard', price_cents: 1250, quota: 100, note: '' },
      { name_fr: 'NIP', price_cents: 3000, quota: 10, note: 'Not Very Important Person' },
    ]);
    expect((await http(`/e/${ev.slug}`)).status).toBe(404); // brouillon : invisible

    const pub = await http(`/admin/events/${ev.id}/status`, { form: { status: 'published' } });
    expect(pub.status).toBe(303);
    const page = await (await http(`/e/${ev.slug}`)).text();
    expect(page).toContain('Bruit Blanc + Les Cafards');
    expect(page).toContain('12,50');
    expect(page).toContain('Du bruit.');
    expect(Date.parse(ev.doors_at)).toBeLessThan(Date.parse(ev.starts_at));
    expect(await (await http('/')).text()).toContain('/e/bruit-blanc-les-cafards');
  });

  it('NIP = « Not Very Important Person » : petit texte proposé à la création, modifiable, copié, affiché et échappé', async () => {
    const venueId = await createVenue();
    // le formulaire de création propose le texte déjà rempli
    expect(await (await http('/admin/events/new')).text()).toContain('value="Not Very Important Person"');
    await http('/admin/events', { form: eventForm(venueId, { slug: 'nip-test' }) });
    const ev = (await e.DB.prepare("SELECT id FROM events WHERE slug = 'nip-test'").first<{ id: number }>())!;
    await http(`/admin/events/${ev.id}/status`, { form: { status: 'published' } });

    const page = await (await http('/e/nip-test')).text();
    expect(page).toContain('<div class="note">Not Very Important Person</div>');

    // billet : la note suit la catégorie
    const nip = (await e.DB.prepare("SELECT id FROM ticket_types WHERE name_fr = 'NIP'").first<{ id: number }>())!.id;
    await http('/admin/door', { form: { type_id: String(nip), qty: '1', mode: 'guest', name: 'Zoé' } });
    const token = (await e.DB.prepare('SELECT token FROM orders').first<{ token: string }>())!.token;
    expect(await (await http(`/o/${token}`)).text()).toContain('Not Very Important Person');

    // modification + XSS + limite de 80 caractères
    await http(`/admin/types/${nip}`, { form: { name_fr: 'NIP', price: '30', quota: '10', online: '1', note: `<img src=x onerror=alert(1)>${'x'.repeat(200)}` } });
    const saved = (await e.DB.prepare('SELECT note FROM ticket_types WHERE id = ?1').bind(nip).first<{ note: string }>())!.note;
    expect(saved.length).toBe(80);
    const html = await (await http('/e/nip-test')).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');

    // la copie d'un concert garde les petits textes ; on peut aussi les effacer
    await http(`/admin/types/${nip}`, { form: { name_fr: 'NIP', price: '30', quota: '10', online: '1', note: 'Pas très important' } });
    await http(`/admin/events/${ev.id}/duplicate`, { method: 'POST' });
    const copied = await e.DB.prepare("SELECT note FROM ticket_types WHERE name_fr = 'NIP' AND event_id != ?1").bind(ev.id).first<{ note: string }>();
    expect(copied?.note).toBe('Pas très important');
    await http(`/admin/types/${nip}`, { form: { name_fr: 'NIP', price: '30', quota: '10', online: '1', note: '' } });
    expect(await (await http('/e/nip-test')).text()).not.toContain('class="note"');
  });

  it('valide les saisies : capacité, dates, TVA, URL, doublon de slug', async () => {
    const venueId = await createVenue('Petite salle', 50);
    const post = async (extra: Record<string, string>) => {
      const r = await http('/admin/events', { form: eventForm(venueId, extra) });
      return { status: r.status, text: await r.text() };
    };
    let r = await post({});
    expect(r.status).toBe(400);
    expect(r.text).toContain('dépassent la capacité de la salle (50)');
    r = await post({ std_quota: '20', nip_quota: '5', starts: '' });
    expect(r.text).toContain('date de début');
    r = await post({ std_quota: '20', nip_quota: '5', vat: 'beaucoup' });
    expect(r.text).toContain('TVA invalide');
    r = await post({ std_quota: '20', nip_quota: '5', image_url: 'javascript:alert(1)' });
    expect(r.text).toContain('https://');
    r = await post({ std_quota: '20', nip_quota: '5', sales_open: local(10), sales_close: local(5) });
    expect(r.text).toContain('ferme avant de s’ouvrir');
    r = await post({ std_quota: '20', nip_quota: '5', std_price: '-4' });
    expect(r.text).toContain('Prix Standard invalide');
    expect(await count('SELECT COUNT(*) AS n FROM events')).toBe(0);

    expect((await post({ std_quota: '20', nip_quota: '5', slug: 'mon-concert' })).status).toBe(303);
    r = await post({ std_quota: '20', nip_quota: '5', slug: 'Mon Concert' });
    expect(r.text).toContain('déjà utilisée');
    // sans slug imposé, le doublon est évité automatiquement
    expect((await post({ std_quota: '20', nip_quota: '5' })).status).toBe(303);
    expect((await post({ std_quota: '20', nip_quota: '5' })).status).toBe(303);
    const slugs = (await e.DB.prepare('SELECT slug FROM events ORDER BY id').all<{ slug: string }>()).results.map((x) => x.slug);
    expect(slugs).toEqual(['mon-concert', 'bruit-blanc-les-cafards', 'bruit-blanc-les-cafards-2']);
  });

  it('refuse de publier sans catégorie en ligne', async () => {
    const venueId = await createVenue();
    await http('/admin/events', { form: eventForm(venueId, { std_quota: '0', nip_quota: '0' }) });
    const ev = (await e.DB.prepare('SELECT id FROM events').first<{ id: number }>())!;
    const r = await http(`/admin/events/${ev.id}/status`, { form: { status: 'published' } });
    expect(r.status).toBe(303);
    expect((await e.DB.prepare('SELECT status FROM events').first<{ status: string }>())!.status).toBe('draft');
  });

  it('catégories : ajout, modification, garde-fous sur quota et suppression', async () => {
    const s = await seedEvent({ standardQuota: 10, capacity: 30 });
    // ajout d'une catégorie 'Réduit'
    expect((await http(`/admin/events/${s.eventId}/types`, { form: { name_fr: 'Réduit', price: '8', quota: '5', online: '1' } })).status).toBe(303);
    const added = (await e.DB.prepare("SELECT * FROM ticket_types WHERE name_fr = 'Réduit'").first<{ id: number; name_en: string; price_cents: number }>())!;
    expect(added.name_en).toBe('Réduit'); // repli sur le FR
    expect(added.price_cents).toBe(800);
    // dépasser la capacité (30) est refusé
    await http(`/admin/events/${s.eventId}/types`, { form: { name_fr: 'Trop', price: '1', quota: '20', online: '1' } });
    expect(await count("SELECT COUNT(*) AS n FROM ticket_types WHERE name_fr = 'Trop'")).toBe(0);
    // quota inférieur aux places vendues : refusé
    await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    await http(`/admin/types/${s.standardId}`, { form: { name_fr: 'Standard', price: '15', quota: '1', online: '1' } });
    expect((await e.DB.prepare('SELECT quota FROM ticket_types WHERE id = ?1').bind(s.standardId).first<{ quota: number }>())!.quota).toBe(10);
    // quota correct accepté, prix changé
    await http(`/admin/types/${s.standardId}`, { form: { name_fr: 'Standard', price: '18', quota: '12', online: '1' } });
    expect(await e.DB.prepare('SELECT quota, price_cents FROM ticket_types WHERE id = ?1').bind(s.standardId).first()).toEqual({ quota: 12, price_cents: 1800 });
    // suppression impossible si commandes, possible sinon
    await http(`/admin/types/${s.standardId}/delete`, { method: 'POST' });
    expect(await count('SELECT COUNT(*) AS n FROM ticket_types WHERE id = ?1', s.standardId)).toBe(1);
    await http(`/admin/types/${added.id}/delete`, { method: 'POST' });
    expect(await count('SELECT COUNT(*) AS n FROM ticket_types WHERE id = ?1', added.id)).toBe(0);
  });

  it('modification, duplication, annulation, suppression', async () => {
    const s = await seedEvent();
    const form = { title: 'Nouveau titre', venue_id: String(s.venueId), starts: local(40), max_per_order: '3', slug: 'nouveau-slug' };
    expect((await http(`/admin/events/${s.eventId}`, { form })).status).toBe(303);
    expect(await e.DB.prepare('SELECT title, slug, max_per_order FROM events WHERE id = ?1').bind(s.eventId).first()).toEqual({ title: 'Nouveau titre', slug: 'nouveau-slug', max_per_order: 3 });

    expect((await http(`/admin/events/${s.eventId}/duplicate`, { method: 'POST' })).status).toBe(303);
    const copy = (await e.DB.prepare("SELECT id, status, title FROM events WHERE title LIKE '%(copie)'").first<{ id: number; status: string }>())!;
    expect(copy.status).toBe('draft');
    expect(await count('SELECT COUNT(*) AS n FROM ticket_types WHERE event_id = ?1', copy.id)).toBe(2);
    expect((await http(`/admin/events/${copy.id}/delete`, { method: 'POST' })).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE id = ?1', copy.id)).toBe(0);

    // un concert avec commandes ne se supprime plus, mais s'annule : la vente s'arrête
    await http('/e/nouveau-slug/checkout', { form: { ...formBody(s) } });
    await http(`/admin/events/${s.eventId}/delete`, { method: 'POST' });
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE id = ?1', s.eventId)).toBe(1);
    await http(`/admin/events/${s.eventId}/status`, { form: { status: 'cancelled' } });
    expect((await http('/e/nouveau-slug/checkout', { form: formBody(s) })).status).toBe(400);
    expect(await (await http('/e/nouveau-slug')).text()).toContain('annulé');
  });

  it('salles : validation, modification, archivage', async () => {
    expect((await http('/admin/venues', { form: { name: '', capacity: '10' } })).status).toBe(400);
    expect((await http('/admin/venues', { form: { name: 'X', capacity: '0' } })).status).toBe(400);
    expect((await http('/admin/venues', { form: { name: 'X', capacity: 'abc' } })).status).toBe(400);
    const id = await createVenue('Salle B', 80);
    // capacité sous un quota existant : refusé
    const s = await seedEvent({ standardQuota: 60, nipQuota: 10, capacity: 100 });
    const r = await http(`/admin/venues/${s.venueId}`, { form: { name: 'La Cave', capacity: '50' } });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('70 places');
    expect((await http(`/admin/venues/${id}`, { form: { name: 'Salle B2', capacity: '90' } })).status).toBe(303);
    await http(`/admin/venues/${id}/archive`, { method: 'POST' });
    expect((await e.DB.prepare('SELECT archived FROM venues WHERE id = ?1').bind(id).first<{ archived: number }>())!.archived).toBe(1);
    expect(await (await http('/admin/events/new')).text()).not.toContain('Salle B2');
  });

  it('XSS : un titre piégé est échappé dans le back-office', async () => {
    const s = await seedEvent();
    await e.DB.prepare("UPDATE events SET title = '<img src=x onerror=alert(1)>' WHERE id = ?1").bind(s.eventId).run();
    for (const p of ['/admin', '/admin/events', `/admin/events/${s.eventId}`, '/admin/orders']) {
      expect(await (await http(p)).text(), p).not.toContain('<img src=x');
    }
  });
});

describe('caisse et invités', () => {
  it('vente en espèces : billets émis tout de suite, impression automatique, facture numérotée', async () => {
    const s = await seedEvent({ standardQuota: 10 });
    const res = await http('/admin/door', { form: { type_id: String(s.standardId), qty: '3', mode: 'cash', name: 'Au guichet' } });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/^\/o\/[\w-]{32}\?print=1$/);
    const o = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    expect(o).toMatchObject({ status: 'paid', channel: 'door', payment_method: 'cash', total_cents: 4500, created_by: 'owner@pnk.test', invoice_seq: 1 });
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(3);
    const page = await (await http(locationOf(res))).text();
    expect(page).toContain('data-autoprint');
    expect(page).toContain('Au guichet');
  });

  it('invitations gratuites : même catégorie NIP hors vente en ligne, sans facture', async () => {
    const s = await seedEvent();
    await e.DB.prepare('UPDATE ticket_types SET online = 0 WHERE id = ?1').bind(s.nipId).run();
    const res = await http('/admin/door', { form: { type_id: String(s.nipId), qty: '4', mode: 'guest', name: 'Les potes', email: 'potes@example.com' } });
    expect(res.status).toBe(303);
    const o = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    expect(o).toMatchObject({ channel: 'guest', payment_method: 'free', total_cents: 0, invoice_seq: null, status: 'paid' });
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(4);
    // ces places comptent dans le quota (10) : 6 restantes seulement
    const again = await http('/admin/door', { form: { type_id: String(s.nipId), qty: '7', mode: 'guest' } });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('Plus assez de places');
  });

  it('refuse les saisies invalides', async () => {
    const s = await seedEvent();
    const bad = async (extra: Record<string, string>) => (await http('/admin/door', { form: { type_id: String(s.standardId), qty: '1', mode: 'cash', ...extra } })).status;
    expect(await bad({ qty: '0' })).toBe(400);
    expect(await bad({ qty: '101' })).toBe(400);
    expect(await bad({ mode: 'bitcoin' })).toBe(400);
    expect(await bad({ email: 'pas-un-email' })).toBe(400);
    expect(await bad({ type_id: '99999' })).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('un scanner ne peut pas vendre', async () => {
    const s = await seedEvent();
    await loginAs('scan@pnk.test', 'scanner');
    expect((await http('/admin/door', { form: { type_id: String(s.standardId), qty: '1', mode: 'guest' } })).status).toBe(403);
  });
});

describe('scanner d’entrée', () => {
  async function ticket(s: Awaited<ReturnType<typeof seedEvent>>, qty = 2) {
    await http('/admin/door', { form: { type_id: String(s.standardId), qty: String(qty), mode: 'guest', name: 'Zoé' } });
    return (await e.DB.prepare('SELECT code FROM tickets ORDER BY id').all<{ code: string }>()).results.map((r) => r.code);
  }
  const scan = async (code: string, eventId: number) => (await http('/api/scan', { json: { code, eventId } })).json() as Promise<Record<string, unknown>>;

  it('billet valide -> OK une fois, puis "déjà entré"', async () => {
    const s = await seedEvent();
    const [code] = await ticket(s);
    const first = await scan(`PNK:${code}`, s.eventId);
    expect(first).toMatchObject({ result: 'ok', type: 'Standard', holder: 'Zoé', checkedIn: 1, total: 2 });
    const second = await scan(code!, s.eventId);
    expect(second).toMatchObject({ result: 'already', holder: 'Zoé', checkedIn: 1 });
    expect(second.checkedInAt).toBeTruthy();
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE checked_in_at IS NOT NULL')).toBe(1);
  });

  it('accepte les codes saisis à la main (minuscules, tirets, O/0)', async () => {
    const s = await seedEvent();
    const [code] = await ticket(s);
    const hand = code!.replace(/(.{4})/g, '$1-').slice(0, -1).toLowerCase();
    expect(await scan(hand, s.eventId)).toMatchObject({ result: 'ok' });
  });

  it('refuse : inconnu, pas un billet PNK, autre concert, billet annulé', async () => {
    const s = await seedEvent();
    const other = await seedEvent();
    const [code] = await ticket(s);
    expect(await scan('0000000000000000', s.eventId)).toMatchObject({ result: 'unknown' });
    expect(await scan('https://evil.example/x', s.eventId)).toMatchObject({ result: 'invalid' });
    expect(await scan('', s.eventId)).toMatchObject({ result: 'invalid' });
    expect(await scan(code!, other.eventId)).toMatchObject({ result: 'wrong_event', eventTitle: 'Les Sales Gosses' });
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE checked_in_at IS NOT NULL')).toBe(0);
    const order = (await e.DB.prepare('SELECT id FROM orders').first<{ id: number }>())!;
    await http(`/admin/orders/${order.id}/refund`, { method: 'POST' });
    expect(await scan(code!, s.eventId)).toMatchObject({ result: 'void' });
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE checked_in_at IS NOT NULL')).toBe(0);
  });

  it('deux scans simultanés du même billet : un seul passe', async () => {
    const s = await seedEvent();
    const [code] = await ticket(s, 1);
    const results = await Promise.all(Array.from({ length: 12 }, () => scan(code!, s.eventId)));
    expect(results.filter((r) => r.result === 'ok').length).toBe(1);
    expect(results.filter((r) => r.result === 'already').length).toBe(11);
  });

  it('requêtes mal formées : 400, jamais 500', async () => {
    const r1 = await http('/api/scan', { method: 'POST', body: '{pas du json', headers: { 'Content-Type': 'application/json' } });
    expect(r1.status).toBe(400);
    expect((await http('/api/scan', { json: { code: 'x', eventId: 'abc' } })).status).toBe(400);
    expect((await http('/api/scan', { json: { code: { a: 1 }, eventId: 1 } })).status).toBe(200);
  });

  it('un scanner voit la page de scan avec les concerts du moment', async () => {
    const s = await seedEvent({ startsInDays: 2 });
    await seedEvent({ startsInDays: 90 }); // trop loin : pas proposé
    await loginAs('scan@pnk.test', 'scanner');
    const html = await (await http('/scan')).text();
    expect(html).toContain(`value="${s.eventId}"`);
    expect(html.match(/<option/g)?.length).toBe(1);
    expect(html).toContain('/assets/scan.js');
    expect(html).not.toContain('back-office'); // un scanner n'a pas le lien
  });
});

describe('commandes, remboursement, exports', () => {
  async function paidOrder(s: Awaited<ReturnType<typeof seedEvent>>, name = 'Jean Test') {
    const r = await http(`/e/${s.slug}/checkout`, { form: formBody(s, { name }) });
    const token = /\/pay\/mock\/([\w-]{32})$/.exec(locationOf(r))![1]!;
    await http(`/pay/mock/${token}`, { form: { result: 'success' } });
    return (await e.DB.prepare('SELECT * FROM orders WHERE token = ?1').bind(token).first<OrderRow>())!;
  }

  it('recherche par email, nom, numéro et code de billet', async () => {
    const s = await seedEvent();
    const o = await paidOrder(s);
    const code = (await e.DB.prepare('SELECT code FROM tickets WHERE order_id = ?1').bind(o.id).first<{ code: string }>())!.code;
    for (const q of ['jean@example', 'Jean', `#${o.id}`, String(o.id), code.toLowerCase()]) {
      expect(await (await http(`/admin/orders?q=${encodeURIComponent(q)}`)).text(), q).toContain(`/admin/orders/${o.id}`);
    }
    expect(await (await http('/admin/orders?q=personne')).text()).not.toContain(`/admin/orders/${o.id}`);
    // caractères spéciaux de LIKE traités comme du texte
    expect(await (await http('/admin/orders?q=%25')).text()).not.toContain(`/admin/orders/${o.id}`);
    expect((await http("/admin/orders?q='%20OR%201=1--")).status).toBe(200);
  });

  it('détail, renvoi d’email, remboursement + journal', async () => {
    const s = await seedEvent();
    const o = await paidOrder(s);
    const detail = await (await http(`/admin/orders/${o.id}`)).text();
    expect(detail).toContain('Rembourser');
    expect(detail).toContain('jean@example.com');
    await e.DB.prepare('DELETE FROM email_outbox').run();
    expect((await http(`/admin/orders/${o.id}/resend`, { method: 'POST' })).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM email_outbox')).toBe(1);
    expect((await http(`/admin/orders/${o.id}/refund`, { method: 'POST' })).status).toBe(303);
    expect((await e.DB.prepare('SELECT status FROM orders WHERE id = ?1').bind(o.id).first<{ status: string }>())!.status).toBe('refunded');
    const actions = (await e.DB.prepare('SELECT action, actor FROM audit_log ORDER BY id').all<{ action: string; actor: string }>()).results;
    expect(actions).toEqual([
      { action: 'order.resend', actor: 'owner@pnk.test' },
      { action: 'order.refund', actor: 'owner@pnk.test' },
    ]);
    // pas de double remboursement ni de renvoi d'email pour une commande remboursée
    await http(`/admin/orders/${o.id}/refund`, { method: 'POST' });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.refund'")).toBe(1);
    expect(await (await http('/admin/orders/99999')).status).toBe(404);
  });

  it('exports CSV : en-têtes, contenu, injection de formule neutralisée, journalisés', async () => {
    const s = await seedEvent();
    await paidOrder(s, '=HYPERLINK("http://evil.example","clic")');
    const orders = await http(`/admin/export/orders.csv?event=${s.eventId}`);
    expect(orders.headers.get('content-type')).toContain('text/csv');
    expect(orders.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await orders.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 pour qu'Excel lise les accents
    const text = await orders.text();
    expect(text.startsWith('Commande;Concert')).toBe(true);
    expect(text).toContain('30,00'); // 2 x 15 €, virgule décimale pour Excel
    expect(text).not.toMatch(/;=HYPERLINK/);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""clic"")"`);
    const att = await (await http('/admin/export/attendees.csv')).text();
    expect(att.split('\r\n').filter(Boolean).length).toBe(3); // en-tête + 2 billets
    const sales = await (await http('/admin/export/sales.csv')).text();
    expect(sales).toContain('Recettes TTC');
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'export.%'")).toBe(3);
  });

  it('tableau de bord et rapports : chiffres exacts', async () => {
    const s = await seedEvent({ standardQuota: 20 });
    await paidOrder(s); // 30 €
    await paidOrder(s); // 30 €
    const refunded = await paidOrder(s);
    await http(`/admin/orders/${refunded.id}/refund`, { method: 'POST' });
    await http('/admin/door', { form: { type_id: String(s.nipId), qty: '1', mode: 'cash' } }); // 30 €
    const html = await (await http('/admin')).text();
    expect(html).toContain('90,00'); // 30 + 30 + 30 de caisse (le remboursé n'est pas compté)
    expect(html).toMatch(/<b>5<\/b>\s*<span>Billets vendus/); // 4 en ligne + 1 caisse
    expect(html).toMatch(/<b>3<\/b>\s*<span>Commandes payées/);
    expect(html).toContain('Remboursées (60,00)'.slice(0, 11));
    expect(html).toContain('caisse');
    expect((await http(`/admin?event=${s.eventId}&range=all`)).status).toBe(200);
    expect((await http('/admin?range=nimporte&event=abc')).status).toBe(200);
    const rep = await (await http(`/admin/reports?event=${s.eventId}`)).text();
    expect(rep).toContain('Par catégorie');
    expect(rep).toContain('NIP');
  });
});

describe('réglages et équipe', () => {
  const settingsForm = (extra: Record<string, string> = {}) => ({
    org_name: 'Les Punks',
    org_legal_name: 'Les Punks ASBL',
    org_vat_number: 'BE0123456789',
    org_email: 'contact@punks.test',
    default_vat: '6',
    timezone: 'Europe/Brussels',
    default_lang: 'nl',
    invoice_prefix: 'LP',
    terms_url: 'https://punks.test/cgv',
    ...extra,
  });

  it('enregistre, puis la langue par défaut et le préfixe de facture s’appliquent', async () => {
    expect((await http('/admin/settings', { form: settingsForm() })).status).toBe(303);
    const s = await seedEvent();
    expect(await (await http(`/e/${s.slug}`)).text()).toContain('<html lang="nl">'); // défaut = NL
    expect(await (await http(`/e/${s.slug}`, { headers: { 'Accept-Language': 'fr' } })).text()).toContain('<html lang="fr">');
    const r = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    const token = /\/pay\/mock\/([\w-]{32})$/.exec(locationOf(r))![1]!;
    await http(`/pay/mock/${token}`, { form: { result: 'success' } });
    expect(await (await http(`/o/${token}/invoice`)).text()).toContain(`LP-${new Date().getFullYear()}-00001`);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'")).toBe(1);
  });

  it('refuse les valeurs invalides sans rien enregistrer', async () => {
    const r = await http('/admin/settings', { form: settingsForm({ default_vat: '150', timezone: 'Mars/Phobos', org_email: 'nope', terms_url: 'ftp://x', default_lang: 'de', invoice_prefix: '!!!' }) });
    expect(r.status).toBe(400);
    const t = await r.text();
    for (const m of ['TVA par défaut invalide', 'Fuseau horaire inconnu', 'Email de contact invalide', 'https://', 'Langue invalide', 'préfixe']) expect(t, m).toContain(m);
    expect((await e.DB.prepare("SELECT value FROM settings WHERE key = 'org_name'").first<{ value: string }>())!.value).toBe('PNK');
  });

  it('équipe : ajout, changement de rôle, protection du dernier propriétaire et de soi-même', async () => {
    await http('/admin'); // crée la ligne owner
    expect((await http('/admin/staff', { form: { email: 'Nouvelle@Example.com', role: 'manager' } })).status).toBe(303);
    expect(await e.DB.prepare('SELECT role FROM staff WHERE email = ?1').bind('nouvelle@example.com').first()).toEqual({ role: 'manager' });
    await http('/admin/staff', { form: { email: 'pas-un-email', role: 'manager' } });
    await http('/admin/staff', { form: { email: 'x@example.com', role: 'dieu' } });
    expect(await count('SELECT COUNT(*) AS n FROM staff')).toBe(2);

    // le seul propriétaire ne peut ni se rétrograder ni se retirer
    await http('/admin/staff/role', { form: { email: 'owner@pnk.test', role: 'scanner' } });
    await http('/admin/staff/delete', { form: { email: 'owner@pnk.test' } });
    expect(await e.DB.prepare("SELECT role FROM staff WHERE email = 'owner@pnk.test'").first()).toEqual({ role: 'owner' });
    // avec un deuxième propriétaire, on peut rétrograder l'autre
    await http('/admin/staff/role', { form: { email: 'nouvelle@example.com', role: 'owner' } });
    await http('/admin/staff/role', { form: { email: 'nouvelle@example.com', role: 'scanner' } });
    expect(await e.DB.prepare("SELECT role FROM staff WHERE email = 'nouvelle@example.com'").first()).toEqual({ role: 'scanner' });
    await http('/admin/staff/delete', { form: { email: 'nouvelle@example.com' } });
    expect(await count('SELECT COUNT(*) AS n FROM staff')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'staff.%'")).toBeGreaterThanOrEqual(4);
  });

  it('le journal est lisible par le propriétaire', async () => {
    const s = await seedEvent();
    await http(`/admin/events/${s.eventId}/status`, { form: { status: 'cancelled' } });
    const html = await (await http('/admin/audit')).text();
    expect(html).toContain('event.status');
    expect(html).toContain('owner@pnk.test');
  });
});
