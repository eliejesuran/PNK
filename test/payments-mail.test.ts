// SPDX-License-Identifier: AGPL-3.0-or-later
// Paiement Stripe et emails : on simule les API externes pour vérifier ce que PNK envoie et comment il réagit aux pannes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScheduled } from '../src/index';
import type { EmailSender } from '../src/env';
import { MAX_ATTEMPTS, deliver, flushOutbox } from '../src/services/mail';
import { refundOrder } from '../src/services/orders';
import { PaymentError } from '../src/services/payments';
import { StripeProvider } from '../src/services/payments/stripe';
import type { OrderRow } from '../src/services/types';
import { e, formBody, http, locationOf, resetData, seedEvent } from './helpers';

const env = e as unknown as Record<string, unknown>;
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams | null;
  raw: string;
}

/** Faux `fetch` : enregistre les appels et répond selon la route. */
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k.toLowerCase()] = v));
    const raw = typeof init?.body === 'string' ? init.body : '';
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers: h, body: raw && !raw.startsWith('{') ? new URLSearchParams(raw) : null, raw };
    calls.push(call);
    return handler(call);
  };
  return { calls, fn: fn as unknown as typeof fetch };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const saved = { ...env };
beforeEach(async () => {
  await resetData();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['PAYMENT_PROVIDER', 'STRIPE_SECRET_KEY', 'MAIL_DRIVER', 'MAIL_FROM', 'EMAIL', 'RESEND_API_KEY', 'ENVIRONMENT']) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe('StripeProvider (API simulée)', () => {
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
    description: 'PNK #42',
  };

  it('crée une session Checkout avec les bons paramètres', async () => {
    const f = fakeFetch(() => json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    const r = await new StripeProvider('sk_test_secret', f.fn).createCheckout(args);
    expect(r).toEqual({ sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(c.method).toBe('POST');
    expect(c.headers['authorization']).toBe('Bearer sk_test_secret');
    expect(c.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(c.headers['idempotency-key']).toBe('pnk-checkout-42');
    const b = c.body!;
    expect(b.get('mode')).toBe('payment');
    expect(b.get('client_reference_id')).toBe('42');
    expect(b.get('customer_email')).toBe('jean@example.com');
    expect(b.get('locale')).toBe('nl');
    expect(b.get('success_url')).toBe(`https://billets.example.org/o/${'T'.repeat(32)}`);
    expect(b.get('cancel_url')).toBe(`https://billets.example.org/o/${'T'.repeat(32)}?cancelled=1`);
    expect(b.get('expires_at')).toBe('1800000000');
    expect(b.get('line_items[0][quantity]')).toBe('2');
    expect(b.get('line_items[0][price_data][unit_amount]')).toBe('1500');
    expect(b.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(b.get('line_items[1][price_data][unit_amount]')).toBe('3000');
    expect(b.get('line_items[1][price_data][product_data][name]')).toBe('Les Sales Gosses — NIP');
    expect(b.get('metadata[order_id]')).toBe('42');
    expect(b.has('payment_method_types[0]')).toBe(false); // moyens de paiement gérés dans le tableau de bord Stripe
  });

  it('une erreur Stripe devient une PaymentError sans fuite de la clé secrète', async () => {
    const f = fakeFetch(() => json({ error: { code: 'rate_limit', message: 'Too many requests' } }, 429));
    const err = await new StripeProvider('sk_test_secret', f.fn).createCheckout(args).catch((x) => x);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.status).toBe(429);
    expect(err.message).toContain('Too many requests');
    expect(err.message).not.toContain('sk_test_secret');
  });

  it('lit l’état d’une session, rembourse, expire (et tolère une session déjà expirée)', async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/expire')) return json({ error: { message: 'already expired' } }, 400);
      if (c.url.includes('/refunds')) return json({ id: 're_1' });
      return json({ payment_status: 'paid', status: 'complete', payment_intent: 'pi_9' });
    });
    const p = new StripeProvider('sk_test_x', f.fn);
    expect(await p.retrieveSession('cs_1')).toEqual({ paid: true, expired: false, paymentId: 'pi_9' });
    await p.refund('pi_9', 'pnk-refund-1');
    const rc = f.calls.find((c) => c.url.endsWith('/refunds'))!;
    expect(rc.body!.get('payment_intent')).toBe('pi_9');
    expect(rc.headers['idempotency-key']).toBe('pnk-refund-1');
    await expect(p.expireSession('cs_1')).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  });
});

describe('achat avec Stripe (API simulée) via le site', () => {
  function useStripe(handler: (c: Call) => Response | Promise<Response>) {
    env.PAYMENT_PROVIDER = 'stripe';
    env.STRIPE_SECRET_KEY = 'sk_test_flow';
    const f = fakeFetch(handler);
    vi.stubGlobal('fetch', f.fn);
    return f;
  }
  const stripeOk = (c: Call) => {
    if (c.method === 'POST' && c.url.endsWith('/checkout/sessions')) return json({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    if (c.method === 'GET' && c.url.includes('/checkout/sessions/cs_test_abc')) return json({ payment_status: 'paid', status: 'complete', payment_intent: 'pi_77' });
    if (c.url.endsWith('/refunds')) return json({ id: 're_1' });
    return json({}, 404);
  };

  it('redirige vers Stripe, puis la page de retour confirme le paiement même si le webhook tarde', async () => {
    const f = useStripe(stripeOk);
    const s = await seedEvent({ standardQuota: 10 });
    const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s, { lang: 'nl' }) });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
    const o = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    expect(o).toMatchObject({ status: 'pending', provider: 'stripe', provider_session_id: 'cs_test_abc', lang: 'nl' });
    expect(o.checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
    const created = f.calls.find((c) => c.method === 'POST')!;
    // la session Stripe expire avant la fin de la réservation de places
    const expiresAt = Number(created.body!.get('expires_at')) * 1000;
    expect(expiresAt - Date.parse(o.created_at)).toBeGreaterThanOrEqual(30 * 60_000);
    expect(expiresAt).toBeLessThan(Date.parse(o.expires_at!));

    // retour de l'acheteur : "en cours" tant que Stripe ne confirme pas, payé sinon
    const page = await (await http(`/o/${o.token}`)).text();
    expect(page).toContain('Je bent erbij.');
    const paid = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    expect(paid).toMatchObject({ status: 'paid', provider_payment_id: 'pi_77' });
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(2);

    // remboursement : appelle bien /refunds avec le payment_intent
    const r = await refundOrder(e, paid, 'owner@pnk.test');
    expect(r.ok).toBe(true);
    const refund = f.calls.find((c) => c.url.endsWith('/refunds'))!;
    expect(refund.body!.get('payment_intent')).toBe('pi_77');
  });

  it('Stripe indisponible : message clair, commande annulée, places rendues', async () => {
    useStripe(() => json({ error: { message: 'boom' } }, 500));
    const s = await seedEvent({ standardQuota: 2 });
    const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('momentanément indisponible');
    expect((await e.DB.prepare('SELECT status FROM orders').first<{ status: string }>())!.status).toBe('cancelled');
    // les 2 places sont de nouveau achetables
    useStripe(stripeOk);
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s) })).status).toBe(303);
  });

  it('remboursement refusé par Stripe : la commande reste payée, les billets restent valides', async () => {
    const f = useStripe((c) => (c.url.endsWith('/refunds') ? json({ error: { message: 'charge_already_refunded' } }, 400) : stripeOk(c)));
    const s = await seedEvent();
    await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    const token = (await e.DB.prepare('SELECT token FROM orders').first<{ token: string }>())!.token;
    await http(`/o/${token}`);
    const order = (await e.DB.prepare('SELECT * FROM orders').first<OrderRow>())!;
    const r = await refundOrder(e, order, 'owner@pnk.test');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('charge_already_refunded');
    expect((await e.DB.prepare('SELECT status FROM orders').first<{ status: string }>())!.status).toBe('paid');
    expect(await count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'valid'")).toBe(2);
    expect(f.calls.length).toBeGreaterThan(0);
  });

  it('sans clé Stripe : le paiement est refusé proprement (échoue fermé)', async () => {
    env.PAYMENT_PROVIDER = 'stripe';
    delete env.STRIPE_SECRET_KEY;
    const s = await seedEvent();
    const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    expect(res.status).toBe(503);
    expect(await count('SELECT COUNT(*) AS n FROM orders WHERE status = \'pending\'')).toBe(0);
  });

  it('le faux paiement est refusé en production, même si PAYMENT_PROVIDER=mock', async () => {
    env.ENVIRONMENT = 'production';
    env.PAYMENT_PROVIDER = 'mock';
    const s = await seedEvent();
    const res = await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    expect(res.status).toBe(503);
  });
});

