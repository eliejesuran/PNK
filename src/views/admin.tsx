// SPDX-License-Identifier: AGPL-3.0-or-later
// Vues du back-office (en français) : tableau de bord, concerts, salles, commandes, caisse, rapports.

import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Staff } from '../env';
import type { Flash } from '../lib/flash';
import { formatTicketCode } from '../lib/ids';
import { centsToInput, formatMoney, formatRate } from '../lib/money';
import { formatDateShort, formatDateTime, utcIsoToLocalInput } from '../lib/time';
import type { Dashboard, EventStat, TypeStat } from '../services/stats';
import type {
  EventRow,
  EventWithVenue,
  OrderItemNamed,
  OrderRow,
  TicketTypeStock,
  TicketWithType,
  Venue,
} from '../services/types';
import { invoiceNumber } from '../services/types';
import { AdminPage } from './layout';

export interface A {
  staff: Staff;
  path: string;
  orgName: string;
  flash: Flash | null;
  tz: string;
  currency: string;
}

const eur = (a: A, cents: number) => formatMoney(cents, 'fr', a.currency);
const dt = (a: A, iso: string | null | undefined) => (iso ? formatDateTime(iso, 'fr', a.tz) : '—');

export const Shell: FC<PropsWithChildren<{ a: A; title: string }>> = ({ a, title, children }) => (
  <AdminPage title={title} staff={a.staff} path={a.path} orgName={a.orgName} flash={a.flash}>
    {children}
  </AdminPage>
);

export const Field: FC<PropsWithChildren<{ id: string; label: string; hint?: string; wide?: boolean }>> = ({ id, label, hint, wide, children }) => (
  <div class={`field${wide ? ' wide' : ''}`}>
    <label for={id}>{label}</label>
    {children}
    {hint ? <div class="hint">{hint}</div> : null}
  </div>
);

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  paid: { label: 'payée', cls: 'ok' },
  pending: { label: 'en attente', cls: 'warn' },
  expired: { label: 'expirée', cls: 'bad' },
  cancelled: { label: 'annulée', cls: 'bad' },
  refunded: { label: 'remboursée', cls: 'bad' },
  draft: { label: 'brouillon', cls: 'warn' },
  published: { label: 'publié', cls: 'ok' },
};
export const StatusChip: FC<{ status: string }> = ({ status }) => {
  const c = STATUS_CHIP[status] ?? { label: status, cls: '' };
  return <span class={`chip ${c.cls}`}>{status === 'cancelled' && !STATUS_CHIP[status] ? status : c.label}</span>;
};

const CHANNEL_LABEL: Record<string, string> = { online: 'en ligne', door: 'caisse', guest: 'invité' };
const METHOD_LABEL: Record<string, string> = { online: 'en ligne', cash: 'espèces', terminal: 'terminal carte', free: 'gratuit' };

const Meter: FC<{ pct: number }> = ({ pct }) => (
  <svg class="meter" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={`${Math.round(pct)} %`}>
    <rect width={Math.max(0, Math.min(100, pct))} height="10" />
  </svg>
);

// ---------- Tableau de bord ----------

