// SPDX-License-Identifier: AGPL-3.0-or-later
// Vues publiques : accueil, page concert (achat), commande + billets, facture.

import type { FC } from 'hono/jsx';
import type { Lang } from '../env';
import { t } from '../i18n';
import { formatTicketCode, qrPayload } from '../lib/ids';
import { formatMoney, formatRate, splitVat } from '../lib/money';
import { qrSvgPath } from '../lib/qr';
import { dateParts, formatDate, formatDateShort, formatDateTime, formatTime } from '../lib/time';
import { salesState } from '../services/events';
import type { Settings } from '../services/settings';
import {
  eventDescription,
  invoiceNumber,
  typeName,
  type EventWithVenue,
  type OrderItemNamed,
  type OrderRow,
  type TicketTypeStock,
  type TicketWithType,
} from '../services/types';
import { Page, type OrgInfo } from './layout';

export interface Ctx {
  lang: Lang;
  org: OrgInfo;
  url: URL;
  tz: string;
}

const venueLine = (e: EventWithVenue) => [e.venue_name, e.venue_city].filter(Boolean).join(' — ');

// ---------- Accueil ----------

export interface HomeEvent {
  event: EventWithVenue;
  soldOut: boolean;
  minPriceCents: number | null;
}

export const HomeView: FC<Ctx & { events: HomeEvent[]; currency: string }> = ({ lang, org, url, tz, events, currency }) => (
  <Page lang={lang} title={`${org.name} — ${t(lang, 'home.title')}`} description={t(lang, 'home.tagline')} org={org} url={url}>
    <section class="hero">
      <p class="tag">{t(lang, 'home.tagline')}</p>
      <h1>
        <em>{t(lang, 'home.title')}</em>
      </h1>
    </section>
    {events.length === 0 ? (
      <p class="empty">{t(lang, 'home.empty')}</p>
    ) : (
      <ol class="events">
        {events.map(({ event: e, soldOut, minPriceCents }) => {
          const d = dateParts(e.starts_at, lang, tz);
          const cancelled = e.status === 'cancelled';
          return (
            <li class={`poster${cancelled ? ' off' : ''}`}>
              {cancelled ? <span class="sticker">{t(lang, 'event.cancelled')}</span> : soldOut ? <span class="sticker">{t(lang, 'event.soldout')}</span> : null}
              <div class="date" aria-hidden="true">
                <span>{d.weekday}</span>
                <b>{d.day}</b>
                <span>{d.month}</span>
                <small>{d.time}</small>
              </div>
              <div class="body">
                <h2>
                  <a class="nolink" href={`/e/${encodeURIComponent(e.slug)}`}>{e.title}</a>
                </h2>
                {e.subtitle ? <p class="sub">{e.subtitle}</p> : null}
                <p class="where">
                  {formatDate(e.starts_at, lang, tz)} · {venueLine(e)}
                  {minPriceCents !== null ? ` · ${minPriceCents === 0 ? t(lang, 'event.free') : formatMoney(minPriceCents, lang, currency)}` : ''}
                </p>
                <a class="btn" href={`/e/${encodeURIComponent(e.slug)}`}>
                  {t(lang, 'home.see')}
                </a>
              </div>
            </li>
          );
        })}
      </ol>
    )}
  </Page>
);

// ---------- Page concert ----------

export interface CheckoutValues {
  name: string;
  email: string;
  billing_name: string;
  billing_vat: string;
  billing_address: string;
  terms: boolean;
  qty: Record<number, number>;
}

export const EventView: FC<
  Ctx & {
    event: EventWithVenue;
    types: TicketTypeStock[];
    nowIso: string;
    currency: string;
    values: CheckoutValues;
    error?: string;
    turnstileSiteKey?: string;
  }
