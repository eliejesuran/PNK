// SPDX-License-Identifier: AGPL-3.0-or-later
// Gabarits d'emails transactionnels (HTML en ligne + texte brut), dans la langue de la commande.

import type { Lang } from '../env';
import { t } from '../i18n';
import { esc } from '../lib/text';
import { formatDateTime, formatTime } from '../lib/time';
import { formatTicketCode } from '../lib/ids';
import type { EventWithVenue, OrderRow, TicketWithType } from './types';
import { typeName } from './types';

const RED = '#e10b17';
const INK = '#0b0b0b';
const PAPER = '#f4efe6';

function shell(lang: Lang, orgName: string, preheader: string, inner: string, footer: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(orgName)}</title></head>
<body style="margin:0;padding:0;background:${INK};font-family:'Courier New',Courier,monospace;color:${INK};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="background:${RED};padding:14px 20px;border:3px solid ${PAPER};font-family:Impact,'Arial Black',sans-serif;font-size:34px;letter-spacing:4px;color:${PAPER};text-transform:uppercase;">${esc(orgName)}</td></tr>
<tr><td style="background:${PAPER};padding:24px 20px;border:3px solid ${PAPER};border-top:0;font-size:15px;line-height:1.5;">${inner}</td></tr>
<tr><td style="padding:14px 4px;font-size:12px;color:${PAPER};opacity:.8;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function button(href: string, label: string, primary = true): string {
  const bg = primary ? RED : INK;
  return `<a href="${esc(href)}" style="display:inline-block;margin:6px 8px 6px 0;padding:12px 18px;background:${bg};color:${PAPER};text-decoration:none;font-weight:bold;text-transform:uppercase;letter-spacing:1px;border:3px solid ${INK};">${esc(label)}</a>`;
}

export interface TicketsEmailInput {
  order: OrderRow;
  event: EventWithVenue;
  tickets: TicketWithType[];
  orgName: string;
  timezone: string;
  baseUrl: string;
  hasInvoice: boolean;
}

export function ticketsEmail(i: TicketsEmailInput): { subject: string; html: string; text: string } {
  const lang = i.order.lang;
  const ordUrl = `${i.baseUrl}/o/${i.order.token}`;
  const invUrl = `${ordUrl}/invoice`;
  const when = formatDateTime(i.event.starts_at, lang, i.timezone);
  const where = [i.event.venue_name, i.event.venue_address, i.event.venue_city].filter(Boolean).join(', ');
  const name = i.order.name || i.order.email;
  const subject = t(lang, 'mail.tickets_subject', { title: i.event.title });

  const shown = i.tickets.slice(0, 8);
  const qrs = shown
    .map(
      (tk) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0;border:3px solid ${INK};background:#fff;width:100%;"><tr>
<td style="padding:10px;width:140px;"><img src="${esc(i.baseUrl)}/q/${esc(tk.code)}.png" width="130" height="130" alt="QR ${esc(formatTicketCode(tk.code))}" style="display:block;"></td>
<td style="padding:10px;vertical-align:top;"><div style="font-weight:bold;text-transform:uppercase;">${esc(typeName(tk, lang))}</div>
<div style="font-size:12px;margin-top:6px;">${esc(formatTicketCode(tk.code))}</div></td></tr></table>`,
    )
    .join('');
  const more = i.tickets.length > shown.length ? `<p>… +${i.tickets.length - shown.length}</p>` : '';

  const inner = `
<p style="margin:0 0 12px;font-weight:bold;">${esc(t(lang, 'mail.hello', { name }))}</p>
<p style="margin:0 0 16px;">${esc(t(lang, 'mail.tickets_body'))}</p>
<div style="border-left:6px solid ${RED};padding:4px 12px;margin:0 0 16px;">
<div style="font-family:Impact,'Arial Black',sans-serif;font-size:26px;text-transform:uppercase;line-height:1.1;">${esc(i.event.title)}</div>
<div><b>${esc(t(lang, 'mail.when'))}</b> ${esc(when)}${i.event.doors_at ? ` (${esc(t(lang, 'ticket.doors', { time: formatTime(i.event.doors_at, lang, i.timezone) }))})` : ''}</div>
<div><b>${esc(t(lang, 'mail.where'))}</b> ${esc(where)}</div></div>
${qrs}${more}
<p style="margin:16px 0 4px;">${button(ordUrl, t(lang, 'mail.btn_tickets'))}${i.hasInvoice ? button(invUrl, t(lang, 'mail.btn_invoice'), false) : ''}</p>
<p style="margin:16px 0 0;font-size:13px;"><b>${esc(t(lang, 'mail.footer'))}</b></p>`;

  const html = shell(lang, i.orgName, subject, inner, esc(i.orgName));
  const text = [
    t(lang, 'mail.hello', { name }),
    '',
    t(lang, 'mail.tickets_body'),
    '',
    i.event.title,
    `${t(lang, 'mail.when')}: ${when}`,
    `${t(lang, 'mail.where')}: ${where}`,
    '',
    `${t(lang, 'mail.btn_tickets')}: ${ordUrl}`,
    i.hasInvoice ? `${t(lang, 'mail.btn_invoice')}: ${invUrl}` : '',
    '',
    t(lang, 'mail.footer'),
  ]
    .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
    .join('\n');
  return { subject, html, text };
}

export function refundEmail(i: { order: OrderRow; event: EventWithVenue; orgName: string; reason: 'refund' | 'oversold' }): {
  subject: string;
  html: string;
  text: string;
} {
  const lang = i.order.lang;
  const subject =
    i.reason === 'oversold'
      ? t(lang, 'mail.oversold_subject', { title: i.event.title })
      : t(lang, 'mail.refund_subject', { title: i.event.title });
  const body =
    i.reason === 'oversold' ? t(lang, 'mail.oversold_body') : t(lang, 'mail.refund_body', { n: i.order.id });
  const name = i.order.name || i.order.email;
  const inner = `<p style="margin:0 0 12px;font-weight:bold;">${esc(t(lang, 'mail.hello', { name }))}</p><p>${esc(body)}</p>`;
  return {
    subject,
    html: shell(lang, i.orgName, subject, inner, esc(i.orgName)),
    text: `${t(lang, 'mail.hello', { name })}\n\n${body}\n`,
  };
}
