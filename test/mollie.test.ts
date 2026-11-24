// SPDX-License-Identifier: AGPL-3.0-or-later
// Paiement Mollie : API simulée (on vérifie le contenu exact des requêtes), flux complet, sécurité de la notification.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScheduled } from '../src/index';
import { envGaps } from '../src/lib/auth';
import type { Env } from '../src/env';
import { expireStaleOrders, refundOrder } from '../src/services/orders';
import { getProvider } from '../src/services/payments';
import { MollieApiError, MollieProvider, mollieAmount } from '../src/services/payments/mollie';
import type { OrderRow } from '../src/services/types';
import { e, fakeFetch, formBody, http, json, locationOf, resetData, seedEvent, type Call, type Seed } from './helpers';

const env = e as unknown as Record<string, unknown>;
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const order = async (token: string) => (await e.DB.prepare('SELECT * FROM orders WHERE token = ?1').bind(token).first<OrderRow>())!;

const saved = { ...env };
beforeEach(async () => {
  await resetData();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['PAYMENT_PROVIDER', 'MOLLIE_API_KEY', 'BASE_URL', 'ENVIRONMENT']) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

/** Mollie simulé : garde l'état de chaque paiement, journalise remboursements et annulations. */
function mollieSim() {
  const pays = new Map<string, { status: string; value: string; refunded: boolean }>();
  const refunds: { id: string; body: { amount: { currency: string; value: string } }; key?: string }[] = [];
  const deleted: string[] = [];
  const created: Record<string, unknown>[] = [];
  const state = { down: false, n: 0 };
  const f = fakeFetch((c: Call) => {
    if (state.down) return json({ status: 500, title: 'Internal Server Error', detail: 'down' }, 500);
    const u = new URL(c.url);
    if (c.method === 'POST' && u.pathname === '/v2/payments') {
      const b = JSON.parse(c.raw) as { amount: { currency: string; value: string } };
      const id = `tr_sim${++state.n}`;
      created.push(b);
      pays.set(id, { status: 'open', value: b.amount.value, refunded: false });
      return json({ id, status: 'open', amount: b.amount, _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } } }, 201);
    }
    const m = /^\/v2\/payments\/(tr_\w+)(\/refunds)?$/.exec(u.pathname);
    const p = m ? pays.get(m[1]!) : undefined;
    if (!m || !p) return json({ status: 404, title: 'Not Found', detail: 'No payment exists with this token' }, 404);
    if (c.method === 'GET') {
      return json({ id: m[1], status: p.status, amount: { currency: 'EUR', value: p.value }, amountRemaining: { currency: 'EUR', value: p.refunded ? '0.00' : p.value } });
    }
    if (m[2] && c.method === 'POST') {
      refunds.push({ id: m[1]!, body: JSON.parse(c.raw), key: c.headers['idempotency-key'] });
      p.refunded = true;
      return json({ id: 're_1' }, 201);
    }
    if (c.method === 'DELETE') {
      deleted.push(m[1]!);
      if (p.status === 'open') p.status = 'canceled';
      return json({ id: m[1], status: p.status });
    }
    return json({}, 405);
  });
  return { ...f, pays, refunds, deleted, created, state, setStatus: (id: string, s: string) => (pays.get(id)!.status = s) };
}

function useMollie() {
  env.PAYMENT_PROVIDER = 'mollie';
  env.MOLLIE_API_KEY = 'test_flowkey';
  const sim = mollieSim();
  vi.stubGlobal('fetch', sim.fn);
  return sim;
}

async function buy(s: Seed, extra: Record<string, string> = {}): Promise<string> {
  const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s, extra) });
  expect(res.status, await res.clone().text()).toBe(303);
  expect(locationOf(res)).toMatch(/^https:\/\/www\.mollie\.com\/checkout\/select-method\/tr_sim\d+$/);
  return (await e.DB.prepare('SELECT token FROM orders ORDER BY id DESC').first<{ token: string }>())!.token;
}

