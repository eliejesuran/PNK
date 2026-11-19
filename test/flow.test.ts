// SPDX-License-Identifier: AGPL-3.0-or-later
// Parcours d'achat de bout en bout, dans le vrai runtime Workers avec une vraie base D1 locale.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacHex } from '../src/lib/ids';
import { fulfillOrder, getOrderById, refundOrder } from '../src/services/orders';
import { expireStaleOrders } from '../src/services/orders';
import type { OrderRow } from '../src/services/types';
import { e, formBody, http, locationOf, resetData, seedEvent, type Seed } from './helpers';

const BASE = 'http://localhost';

async function checkout(seed: Seed, extra: Record<string, string> = {}): Promise<Response> {
  return http(`/e/${seed.slug}/checkout`, { form: formBody(seed, extra) });
}

/** Passe commande avec le faux paiement et renvoie le jeton de la commande. */
async function placeOrder(seed: Seed, extra: Record<string, string> = {}): Promise<string> {
  const res = await checkout(seed, extra);
  expect(res.status, await res.clone().text()).toBe(303);
  const m = /\/pay\/mock\/([\w-]{32})$/.exec(locationOf(res));
  expect(m, locationOf(res)).toBeTruthy();
  return m![1]!;
}

const pay = (token: string) => http(`/pay/mock/${token}`, { form: { result: 'success' } });
const orderByToken = (token: string) => e.DB.prepare('SELECT * FROM orders WHERE token = ?1').bind(token).first<OrderRow>();
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

beforeEach(async () => {
  await resetData();
});

