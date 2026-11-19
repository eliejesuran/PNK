// SPDX-License-Identifier: AGPL-3.0-or-later
// Gabarits de page : public (3 langues) et back-office (français).

import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Lang, Role, Staff } from '../env';
import { LANGS } from '../env';
import { LANG_NAMES, t } from '../i18n';
import { hasRole } from '../lib/auth';

/** Hono n'ajoute pas le doctype tout seul : sans lui, le navigateur passe en mode quirks. */
export const DOCTYPE = raw('<!DOCTYPE html>');

export interface OrgInfo {
  name: string;
  termsUrl: string;
  contactEmail: string;
}

export interface PageProps {
  lang: Lang;
  title: string;
  description?: string;
  org: OrgInfo;
  url: URL;
  noindex?: boolean;
  bodyData?: Record<string, string>;
  scripts?: string[];
  ogImage?: string;
}

function langHref(url: URL, lang: Lang): string {
  const u = new URL(url.toString());
  u.searchParams.set('lang', lang);
  return `${u.pathname}${u.search}`;
}

const Head: FC<{ title: string; description?: string; noindex?: boolean; lang: Lang; ogImage?: string; preload?: boolean }> = ({
  title,
  description,
  noindex,
  ogImage,
  preload,
}) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    {description ? <meta name="description" content={description} /> : null}
    {noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
    <meta name="theme-color" content="#d7000f" />
    <meta property="og:title" content={title} />
    {description ? <meta property="og:description" content={description} /> : null}
    {ogImage ? <meta property="og:image" content={ogImage} /> : null}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    {preload ? (
      <>
        <link rel="preload" href="/assets/fonts/anton-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="preload" href="/assets/fonts/courier-prime-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
      </>
    ) : null}
    <link rel="stylesheet" href="/assets/pnk.css" />
  </head>
);

export const Logo: FC = () => (
  <a class="logo" href="/" aria-label="PNK">
    <span>P</span>
    <span>N</span>
    <span>K</span>
  </a>
);

/** Page publique : en-tête avec logo + langues, contenu, pied de page. */
export const Page: FC<PropsWithChildren<PageProps>> = ({ lang, title, description, org, url, noindex, bodyData, scripts, ogImage, children }) => (
  <>
  {DOCTYPE}
  <html lang={lang}>
    <Head title={title} description={description} noindex={noindex} lang={lang} ogImage={ogImage} preload />
    <body {...(bodyData ?? {})}>
      <a class="skip" href="#main">
        {t(lang, 'nav.skip')}
      </a>
      <header class="top">
        <Logo />
        <nav class="langs" aria-label={t(lang, 'lang.label')}>
          {LANGS.map((l) => (
            <a href={langHref(url, l)} hreflang={l} lang={l} aria-current={l === lang ? 'true' : undefined}>
              {LANG_NAMES[l]}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" class="wrap">
        {children}
      </main>
      <footer class="foot">
        <span>{org.name}</span>
        <span>
          {org.termsUrl ? (
            <>
              <a href={org.termsUrl}>{t(lang, 'footer.terms')}</a> ·{' '}
            </>
          ) : null}
          {org.contactEmail ? (
            <>
              <a href={`mailto:${org.contactEmail}`}>{t(lang, 'footer.contact')}</a> ·{' '}
            </>
          ) : null}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html">{t(lang, 'footer.open')}</a>
        </span>
      </footer>
      <script src="/assets/app.js" defer></script>
      {(scripts ?? []).map((s) => (
        <script src={s} defer></script>
      ))}
    </body>
  </html>
  </>
);

// ---------- Back-office ----------

interface AdminNavItem {
  href: string;
  label: string;
  min: Role;
  match: string;
}

const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin', label: 'Tableau de bord', min: 'manager', match: '/admin' },
  { href: '/admin/events', label: 'Concerts', min: 'manager', match: '/admin/events' },
  { href: '/admin/venues', label: 'Salles', min: 'manager', match: '/admin/venues' },
  { href: '/admin/orders', label: 'Commandes', min: 'manager', match: '/admin/orders' },
  { href: '/admin/door', label: 'Caisse / invités', min: 'manager', match: '/admin/door' },
  { href: '/admin/reports', label: 'Rapports', min: 'manager', match: '/admin/reports' },
  { href: '/scan', label: 'Scanner', min: 'scanner', match: '/scan' },
  { href: '/admin/settings', label: 'Réglages', min: 'owner', match: '/admin/settings' },
  { href: '/admin/staff', label: 'Équipe', min: 'owner', match: '/admin/staff' },
  { href: '/admin/audit', label: 'Journal', min: 'owner', match: '/admin/audit' },
];

export interface AdminPageProps {
  title: string;
  staff: Staff;
  path: string;
  orgName: string;
  flash?: { kind: 'ok' | 'err' | 'info'; text: string } | null;
  wide?: boolean;
}

function navActive(item: AdminNavItem, path: string): boolean {
  if (item.match === '/admin') return path === '/admin';
  return path === item.match || path.startsWith(`${item.match}/`);
}

export const AdminPage: FC<PropsWithChildren<AdminPageProps>> = ({ title, staff, path, orgName, flash, children }) => (
  <>
  {DOCTYPE}
  <html lang="fr">
    <Head title={`${title} · ${orgName}`} noindex lang="fr" preload />
    <body class="admin">
      <header class="admin-top no-print">
        <Logo />
        <nav aria-label="Navigation du back-office">
          {ADMIN_NAV.filter((n) => hasRole(staff, n.min)).map((n) => (
            <a href={n.href} aria-current={navActive(n, path) ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <span class="who">{staff.email} · {staff.role}</span>
      </header>
      <main id="main" class="wrap">
        {flash ? <div class={`alert ${flash.kind}`} role="status">{flash.text}</div> : null}
        {children}
      </main>
      <script src="/assets/app.js" defer></script>
    </body>
  </html>
  </>
);
