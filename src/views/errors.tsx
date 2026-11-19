// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FC } from 'hono/jsx';
import type { Lang } from '../env';
import { t } from '../i18n';
import { DOCTYPE, Page, type OrgInfo } from './layout';

export const ErrorView: FC<{ lang: Lang; org: OrgInfo; url: URL; title: string; text: string; code?: number }> = ({
  lang,
  org,
  url,
  title,
  text,
  code,
}) => (
  <Page lang={lang} title={`${title} · ${org.name}`} org={org} url={url} noindex>
    <section class="status-box">
      {code ? <p class="marker">{code}</p> : null}
      <h1>{title}</h1>
      <p>{text}</p>
      <p>
        <a class="btn" href="/">
          {t(lang, 'err.home')}
        </a>
      </p>
    </section>
  </Page>
);

/** Page d'erreur minimale du back-office (accès refusé, auth non configurée…). */
export const AdminDenied: FC<{ code: number; message: string }> = ({ code, message }) => (
  <>
  {DOCTYPE}
  <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>Accès refusé · PNK</title>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="/assets/pnk.css" />
    </head>
    <body>
      <main class="wrap">
        <section class="status-box">
          <p class="marker">{code}</p>
          <h1>Accès refusé</h1>
          <p>{message}</p>
          <p>
            <a class="btn" href="/">
              Retour au site
            </a>
          </p>
        </section>
      </main>
    </body>
  </html>
  </>
);