describe('pages publiques', () => {
  it('accueil : liste les concerts publiés, cache les brouillons', async () => {
    const pub = await seedEvent({ slug: 'publie' });
    await seedEvent({ slug: 'brouillon', status: 'draft' });
    const html = await (await http('/')).text();
    expect(html).toContain('Les Sales Gosses');
    expect(html).toContain(`/e/${pub.slug}`);
    expect(html).not.toContain('/e/brouillon');
  });

  it('page concert : infos, catégories, prix ; 404 pour inconnu et brouillon', async () => {
    const s = await seedEvent({ slug: 'page-test' });
    const res = await http(`/e/${s.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Standard');
    expect(html).toContain('NIP');
    expect(html).toMatch(/15,00/);
    expect(html).toContain('La Cave');
    expect((await http('/e/n-existe-pas')).status).toBe(404);
    await seedEvent({ slug: 'cache', status: 'draft' });
    expect((await http('/e/cache')).status).toBe(404);
  });

  it('langue : ?lang=nl traduit la page et pose un cookie', async () => {
    const s = await seedEvent();
    const res = await http(`/e/${s.slug}?lang=nl`);
    const html = await res.text();
    expect(html).toContain('<html lang="nl">');
    expect(html).toContain('Betalen');
    expect(res.headers.get('set-cookie')).toContain('pnk_lang=nl');
    const en = await (await http(`/e/${s.slug}`, { headers: { 'Accept-Language': 'en-GB,en;q=0.9' } })).text();
    expect(en).toContain('Terms of sale'.slice(0, 0) + 'Tickets');
    expect(en).toContain('<html lang="en">');
  });

  it('en-têtes de sécurité présents', async () => {
    const res = await http('/');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('aucun style inline (la CSP les bloquerait)', async () => {
    const s = await seedEvent();
    for (const path of ['/', `/e/${s.slug}`]) {
      expect(await (await http(path)).text(), path).not.toMatch(/\sstyle="/);
    }
  });
});

describe('achat', () => {
  it('refuse sans billet, sans nom, avec un mauvais email, sans conditions', async () => {
    const s = await seedEvent();
    const bad = async (extra: Record<string, string>) => {
      const r = await checkout(s, extra);
      expect(r.status).toBe(400);
      return r.text();
    };
    expect(await bad({ [`qty_${s.standardId}`]: '0' })).toContain('au moins un billet');
    expect(await bad({ name: '' })).toContain('ton nom');
    expect(await bad({ email: 'pas-un-email' })).toContain('ne ressemble pas');
    expect(await bad({ terms: '' })).toContain('conditions de vente');
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('garde les valeurs saisies quand le formulaire est refusé', async () => {
    const s = await seedEvent();
    const html = await (await checkout(s, { email: 'oops', name: 'Zoé "<b>" Test' })).text();
    expect(html).toContain('Zoé &quot;&lt;b&gt;&quot; Test'); // échappé
    expect(html).not.toContain('<b>" Test');
  });

  it('réserve les places pendant le paiement puis émet les billets', async () => {
    const s = await seedEvent({ standardQuota: 10 });
    const token = await placeOrder(s);
    let o = (await orderByToken(token))!;
    expect(o.status).toBe('pending');
    expect(o.total_cents).toBe(3000);
    expect(o.provider).toBe('mock');
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(0);
    // 2 places sont retenues : il en reste 8
    expect(await (await http(`/e/${s.slug}`)).text()).toContain('value="0" data-price="1500"');

    const res = await pay(token);
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`/o/${token}`);
    o = (await orderByToken(token))!;
    expect(o.status).toBe('paid');
    expect(o.invoice_seq).toBe(1);
    expect(o.invoice_year).toBe(new Date().getFullYear());
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);

    const page = await (await http(`/o/${token}`)).text();
    expect(page).toContain('t’es dedans');
    expect(page).toContain('<svg class="qr"');
    expect(page).toContain('Jean Test');
    // email de confirmation journalisé
    await vi.waitFor(async () => expect(await count("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'sent' AND to_email = 'jean@example.com'")).toBe(1));
    const mail = (await e.DB.prepare('SELECT subject, html, text FROM email_outbox').first<{ subject: string; html: string; text: string }>())!;
    expect(mail.subject).toBe('Tes billets pour Les Sales Gosses');
    expect(mail.html).toContain(`${BASE}/o/${token}`);
    expect(mail.html).toContain('/q/');
    expect(mail.text).toContain(`${BASE}/o/${token}/invoice`);
  });

  it('facture : numéro, HT/TVA/TTC, mentions vendeur et acheteur', async () => {
    await e.DB.prepare("UPDATE settings SET value = 'Les Punks ASBL' WHERE key = 'org_legal_name'").run();
    await e.DB.prepare("UPDATE settings SET value = 'BE0123.456.789' WHERE key = 'org_vat_number'").run();
    const s = await seedEvent();
    const token = await placeOrder(s, { billing_name: 'ACME SPRL', billing_vat: 'BE0999.999.999', billing_address: '1 rue X\n1000 Bruxelles' });
    await pay(token);
    const html = await (await http(`/o/${token}/invoice`)).text();
    const year = new Date().getFullYear();
    expect(html).toContain(`PNK-${year}-00001`);
    expect(html).toContain('Les Punks ASBL');
    expect(html).toContain('BE0123.456.789');
    expect(html).toContain('ACME SPRL');
    expect(html).toContain('BE0999.999.999');
    expect(html).toMatch(/28,30/); // HT de 30,00 TTC à 6 %
    expect(html).toMatch(/1,70/); // TVA
    expect(html).toContain('TVA 6 %');
  });

  it('numérotation des factures continue sans doublon', async () => {
    const s = await seedEvent();
    const tokens = [await placeOrder(s), await placeOrder(s), await placeOrder(s)];
    for (const t of tokens) await pay(t);
    const rows = await e.DB.prepare('SELECT invoice_seq FROM orders ORDER BY invoice_seq').all<{ invoice_seq: number }>();
    expect(rows.results.map((r) => r.invoice_seq)).toEqual([1, 2, 3]);
  });

  it('billets gratuits : validés tout de suite, pas de facture', async () => {
    const s = await seedEvent({ standardCents: 0 });
    const res = await checkout(s);
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/^\/o\/[\w-]{32}$/);
    const o = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    expect(o.status).toBe('paid');
    expect(o.payment_method).toBe('free');
    expect(o.invoice_seq).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(2);
    expect(await (await http(`${locationOf(res)}/invoice`)).text()).toContain('Pas de facture');
  });

  it('respecte le maximum par commande', async () => {
    const s = await seedEvent();
    const r = await checkout(s, { [`qty_${s.standardId}`]: '7' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Maximum 6 billets');
  });

  it('refuse l’achat hors période de vente', async () => {
    const s = await seedEvent();
    await e.DB.prepare('UPDATE events SET sales_open_at = ?1 WHERE id = ?2').bind(new Date(Date.now() + 86400_000).toISOString(), s.eventId).run();
    expect((await checkout(s)).status).toBe(400);
    await e.DB.prepare('UPDATE events SET sales_open_at = NULL, status = ?1 WHERE id = ?2').bind('cancelled', s.eventId).run();
    expect((await checkout(s)).status).toBe(400);
    await e.DB.prepare("UPDATE events SET status = 'published', sales_close_at = ?1 WHERE id = ?2").bind(new Date(Date.now() - 1000).toISOString(), s.eventId).run();
    expect((await checkout(s)).status).toBe(400);
  });

  it('ignore une catégorie hors vente en ligne', async () => {
    const s = await seedEvent();
    await e.DB.prepare('UPDATE ticket_types SET online = 0 WHERE id = ?1').bind(s.nipId).run();
    const r = await checkout(s, { [`qty_${s.standardId}`]: '0', [`qty_${s.nipId}`]: '2' });
    expect(r.status).toBe(400); // aucune ligne valide
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('un prix modifié entre la page et l’achat ne passe pas à l’ancien tarif', async () => {
    const s = await seedEvent();
    const before = await placeOrder(s);
    await e.DB.prepare('UPDATE ticket_types SET price_cents = 2000 WHERE id = ?1').bind(s.standardId).run();
    const after = await placeOrder(s);
    expect((await orderByToken(before))!.total_cents).toBe(3000);
    expect((await orderByToken(after))!.total_cents).toBe(4000);
  });
});

describe('stock : jamais de survente', () => {
  it('refuse quand il ne reste pas assez de places (réservations comprises)', async () => {
    const s = await seedEvent({ standardQuota: 3 });
    await placeOrder(s); // 2 réservées
    const r = await checkout(s); // 2 demandées, 1 dispo
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Plus assez de places pour « Standard »');
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(1); // la commande échouée est nettoyée
    const ok = await checkout(s, { [`qty_${s.standardId}`]: '1' });
    expect(ok.status).toBe(303);
  });

  it('20 achats simultanés pour 5 places : exactement 5 réussissent', async () => {
    const s = await seedEvent({ standardQuota: 5 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => checkout(s, { [`qty_${s.standardId}`]: '1', email: `p${i}@example.com` })),
    );
    const ok = results.filter((r) => r.status === 303).length;
    const sold = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(5);
    expect(sold).toBe(15);
    expect(await count("SELECT COALESCE(SUM(qty),0) AS n FROM order_items")).toBe(5);
  });

  it('commande multi-catégories : tout ou rien', async () => {
    const s = await seedEvent({ standardQuota: 10, nipQuota: 1 });
    const r = await checkout(s, { [`qty_${s.standardId}`]: '2', [`qty_${s.nipId}`]: '2' });
    expect(r.status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM order_items')).toBe(0);
  });

  it('les réservations expirées libèrent les places', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    const token = await placeOrder(s);
    expect((await checkout(s)).status).toBe(409);
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(token).run();
    // même avant le passage du cron, une réservation expirée ne compte plus
    expect((await checkout(s)).status).toBe(303);
    expect(await expireStaleOrders(e.DB, new Date().toISOString())).toBe(1);
    expect((await orderByToken(token))!.status).toBe('expired');
  });

  it('annulation par l’acheteur : libère les places', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    const token = await placeOrder(s);
    const res = await http(`/o/${token}/cancel`, { method: 'POST' });
    expect(res.status).toBe(303);
    expect((await orderByToken(token))!.status).toBe('cancelled');
    expect((await checkout(s)).status).toBe(303);
  });

  it('paiement tardif : places encore libres -> la commande est honorée', async () => {
    const s = await seedEvent({ standardQuota: 4 });
    const token = await placeOrder(s);
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(token).run();
    await expireStaleOrders(e.DB, new Date().toISOString());
    await pay(token);
    const o = (await orderByToken(token))!;
    expect(o.status).toBe('paid');
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);
  });

  it('paiement tardif : plus de place -> remboursement automatique, aucun billet', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    const late = await placeOrder(s);
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(late).run();
    await expireStaleOrders(e.DB, new Date().toISOString());
    const winner = await placeOrder(s); // quelqu'un d'autre prend les 2 places
    await pay(winner);
    await pay(late); // paie trop tard
    const o = (await orderByToken(late))!;
    expect(o.status).toBe('refunded');
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tickets")).toBe(2); // seulement ceux du gagnant
    await vi.waitFor(async () => expect(await count("SELECT COUNT(*) AS n FROM email_outbox WHERE subject LIKE '%remboursée automatiquement%'")).toBe(1));
  });

  it('émission idempotente : 10 confirmations simultanées = un seul jeu de billets', async () => {
    const s = await seedEvent({ standardQuota: 10 });
    const token = await placeOrder(s, {});
    const o = (await orderByToken(token))!;
    const results = await Promise.all(Array.from({ length: 10 }, () => fulfillOrder(e, o.id, { baseUrl: BASE, providerPaymentId: 'pi_x' })));
    expect(results.filter((r) => r.kind === 'paid' && r.justPaid).length).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);
    expect((await orderByToken(token))!.invoice_seq).toBe(1);
    await vi.waitFor(async () => expect(await count('SELECT COUNT(*) AS n FROM email_outbox')).toBe(1)); // un seul email
  });
});

describe('webhook Stripe', () => {
  async function stripeOrder(s: Seed): Promise<OrderRow> {
    const token = await placeOrder(s);
    await e.DB.prepare("UPDATE orders SET provider = 'stripe', provider_session_id = 'cs_test_123' WHERE token = ?1").bind(token).run();
    return (await orderByToken(token))!;
  }
  async function send(body: object, opts: { secret?: string; ts?: number; noSig?: boolean } = {}): Promise<Response> {
    const payload = JSON.stringify(body);
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const sig = await hmacHex(opts.secret ?? 'whsec_test_secret', `${ts}.${payload}`);
    return http('/webhooks/stripe', { method: 'POST', body: payload, headers: opts.noSig ? {} : { 'Stripe-Signature': `t=${ts},v1=${sig}` } });
  }
  const completed = (o: OrderRow, id = 'evt_1', status = 'paid') => ({
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123', client_reference_id: String(o.id), payment_status: status, payment_intent: 'pi_123' } },
  });

  it('refuse les signatures absentes, fausses ou périmées', async () => {
    const s = await seedEvent();
    const o = await stripeOrder(s);
    expect((await send(completed(o), { noSig: true })).status).toBe(400);
    expect((await send(completed(o), { secret: 'faux' })).status).toBe(400);
    expect((await send(completed(o), { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
    expect((await getOrderById(e.DB, o.id))!.status).toBe('pending');
  });

  it('paiement confirmé : billets émis, idempotent aux rejeux', async () => {
    const s = await seedEvent();
    const o = await stripeOrder(s);
    expect((await send(completed(o))).status).toBe(200);
    expect((await send(completed(o))).status).toBe(200); // rejeu de Stripe
    const paid = (await getOrderById(e.DB, o.id))!;
    expect(paid.status).toBe('paid');
    expect(paid.provider_payment_id).toBe('pi_123');
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM webhook_events')).toBe(1);
  });

  it('ignore un paiement non encore encaissé (moyen différé) puis le prend en compte', async () => {
    const s = await seedEvent();
    const o = await stripeOrder(s);
    await send(completed(o, 'evt_a', 'unpaid'));
    expect((await getOrderById(e.DB, o.id))!.status).toBe('pending');
    await send({ id: 'evt_b', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_test_123', client_reference_id: String(o.id), payment_intent: 'pi_9' } } });
    expect((await getOrderById(e.DB, o.id))!.status).toBe('paid');
  });

  it('refuse un évènement dont la session ne correspond pas à la commande', async () => {
    const s = await seedEvent();
    const o = await stripeOrder(s);
    const evil = completed(o);
    evil.data.object.id = 'cs_autre';
    expect((await send(evil)).status).toBe(200);
    expect((await getOrderById(e.DB, o.id))!.status).toBe('pending');
  });

  it('session expirée : libère les places', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    const o = await stripeOrder(s);
    await send({ id: 'evt_x', type: 'checkout.session.expired', data: { object: { id: 'cs_test_123', client_reference_id: String(o.id) } } });
    expect((await getOrderById(e.DB, o.id))!.status).toBe('expired');
    expect((await checkout(s)).status).toBe(303);
  });
});

describe('remboursement', () => {
  it('invalide les billets, prévient l’acheteur, libère les places', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    const token = await placeOrder(s);
    await pay(token);
    const o = (await orderByToken(token))!;
    expect((await checkout(s)).status).toBe(409); // complet
    const r = await refundOrder(e, o, 'owner@pnk.test');
    expect(r.ok).toBe(true);
    expect((await orderByToken(token))!.status).toBe('refunded');
    expect(await count("SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1 AND status = 'void'", o.id)).toBe(2);
    expect((await checkout(s)).status).toBe(303); // places libérées
    expect(await (await http(`/o/${token}`)).text()).toContain('ANNULÉ');
    const again = await refundOrder(e, (await orderByToken(token))!, 'owner@pnk.test');
    expect(again.ok).toBe(false); // pas deux fois
  });
});

describe('sécurité de l’accès public', () => {
  it('anti-CSRF : un POST sans origine propre est refusé', async () => {
    const s = await seedEvent();
    const body = new URLSearchParams(formBody(s)).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const evil = await http(`/e/${s.slug}/checkout`, { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const noOrigin = await http(`/e/${s.slug}/checkout`, { method: 'POST', body, headers: { ...headers, Origin: '' } });
    expect(noOrigin.status).toBe(403);
    const crossSite = await http(`/e/${s.slug}/checkout`, { method: 'POST', body, headers: { ...headers, Origin: '', 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('limite de débit : 12 commandes par fenêtre puis 429', async () => {
    const s = await seedEvent({ standardQuota: 100 });
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await http(`/e/${s.slug}/checkout`, { form: formBody(s, { [`qty_${s.standardId}`]: '1' }), headers: { 'cf-connecting-ip': '203.0.113.9' } });
      codes.push(r.status);
    }
    expect(codes.slice(0, 12).every((c) => c === 303)).toBe(true);
    expect(codes.slice(12)).toEqual([429, 429]);
  });

  it('jetons de commande invalides ou inconnus -> 404, jamais d’erreur 500', async () => {
    for (const p of ['/o/x', '/o/' + 'a'.repeat(32), '/o/..%2fadmin', '/o/' + 'a'.repeat(32) + '/invoice', '/o/%00']) {
      const res = await http(p);
      expect(res.status, p).toBe(404);
    }
  });

  it('faux paiement : introuvable hors développement', async () => {
    const s = await seedEvent();
    const token = await placeOrder(s);
    const saved = e.ENVIRONMENT;
    (e as { ENVIRONMENT?: string }).ENVIRONMENT = 'production';
    try {
      expect((await http(`/pay/mock/${token}`)).status).toBe(404);
      expect((await pay(token)).status).toBe(404);
      expect((await orderByToken(token))!.status).toBe('pending');
    } finally {
      (e as { ENVIRONMENT?: string }).ENVIRONMENT = saved;
    }
  });

  it('QR PNG : image pour un vrai billet, 404 sinon', async () => {
    const s = await seedEvent();
    const token = await placeOrder(s);
    await pay(token);
    const code = (await e.DB.prepare('SELECT code FROM tickets').first<{ code: string }>())!.code;
    const res = await http(`/q/${code}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(1, 4)]).toEqual([80, 78, 71]);
    expect((await http('/q/0000000000000000.png')).status).toBe(404);
    expect((await http('/q/../etc.png')).status).toBe(404);
  });

  it('XSS : le titre d’un concert est échappé partout', async () => {
    const s = await seedEvent();
    await e.DB.prepare("UPDATE events SET title = '<script>alert(1)</script>', subtitle = '\"><img src=x onerror=alert(1)>' WHERE id = ?1").bind(s.eventId).run();
    const token = await placeOrder(s);
    await pay(token);
    for (const p of ['/', `/e/${s.slug}`, `/o/${token}`, `/o/${token}/invoice`]) {
      const html = await (await http(p)).text();
      expect(html, p).not.toContain('<script>alert(1)');
      expect(html, p).not.toContain('<img src=x');
    }
  });
});
