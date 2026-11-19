# CLAUDE.md — PNK (billetterie punk, in-house)

> Fichier de suivi pour Claude Code. Lis-le en entier avant de toucher au code, mets-le à jour avant de terminer.
> Humain : voir `README.md`. Questions en attente pour le propriétaire : `docs/QUESTIONS.md`.

## Quoi / pourquoi
Billetterie pour une salle de concert punk : vente en ligne (QR code, facture, impression), back-office (concerts, salles, places,
stats, caisse/invités, scanner d'entrée). Open source **AGPL-3.0-or-later**, hébergée sur le compte Cloudflare du propriétaire,
coût minimal. Langues publiques : FR (référence), EN, NL. Back-office : FR seulement. Style punk, **rouge** dominant, rien qui
ressemble à du « design IA » (pas de dégradés doux, coins ronds, violet, Inter).

## Stack
Cloudflare Workers + D1 (SQLite) · Hono (+ JSX serveur `hono/jsx`, pas de React) · TypeScript strict · jose (JWT Cloudflare Access)
· qrcode-generator · Stripe Checkout via REST (pas de SDK) · Cloudflare Email Service (binding `EMAIL`) ou Resend · vitest +
`@cloudflare/vitest-plugin` (tests dans le vrai runtime workerd, vraie D1 locale).

## Commandes
```bash
npm run dev                 # wrangler dev (http://localhost:8787) ; copier .dev.vars.example -> .dev.vars d'abord
npm run db:reset:local      # migrations + données de démo (seed/dev.sql) — LOCAL uniquement
npm run check               # tsc --noEmit + vitest run  → DOIT être vert avant tout commit
npm run test                # vitest seul (≈ 5 s)
npm run build:assets        # recopie polices + jsQR dans public/assets (les fichiers copiés sont commités)
npx wrangler d1 migrations apply DB --remote   # prod : voir docs/DEPLOY.md
```

## Carte du code
| Chemin | Rôle |
|---|---|
| `src/index.tsx` | Assemblage Hono, gardes de rôle (`requireRole`), 404/500, cron (`runScheduled`) |
| `src/env.ts` | Types des bindings/variables (`Env`, `Vars`, `Role`) |
| `src/ctx.ts` | Middleware langue + réglages, `viewCtx()` |
| `src/middleware.tsx` | `requireRole(min)` : identité Access → ligne `staff` → rôle |
| `src/lib/auth.ts` | Vérif JWT Cloudflare Access (RS256), auth dev localhost, `resolveStaff`, `envGaps` |
| `src/lib/security.ts` | CSP, en-têtes, anti-CSRF (Origin/Sec-Fetch-Site), hash d'IP, Turnstile |
| `src/lib/{ids,money,time,qr,text,flash}.ts` | codes billets (Crockford 80 bits), centimes/TVA, fuseaux, QR SVG+PNG, CSV sûr, flash |
| `src/services/orders.ts` | **Cœur** : `createOrder` (réservation atomique), `startCheckout`, `fulfillOrder`, `refundOrder`, `rateLimited` |
| `src/services/payments/` | `stripe.ts` (REST + signature webhook), `mock.ts` (dev), `index.ts` (`getProvider`, échoue fermé) |
| `src/services/{events,settings,stats,mail,emails,audit}.ts` | lecture/écriture métier, file d'emails, gabarits d'emails |
| `src/routes/public.tsx` | accueil, `/e/:slug`, achat, `/o/:token` (+facture, annulation), `/q/:code.png`, faux paiement dev |
| `src/routes/webhooks.ts` | `/webhooks/stripe` (signature + idempotence) |
| `src/routes/admin.tsx`, `admin-ops.tsx` | back-office : dashboard, concerts, types, salles / commandes, caisse, exports, réglages, équipe, journal, `/scan`, `/api/scan` |
| `src/views/*.tsx` | JSX : `layout`, `public`, `admin`, `admin2`, `errors` |
| `src/i18n/` | `fr.ts` (référence, définit `Dict`), `en.ts`, `nl.ts`, `index.ts` (`t()`, `pickLang`) |
| `migrations/` | `0001_init.sql` schéma complet ; `0002_ticket_type_note.sql` (petit texte des catégories). **Ne jamais modifier une migration déjà publiée : en ajouter une** |
| `public/` | assets statiques (servis avant le Worker) : `pnk.css`, `app.js`, `scan.js`, polices, jsQR |
| `test/` | `unit`, `flow` (achat), `admin`, `payments-mail`, `invariants` (chaos), `qr-decode` |

## Invariants et règles (à ne pas casser)
1. **Argent en centimes (entiers)**, prix TTC, TVA extraite du TTC (`splitVat`). Dates en UTC ISO, affichées dans `settings.timezone`.
2. **Pas de survente** : toute réservation = `INSERT … SELECT` conditionnel (`takenSql`), jamais « lire puis écrire ». Les
   réservations `pending` expirent (`HOLD_MINUTES`=32 > session Stripe 31 min ; Stripe exige ≥ 30 min).
3. **`fulfillOrder` est idempotent** (webhook + page de retour + cron peuvent l'appeler en parallèle). Facture : numéro calculé
   dans l'UPDATE (`MAX(invoice_seq)+1`) + `UNIQUE(invoice_year, invoice_seq)` → sans trou ni doublon. Paiement reçu après expiration :
   re-réservation, sinon remboursement automatique.
4. **Échoue fermé** : pas de config Access en prod ⇒ 503 sur le back-office ; `PAYMENT_PROVIDER=mock` refusé hors
   `ENVIRONMENT=development` ; auth dev seulement si host = localhost.
5. **CSP stricte** (`style-src 'self'`, `script-src 'self'` + Turnstile) : **aucun `style=""` ni `<script>` inline** dans les vues. Utiliser
   des classes CSS. Tout JS vit dans `public/assets/*.js`.
6. **i18n** : toute chaîne publique passe par `t()`. Ajouter la clé dans `fr.ts` PUIS `en.ts` et `nl.ts` (le compilateur et
   `test/unit.test.ts` vérifient la parité des clés et des `{variables}`).
7. **Échapper** : JSX échappe seul ; pour du HTML construit à la main (emails) utiliser `esc()`. Les CSV passent par `csvCell` (anti-injection de formules).
8. **Tout fichier source** commence par `// SPDX-License-Identifier: AGPL-3.0-or-later` (ou `/* … */` / `--`).
9. **Secrets et données d'installation** : jamais dans le dépôt (public !). `.dev.vars` est ignoré ; secrets de prod via `wrangler secret put` (dont `BOOTSTRAP_OWNERS`, les emails des premiers propriétaires). La configuration propre à l'organisation (raison sociale, adresse, TVA par défaut…) vit dans `seed/*.local.sql` (ignoré par git) et dans la table `settings` ; les identifiants de compte Cloudflare (database_id, URL…) vivent dans `wrangler.local.jsonc` (ignoré par git, utilisé par `npm run deploy`). Ne jamais écrire emails, noms ou adresses réels dans le code, les docs ou les tests.
10. Tout changement de logique métier = un test (ou plus) ; les bugs corrigés laissent un test de non-régression.

## Pièges connus (déjà rencontrés)
- Hono `c.html(<Comp/>)` **n'ajoute pas** `<!DOCTYPE html>` → on l'injecte via `DOCTYPE` (`views/layout.tsx`) dans chaque page.
- Attributs JSX numériques (`maxlength`, `colspan`) : passer un nombre `{120}`, pas une chaîne.
- `Response.text()` retire le BOM UTF-8 : pour tester le BOM des CSV, lire `arrayBuffer()`.
- L'outil d'écriture transforme `'﻿'` en caractère réel : vérifier avec `grep -n ufeff` ; préférer `String.fromCharCode`/échappement testé.
- `URL` normalise `/o/../admin` et `/o/%2e%2e/admin` en `/admin` : pour tester un chemin piégé, utiliser `..%2f`.
- `@cloudflare/vitest-pool-workers` est déprécié → on utilise `@cloudflare/vitest-plugin` (`cloudflareTest`).
- Le limiteur de débit regroupe par `cf-connecting-ip` ; en `wrangler dev` l'en-tête est absent (tous = « unknown », 12 achats/10 min).
- D1 : paramètres `?1`, `?2` numérotés ; `batch()` est transactionnel mais un `INSERT…SELECT` à 0 ligne ne lève pas d'erreur → vérifier `meta.changes`.
- Les assets de `public/` sont servis **avant** le Worker (pas d'en-têtes de sécurité du Worker dessus) ; cache 5 min via `public/_headers`.
- **Impression des billets : 2 par page au maximum** (`@media print` dans `pnk.css` : bloc normal + `break-after: page` après chaque 2ᵉ billet). Vérifier après toute modification avec Chrome sans interface : créer des commandes de 1 à 5 billets, `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --print-to-pdf=x.pdf <url /o/TOKEN>`, compter les `/Type /Page` du PDF → attendu 1, 1, 2, 2, 3 pages.
- Les iframes sont interdites (`X-Frame-Options: DENY`, `frame-ancestors 'none'`). Si le site de la salle veut intégrer la billetterie : à décider (voir QUESTIONS).

## Visite de démonstration (GitHub Pages)
Site statique cliquable : https://eliejesuran.github.io/PNK/ — branche `gh-pages` (ne contient que le site généré). Il montre l'identité **publique** de l'organisation (raison sociale, siège, n° d'entreprise, email de contact) **sur demande expresse du propriétaire** ; concerts, noms de spectateurs et commandes y sont fictifs, jamais de vraies données de clients.
- Régénérer : `npm run db:reset:local` (jamais le fichier d'installation `seed/*.local.sql`) → `npm run dev` → `python3 scripts/build-demo-site.py <dossier> --forbid "<mots réels à interdire>"`
  (le script refuse de produire le site si `localhost` ou un mot interdit apparaît) → committer le dossier généré **sur `gh-pages`** (dépôt git temporaire, push `gh-pages`).
- À refaire après toute modification visible de l'interface. Le gabarit de la page d'accueil est `scripts/demo-site/index.html`.

## État d'avancement (mettre à jour)
**Fait et vérifié (tests + navigateur local)**
- [x] Parcours public complet : accueil, page concert (3 langues), achat, page commande + billets QR imprimables, facture, emails.
- [x] Stock sans survente (testé : 20 achats simultanés / 5 places ; chaos aléatoire ×4 graines), paiement tardif, auto-remboursement.
- [x] Stripe Checkout (REST) + webhook signé idempotent + filet de sécurité au retour. **Testé contre une API simulée, jamais contre le vrai Stripe.**
- [x] Catégories de places : nom FR/EN/NL, prix, quota, vente en ligne oui/non, **petit texte**. **NIP = « Not Very Important Person » = invitations gratuites, jamais en vente en ligne** (créé à prix 0 et `online = 0` par le formulaire de concert ; généré via *Caisse / invités → Invitation gratuite*). Back-office : tableau de bord (KPI, courbe, canaux, remplissage), concerts (+ Standard/NIP/types libres, publier, dupliquer, annuler),
      salles, commandes (recherche, remboursement, renvoi d'email), caisse/invités (impression directe), rapports + exports CSV,
      réglages, équipe (3 rôles), journal d'audit.
- [x] Scanner d'entrée (caméra BarcodeDetector/jsQR + saisie manuelle, anti double passage atomique, compteur).
- [x] Sécurité : Cloudflare Access (JWT RS256) + rôles, CSP, CSRF, anti-abus (limiteur + Turnstile optionnel), audit.
- [x] 3 langues publiques, style punk, responsive (vérifié en mobile 375 px).
- [x] 131 tests verts ; `tsc` strict propre.

**État du déploiement de test (workers.dev)** : Worker, base D1 (EU), migrations, configuration de l'organisation et secrets (`HASH_SECRET`, `BOOTSTRAP_OWNERS`) sont en place sur le compte du propriétaire ; le site public répond, `/admin` et `/scan` répondent 503 tant qu'Access n'est pas configuré (échoue fermé, voulu). Reste : Access (voir `docs/DEPLOY.md` §3 bis), Stripe (test), domaine + emails.

**Pas vérifié en réel (aucun accès aux comptes)** — à faire au déploiement, voir `docs/DEPLOY.md` §Recette :
- [ ] Vrai paiement Stripe (mode test) + webhook, Apple Pay / Google Pay / Bancontact.
- [ ] Vrai JWT Cloudflare Access (seul le rejet des faux a été testé).
- [ ] Envoi réel via Cloudflare Email Service (domaine à activer) ; rendu de l'email dans Gmail/Outlook/Apple Mail.
- [ ] Scan caméra sur un vrai téléphone (iOS Safari = jsQR ; Android Chrome = BarcodeDetector) ; impression papier réelle.

**À faire / idées (non bloquant)** — priorisées dans `docs/QUESTIONS.md`
- [ ] Notes de crédit numérotées pour les remboursements (aujourd'hui : facture marquée « remboursée »).
- [ ] Remboursement partiel ; billets nominatifs / transfert ; codes promo ; frais de service.
- [ ] Upload d'affiches (R2) ; back-office traduit EN/NL ; PDF des billets en pièce jointe ; Apple/Google Wallet.
- [ ] Mode scanner hors-ligne (liste de codes en cache) si le réseau de la salle est mauvais.
- [ ] Pages légales (CGV, confidentialité) : le lien CGV est un réglage, le texte reste à fournir par la salle.

**Bloqué en attente du propriétaire** : voir `docs/QUESTIONS.md` — mention de facture à TVA 0 %, compte Stripe (de l'ASBL), nom de domaine (non urgent pour tester, requis avant la vente), connexion `wrangler login`, textes légaux, email d'expédition. Déjà répondu : NIP, identité de l'organisateur (nom, siège, n° d'entreprise, email), TVA 0 % (modifiable), Belgique, premier propriétaire.

## Déroulé de travail attendu
1. `npm run check` avant chaque commit. Messages de commit en français, concis, à l'impératif ; terminer par la ligne de co-auteur demandée.
2. Nouvelle fonctionnalité : migration SQL (si schéma) → service → route → vue → i18n (3 langues) → tests → mettre à jour ce fichier.
3. Vérifier visuellement dans le navigateur (desktop + mobile 375) toute modification de vue ; vérifier la console (violations CSP).
4. Ne jamais déployer en production ni créer de ressources Cloudflare/Stripe sans demande explicite du propriétaire.
5. Mettre à jour `docs/QUESTIONS.md` dès qu'une décision manque ; `docs/DEBUG-LOG.md` après chaque passe de debug.