describe('emails', () => {
  async function paidOrder(extra: Record<string, string> = {}) {
    const s = await seedEvent();
    const r = await http(`/e/${s.slug}/checkout`, { form: formBody(s, extra) });
    const token = /\/pay\/mock\/([\w-]{32})$/.exec(locationOf(r))![1]!;
    await http(`/pay/mock/${token}`, { form: { result: 'success' } });
    return token;
  }
  const outbox = () => e.DB.prepare('SELECT * FROM email_outbox ORDER BY id').all<{ id: number; status: string; attempts: number; last_error: string | null; subject: string; html: string; text: string; to_email: string; created_at: string }>();

  it('pilote Cloudflare : expéditeur analysé, QR en PNG, liens vers billets et facture', async () => {
    const sent: Parameters<EmailSender['send']>[0][] = [];
    env.MAIL_DRIVER = 'cloudflare';
    env.EMAIL = { send: async (m: Parameters<EmailSender['send']>[0]) => (sent.push(m), { messageId: 'm1' }) } satisfies EmailSender;
    const token = await paidOrder();
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const m = sent[0]!;
    expect(m.to).toBe('jean@example.com');
    expect(m.from).toEqual({ name: 'PNK', email: 'billets@pnk.test' });
    expect(m.subject).toBe('Tes billets pour Les Sales Gosses');
    expect(m.html!).toContain(`http://localhost/o/${token}`);
    expect(m.html!).toContain(`http://localhost/o/${token}/invoice`);
    expect(m.html!.match(/\/q\/[0-9A-Z]{16}\.png/g)?.length).toBe(2);
    expect(m.text).toContain(`http://localhost/o/${token}`);
    expect((await outbox()).results[0]!.status).toBe('sent');
  });

  it('pilote Resend : clé en Bearer, JSON attendu', async () => {
    env.MAIL_DRIVER = 'resend';
    env.RESEND_API_KEY = 're_test_key';
    const f = fakeFetch(() => json({ id: 'x' }));
    vi.stubGlobal('fetch', f.fn);
    await paidOrder();
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.resend.com/emails');
    expect(c.headers['authorization']).toBe('Bearer re_test_key');
    expect(JSON.parse(c.raw)).toMatchObject({ from: 'PNK <billets@pnk.test>', to: ['jean@example.com'] });
  });

  it('panne d’envoi : la commande reste payée, l’email est réessayé puis abandonné après 5 essais', async () => {
    env.MAIL_DRIVER = 'cloudflare';
    let calls = 0;
    env.EMAIL = { send: async () => { calls++; throw Object.assign(new Error('E_SENDER_DOMAIN_NOT_AVAILABLE'), { code: 'E_SENDER_DOMAIN_NOT_AVAILABLE' }); } } satisfies EmailSender;
    const token = await paidOrder();
    expect((await e.DB.prepare('SELECT status FROM orders WHERE token = ?1').bind(token).first<{ status: string }>())!.status).toBe('paid');
    await vi.waitFor(async () => expect((await outbox()).results[0]!.attempts).toBe(1));
    let row = (await outbox()).results[0]!;
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row.last_error).toContain('E_SENDER_DOMAIN_NOT_AVAILABLE');

    // le cron ne retente pas un email trop récent...
    expect(await flushOutbox(e, new Date().toISOString())).toBe(0);
    expect(calls).toBe(1);
    // ...mais retente ceux de plus de 2 minutes, jusqu'à abandon
    await e.DB.prepare("UPDATE email_outbox SET created_at = '2000-01-01T00:00:00.000Z'").run();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await flushOutbox(e, new Date().toISOString());
    row = (await outbox()).results[0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('puis un envoi qui finit par marcher passe en "sent" et n’est plus rejoué', async () => {
    env.MAIL_DRIVER = 'cloudflare';
    let fail = true;
    env.EMAIL = { send: async () => { if (fail) throw new Error('temp'); return { messageId: 'ok' }; } } satisfies EmailSender;
    await paidOrder();
    await vi.waitFor(async () => expect((await outbox()).results[0]!.attempts).toBe(1));
    fail = false;
    await e.DB.prepare("UPDATE email_outbox SET created_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await flushOutbox(e, new Date().toISOString())).toBe(1);
    expect((await outbox()).results[0]).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    expect(await flushOutbox(e, new Date().toISOString())).toBe(0);
  });

  it('deux envois simultanés du même email : un seul part (réservation par compteur)', async () => {
    env.MAIL_DRIVER = 'cloudflare';
    let calls = 0;
    env.EMAIL = { send: async () => (calls++, { messageId: 'x' }) } satisfies EmailSender;
    await paidOrder();
    await vi.waitFor(() => expect(calls).toBe(1));
    await e.DB.prepare("UPDATE email_outbox SET status = 'queued', attempts = 1").run();
    const id = (await outbox()).results[0]!.id;
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(e as never, id)));
    expect(results.filter(Boolean).length).toBe(1);
    expect(calls).toBe(2);
  });

  it('configuration manquante : l’échec est enregistré, jamais une erreur pour l’acheteur', async () => {
    env.MAIL_DRIVER = 'cloudflare';
    delete env.EMAIL;
    await paidOrder();
    await vi.waitFor(async () => expect((await outbox()).results[0]!.last_error).toContain('binding EMAIL'));
    env.MAIL_DRIVER = 'resend';
    delete env.RESEND_API_KEY;
    await e.DB.prepare("UPDATE email_outbox SET created_at = '2000-01-01T00:00:00.000Z'").run();
    await flushOutbox(e, new Date().toISOString());
    expect((await outbox()).results[0]!.last_error).toContain('RESEND_API_KEY');
    env.MAIL_DRIVER = 'inconnu';
    await flushOutbox(e, new Date().toISOString());
    expect((await outbox()).results[0]!.last_error).toContain('MAIL_DRIVER inconnu');
  });

  it('XSS : un nom piégé est échappé dans l’email HTML', async () => {
    env.MAIL_DRIVER = 'log';
    await paidOrder({ name: '<img src=x onerror=alert(1)>"Bob' });
    await vi.waitFor(async () => expect((await outbox()).results.length).toBe(1));
    const html = (await outbox()).results[0]!.html;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;Bob');
  });

  it('l’email part dans la langue de la commande', async () => {
    env.MAIL_DRIVER = 'log';
    await paidOrder({ lang: 'nl' });
    await vi.waitFor(async () => expect((await outbox()).results.length).toBe(1));
    const m = (await outbox()).results[0]!;
    expect(m.subject).toBe('Je tickets voor Les Sales Gosses');
    expect(m.html!).toContain('<html lang="nl">');
    expect(m.text).toContain('Mijn tickets openen');
  });

  it('commande gratuite sans email : aucun envoi, aucune erreur', async () => {
    env.MAIL_DRIVER = 'log';
    const s = await seedEvent();
    await http('/admin/door', { form: { type_id: String(s.standardId), qty: '2', mode: 'guest' } });
    expect(await count('SELECT COUNT(*) AS n FROM tickets')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM email_outbox')).toBe(0);
  });
});

describe('tâches planifiées (cron)', () => {
  it('libère les réservations expirées, réessaie les emails, purge le limiteur', async () => {
    const s = await seedEvent({ standardQuota: 2 });
    await http(`/e/${s.slug}/checkout`, { form: formBody(s) });
    await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    await e.DB.prepare("INSERT INTO rate_limits (key, window, count, at) VALUES ('old', 1, 1, '2000-01-01T00:00:00.000Z')").run();
    await e.DB.prepare("INSERT INTO email_outbox (to_email, subject, html, text, created_at) VALUES ('a@b.co', 's', '<p>x</p>', 'x', '2000-01-01T00:00:00.000Z')").run();
    env.MAIL_DRIVER = 'log';
    const r = await runScheduled(e);
    expect(r).toEqual({ expired: 1, mailed: 1 });
    expect((await e.DB.prepare('SELECT status FROM orders').first<{ status: string }>())!.status).toBe('expired');
    expect(await count("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'old'")).toBe(0);
  });
});
