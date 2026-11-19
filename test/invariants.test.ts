// SPDX-License-Identifier: AGPL-3.0-or-later
// Test "chaos" : opérations aléatoires et simultanées, puis vérification des invariants métier.
import { beforeEach, describe, expect, it } from 'vitest';
import { expireStaleOrders, refundOrder } from '../src/services/orders';
import type { OrderRow } from '../src/services/types';
import { e, formBody, http, locationOf, resetData, seedEvent, type Seed } from './helpers';

/** Générateur pseudo-aléatoire déterministe (mulberry32) : un échec se rejoue avec la même graine. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function checkInvariants(s: Seed, label: string) {
  const q = async <T>(sql: string) => (await e.DB.prepare(sql).all<T>()).results;
  const now = new Date().toISOString();

  // 1. Jamais plus de places prises (payées + réservées non expirées) que le quota
  for (const t of await q<{ id: number; quota: number; taken: number }>(
    `SELECT tt.id, tt.quota, COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.ticket_type_id = tt.id AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > '${now}'))), 0) AS taken
     FROM ticket_types tt`,
  )) {
    expect(t.taken, `${label}: survente sur la catégorie ${t.id} (${t.taken} > ${t.quota})`).toBeLessThanOrEqual(t.quota);
  }

  // 2. Billets cohérents avec les commandes
  for (const o of await q<{ id: number; status: string; items: number; tickets: number; voids: number; valid: number }>(
    `SELECT o.id, o.status, COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = o.id), 0) AS items,
       (SELECT COUNT(*) FROM tickets WHERE order_id = o.id) AS tickets,
       (SELECT COUNT(*) FROM tickets WHERE order_id = o.id AND status = 'void') AS voids,
       (SELECT COUNT(*) FROM tickets WHERE order_id = o.id AND status = 'valid') AS valid
     FROM orders o`,
  )) {
    if (o.status === 'paid') {
      expect(o.tickets, `${label}: commande payée ${o.id} sans le bon nombre de billets`).toBe(o.items);
      expect(o.valid, `${label}: commande payée ${o.id} avec billets invalides`).toBe(o.items);
    } else if (o.status === 'refunded') {
      expect(o.valid, `${label}: commande remboursée ${o.id} avec billets valides`).toBe(0);
    } else {
      expect(o.tickets, `${label}: billets pour une commande ${o.status} (${o.id})`).toBe(0);
    }
  }

  // 3. Factures : uniques et sans trou par année
  const inv = await q<{ invoice_year: number; invoice_seq: number }>('SELECT invoice_year, invoice_seq FROM orders WHERE invoice_seq IS NOT NULL ORDER BY invoice_year, invoice_seq');
  const byYear = new Map<number, number[]>();
  for (const r of inv) byYear.set(r.invoice_year, [...(byYear.get(r.invoice_year) ?? []), r.invoice_seq]);
  for (const [year, seqs] of byYear) expect(seqs, `${label}: numérotation ${year}`).toEqual(seqs.map((_, i) => i + 1));

  // 4. Une commande payée avec un total > 0 a une facture ; gratuite : aucune
  expect(await q("SELECT id FROM orders WHERE status = 'paid' AND total_cents > 0 AND invoice_seq IS NULL"), `${label}: payée sans facture`).toEqual([]);
  expect(await q("SELECT id FROM orders WHERE total_cents = 0 AND invoice_seq IS NOT NULL"), `${label}: facture pour du gratuit`).toEqual([]);

  // 5. Codes de billets uniques, entrées jamais en double
  const codes = await q<{ n: number; d: number }>('SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS d FROM tickets');
  expect(codes[0]!.n).toBe(codes[0]!.d);
  void s;
}

describe('invariants sous charge aléatoire', () => {
  beforeEach(async () => {
    await resetData();
  });

  for (const seed of [1, 2, 3, 42]) {
    it(`graine ${seed} : 250 opérations dont des rafales simultanées`, async () => {
      const rand = rng(seed);
      const pick = <T,>(a: T[]): T | undefined => a[Math.floor(rand() * a.length)];
      const s = await seedEvent({ standardQuota: 12, nipQuota: 4, capacity: 40 });
      const staffEmail = 'owner@pnk.test';
      void staffEmail;

      const pendingTokens = async () => (await e.DB.prepare("SELECT token FROM orders WHERE status = 'pending'").all<{ token: string }>()).results.map((r) => r.token);
      const tokensWhere = async (st: string) => (await e.DB.prepare('SELECT token FROM orders WHERE status = ?1').bind(st).all<{ token: string }>()).results.map((r) => r.token);

      const ops: Record<string, () => Promise<unknown>> = {
        buy: async () => {
          const type = rand() < 0.7 ? s.standardId : s.nipId;
          const qty = 1 + Math.floor(rand() * 3);
          const other = type === s.standardId ? s.nipId : s.standardId;
          return http(`/e/${s.slug}/checkout`, { form: formBody(s, { [`qty_${type}`]: String(qty), [`qty_${other}`]: rand() < 0.2 ? '1' : '0' }) });
        },
        pay: async () => {
          const t = pick(await pendingTokens());
          if (t) await http(`/pay/mock/${t}`, { form: { result: 'success' } });
        },
        cancel: async () => {
          const t = pick(await pendingTokens());
          if (t) await http(`/o/${t}/cancel`, { method: 'POST' });
        },
        expire: async () => {
          const t = pick(await pendingTokens());
          if (t) {
            await e.DB.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?1").bind(t).run();
            await expireStaleOrders(e.DB, new Date().toISOString());
          }
        },
        latePay: async () => {
          const t = pick([...(await tokensWhere('expired')), ...(await tokensWhere('cancelled'))]);
          if (t) await http(`/pay/mock/${t}`, { form: { result: 'success' } });
        },
        refund: async () => {
          const t = pick(await tokensWhere('paid'));
          if (t) {
            const o = (await e.DB.prepare('SELECT * FROM orders WHERE token = ?1').bind(t).first<OrderRow>())!;
            await refundOrder(e, o, staffEmail);
          }
        },
        door: async () => {
          await http('/admin/door', { form: { type_id: String(rand() < 0.5 ? s.standardId : s.nipId), qty: String(1 + Math.floor(rand() * 2)), mode: pick(['cash', 'terminal', 'guest'])! } });
        },
        scan: async () => {
          const row = (await e.DB.prepare('SELECT code FROM tickets ORDER BY RANDOM() LIMIT 1').first<{ code: string }>());
          if (row) await http('/api/scan', { json: { code: row.code, eventId: s.eventId } });
        },
      };
      const names = Object.keys(ops);
      const weights: Record<string, number> = { buy: 6, pay: 5, cancel: 1, expire: 1, latePay: 2, refund: 1, door: 2, scan: 2 };
      const bag = names.flatMap((n) => Array(weights[n] ?? 1).fill(n) as string[]);

      for (let round = 0; round < 50; round++) {
        const burst = 1 + Math.floor(rand() * 5); // jusqu'à 5 opérations simultanées
        await Promise.all(Array.from({ length: burst }, () => ops[pick(bag)!]!()));
        await checkInvariants(s, `graine ${seed}, tour ${round}`);
      }
      // Fin de partie : tout le monde finit de payer, ce qui doit encore respecter les quotas
      for (const t of await pendingTokens()) await http(`/pay/mock/${t}`, { form: { result: 'success' } });
      await checkInvariants(s, `graine ${seed}, fin`);
      const dist = (await e.DB.prepare("SELECT status || '/' || channel || CASE WHEN refunded_at IS NOT NULL AND invoice_seq IS NULL AND total_cents > 0 THEN '/auto-remboursée' ELSE '' END AS k, COUNT(*) AS n FROM orders GROUP BY k").all<{ k: string; n: number }>()).results;
      const sc = (await e.DB.prepare('SELECT COUNT(*) AS n, SUM(checked_in_at IS NOT NULL) AS c FROM tickets').first<{ n: number; c: number }>())!;
      console.info(`[chaos graine ${seed}] ` + dist.map((d) => `${d.k}=${d.n}`).join(' ') + ` | billets=${sc.n} entrés=${sc.c}`);
      expect(dist.length).toBeGreaterThan(2); // le scénario doit réellement varier
    });
  }

  it('toutes les places vendues, jusqu’à la dernière : exactement quota billets, jamais un de plus', async () => {
    const s = await seedEvent({ standardQuota: 7, nipQuota: 0 });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => http(`/e/${s.slug}/checkout`, { form: formBody(s, { [`qty_${s.standardId}`]: '2' }) })),
    );
    const tokens = results.filter((r) => r.status === 303).map((r) => /\/pay\/mock\/([\w-]{32})$/.exec(locationOf(r))![1]!);
    expect(tokens.length).toBe(3); // 3 x 2 = 6 places ; la 7e ne suffit pas pour une commande de 2
    await Promise.all(tokens.map((t) => http(`/pay/mock/${t}`, { form: { result: 'success' } })));
    const last = await http(`/e/${s.slug}/checkout`, { form: formBody(s, { [`qty_${s.standardId}`]: '1' }) });
    expect(last.status).toBe(303); // il restait bien 1 place
    expect((await http(`/e/${s.slug}/checkout`, { form: formBody(s, { [`qty_${s.standardId}`]: '1' }) })).status).toBe(409);
    await checkInvariants(s, 'dernière place');
  });
});