const webhook = (id: string) =>
  http('/webhooks/mollie', { method: 'POST', body: `id=${id}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

describe('MollieProvider (API simulée)', () => {
  const args = {
    orderId: 42,
    token: 'T'.repeat(32),
    email: 'jean@example.com',
    lang: 'nl' as const,
    lines: [
      { name: 'Les Sales Gosses — Standard', qty: 2, unitCents: 1500 },
      { name: 'Les Sales Gosses — NIP', qty: 1, unitCents: 3000 },
    ],
    currency: 'EUR',
    baseUrl: 'https://billets.example.org',
    expiresAtUnix: 1_800_000_000,
    description: 'PNK #42 — Les Sales Gosses',
  };
  const created = (c: Call) =>
    c.method === 'POST' && c.url.endsWith('/payments')
      ? json({ id: 'tr_abc123', status: 'open', _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/abc' } } }, 201)
      : json({}, 404);

  it('crée un paiement avec les bons paramètres (montant en chaîne, langue belge, retours, notification)', async () => {
    const f = fakeFetch(created);
    const r = await new MollieProvider('test_secretkey', f.fn).createCheckout(args);
    expect(r).toEqual({ sessionId: 'tr_abc123', url: 'https://www.mollie.com/checkout/select-method/abc' });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.mollie.com/v2/payments');
    expect(c.method).toBe('POST');
    expect(c.headers['authorization']).toBe('Bearer test_secretkey');
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.headers['idempotency-key']).toBe('pnk-checkout-42');
    const b = JSON.parse(c.raw);
    expect(b.amount).toEqual({ currency: 'EUR', value: '60.00' });
    expect(b.description).toBe('PNK #42 — Les Sales Gosses');
    expect(b.redirectUrl).toBe(`https://billets.example.org/o/${'T'.repeat(32)}`);
    expect(b.cancelUrl).toBe(`https://billets.example.org/o/${'T'.repeat(32)}?cancelled=1`);
    expect(b.webhookUrl).toBe('https://billets.example.org/webhooks/mollie');
    expect(b.locale).toBe('nl_BE');
    expect(b.metadata).toEqual({ order_id: 42 });
    expect('method' in b).toBe(false); // le client choisit sur la page de Mollie
  });

  it('montants : toujours deux décimales, sans erreur d’arrondi', () => {
    expect(mollieAmount(3000, 'eur')).toEqual({ currency: 'EUR', value: '30.00' });
    expect(mollieAmount(1250, 'EUR').value).toBe('12.50');
    expect(mollieAmount(5, 'EUR').value).toBe('0.05');
    expect(mollieAmount(1999, 'EUR').value).toBe('19.99');
  });

  it('pas de notification vers localhost ni en http (Mollie la refuserait)', async () => {
    for (const baseUrl of ['http://localhost:8787', 'https://app.localhost', 'http://billets.example.org']) {
      const f = fakeFetch(created);
      await new MollieProvider('test_k', f.fn).createCheckout({ ...args, baseUrl });
      expect('webhookUrl' in JSON.parse(f.calls[0]!.raw), baseUrl).toBe(false);
    }
  });

  it('Mollie refuse la notification (site derrière Access) : on réessaie sans, avec une autre clé d’idempotence', async () => {
    const f = fakeFetch((c) =>
      JSON.parse(c.raw).webhookUrl ? json({ status: 422, title: 'Unprocessable Entity', detail: 'The webhook URL is invalid', field: 'webhookUrl' }, 422) : created(c),
    );
    const r = await new MollieProvider('test_k', f.fn).createCheckout(args);
    expect(r.sessionId).toBe('tr_abc123');
    expect(f.calls.length).toBe(2);
    expect(f.calls[0]!.headers['idempotency-key']).toBe('pnk-checkout-42');
    expect(f.calls[1]!.headers['idempotency-key']).toBe('pnk-checkout-42-sans-webhook'); // mêmes clés + autres paramètres = 400 chez Mollie
    expect('webhookUrl' in JSON.parse(f.calls[1]!.raw)).toBe(false);
  });

  it('une autre erreur 422 n’est pas rejouée et ne divulgue pas la clé', async () => {
    const f = fakeFetch(() => json({ status: 422, title: 'Unprocessable Entity', detail: 'The amount is lower than the minimum', field: 'amount' }, 422));
    const err = await new MollieProvider('test_secretkey', f.fn).createCheckout(args).catch((x) => x);
    expect(err).toBeInstanceOf(MollieApiError);
    expect(err.status).toBe(422);
    expect(err.field).toBe('amount');
    expect(err.message).toContain('minimum');
    expect(err.message).not.toContain('test_secretkey');
    expect(f.calls.length).toBe(1);
  });

  it('statuts : payé, définitivement terminé sans paiement, ou encore en cours', async () => {
    const st = async (status: string) => {
      const f = fakeFetch(() => json({ id: 'tr_x', status, amount: { currency: 'EUR', value: '1.00' } }));
      return new MollieProvider('test_k', f.fn).retrieveSession('tr_x');
    };
    expect(await st('paid')).toEqual({ paid: true, expired: false, paymentId: 'tr_x' });
    for (const s of ['expired', 'canceled', 'failed']) expect(await st(s), s).toEqual({ paid: false, expired: true, paymentId: 'tr_x' });
    for (const s of ['open', 'pending', 'authorized']) expect(await st(s), s).toEqual({ paid: false, expired: false, paymentId: 'tr_x' });
  });

  it('remboursement : rembourse le montant restant, avec clé d’idempotence', async () => {
    const f = fakeFetch((c) =>
      c.method === 'GET'
        ? json({ id: 'tr_x', status: 'paid', amount: { currency: 'EUR', value: '60.00' }, amountRemaining: { currency: 'EUR', value: '20.00' } })
        : json({ id: 're_1' }, 201),
    );
    await new MollieProvider('test_k', f.fn).refund('tr_x', 'pnk-refund-7');
    const post = f.calls[1]!;
    expect(post.url).toBe('https://api.mollie.com/v2/payments/tr_x/refunds');
    expect(post.headers['idempotency-key']).toBe('pnk-refund-7');
    expect(JSON.parse(post.raw).amount).toEqual({ currency: 'EUR', value: '20.00' });
  });

  it('remboursement : déjà remboursé -> rien à envoyer ; doublon (409) toléré ; non payé -> erreur', async () => {
    const get = (status: string, remaining: string) => json({ id: 'tr_x', status, amount: { currency: 'EUR', value: '60.00' }, amountRemaining: { currency: 'EUR', value: remaining } });
    let f = fakeFetch(() => get('paid', '0.00'));
    await new MollieProvider('test_k', f.fn).refund('tr_x', 'k');
    expect(f.calls.length).toBe(1); // lecture seule

    f = fakeFetch((c) => (c.method === 'GET' ? get('paid', '60.00') : json({ status: 409, title: 'Conflict', detail: 'Two identical refund requests' }, 409)));
    await expect(new MollieProvider('test_k', f.fn).refund('tr_x', 'k')).resolves.toBeUndefined();

    f = fakeFetch(() => get('open', '60.00'));
    await expect(new MollieProvider('test_k', f.fn).refund('tr_x', 'k')).rejects.toThrow(/pas payé/);
    expect(f.calls.length).toBe(1);

    f = fakeFetch((c) => (c.method === 'GET' ? get('paid', '60.00') : json({ status: 422, title: 'Unprocessable Entity', detail: 'insufficient balance' }, 422)));
    await expect(new MollieProvider('test_k', f.fn).refund('tr_x', 'k')).rejects.toThrow(/insufficient balance/);
  });

  it('fermeture d’un paiement : introuvable ou non annulable tolérés, panne remontée', async () => {
    for (const status of [404, 422]) {
      const f = fakeFetch(() => json({ status, title: 'x', detail: 'y' }, status));
      await expect(new MollieProvider('test_k', f.fn).expireSession('tr_x')).resolves.toBeUndefined();
    }
    const down = fakeFetch(() => json({ status: 500, title: 'x', detail: 'y' }, 500));
    await expect(new MollieProvider('test_k', down.fn).expireSession('tr_x')).rejects.toThrow(/500/);
  });
});

