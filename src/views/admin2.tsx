// SPDX-License-Identifier: AGPL-3.0-or-later
// Vues du back-office (suite) : réglages, équipe, journal d'audit, scanner d'entrée.

import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Role } from '../env';
import { ROLE_LABEL } from '../lib/auth';
import { formatDateTime } from '../lib/time';
import type { Settings } from '../services/settings';
import { Field, type A } from './admin';
import { AdminPage, DOCTYPE, Logo } from './layout';

const Shell: FC<PropsWithChildren<{ a: A; title: string }>> = ({ a, title, children }) => (
  <AdminPage title={title} staff={a.staff} path={a.path} orgName={a.orgName} flash={a.flash}>
    {children}
  </AdminPage>
);

// ---------- Réglages ----------

export const SettingsView: FC<{ a: A; s: Settings; vatPercent: string; errors: string[] }> = ({ a, s, vatPercent, errors }) => (
  <Shell a={a} title="Réglages">
    <h1>
      <em>Réglages</em>
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
    <form method="post" action="/admin/settings" class="panel" data-once>
      <h2>Organisateur (apparaît sur les factures)</h2>
      <div class="form-grid">
        <Field id="org_name" label="Nom affiché sur le site *">
          <input id="org_name" name="org_name" type="text" required maxlength={80} value={s.org_name} />
        </Field>
        <Field id="org_legal_name" label="Raison sociale" hint="Ex. : Les Punks ASBL">
          <input id="org_legal_name" name="org_legal_name" type="text" maxlength={120} value={s.org_legal_name} />
        </Field>
        <Field id="org_vat_number" label="N° de TVA / d’entreprise">
          <input id="org_vat_number" name="org_vat_number" type="text" maxlength={40} value={s.org_vat_number} />
        </Field>
        <Field id="org_email" label="Email de contact">
          <input id="org_email" name="org_email" type="email" maxlength={254} value={s.org_email} />
        </Field>
        <Field id="org_phone" label="Téléphone">
          <input id="org_phone" name="org_phone" type="text" maxlength={40} value={s.org_phone} />
        </Field>
        <Field id="org_website" label="Site web (URL)">
          <input id="org_website" name="org_website" type="url" maxlength={200} value={s.org_website} />
        </Field>
        <Field id="org_address" label="Adresse" wide>
          <textarea id="org_address" name="org_address" maxlength={300}>
            {s.org_address}
          </textarea>
        </Field>
      </div>
      <h2>Ventes et factures</h2>
      <div class="form-grid">
        <Field id="default_vat" label="TVA par défaut (%)" hint="Prix affichés TTC. À valider avec ton comptable !">
          <input id="default_vat" name="default_vat" type="text" inputmode="decimal" required value={vatPercent} />
        </Field>
        <Field id="timezone" label="Fuseau horaire" hint="Ex. : Europe/Brussels, Europe/Paris, Europe/Zurich">
          <input id="timezone" name="timezone" type="text" required value={s.timezone} />
        </Field>
        <Field id="default_lang" label="Langue par défaut du site">
          <select id="default_lang" name="default_lang">
            {[
              ['fr', 'Français'],
              ['en', 'English'],
              ['nl', 'Nederlands'],
            ].map(([v, l]) => (
              <option value={v} selected={s.default_lang === v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id="invoice_prefix" label="Préfixe des factures" hint="Lettres et chiffres. Ex. : PNK → PNK-2026-00001">
          <input id="invoice_prefix" name="invoice_prefix" type="text" maxlength={10} value={s.invoice_prefix} />
        </Field>
        <Field id="terms_url" label="Lien des conditions de vente (URL)" hint="Affiché sur la page d’achat et en pied de page" wide>
          <input id="terms_url" name="terms_url" type="url" maxlength={300} value={s.terms_url} />
        </Field>
        <Field id="invoice_footer" label="Mentions de pied de facture" hint="Ex. : conditions de paiement, mention légale, IBAN…" wide>
          <textarea id="invoice_footer" name="invoice_footer" maxlength={600}>
            {s.invoice_footer}
          </textarea>
        </Field>
      </div>
      <button class="btn" type="submit">
        Enregistrer
      </button>
    </form>
  </Shell>
);

// ---------- Équipe ----------

export const StaffView: FC<{
  a: A;
  staff: { email: string; role: Role; created_at: string; last_seen_at: string | null }[];
  errors: string[];
}> = ({ a, staff, errors }) => (
  <Shell a={a} title="Équipe">
    <h1>
      <em>Équipe</em>
    </h1>
    <p>
      Qui peut entrer dans le back-office, et pour quoi faire. La connexion elle-même (email + code) est gérée par Cloudflare
      Access : il faut aussi y autoriser l’adresse.
    </p>
    {errors.length ? (
      <div class="alert err" role="alert">
        {errors.join(' ')}
      </div>
    ) : null}
    <div class="panel tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Email</th>
            <th>Rôle</th>
            <th>Dernière visite</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {staff.map((m) => (
            <tr>
              <td>
                {m.email} {m.email === a.staff.email ? <span class="chip">toi</span> : null}
              </td>
              <td>
                <form method="post" action="/admin/staff/role" class="inline row-actions">
                  <input type="hidden" name="email" value={m.email} />
                  <select name="role" aria-label={`Rôle de ${m.email}`}>
                    {(['owner', 'manager', 'scanner'] as Role[]).map((r) => (
                      <option value={r} selected={m.role === r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button class="btn small ghost" type="submit">
                    Changer
                  </button>
                </form>
              </td>
              <td>{m.last_seen_at ? formatDateTime(m.last_seen_at, 'fr', a.tz) : 'jamais'}</td>
              <td>
                <form method="post" action="/admin/staff/delete" class="inline" data-confirm={`Retirer ${m.email} de l’équipe ?`}>
                  <input type="hidden" name="email" value={m.email} />
                  <button class="btn small danger" type="submit">
                    Retirer
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <form method="post" action="/admin/staff" class="panel" data-once>
      <h2>Ajouter quelqu’un</h2>
      <div class="form-grid">
        <Field id="email" label="Email *">
          <input id="email" name="email" type="email" required maxlength={254} />
        </Field>
        <Field id="role" label="Rôle">
          <select id="role" name="role">
            <option value="scanner">{ROLE_LABEL.scanner} — scanne les billets à l’entrée, rien d’autre</option>
            <option value="manager">{ROLE_LABEL.manager} — concerts, salles, commandes, rapports</option>
            <option value="owner">{ROLE_LABEL.owner} — tout, y compris réglages et équipe</option>
          </select>
        </Field>
      </div>
      <button class="btn" type="submit">
        Ajouter
      </button>
    </form>
  </Shell>
);

// ---------- Journal ----------

export const AuditView: FC<{
  a: A;
  rows: { id: number; at: string; actor: string; action: string; entity: string; entity_id: string; details: string }[];
  page: number;
  hasMore: boolean;
}> = ({ a, rows, page, hasMore }) => (
  <Shell a={a} title="Journal">
    <h1>
      <em>Journal</em>
    </h1>
    <div class="panel tbl-wrap">
      <table class="tbl compact">
        <thead>
          <tr>
            <th>Quand</th>
            <th>Qui</th>
            <th>Action</th>
            <th>Objet</th>
            <th>Détails</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{formatDateTime(r.at, 'fr', a.tz)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>
                {r.entity} {r.entity_id}
              </td>
              <td class="muted">{r.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="row-actions">
        {page > 1 ? <a href={`/admin/audit?page=${page - 1}`}>← Plus récent</a> : null}
        {hasMore ? <a href={`/admin/audit?page=${page + 1}`}>Plus ancien →</a> : null}
      </p>
    </div>
  </Shell>
);

// ---------- Scanner ----------

export const ScanView: FC<{
  events: { id: number; title: string; starts_at: string }[];
  email: string;
  canManage: boolean;
  tz: string;
}> = ({ events, email, canManage, tz }) => (
  <>
    {DOCTYPE}
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="theme-color" content="#0b0b0b" />
        <title>Scanner · PNK</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/assets/pnk.css" />
      </head>
      <body class="scan-body">
        <header class="top">
          <Logo />
          <span>
            {email} {canManage ? <a href="/admin">· back-office</a> : null}
          </span>
        </header>
        <main class="scan" id="main">
          {events.length === 0 ? (
            <p class="alert info">Aucun concert publié cette semaine. Rien à scanner pour l’instant.</p>
          ) : (
            <>
              <div class="bar">
                <div>
                  <label for="event">Concert</label>
                  <select id="event">
                    {events.map((e) => (
                      <option value={String(e.id)}>
                        {formatDateTime(e.starts_at, 'fr', tz)} — {e.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span class="sr">Entrées</span>
                  <div id="count" aria-live="polite">
                    — / —
                  </div>
                </div>
              </div>
              <video id="video" playsinline muted hidden></video>
              <p>
                <button id="cam" class="btn big block" type="button">
                  Activer la caméra
                </button>
              </p>
              <p id="cam-msg" class="muted" role="status"></p>
              <div id="result" class="scan-result" role="status" aria-live="assertive">
                <h2 id="result-title">PRÊT</h2>
                <p id="result-detail">Scanne un billet ou tape son code.</p>
              </div>
              <form id="manual" class="manual" autocomplete="off">
                <label class="sr" for="code">
                  Code du billet
                </label>
                <input id="code" type="text" placeholder="CODE DU BILLET" autocapitalize="characters" spellcheck={false} />
                <button class="btn" type="submit">
                  Valider
                </button>
              </form>
              <ul id="log" aria-label="Derniers scans"></ul>
            </>
          )}
        </main>
        <script src="/assets/jsQR.js" defer></script>
        <script src="/assets/scan.js" defer></script>
      </body>
    </html>
  </>
);