> = ({ lang, org, url, tz, event: e, types, nowIso, currency, values, error, turnstileSiteKey }) => {
  const state = salesState(e, nowIso);
  const online = types.filter((x) => x.online === 1);
  const desc = eventDescription(e, lang);
  const allFree = online.length > 0 && online.every((x) => x.price_cents === 0);
  const anyAvailable = online.some((x) => x.available > 0);
  return (
    <Page
      lang={lang}
      title={`${e.title} — ${org.name}`}
      description={`${formatDateTime(e.starts_at, lang, tz)} · ${venueLine(e)}`}
      org={org}
      url={url}
      ogImage={e.image_url || undefined}
      scripts={turnstileSiteKey && state === 'open' ? ['https://challenges.cloudflare.com/turnstile/v0/api.js'] : []}
    >
      <div class="event-grid">
        <article class="event-head">
          <a class="back" href="/">
            {t(lang, 'event.back')}
          </a>
          {e.image_url ? <img class="poster-img" src={e.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" /> : null}
          <h1>{e.title}</h1>
          {e.subtitle ? <p class="sub">{e.subtitle}</p> : null}
          <ul class="facts">
            <li>
              <b>{t(lang, 'event.start')}</b>
              {formatDateTime(e.starts_at, lang, tz)}
            </li>
            {e.doors_at ? (
              <li>
                <b>{t(lang, 'event.doors')}</b>
                {formatTime(e.doors_at, lang, tz)}
              </li>
            ) : null}
            <li>
              <b>{t(lang, 'event.venue')}</b>
              {[e.venue_name, e.venue_address, e.venue_city].filter(Boolean).join(', ')}
            </li>
          </ul>
          {desc ? (
            <>
              <h2>{t(lang, 'event.about')}</h2>
              <div class="desc">{desc}</div>
            </>
          ) : null}
        </article>

        <aside class="paper tape buy" aria-labelledby="tickets-h">
          <h2 id="tickets-h">{t(lang, 'event.tickets')}</h2>
          {error ? (
            <div class="alert err" role="alert">
              {error}
            </div>
          ) : null}
          {state === 'cancelled' ? <p class="alert err">{t(lang, 'event.cancelled')}</p> : null}
          {state === 'not_open' ? <p class="alert info">{t(lang, 'event.not_open', { date: formatDateTime(e.sales_open_at!, lang, tz) })}</p> : null}
          {state === 'closed' || state === 'past' ? <p class="alert info">{state === 'past' ? t(lang, 'event.past') : t(lang, 'event.closed')}</p> : null}
          {state === 'draft' ? <p class="alert info">{t(lang, 'event.closed')}</p> : null}
          {state === 'open' && online.length === 0 ? <p>{t(lang, 'event.no_types')}</p> : null}
          {state === 'open' && online.length > 0 ? (
            <form method="post" action={`/e/${encodeURIComponent(e.slug)}/checkout`} data-cart data-once data-currency={currency} data-max={String(e.max_per_order)}>
              <input type="hidden" name="lang" value={lang} />
              <div>
                {online.map((tt) => {
                  const out = tt.available <= 0;
                  const max = Math.min(tt.available, e.max_per_order);
                  const id = `qty-${tt.id}`;
                  return (
                    <div class={`tt${out ? ' out' : ''}`}>
                      <div>
                        <div class="name">{typeName(tt, lang)}</div>
                        <div class="price">{tt.price_cents === 0 ? t(lang, 'event.free') : formatMoney(tt.price_cents, lang, currency)}</div>
                        {!out && tt.available <= 10 ? <div class="left">{t(lang, 'event.low', { n: tt.available })}</div> : null}
                      </div>
                      {out ? (
                        <span class="sticker">{t(lang, 'event.soldout')}</span>
                      ) : (
                        <div class="stepper">
                          <button type="button" data-step="-1" data-for={id} aria-label={`− ${typeName(tt, lang)}`}>
                            −
                          </button>
                          <input
                            class="qty"
                            id={id}
                            name={`qty_${tt.id}`}
                            type="number"
                            inputmode="numeric"
                            min="0"
                            max={String(max)}
                            value={String(values.qty[tt.id] ?? 0)}
                            data-price={String(tt.price_cents)}
                            aria-label={`${t(lang, 'event.qty')} — ${typeName(tt, lang)}`}
                          />
                          <button type="button" data-step="1" data-for={id} aria-label={`+ ${typeName(tt, lang)}`}>
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p class="hint">{t(lang, 'event.max', { n: e.max_per_order })}</p>

              {anyAvailable ? (
                <>
                  <div class="total-row">
                    <span>{t(lang, 'event.total')}</span>
                    <span id="total">{formatMoney(0, lang, currency)}</span>
                  </div>

                  <h3>{t(lang, 'event.you')}</h3>
                  <div class="field">
                    <label for="name">{t(lang, 'event.name')}</label>
                    <input id="name" name="name" type="text" autocomplete="name" required maxlength={120} value={values.name} />
                  </div>
                  <div class="field">
                    <label for="email">{t(lang, 'event.email')}</label>
                    <input id="email" name="email" type="email" autocomplete="email" required maxlength={254} value={values.email} />
                    <div class="hint">{t(lang, 'event.email_hint')}</div>
                  </div>
                  <details class="opt" open={!!(values.billing_name || values.billing_vat || values.billing_address)}>
                    <summary>{t(lang, 'event.invoice_toggle')}</summary>
                    <div class="field">
                      <label for="billing_name">{t(lang, 'event.billing_name')}</label>
                      <input id="billing_name" name="billing_name" type="text" maxlength={120} value={values.billing_name} />
                    </div>
                    <div class="field">
                      <label for="billing_vat">{t(lang, 'event.billing_vat')}</label>
                      <input id="billing_vat" name="billing_vat" type="text" maxlength={40} value={values.billing_vat} />
                    </div>
                    <div class="field">
                      <label for="billing_address">{t(lang, 'event.billing_address')}</label>
                      <textarea id="billing_address" name="billing_address" maxlength={300}>
                        {values.billing_address}
                      </textarea>
                    </div>
                  </details>
                  <div class="field">
                    <label class="check" for="terms">
                      <input id="terms" name="terms" type="checkbox" value="1" required checked={values.terms} />
                      <span>
                        {t(lang, 'event.terms')}{' '}
                        {org.termsUrl ? (
                          <a href={org.termsUrl} target="_blank" rel="noopener">
                            {t(lang, 'event.terms_link')}
                          </a>
                        ) : null}
                      </span>
                    </label>
                  </div>
                  {turnstileSiteKey ? <div class="cf-turnstile field" data-sitekey={turnstileSiteKey} data-language={lang}></div> : null}
                  <button id="pay" class="btn big block" type="submit">
                    {allFree ? t(lang, 'event.free_confirm') : t(lang, 'event.pay')}
                  </button>
                  {!allFree ? <p class="paynote">{t(lang, 'event.pay_hint')}</p> : null}
                  <p class="paynote">{t(lang, 'event.hold')}</p>
                </>
              ) : null}
            </form>
          ) : null}
        </aside>
      </div>
    </Page>
  );
};

// ---------- Billet ----------

export const TicketCard: FC<{
  ticket: TicketWithType;
  index: number;
  total: number;
  event: EventWithVenue;
  order: OrderRow;
  lang: Lang;
  tz: string;
  orgName: string;
}> = ({ ticket, index, total, event: e, order, lang, tz, orgName }) => {
  const qr = qrSvgPath(qrPayload(ticket.code));
  const void_ = ticket.status === 'void' || order.status === 'refunded';
  const holder = order.name || order.billing_name;
  return (
    <article class={`ticket${void_ ? ' void' : ''}`} data-void={t(lang, 'ticket.void')}>
      <div class="band">
        <span>{orgName}</span>
        <span>
          {t(lang, 'ticket.admit')} · {t(lang, 'ticket.n_of', { i: index + 1, n: total })}
        </span>
      </div>
      <div class="main">
        <div class="t-title">{e.title}</div>
        {e.subtitle ? <div class="t-sub">{e.subtitle}</div> : null}
        <dl>
          <dt>{t(lang, 'event.start')}</dt>
          <dd>
            {formatDateTime(e.starts_at, lang, tz)}
            {e.doors_at ? ` · ${t(lang, 'ticket.doors', { time: formatTime(e.doors_at, lang, tz) })}` : ''}
          </dd>
          <dt>{t(lang, 'event.venue')}</dt>
          <dd>{[e.venue_name, e.venue_address, e.venue_city].filter(Boolean).join(', ')}</dd>
          <dt>{t(lang, 'ticket.type')}</dt>
          <dd>
            <b>{typeName(ticket, lang)}</b>
          </dd>
          {holder ? (
            <>
              <dt>{t(lang, 'ticket.holder')}</dt>
              <dd>{holder}</dd>
            </>
          ) : null}
        </dl>
        <p class="rule">{t(lang, 'ticket.rule')}</p>
      </div>
      <div class="stub">
        <svg class="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR ${formatTicketCode(ticket.code)}`} shape-rendering="crispEdges">
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.d} fill="#000" />
        </svg>
        <div class="code">{formatTicketCode(ticket.code)}</div>
      </div>
    </article>
  );
};

// ---------- Commande ----------

export const OrderView: FC<
  Ctx & {
    order: OrderRow;
    event: EventWithVenue;
    tickets: TicketWithType[];
    items: OrderItemNamed[];
    currency: string;
    invoiceNo: string | null;
    cancelled?: boolean;
    autoPrint?: boolean;
  }
> = ({ lang, org, url, tz, order, event: e, tickets, items, currency, invoiceNo, cancelled, autoPrint }) => {
  const paid = order.status === 'paid';
  const title = paid ? t(lang, 'order.paid_title') : order.status === 'pending' ? t(lang, 'order.pending_title') : order.status === 'expired' ? t(lang, 'order.expired_title') : order.status === 'refunded' ? t(lang, 'order.refunded_title') : t(lang, 'order.cancelled_title');
  const text = paid ? t(lang, 'order.paid_text') : order.status === 'pending' ? t(lang, 'order.pending_text') : order.status === 'expired' ? t(lang, 'order.expired_text') : order.status === 'refunded' ? t(lang, 'order.refunded_text') : t(lang, 'order.cancelled_text');
  const bodyData: Record<string, string> = {};
  if (order.status === 'pending' && !cancelled) bodyData['data-refresh'] = '4';
  if (autoPrint && paid) bodyData['data-autoprint'] = '1';
  const evUrl = `/e/${encodeURIComponent(e.slug)}`;
  return (
    <Page lang={lang} title={`${t(lang, 'order.ref', { n: order.id })} — ${org.name}`} org={org} url={url} noindex bodyData={bodyData}>
      <section class={`status-box${paid ? ' ok' : ''}`}>
        <p class="marker">{t(lang, 'order.ref', { n: order.id })}</p>
        <h1>{title}</h1>
        <p>{text}</p>
        {order.status === 'pending' && order.checkout_url ? (
          <div class="actions center">
            <a class="btn big" href={order.checkout_url}>
              {t(lang, 'order.resume')}
            </a>
            <form method="post" action={`/o/${order.token}/cancel`} data-confirm={t(lang, 'order.cancel_confirm')}>
              <button class="btn ghost dark" type="submit">
                {t(lang, 'order.cancel')}
              </button>
            </form>
          </div>
        ) : null}
        {order.status === 'expired' || order.status === 'cancelled' ? (
          <a class="btn" href={evUrl}>
            {t(lang, 'order.retry')}
          </a>
        ) : null}
      </section>

      {paid ? (
        <>
          <div class="actions no-print">
            <button class="btn" type="button" data-print>
              {t(lang, 'order.print')}
            </button>
            {invoiceNo ? (
              <a class="btn ghost dark" href={`/o/${order.token}/invoice`}>
                {t(lang, 'order.invoice')} {invoiceNo}
              </a>
            ) : null}
            <a class="btn ghost dark" href={evUrl}>
              {t(lang, 'order.back_event')}
            </a>
          </div>
          <p class="no-print">{t(lang, 'order.keep')}</p>
          <h2 class="no-print">{t(lang, 'order.tickets')}</h2>
          <div class="tickets">
            {tickets.map((tk, i) => (
              <TicketCard ticket={tk} index={i} total={tickets.length} event={e} order={order} lang={lang} tz={tz} orgName={org.name} />
            ))}
          </div>
        </>
      ) : null}

      {order.status === 'refunded' ? (
        <div class="tickets">
          {tickets.map((tk, i) => (
            <TicketCard ticket={tk} index={i} total={tickets.length} event={e} order={order} lang={lang} tz={tz} orgName={org.name} />
          ))}
        </div>
      ) : null}

      <section class="paper no-print" aria-label={t(lang, 'order.summary')}>
        <h3>{t(lang, 'order.summary')}</h3>
        <p>
          <b>{e.title}</b> — {formatDateTime(e.starts_at, lang, tz)}
        </p>
        <table class="tbl compact">
          <tbody>
            {items.map((it) => (
              <tr>
                <td>
                  {it.qty} × {typeName(it, lang)}
                </td>
                <td class="num">{formatMoney(it.qty * it.unit_price_cents, lang, currency)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <b>{t(lang, 'event.total')}</b>
              </td>
              <td class="num">
                <b>{formatMoney(order.total_cents, lang, currency)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </Page>
  );
};

// ---------- Facture ----------

export const InvoiceView: FC<
  Ctx & {
    order: OrderRow;
    event: EventWithVenue;
    items: OrderItemNamed[];
    settings: Settings;
  }
> = ({ lang, org, url, tz, order, event: e, items, settings: s }) => {
  const no = invoiceNumber(order, s.invoice_prefix);
  const { net, vat, gross } = splitVat(order.total_cents, order.vat_rate_bp);
  const money = (c: number) => formatMoney(c, lang, order.currency);
  const sellerName = s.org_legal_name || s.org_name;
  const buyerName = order.billing_name || order.name || order.email || '—';
  const methodKey = `inv.method_${order.payment_method}` as 'inv.method_online';
  return (
    <Page lang={lang} title={`${t(lang, 'inv.title')} ${no ?? ''} — ${org.name}`} org={org} url={url} noindex>
      {no ? (
        <>
          <div class="actions no-print center">
            <button class="btn" type="button" data-print>
              {t(lang, 'inv.print')}
            </button>
            <a class="btn ghost dark" href={`/o/${order.token}`}>
              {t(lang, 'order.tickets')}
            </a>
          </div>
          <article class="sheet">
            {order.status === 'refunded' ? <div class="stamp">{t(lang, 'inv.refunded')}</div> : null}
            <h1>{t(lang, 'inv.title')}</h1>
            <p>
              <b>
                {t(lang, 'inv.number')} {no}
              </b>
              <br />
              {t(lang, 'inv.date')}: {formatDateShort(order.paid_at ?? order.created_at, lang, tz)}
            </p>
            <div class="cols">
              <div>
                <h3>{t(lang, 'inv.seller')}</h3>
                <b>{sellerName}</b>
                <br />
                <span class="pre">{s.org_address}</span>
                {s.org_vat_number ? (
                  <>
                    <br />
                    {t(lang, 'inv.vat_no')}: {s.org_vat_number}
                  </>
                ) : null}
                {s.org_email ? (
                  <>
                    <br />
                    {s.org_email}
                  </>
                ) : null}
              </div>
              <div>
                <h3>{t(lang, 'inv.buyer')}</h3>
                <b>{buyerName}</b>
                {order.billing_address ? (
                  <>
                    <br />
                    <span class="pre">{order.billing_address}</span>
                  </>
                ) : null}
                {order.billing_vat ? (
                  <>
                    <br />
                    {t(lang, 'inv.vat_no')}: {order.billing_vat}
                  </>
                ) : null}
                {order.email ? (
                  <>
                    <br />
                    {order.email}
                  </>
                ) : null}
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{t(lang, 'inv.desc')}</th>
                  <th class="num">{t(lang, 'inv.qty')}</th>
                  <th class="num">{t(lang, 'inv.unit')}</th>
                  <th class="num">{t(lang, 'inv.line_total')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr>
                    <td>
                      {t(lang, 'inv.event_line', { title: e.title, date: formatDateShort(e.starts_at, lang, tz) })}
                      <br />
                      <span class="muted">{typeName(it, lang)}</span>
                    </td>
                    <td class="num">{it.qty}</td>
                    <td class="num">{money(it.unit_price_cents)}</td>
                    <td class="num">{money(it.qty * it.unit_price_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan={3} class="num">
                    {t(lang, 'inv.net')}
                  </td>
                  <td class="num">{money(net)}</td>
                </tr>
                <tr>
                  <td colspan={3} class="num">
                    {t(lang, 'inv.vat', { rate: formatRate(order.vat_rate_bp) })}
                  </td>
                  <td class="num">{money(vat)}</td>
                </tr>
                <tr class="gross">
                  <td colspan={3} class="num">
                    {t(lang, 'inv.gross')}
                  </td>
                  <td class="num">{money(gross)}</td>
                </tr>
              </tfoot>
            </table>
            <p>{t(lang, 'inv.paid', { date: formatDateShort(order.paid_at ?? order.created_at, lang, tz), method: t(lang, methodKey) })}</p>
            {s.invoice_footer ? <div class="foot-note">{s.invoice_footer}</div> : null}
          </article>
        </>
      ) : (
        <section class="status-box">
          <h1>{t(lang, 'inv.title')}</h1>
          <p>{t(lang, 'inv.none')}</p>
          <a class="btn" href={`/o/${order.token}`}>
            {t(lang, 'order.tickets')}
          </a>
        </section>
      )}
    </Page>
  );
};

// ---------- Faux paiement (développement uniquement) ----------

export const MockPayView: FC<Ctx & { order: OrderRow; currency: string }> = ({ lang, org, url, order, currency }) => (
  <Page lang={lang} title="Paiement factice" org={org} url={url} noindex>
    <section class="paper tape narrow">
      <p class="marker">DEV</p>
      <h1>Paiement factice</h1>
      <p>
        Commande n° {order.id} — <b>{formatMoney(order.total_cents, lang, currency)}</b>. Ce faux écran n'existe qu'en développement
        (ENVIRONMENT=development).
      </p>
      <form method="post" action={`/pay/mock/${order.token}`} class="actions">
        <button class="btn" type="submit" name="result" value="success">
          Payer
        </button>
        <button class="btn ghost dark" type="submit" name="result" value="fail">
          Échouer
        </button>
      </form>
    </section>
  </Page>
);