describe('sélection du fournisseur et configuration', () => {
  it('Mollie par défaut ; sans clé : aucun fournisseur (échoue fermé)', () => {
    expect(getProvider({} as Env)).toBeNull();
    expect(getProvider({ MOLLIE_API_KEY: 'test_k' } as Env)?.name).toBe('mollie');
    expect(getProvider({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' } as Env)?.name).toBe('stripe');
    expect(getProvider({ PAYMENT_PROVIDER: 'inconnu', MOLLIE_API_KEY: 'k' } as Env)).toBeNull();
  });

  it('le tableau de bord signale une clé de test, une clé absente, et se tait avec une clé live', () => {
    const base = { ENVIRONMENT: 'production', PAYMENT_PROVIDER: 'mollie', HASH_SECRET: 'x' } as Env;
    expect(envGaps({ ...base } as Env).join('|')).toContain('MOLLIE_API_KEY');
    expect(envGaps({ ...base, MOLLIE_API_KEY: 'test_abc' } as Env).join('|')).toContain('mode TEST');
    expect(envGaps({ ...base, MOLLIE_API_KEY: 'live_abc' } as Env).join('|')).not.toMatch(/Mollie|MOLLIE/);
  });

  it('la politique de sécurité autorise la redirection vers la page de paiement Mollie', async () => {
    expect((await http('/')).headers.get('content-security-policy')).toMatch(/form-action [^;]*https:\/\/\*\.mollie\.com/);
  });
});

describe('achat avec Mollie via le site', () => {
  it('redirige vers Mollie, puis la page de retour confirme le paiement (même sans notification)', async () => {
    const sim = useMollie();
    const s = await seedEvent({ standardQuota: 10 });
    const token = await buy(s);
    expect(sim.created[0]).toMatchObject({ amount: { currency: 'EUR', value: '30.00' }, locale: 'fr_BE' });
    expect('webhookUrl' in sim.created[0]!).toBe(false); // BASE_URL de test en http
    let o = await order(token);
    expect(o).toMatchObject({ status: 'pending', provider: 'mollie', provider_session_id: 'tr_sim1', checkout_url: 'https://www.mollie.com/checkout/select-method/tr_sim1' });

    expect(await (await http(`/o/${token}`)).text()).toContain('On vérifie ton paiement'); // Mollie : encore « open »
    sim.setStatus('tr_sim1', 'paid');
    expect(await (await http(`/o/${token}`)).text()).toContain('t’es dedans');
    o = await order(token);
    expect(o).toMatchObject({ status: 'paid', provider_payment_id: 'tr_sim1' });
    expect(o.invoice_seq).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);
  });

  it('avec une adresse publique en https, Mollie reçoit l’adresse de notification et de retour', async () => {
    const sim = useMollie();
    env.BASE_URL = 'https://billets.exemple.test';
    const token = await buy(await seedEvent());
    expect(sim.created[0]).toMatchObject({
      webhookUrl: 'https://billets.exemple.test/webhooks/mollie',
      redirectUrl: `https://billets.exemple.test/o/${token}`,
      cancelUrl: `https://billets.exemple.test/o/${token}?cancelled=1`,
    });
  });

  it('notification : relit le paiement chez Mollie, valide la commande une seule fois (rejeux inclus)', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent({ standardQuota: 10 }));
    sim.setStatus('tr_sim1', 'paid');
    expect((await webhook('tr_sim1')).status).toBe(200);
    expect((await webhook('tr_sim1')).status).toBe(200); // Mollie rejoue
    expect((await webhook('tr_sim1')).status).toBe(200);
    const o = await order(token);
    expect(o.status).toBe('paid');
    expect(await count('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1', o.id)).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM orders WHERE invoice_seq IS NOT NULL')).toBe(1);
  });

  it('notification forgée : une requête ne valide jamais une commande que Mollie ne dit pas payée', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent());
    expect((await webhook('tr_sim1')).status).toBe(200); // Mollie répond « open »
    expect((await order(token)).status).toBe('pending');
    // contenu sans rapport : ignoré sans appeler l'API
    const before = sim.calls.length;
    for (const body of ['id=tr_inconnu', 'id=x', 'id=tr_..%2F..%2Fadmin', 'id=', 'rien=1', 'id[]=tr_sim1']) {
      const r = await http('/webhooks/mollie', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      expect(r.status, body).toBe(200);
    }
    const json_ = await http('/webhooks/mollie', { method: 'POST', body: '{"id":"tr_sim1","status":"paid"}', headers: { 'Content-Type': 'application/json' } });
    expect(json_.status).toBe(200);
    expect((await order(token)).status).toBe('pending'); // un faux « status: paid » dans le corps ne compte pas
    expect(sim.calls.length).toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(0);
  });

  it('notification pour une commande d’un autre fournisseur : ignorée', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent());
    await e.DB.prepare("UPDATE orders SET provider = 'stripe' WHERE token = ?1").bind(token).run();
    sim.setStatus('tr_sim1', 'paid');
    expect((await webhook('tr_sim1')).status).toBe(200);
    expect((await order(token)).status).toBe('pending');
  });

  it('paiement abandonné, annulé ou échoué : la notification libère les places', async () => {
    const sim = useMollie();
    const s = await seedEvent({ standardQuota: 2 });
    const token = await buy(s);
    const full = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    expect(full.status).toBe(409); // les 2 places sont retenues
    sim.setStatus('tr_sim1', 'canceled');
    expect((await webhook('tr_sim1')).status).toBe(200);
    expect((await order(token)).status).toBe('expired');
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s) })).status).toBe(303);
  });

  it('panne de l’API Mollie pendant la notification : erreur 500 (Mollie réessaiera), commande intacte', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent());
    sim.state.down = true;
    expect((await webhook('tr_sim1')).status).toBe(500);
    sim.state.down = false;
    sim.setStatus('tr_sim1', 'paid');
    expect((await webhook('tr_sim1')).status).toBe(200); // le réessai aboutit
    expect((await order(token)).status).toBe('paid');
  });

  it('sans clé Mollie : la notification répond 503 et l’achat est refusé proprement', async () => {
    env.PAYMENT_PROVIDER = 'mollie';
    delete env.MOLLIE_API_KEY;
    expect((await webhook('tr_sim1')).status).toBe(503);
    const s = await seedEvent();
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s) })).status).toBe(503);
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")).toBe(0);
  });

  it('Mollie indisponible à la création : message clair, commande annulée, places rendues', async () => {
    const sim = useMollie();
    const s = await seedEvent({ standardQuota: 2 });
    sim.state.down = true;
    const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('momentanément indisponible');
    expect((await e.DB.prepare('SELECT status FROM orders').first<{ status: string }>())!.status).toBe('cancelled');
    sim.state.down = false;
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s) })).status).toBe(303);
  });

  it('remboursement depuis le back-office : montant exact, clé d’idempotence, billets annulés ; idempotent', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent());
    sim.setStatus('tr_sim1', 'paid');
    await webhook('tr_sim1');
    const o = await order(token);
    const r = await refundOrder(e, o, 'owner@pnk.test');
    expect(r.ok).toBe(true);
    expect(sim.refunds).toEqual([{ id: 'tr_sim1', body: { amount: { currency: 'EUR', value: '30.00' }, description: 'Remboursement PNK' }, key: `pnk-refund-${o.id}` }]);
    expect((await order(token)).status).toBe('refunded');
    expect(await count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'void'")).toBe(2);
    // déjà remboursé chez Mollie (remboursement fait dans leur tableau de bord) : PNK se met quand même à jour
    const token2 = await buy(await seedEvent());
    sim.setStatus('tr_sim2', 'paid');
    await webhook('tr_sim2');
    sim.pays.get('tr_sim2')!.refunded = true;
    expect((await refundOrder(e, await order(token2), 'owner@pnk.test')).ok).toBe(true);
    expect(sim.refunds.length).toBe(1); // aucun second remboursement envoyé
    expect((await order(token2)).status).toBe('refunded');
  });

  it('paiement tardif sans place restante : remboursement automatique via Mollie, aucun billet', async () => {
    const sim = useMollie();
    const s = await seedEvent({ standardQuota: 2 });
    const late = await buy(s);
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(late).run();
    await expireStaleOrders(e.DB, new Date().toISOString());
    const winner = await buy(s); // quelqu'un d'autre prend les 2 places
    sim.setStatus('tr_sim2', 'paid');
    await webhook('tr_sim2');
    sim.setStatus('tr_sim1', 'paid'); // le premier acheteur finit par payer, trop tard
    expect((await webhook('tr_sim1')).status).toBe(200);
    expect((await order(late)).status).toBe('refunded');
    expect((await order(winner)).status).toBe('paid');
    expect(sim.refunds.map((x) => x.id)).toEqual(['tr_sim1']);
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(2); // ceux du gagnant seulement
  });

  it('tâche planifiée : ferme chez Mollie les paiements des réservations expirées, une seule fois', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent({ standardQuota: 4 }));
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(token).run();
    env.MAIL_DRIVER = 'log';
    const r1 = await runScheduled(e);
    expect(r1).toMatchObject({ expired: 1, closed: 1 });
    expect(sim.deleted).toEqual(['tr_sim1']);
    expect((await order(token)).provider_closed).toBe(1);
    expect((await runScheduled(e)).closed).toBe(0);
    expect(sim.deleted.length).toBe(1);
  });

  it('tâche planifiée : si Mollie ne répond pas, on réessaie au passage suivant', async () => {
    const sim = useMollie();
    const token = await buy(await seedEvent());
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(token).run();
    sim.state.down = true;
    expect((await runScheduled(e)).closed).toBe(0);
    expect((await order(token)).provider_closed).toBe(0);
    sim.state.down = false;
    expect((await runScheduled(e)).closed).toBe(1);
    expect((await order(token)).provider_closed).toBe(1);
  });

  it('commande gratuite ou de caisse : Mollie n’est jamais appelé', async () => {
    const sim = useMollie();
    const s = await seedEvent({ standardCents: 0 });
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s) })).status).toBe(303);
    expect(sim.calls.length).toBe(0);
    const paid = await seedEvent();
    await http('/admin/door', { form: { type_id: String(paid.standardId), qty: '2', mode: 'cash' } });
    expect(sim.calls.length).toBe(0);
  });
});
