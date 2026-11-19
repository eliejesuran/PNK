// SPDX-License-Identifier: AGPL-3.0-or-later
// File d'envoi d'emails : on enregistre d'abord (table email_outbox), on envoie ensuite, on réessaie si ça échoue.
// Pilotes : "cloudflare" (Cloudflare Email Service, binding EMAIL), "resend" (API HTTP), "log" (dev : n'envoie rien).

import type { Env } from '../env';
import { parseMailbox } from '../lib/text';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  orderId?: number | null;
}

export const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: number;
  to_email: string;
  subject: string;
  html: string;
  text: string;
  attempts: number;
}

export async function queueMail(db: D1Database, msg: MailMessage): Promise<number> {
  const r = await db
    .prepare('INSERT INTO email_outbox (order_id, to_email, subject, html, text) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(msg.orderId ?? null, msg.to, msg.subject, msg.html, msg.text)
    .run();
  return Number(r.meta.last_row_id);
}

async function transport(env: Env, row: OutboxRow): Promise<void> {
  const driver = env.MAIL_DRIVER ?? 'cloudflare';
  const fromRaw = env.MAIL_FROM;
  if (driver === 'log') {
    console.log(`[mail:log] to=${row.to_email} subject=${row.subject}`);
    return;
  }
  if (!fromRaw) throw new Error('MAIL_FROM non configuré');
  if (driver === 'cloudflare') {
    if (!env.EMAIL) throw new Error('binding EMAIL (send_email) absent');
    await env.EMAIL.send({ to: row.to_email, from: parseMailbox(fromRaw), subject: row.subject, html: row.html, text: row.text });
    return;
  }
  if (driver === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY non configurée');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromRaw, to: [row.to_email], subject: row.subject, html: row.html, text: row.text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error(`MAIL_DRIVER inconnu : ${driver}`);
}

/**
 * Tente l'envoi d'un email de la file. Le "claim" (attempts = attempts + 1 conditionné à l'ancienne valeur)
 * garantit qu'un seul worker tente un envoi donné. Renvoie true si l'email est parti.
 */
export async function deliver(env: Env, id: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, to_email, subject, html, text, attempts FROM email_outbox WHERE id = ?1 AND status = 'queued'",
  )
    .bind(id)
    .first<OutboxRow>();
  if (!row) return false;
  const claim = await env.DB.prepare(
    "UPDATE email_outbox SET attempts = attempts + 1 WHERE id = ?1 AND status = 'queued' AND attempts = ?2",
  )
    .bind(id, row.attempts)
    .run();
  if (claim.meta.changes !== 1) return false;
  try {
    await transport(env, row);
    await env.DB.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?2, last_error = NULL WHERE id = ?1")
      .bind(id, new Date().toISOString())
      .run();
    return true;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const giveUp = row.attempts + 1 >= MAX_ATTEMPTS;
    await env.DB.prepare('UPDATE email_outbox SET status = ?2, last_error = ?3 WHERE id = ?1')
      .bind(id, giveUp ? 'failed' : 'queued', msg)
      .run();
    console.error('mail delivery failed', id, msg);
    return false;
  }
}

/** Cron : réessaie les emails restés en file depuis plus de 2 minutes. */
export async function flushOutbox(env: Env, nowIso: string, limit = 20): Promise<number> {
  const cutoff = new Date(Date.parse(nowIso) - 2 * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id FROM email_outbox WHERE status = 'queued' AND created_at <= ?1 ORDER BY id LIMIT ?2",
  )
    .bind(cutoff, limit)
    .all<{ id: number }>();
  let sent = 0;
  for (const { id } of results) if (await deliver(env, id)) sent++;
  return sent;
}