const SalesChart: FC<{ points: Dashboard['byDay']; a: A }> = ({ points, a }) => {
  const W = 720;
  const H = 170;
  const pad = { l: 4, r: 4, t: 8, b: 22 };
  const max = Math.max(1, ...points.map((p) => p.revenueCents));
  const bw = (W - pad.l - pad.r) / Math.max(1, points.length);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  return (
    <svg class="bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Recettes par jour">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="#0b0b0b" stroke-width="2" />
      {points.map((p, i) => {
        const h = Math.round(((H - pad.t - pad.b) * p.revenueCents) / max);
        const x = pad.l + i * bw;
        return (
          <g>
            <rect class="b" x={x + 1} y={H - pad.b - h} width={Math.max(1, bw - 2)} height={Math.max(h, p.revenueCents > 0 ? 2 : 0)}>
              <title>{`${p.day} : ${eur(a, p.revenueCents)} · ${p.tickets} billet(s)`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text x={x} y={H - 6}>
                {p.day.slice(5)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
};

export const DashboardView: FC<{
  a: A;
  d: Dashboard;
  events: EventStat[];
  types: TypeStat[];
  recent: (OrderRow & { event_title: string })[];
  range: string;
  eventId: number | null;
  eventOptions: { id: number; title: string; starts_at: string }[];
  gaps: string[];
  envGaps: string[];
}> = ({ a, d, events, types, recent, range, eventId, eventOptions, gaps, envGaps }) => (
  <Shell a={a} title="Tableau de bord">
    <h1>
      Tableau de <em>bord</em>
    </h1>
    {gaps.length + envGaps.length > 0 ? (
      <div class="todo">
        <b>Avant de vendre pour de vrai, il reste :</b>
        <ul>
          {gaps.map((g) => (
            <li>
              {g} — <a href="/admin/settings">Réglages</a>
            </li>
          ))}
          {envGaps.map((g) => (
            <li>{g} — configuration technique (voir docs/DEPLOY.md)</li>
          ))}
        </ul>
      </div>
    ) : null}
    <form method="get" class="filters" action="/admin">
      <div>
        <label for="range">Période</label>
        <select id="range" name="range">
          {[
            ['7', '7 derniers jours'],
            ['30', '30 derniers jours'],
            ['90', '90 derniers jours'],
            ['365', '12 derniers mois'],
            ['all', 'Depuis le début'],
          ].map(([v, l]) => (
            <option value={v} selected={range === v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label for="event">Concert</label>
        <select id="event" name="event">
          <option value="">Tous</option>
          {eventOptions.map((e) => (
            <option value={String(e.id)} selected={eventId === e.id}>
              {formatDateShort(e.starts_at, 'fr', a.tz)} — {e.title}
            </option>
          ))}
        </select>
      </div>
      <button class="btn small" type="submit">
        Filtrer
      </button>
    </form>

    <div class="kpis">
      <div class="kpi red">
        <b>{eur(a, d.revenueCents)}</b>
        <span>Recettes TTC</span>
      </div>
      <div class="kpi">
        <b>{d.ticketsSold}</b>
        <span>Billets vendus</span>
      </div>
      <div class="kpi">
        <b>{d.ordersPaid}</b>
        <span>Commandes payées</span>
      </div>
      <div class="kpi">
        <b>{eur(a, d.avgBasketCents)}</b>
        <span>Panier moyen</span>
      </div>
      <div class="kpi">
        <b>{d.pendingOrders}</b>
        <span>Paiements en cours</span>
      </div>
      <div class="kpi">
        <b>{d.refundedOrders}</b>
        <span>Remboursées ({eur(a, d.refundedCents)})</span>
      </div>
    </div>

    <section class="panel">
      <h2>Recettes par jour</h2>
      <SalesChart points={d.byDay} a={a} />
    </section>

    <div class="cols-2">
      <section class="panel">
        <h2>Par canal</h2>
        <table class="tbl compact">
          <thead>
            <tr>
              <th>Canal</th>
              <th class="num">Commandes</th>
              <th class="num">Billets</th>
              <th class="num">Recettes</th>
            </tr>
          </thead>
          <tbody>
            {d.byChannel.length === 0 ? (
              <tr>
                <td colspan={4}>Aucune vente sur la période.</td>
              </tr>
            ) : (
              d.byChannel.map((c) => (
                <tr>
                  <td>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                  <td class="num">{c.orders}</td>
                  <td class="num">{c.tickets}</td>
                  <td class="num">{eur(a, c.revenueCents)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      {eventId && types.length ? (
        <section class="panel">
          <h2>Par catégorie</h2>
          <table class="tbl compact">
            <thead>
              <tr>
                <th>Catégorie</th>
                <th class="num">Vendus</th>
                <th class="num">Quota</th>
                <th class="num">Recettes</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr>
                  <td>{t.name}</td>
                  <td class="num">{t.sold}</td>
                  <td class="num">{t.quota}</td>
                  <td class="num">{eur(a, t.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>

    <section class="panel">
      <h2>Concerts</h2>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th>Concert</th>
              <th>Remplissage</th>
              <th class="num">Vendus / quota</th>
              <th class="num">Entrés</th>
              <th class="num">Recettes</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colspan={6}>Aucun concert à venir. <a href="/admin/events/new">En créer un</a>.</td>
              </tr>
            ) : (
              events.map((e) => (
                <tr>
                  <td>{formatDateShort(e.starts_at, 'fr', a.tz)}</td>
                  <td>
                    <a href={`/admin/events/${e.id}`}>{e.title}</a> <StatusChip status={e.status} />
                  </td>
                  <td class="meter-cell">
                    <Meter pct={e.quota ? (e.sold / e.quota) * 100 : 0} />
                  </td>
                  <td class="num">
                    {e.sold} / {e.quota}
                  </td>
                  <td class="num">{e.checkedIn}</td>
                  <td class="num">{eur(a, e.revenueCents)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Dernières commandes</h2>
      <OrdersTable a={a} orders={recent} />
    </section>
  </Shell>
);

// ---------- Concerts ----------

export const EventsListView: FC<{ a: A; events: (EventWithVenue & { sold: number; quota: number })[] }> = ({ a, events }) => (
  <Shell a={a} title="Concerts">
    <h1>
      <em>Concerts</em>
    </h1>
    <p>
      <a class="btn" href="/admin/events/new">
        Nouveau concert
      </a>
    </p>
    <div class="panel tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Date</th>
            <th>Concert</th>
            <th>Salle</th>
            <th>Statut</th>
            <th class="num">Vendus / quota</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colspan={5}>Aucun concert pour l’instant.</td>
            </tr>
          ) : (
            events.map((e) => (
              <tr>
                <td>{dt(a, e.starts_at)}</td>
                <td>
                  <a href={`/admin/events/${e.id}`}>{e.title}</a>
                </td>
                <td>{e.venue_name}</td>
                <td>
                  <StatusChip status={e.status} />
                </td>
                <td class="num">
                  {e.sold} / {e.quota}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </Shell>
);

export interface EventFormValues {
  title: string;
  subtitle: string;
  slug: string;
  venue_id: string;
  starts: string;
  doors: string;
  sales_open: string;
  sales_close: string;
  max_per_order: string;
  image_url: string;
  vat: string;
  description_fr: string;
  description_en: string;
  description_nl: string;
  std_price: string;
  std_quota: string;
  std_note: string;
  nip_quota: string;
  nip_note: string;
}

export function eventToForm(e: EventRow, tz: string): EventFormValues {
  return {
    title: e.title,
    subtitle: e.subtitle,
    slug: e.slug,
    venue_id: String(e.venue_id),
    starts: utcIsoToLocalInput(e.starts_at, tz),
    doors: utcIsoToLocalInput(e.doors_at, tz),
    sales_open: utcIsoToLocalInput(e.sales_open_at, tz),
    sales_close: utcIsoToLocalInput(e.sales_close_at, tz),
    max_per_order: String(e.max_per_order),
    image_url: e.image_url,
    vat: e.vat_rate_bp === null ? '' : String(e.vat_rate_bp / 100),
    description_fr: e.description_fr,
    description_en: e.description_en,
    description_nl: e.description_nl,
    std_price: '',
    std_quota: '',
    std_note: '',
    nip_quota: '',
    nip_note: '',
  };
}

export const emptyEventForm = (venueId?: number): EventFormValues => ({
  title: '',
  subtitle: '',
  slug: '',
  venue_id: venueId ? String(venueId) : '',
  starts: '',
  doors: '',
  sales_open: '',
  sales_close: '',
  max_per_order: '6',
  image_url: '',
  vat: '',
  description_fr: '',
  description_en: '',
  description_nl: '',
  std_price: '15',
  std_quota: '100',
  std_note: '',
  nip_quota: '10',
  nip_note: 'Not Very Important Person',
});

const EventFields: FC<{ v: EventFormValues; venues: Venue[]; isNew: boolean; defaultVat: number }> = ({ v, venues, isNew, defaultVat }) => (
  <>
    <div class="form-grid">
      <Field id="title" label="Titre du concert *">
        <input id="title" name="title" type="text" required maxlength={120} value={v.title} />
      </Field>
      <Field id="subtitle" label="Sous-titre / line-up" hint="Ex. : GROUPE A + GROUPE B">
        <input id="subtitle" name="subtitle" type="text" maxlength={160} value={v.subtitle} />
      </Field>
      <Field id="venue_id" label="Salle *">
        <select id="venue_id" name="venue_id" required>
          <option value="">— choisir —</option>
          {venues.map((x) => (
            <option value={String(x.id)} selected={v.venue_id === String(x.id)}>
              {x.name} ({x.capacity} places)
            </option>
          ))}
        </select>
      </Field>
      <Field id="slug" label="Adresse web (slug)" hint="Laisse vide pour la générer à partir du titre. Ex. : mon-concert → /e/mon-concert">
        <input id="slug" name="slug" type="text" maxlength={80} value={v.slug} />
      </Field>
      <Field id="starts" label="Début du concert *" hint="Heure locale de la salle">
        <input id="starts" name="starts" type="datetime-local" required value={v.starts} />
      </Field>
      <Field id="doors" label="Ouverture des portes">
        <input id="doors" name="doors" type="datetime-local" value={v.doors} />
      </Field>
      <Field id="sales_open" label="Ouverture de la billetterie" hint="Vide = dès la publication">
        <input id="sales_open" name="sales_open" type="datetime-local" value={v.sales_open} />
      </Field>
      <Field id="sales_close" label="Fermeture de la billetterie" hint="Vide = au début du concert">
        <input id="sales_close" name="sales_close" type="datetime-local" value={v.sales_close} />
      </Field>
      <Field id="max_per_order" label="Billets max par commande">
        <input id="max_per_order" name="max_per_order" type="number" min="1" max="50" value={v.max_per_order} />
      </Field>
      <Field id="vat" label="TVA de ce concert (%)" hint={`Vide = taux par défaut (${formatRate(defaultVat)})`}>
        <input id="vat" name="vat" type="text" inputmode="decimal" value={v.vat} />
      </Field>
      <Field id="image_url" label="Affiche (URL https)" hint="Lien vers une image hébergée ailleurs (ton site, par ex.)" wide>
        <input id="image_url" name="image_url" type="url" maxlength={500} value={v.image_url} />
      </Field>
      <Field id="description_fr" label="Description (français)" wide>
        <textarea id="description_fr" name="description_fr" maxlength={5000}>
          {v.description_fr}
        </textarea>
      </Field>
      <Field id="description_en" label="Description (anglais)" hint="Vide = on affiche le français" wide>
        <textarea id="description_en" name="description_en" maxlength={5000}>
          {v.description_en}
        </textarea>
      </Field>
      <Field id="description_nl" label="Description (néerlandais)" hint="Vide = on affiche le français" wide>
        <textarea id="description_nl" name="description_nl" maxlength={5000}>
          {v.description_nl}
        </textarea>
      </Field>
    </div>
    {isNew ? (
      <>
        <h2>Places</h2>
        <p class="hint">Mets 0 en quantité pour ne pas créer la catégorie. Tu pourras en ajouter d’autres après.</p>
        <div class="form-grid">
          <Field id="std_quota" label="Standard — nombre de places">
            <input id="std_quota" name="std_quota" type="number" min="0" value={v.std_quota} />
          </Field>
          <Field id="std_price" label="Standard — prix TTC (€)">
            <input id="std_price" name="std_price" type="text" inputmode="decimal" value={v.std_price} />
          </Field>
          <Field id="std_note" label="Standard — petit texte (facultatif)">
            <input id="std_note" name="std_note" type="text" maxlength={80} value={v.std_note} />
          </Field>
          <Field id="nip_quota" label="NIP — invitations gratuites (nombre)" hint="Jamais en vente en ligne : tu les génères toi-même depuis « Caisse / invités »">
            <input id="nip_quota" name="nip_quota" type="number" min="0" value={v.nip_quota} />
          </Field>
          <Field id="nip_note" label="NIP — petit texte (facultatif)" hint="Imprimé sur le billet d’invitation">
            <input id="nip_note" name="nip_note" type="text" maxlength={80} value={v.nip_note} />
          </Field>
        </div>
      </>
    ) : null}
  </>
);

export const EventNewView: FC<{ a: A; v: EventFormValues; venues: Venue[]; errors: string[]; defaultVat: number }> = ({ a, v, venues, errors, defaultVat }) => (
  <Shell a={a} title="Nouveau concert">
    <h1>
      Nouveau <em>concert</em>
    </h1>
    {errors.length ? (
      <div class="alert err" role="alert">
        <ul>
          {errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      </div>
    ) : null}
    {venues.length === 0 ? (
      <p class="alert info">
        Il faut d’abord créer une salle : <a href="/admin/venues">Salles</a>.
      </p>
    ) : (
      <form method="post" action="/admin/events" class="panel" data-once>
        <EventFields v={v} venues={venues} isNew defaultVat={defaultVat} />
        <button class="btn" type="submit">
          Créer (en brouillon)
        </button>
      </form>
    )}
  </Shell>
);

export const EventEditView: FC<{
  a: A;
  event: EventWithVenue;
  v: EventFormValues;
  venues: Venue[];
  types: TicketTypeStock[];
  errors: string[];
  orderCount: number;
  publicUrl: string;
  defaultVat: number;
}> = ({ a, event: e, v, venues, types, errors, orderCount, publicUrl, defaultVat }) => {
  const quota = types.reduce((s, x) => s + x.quota, 0);
  return (
    <Shell a={a} title={e.title}>
      <h1>
        <em>{e.title}</em> <StatusChip status={e.status} />
      </h1>
      <p>
        {dt(a, e.starts_at)} · {e.venue_name} ·{' '}
        <a href={publicUrl} target="_blank" rel="noopener">
          page publique
        </a>
      </p>
      <div class="row-actions mb">
        {e.status !== 'published' ? (
          <form method="post" action={`/admin/events/${e.id}/status`} class="inline">
            <input type="hidden" name="status" value="published" />
            <button class="btn small" type="submit">
              Publier
            </button>
          </form>
        ) : (
          <form method="post" action={`/admin/events/${e.id}/status`} class="inline">
            <input type="hidden" name="status" value="draft" />
            <button class="btn small ghost" type="submit">
              Repasser en brouillon
            </button>
          </form>
        )}
        {e.status !== 'cancelled' ? (
          <form method="post" action={`/admin/events/${e.id}/status`} class="inline" data-confirm="Marquer ce concert comme annulé ? La vente en ligne s’arrête. Les remboursements restent à faire commande par commande.">
            <input type="hidden" name="status" value="cancelled" />
            <button class="btn small ghost" type="submit">
              Annuler le concert
            </button>
          </form>
        ) : null}
        <form method="post" action={`/admin/events/${e.id}/duplicate`} class="inline">
          <button class="btn small ghost" type="submit">
            Dupliquer
          </button>
        </form>
        <a class="btn small ghost" href={`/admin/orders?event=${e.id}`}>
          Commandes ({orderCount})
        </a>
        <a class="btn small ghost" href={`/admin/reports?event=${e.id}`}>
          Rapport
        </a>
        {orderCount === 0 ? (
          <form method="post" action={`/admin/events/${e.id}/delete`} class="inline" data-confirm="Supprimer définitivement ce concert ?">
            <button class="btn small danger ghost" type="submit">
              Supprimer
            </button>
          </form>
        ) : null}
      </div>
      {errors.length ? (
        <div class="alert err" role="alert">
          <ul>
            {errors.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section class="panel">
        <h2>Places</h2>
        <p class="hint">
          Total des quotas : <b>{quota}</b> / capacité de la salle : <b>{e.venue_capacity}</b>
        </p>
        {types.map((tt) => (
          <form method="post" action={`/admin/types/${tt.id}`} class="form-grid" data-once>
            <Field id={`n-${tt.id}`} label="Nom (FR)">
              <input id={`n-${tt.id}`} name="name_fr" type="text" required maxlength={60} value={tt.name_fr} />
            </Field>
            <Field id={`ne-${tt.id}`} label="Nom (EN)">
              <input id={`ne-${tt.id}`} name="name_en" type="text" maxlength={60} value={tt.name_en} />
            </Field>
            <Field id={`nn-${tt.id}`} label="Nom (NL)">
              <input id={`nn-${tt.id}`} name="name_nl" type="text" maxlength={60} value={tt.name_nl} />
            </Field>
            <Field id={`p-${tt.id}`} label="Prix TTC (€)">
              <input id={`p-${tt.id}`} name="price" type="text" inputmode="decimal" required value={centsToInput(tt.price_cents)} />
            </Field>
            <Field id={`q-${tt.id}`} label="Quota" hint={`${tt.sold} vendus · ${tt.held} en cours de paiement`}>
              <input id={`q-${tt.id}`} name="quota" type="number" min="0" required value={String(tt.quota)} />
            </Field>
            <Field id={`s-${tt.id}`} label="Ordre">
              <input id={`s-${tt.id}`} name="sort" type="number" value={String(tt.sort)} />
            </Field>
            <Field id={`t-${tt.id}`} label="Petit texte (facultatif)" hint="Même texte dans toutes les langues">
              <input id={`t-${tt.id}`} name="note" type="text" maxlength={80} value={tt.note} />
            </Field>
            <div class="field">
              <label class="check" for={`o-${tt.id}`}>
                <input id={`o-${tt.id}`} name="online" type="checkbox" value="1" checked={tt.online === 1} />
                <span>En vente en ligne</span>
              </label>
            </div>
            <div class="row-actions">
              <button class="btn small" type="submit">
                Enregistrer
              </button>
              {tt.sold === 0 && tt.held === 0 ? (
                <button class="btn small ghost" type="submit" formaction={`/admin/types/${tt.id}/delete`} formnovalidate>
                  Supprimer
                </button>
              ) : null}
            </div>
            <hr />
          </form>
        ))}
        <h3>Ajouter une catégorie</h3>
        <form method="post" action={`/admin/events/${e.id}/types`} class="form-grid" data-once>
          <Field id="new-n" label="Nom (FR) *">
            <input id="new-n" name="name_fr" type="text" required maxlength={60} />
          </Field>
          <Field id="new-ne" label="Nom (EN)" hint="Vide = même nom">
            <input id="new-ne" name="name_en" type="text" maxlength={60} />
          </Field>
          <Field id="new-nn" label="Nom (NL)" hint="Vide = même nom">
            <input id="new-nn" name="name_nl" type="text" maxlength={60} />
          </Field>
          <Field id="new-p" label="Prix TTC (€)">
            <input id="new-p" name="price" type="text" inputmode="decimal" required value="0" />
          </Field>
          <Field id="new-q" label="Quota">
            <input id="new-q" name="quota" type="number" min="0" required value="10" />
          </Field>
          <Field id="new-t" label="Petit texte (facultatif)">
            <input id="new-t" name="note" type="text" maxlength={80} />
          </Field>
          <div class="field">
            <label class="check" for="new-o">
              <input id="new-o" name="online" type="checkbox" value="1" checked />
              <span>En vente en ligne</span>
            </label>
          </div>
          <div>
            <button class="btn small" type="submit">
              Ajouter
            </button>
          </div>
        </form>
      </section>

      <form method="post" action={`/admin/events/${e.id}`} class="panel" data-once>
        <h2>Informations</h2>
        <EventFields v={v} venues={venues} isNew={false} defaultVat={defaultVat} />
        <button class="btn" type="submit">
          Enregistrer
        </button>
      </form>
    </Shell>
  );
};

// ---------- Salles ----------

export const VenuesView: FC<{ a: A; venues: Venue[]; errors: string[] }> = ({ a, venues, errors }) => (
  <Shell a={a} title="Salles">
    <h1>
      <em>Salles</em>
    </h1>
    {errors.length ? (
      <div class="alert err" role="alert">
        {errors.join(' ')}
      </div>
    ) : null}
    <div class="panel tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Adresse</th>
            <th class="num">Capacité</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {venues.length === 0 ? (
            <tr>
              <td colspan={4}>Aucune salle. Crée la première ci-dessous.</td>
            </tr>
          ) : (
            venues.map((v) => (
              <tr>
                <td>
                  <a href={`/admin/venues/${v.id}`}>{v.name}</a> {v.archived ? <span class="chip bad">archivée</span> : null}
                </td>
                <td>{[v.address, v.city].filter(Boolean).join(', ')}</td>
                <td class="num">{v.capacity}</td>
                <td>
                  <a href={`/admin/venues/${v.id}`}>Modifier</a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
    <form method="post" action="/admin/venues" class="panel" data-once>
      <h2>Ajouter une salle</h2>
      <VenueFields />
      <button class="btn" type="submit">
        Ajouter
      </button>
    </form>
  </Shell>
);

const VenueFields: FC<{ v?: Venue }> = ({ v }) => (
  <div class="form-grid">
    <Field id="name" label="Nom *">
      <input id="name" name="name" type="text" required maxlength={100} value={v?.name ?? ''} />
    </Field>
    <Field id="capacity" label="Capacité (personnes) *">
      <input id="capacity" name="capacity" type="number" min="1" max="100000" required value={v ? String(v.capacity) : ''} />
    </Field>
    <Field id="address" label="Adresse">
      <input id="address" name="address" type="text" maxlength={160} value={v?.address ?? ''} />
    </Field>
    <Field id="city" label="Ville">
      <input id="city" name="city" type="text" maxlength={80} value={v?.city ?? ''} />
    </Field>
  </div>
);

export const VenueEditView: FC<{ a: A; venue: Venue; errors: string[] }> = ({ a, venue, errors }) => (
  <Shell a={a} title={venue.name}>
    <h1>
      <em>{venue.name}</em>
    </h1>
    {errors.length ? (
      <div class="alert err" role="alert">
        {errors.join(' ')}
      </div>
    ) : null}
    <form method="post" action={`/admin/venues/${venue.id}`} class="panel" data-once>
      <VenueFields v={venue} />
      <div class="row-actions">
        <button class="btn" type="submit">
          Enregistrer
        </button>
        <button class="btn ghost" type="submit" formaction={`/admin/venues/${venue.id}/archive`} formnovalidate>
          {venue.archived ? 'Désarchiver' : 'Archiver'}
        </button>
        <a href="/admin/venues">Retour</a>
      </div>
    </form>
  </Shell>
);

// ---------- Commandes ----------

export const OrdersTable: FC<{ a: A; orders: (OrderRow & { event_title?: string })[] }> = ({ a, orders }) => (
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>N°</th>
          <th>Date</th>
          <th>Concert</th>
          <th>Client</th>
          <th>Canal</th>
          <th>Statut</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        {orders.length === 0 ? (
          <tr>
            <td colspan={7}>Aucune commande.</td>
          </tr>
        ) : (
          orders.map((o) => (
            <tr>
              <td>
                <a href={`/admin/orders/${o.id}`}>#{o.id}</a>
              </td>
              <td>{dt(a, o.paid_at ?? o.created_at)}</td>
              <td>{o.event_title ?? ''}</td>
              <td>
                {o.name || '—'}
                <br />
                <span class="muted">{o.email}</span>
              </td>
              <td>{CHANNEL_LABEL[o.channel]}</td>
              <td>
                <StatusChip status={o.status} />
              </td>
              <td class="num">{eur(a, o.total_cents)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

export const OrdersView: FC<{
  a: A;
  orders: (OrderRow & { event_title: string })[];
  q: string;
  status: string;
  eventId: number | null;
  eventOptions: { id: number; title: string; starts_at: string }[];
  page: number;
  hasMore: boolean;
}> = ({ a, orders, q, status, eventId, eventOptions, page, hasMore }) => {
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q);
    if (status) u.set('status', status);
    if (eventId) u.set('event', String(eventId));
    u.set('page', String(p));
    return `/admin/orders?${u.toString()}`;
  };
  return (
    <Shell a={a} title="Commandes">
      <h1>
        <em>Commandes</em>
      </h1>
      <form method="get" action="/admin/orders" class="filters">
        <div>
          <label for="q">Recherche</label>
          <input id="q" name="q" type="search" placeholder="email, nom, n°, code billet" value={q} />
        </div>
        <div>
          <label for="status">Statut</label>
          <select id="status" name="status">
            <option value="">Tous</option>
            {['paid', 'pending', 'expired', 'cancelled', 'refunded'].map((s) => (
              <option value={s} selected={status === s}>
                {STATUS_CHIP[s]?.label ?? s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="event">Concert</label>
          <select id="event" name="event">
            <option value="">Tous</option>
            {eventOptions.map((e) => (
              <option value={String(e.id)} selected={eventId === e.id}>
                {formatDateShort(e.starts_at, 'fr', a.tz)} — {e.title}
              </option>
            ))}
          </select>
        </div>
        <button class="btn small" type="submit">
          Chercher
        </button>
      </form>
      <div class="panel">
        <OrdersTable a={a} orders={orders} />
        <p class="row-actions">
          {page > 1 ? <a href={qs(page - 1)}>← Précédent</a> : null}
          {hasMore ? <a href={qs(page + 1)}>Suivant →</a> : null}
        </p>
      </div>
    </Shell>
  );
};

export const OrderDetailView: FC<{
  a: A;
  order: OrderRow;
  event: EventWithVenue;
  items: OrderItemNamed[];
  tickets: TicketWithType[];
  invoicePrefix: string;
}> = ({ a, order: o, event: e, items, tickets, invoicePrefix }) => {
  const inv = invoiceNumber(o, invoicePrefix);
  const canRefund = o.status === 'paid';
  return (
    <Shell a={a} title={`Commande #${o.id}`}>
      <h1>
        Commande <em>#{o.id}</em> <StatusChip status={o.status} />
      </h1>
      <div class="cols-2">
        <section class="panel">
          <h2>Détails</h2>
          <table class="tbl compact">
            <tbody>
              <tr>
                <th>Concert</th>
                <td>
                  <a href={`/admin/events/${e.id}`}>{e.title}</a>
                </td>
              </tr>
              <tr>
                <th>Client</th>
                <td>
                  {o.name || '—'} · {o.email || '—'}
                </td>
              </tr>
              <tr>
                <th>Canal</th>
                <td>
                  {CHANNEL_LABEL[o.channel]} · {METHOD_LABEL[o.payment_method]}
                  {o.created_by ? ` (par ${o.created_by})` : ''}
                </td>
              </tr>
              <tr>
                <th>Créée</th>
                <td>{dt(a, o.created_at)}</td>
              </tr>
              <tr>
                <th>Payée</th>
                <td>{dt(a, o.paid_at)}</td>
              </tr>
              {o.refunded_at ? (
                <tr>
                  <th>Remboursée</th>
                  <td>{dt(a, o.refunded_at)}</td>
                </tr>
              ) : null}
              <tr>
                <th>Total TTC</th>
                <td>
                  <b>{eur(a, o.total_cents)}</b> (TVA {formatRate(o.vat_rate_bp)})
                </td>
              </tr>
              <tr>
                <th>Facture</th>
                <td>{inv ? <a href={`/o/${o.token}/invoice`}>{inv}</a> : '—'}</td>
              </tr>
              {o.billing_name ? (
                <tr>
                  <th>Facturation</th>
                  <td>
                    {o.billing_name} {o.billing_vat} <span class="pre">{o.billing_address}</span>
                  </td>
                </tr>
              ) : null}
              <tr>
                <th>Paiement</th>
                <td>
                  {o.provider !== 'none' ? `${o.provider} ` : ''}
                  <span class="muted">{o.provider_payment_id ?? ''}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <h3>Lignes</h3>
          <table class="tbl compact">
            <tbody>
              {items.map((it) => (
                <tr>
                  <td>
                    {it.qty} × {it.name_fr}
                  </td>
                  <td class="num">{eur(a, it.unit_price_cents)}</td>
                  <td class="num">{eur(a, it.qty * it.unit_price_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h2>Actions</h2>
          <div class="row-actions">
            {o.status === 'paid' ? (
              <>
                <a class="btn small" href={`/o/${o.token}?print=1`} target="_blank" rel="noopener">
                  Imprimer les billets
                </a>
                <a class="btn small ghost" href={`/o/${o.token}`} target="_blank" rel="noopener">
                  Page du client
                </a>
                {o.email ? (
                  <form method="post" action={`/admin/orders/${o.id}/resend`} class="inline">
                    <button class="btn small ghost" type="submit">
                      Renvoyer l’email
                    </button>
                  </form>
                ) : null}
              </>
            ) : null}
            {canRefund ? (
              <form
                method="post"
                action={`/admin/orders/${o.id}/refund`}
                class="inline"
                data-confirm={`Rembourser la commande #${o.id} (${eur(a, o.total_cents)}) et invalider ses billets ? C’est définitif.`}
              >
                <button class="btn small danger ghost" type="submit">
                  Rembourser
                </button>
              </form>
            ) : null}
          </div>
          {canRefund && o.payment_method !== 'online' && o.total_cents > 0 ? (
            <p class="hint">Paiement {METHOD_LABEL[o.payment_method]} : le remboursement en main propre reste à faire par toi.</p>
          ) : null}
          <h2>Billets</h2>
          <table class="tbl compact">
            <thead>
              <tr>
                <th>Code</th>
                <th>Catégorie</th>
                <th>État</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colspan={3}>Aucun billet émis.</td>
                </tr>
              ) : (
                tickets.map((t) => (
                  <tr>
                    <td>{formatTicketCode(t.code)}</td>
                    <td>{t.name_fr}</td>
                    <td>
                      {t.status === 'void' ? (
                        <span class="chip bad">annulé</span>
                      ) : t.checked_in_at ? (
                        <span class="chip ok">entré {dt(a, t.checked_in_at)}</span>
                      ) : (
                        <span class="chip warn">pas encore entré</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
};

// ---------- Caisse / invités ----------

export const DoorView: FC<{
  a: A;
  events: { id: number; title: string; starts_at: string }[];
  types: (TicketTypeStock & { event_title: string })[];
  errors: string[];
}> = ({ a, events, types, errors }) => (
  <Shell a={a} title="Caisse et invités">
    <h1>
      Caisse <em>/ invités</em>
    </h1>
    <p>
      Vends des places à l’entrée (espèces, terminal) ou génère des billets d’invitation gratuits. Les billets sont créés tout de
      suite, avec QR code, et prêts à imprimer. Pour les places <b>NIP</b> (jamais en vente en ligne), choisis la catégorie NIP et le mode
      « Invitation gratuite ».
    </p>
    {errors.length ? (
      <div class="alert err" role="alert">
        {errors.join(' ')}
      </div>
    ) : null}
    {events.length === 0 ? (
      <p class="alert info">Aucun concert à venir.</p>
    ) : (
      <form method="post" action="/admin/door" class="panel" data-once>
        <div class="form-grid">
          <Field id="type_id" label="Concert et catégorie" hint="Les places restantes sont indiquées">
            <select id="type_id" name="type_id" required>
              {types.map((t) => (
                <option value={String(t.id)}>
                  {t.event_title} — {t.name_fr} ({eur(a, t.price_cents)}, reste {t.available})
                </option>
              ))}
            </select>
          </Field>
          <Field id="qty" label="Quantité">
            <input id="qty" name="qty" type="number" min="1" max="100" value="1" required />
          </Field>
          <Field id="mode" label="Mode">
            <select id="mode" name="mode">
              <option value="cash">Vente en espèces</option>
              <option value="terminal">Vente par terminal carte</option>
              <option value="guest">Invitation gratuite (liste invités)</option>
            </select>
          </Field>
          <Field id="name" label="Nom (facultatif)" hint="Imprimé sur le billet">
            <input id="name" name="name" type="text" maxlength={120} />
          </Field>
          <Field id="email" label="Email (facultatif)" hint="Pour envoyer les billets (et la facture)">
            <input id="email" name="email" type="email" maxlength={254} />
          </Field>
        </div>
        <button class="btn big" type="submit">
          Créer et imprimer
        </button>
      </form>
    )}
  </Shell>
);

// ---------- Rapports ----------

export const ReportsView: FC<{
  a: A;
  d: Dashboard;
  types: TypeStat[];
  eventId: number | null;
  eventOptions: { id: number; title: string; starts_at: string }[];
}> = ({ a, d, types, eventId, eventOptions }) => {
  const q = eventId ? `?event=${eventId}` : '';
  return (
    <Shell a={a} title="Rapports">
      <h1>
        <em>Rapports</em>
      </h1>
      <form method="get" action="/admin/reports" class="filters">
        <div>
          <label for="event">Concert</label>
          <select id="event" name="event">
            <option value="">Tous les concerts</option>
            {eventOptions.map((e) => (
              <option value={String(e.id)} selected={eventId === e.id}>
                {formatDateShort(e.starts_at, 'fr', a.tz)} — {e.title}
              </option>
            ))}
          </select>
        </div>
        <button class="btn small" type="submit">
          Afficher
        </button>
      </form>
      <div class="kpis">
        <div class="kpi red">
          <b>{eur(a, d.revenueCents)}</b>
          <span>Recettes TTC</span>
        </div>
        <div class="kpi">
          <b>{d.ticketsSold}</b>
          <span>Billets vendus</span>
        </div>
        <div class="kpi">
          <b>{d.ordersPaid}</b>
          <span>Commandes</span>
        </div>
      </div>
      <section class="panel">
        <h2>Exports (CSV, ouvrable dans Excel)</h2>
        <div class="row-actions">
          <a class="btn small" href={`/admin/export/orders.csv${q}`}>
            Commandes
          </a>
          <a class="btn small" href={`/admin/export/attendees.csv${q}`}>
            Liste des billets / entrées
          </a>
          <a class="btn small" href={`/admin/export/sales.csv${q}`}>
            Ventes par jour
          </a>
        </div>
        <p class="hint">Chaque export est enregistré dans le journal (il contient des données personnelles : à traiter avec soin).</p>
      </section>
      {types.length ? (
        <section class="panel">
          <h2>Par catégorie</h2>
          <table class="tbl compact">
            <thead>
              <tr>
                <th>Catégorie</th>
                <th class="num">Prix</th>
                <th class="num">Vendus</th>
                <th class="num">Quota</th>
                <th class="num">Recettes</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr>
                  <td>{t.name}</td>
                  <td class="num">{eur(a, t.priceCents)}</td>
                  <td class="num">{t.sold}</td>
                  <td class="num">{t.quota}</td>
                  <td class="num">{eur(a, t.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section class="panel">
        <h2>Ventes par jour (30 derniers jours)</h2>
        <table class="tbl compact">
          <thead>
            <tr>
              <th>Jour</th>
              <th class="num">Commandes</th>
              <th class="num">Billets</th>
              <th class="num">Recettes</th>
            </tr>
          </thead>
          <tbody>
            {[...d.byDay]
              .reverse()
              .filter((p) => p.orders > 0)
              .map((p) => (
                <tr>
                  <td>{p.day}</td>
                  <td class="num">{p.orders}</td>
                  <td class="num">{p.tickets}</td>
                  <td class="num">{eur(a, p.revenueCents)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </Shell>
  );
};
