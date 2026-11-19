# Déployer PNK sur Cloudflare

Durée : ~1 h la première fois. Rien n'est facturé hors du forfait Workers (recommandé : **Workers Payant**, ≈ 5 $/mois — la page « billets » fait du
calcul de QR, le plan gratuit limite le CPU à 10 ms par requête) et des frais de transaction Stripe.

> ⚠️ Ne déploie qu'après avoir répondu aux questions 🔴 de [QUESTIONS.md](QUESTIONS.md) (TVA, identité légale…) : elles s'impriment sur de vraies factures.

## 0. Prérequis
- Compte Cloudflare, `npm install` fait, `npx wrangler login` effectué (une fenêtre de navigateur s'ouvre : tu cliques « Autoriser »).
- **Un nom de domaine** (≈ 10–15 €/an) géré par Cloudflare : pas nécessaire pour développer et tester sur `*.workers.dev`, mais **indispensable avant d'ouvrir la vente** (emails d'expédition, protection du back-office par chemin, confiance des acheteurs).
- Compte Stripe (de l'organisateur légal), en **mode test** d'abord.

## 1. Base de données D1
```bash
npx wrangler d1 create pnk
# copie le "database_id" affiché dans wrangler.jsonc (d1_databases[0].database_id)
npx wrangler d1 migrations apply DB --remote
```
Ne lance **jamais** `seed/dev.sql` en production (données de démonstration).
La configuration de l'installation (raison sociale, adresse, TVA par défaut) se pose avec un fichier **non commité** :
`seed/instance.local.sql` (ignoré par git) puis `npx wrangler d1 execute DB --remote --file=seed/instance.local.sql`.
Tout reste modifiable ensuite dans *Réglages*.

## 2. Variables (`wrangler.jsonc` → `vars`)
| Variable | Valeur |
|---|---|
| `BASE_URL` | `https://billets.tondomaine.be` (sans slash final) |
| `MAIL_FROM` | `PNK <billets@tondomaine.be>` |
| `MAIL_DRIVER` | `cloudflare` (défaut) ou `resend` |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | voir §4 |
| `PAYMENT_PROVIDER` | `stripe` (ne jamais mettre `mock` en prod : il est refusé) |

Domaine personnalisé : ajoute dans `wrangler.jsonc` : `"routes": [{ "pattern": "billets.tondomaine.be", "custom_domain": true }]`.

## 3. Secrets
```bash
npx wrangler secret put HASH_SECRET            # openssl rand -hex 32
npx wrangler secret put BOOTSTRAP_OWNERS       # emails (séparés par des virgules) des 1ers PROPRIÉTAIRES, ex. toi@exemple.be
                                               # (en secret et non dans wrangler.jsonc : le dépôt est public)
npx wrangler secret put STRIPE_SECRET_KEY      # sk_test_… puis sk_live_… au passage en production
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… (voir §5)
# facultatifs : TURNSTILE_SECRET (+ TURNSTILE_SITE_KEY en var), RESEND_API_KEY
```

## 4. Cloudflare Access (la porte du back-office) — **obligatoire**
Sans ça, `/admin`, `/scan` et `/api/*` répondent **503** (le Worker refuse par sécurité).
1. Zero Trust → Access → Applications → *Add an application* → **Self-hosted**.
2. Domaine : `billets.tondomaine.be`, chemins : `/admin*`, `/scan*`, `/api/*` (trois entrées).
3. Politique *Allow* : les emails de l'équipe (ou ton domaine mail). Méthode de connexion : code à usage unique par email (ou Google).
4. Durée de session : **≥ 24 h** (sinon le scanner est déconnecté en pleine soirée → « ERREUR » à l'écran).
5. Récupère l'**Application Audience (AUD) tag** → `ACCESS_AUD`, et ton domaine d'équipe (`xxxx.cloudflareaccess.com`) → `ACCESS_TEAM_DOMAIN`.
6. Rôles *dans* PNK : page **Équipe** (propriétaire / gestionnaire / contrôle). Access dit **qui** tu es, PNK dit **ce que tu peux faire**.

## 5. Stripe
1. Développeurs → Webhooks → *Add endpoint* : `https://billets.tondomaine.be/webhooks/stripe`, évènements :
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
   Copie le *signing secret* → `STRIPE_WEBHOOK_SECRET`.
2. Paramètres → Moyens de paiement : active cartes, Apple Pay, Google Pay (automatiques), + Bancontact / iDEAL / Payconiq selon ton pays.
   Aucun changement de code nécessaire.
3. Repasse en **mode live** seulement après la recette (§8) : nouvelle clé, nouveau webhook, nouveau secret.

## 6. Emails
- **Cloudflare Email Service** : `npx wrangler email sending enable tondomaine.be`, puis `MAIL_FROM` avec une adresse de ce domaine.
  Vérifie dans la doc/le tableau de bord que l'offre est disponible sur ton forfait.
- **Alternative** : `MAIL_DRIVER=resend` + secret `RESEND_API_KEY` + domaine vérifié chez Resend.
- Les emails sont mis en file (`email_outbox`) et réessayés par le cron toutes les 10 min (5 essais).

## 7. (Recommandé) Anti-robots et limites
- **Turnstile** : crée un widget, `TURNSTILE_SITE_KEY` (var) + `TURNSTILE_SECRET` (secret). Le formulaire d'achat l'affiche automatiquement.
- WAF → Règle de limitation de débit sur `POST /e/*/checkout` (ex. 20 requêtes/minute/IP) en plus de la limite interne (12/10 min).

## 8. Déployer puis recette
```bash
npm run check && npx wrangler deploy
```
Recette à faire **en mode test Stripe**, avec toi (je ne peux pas la faire seul) :
- [ ] `https://…/` s'affiche ; `/admin` te demande ta connexion Access puis t'ouvre ; un inconnu est refusé.
- [ ] Réglages renseignés (raison sociale, adresse, n° TVA, TVA, lien CGV) → le bandeau jaune disparaît.
- [ ] Salle + concert créés, publié, visible en FR/EN/NL.
- [ ] Achat avec la carte test `4242 4242 4242 4242` : page de confirmation, **email reçu** (Gmail + Outlook), QR lisible.
- [ ] Apple Pay / Google Pay proposés sur téléphone ; Bancontact/iDEAL (mode test) si activés.
- [ ] Facture : mentions correctes ; **faire valider par le comptable**.
- [ ] Billet imprimé sur ton imprimante : QR scannable.
- [ ] Scanner sur un vrai téléphone (iPhone **et** Android) : OK, « déjà entré », mauvais concert.
- [ ] Remboursement depuis la page d'une commande : Stripe rembourse, billet « ANNULÉ ».
- [ ] Webhook : dans Stripe, évènements livrés avec statut 200.
- [ ] Puis seulement : clés **live**, nouveau webhook, un vrai achat de 1 €.

## 9. Exploitation
- **Sauvegardes** : D1 garde l'historique (Time Travel : `npx wrangler d1 time-travel info pnk`). Export manuel :
  `npx wrangler d1 export pnk --remote --output=sauvegarde.sql` (contient des données personnelles : à stocker avec soin).
- **Journaux** : `npx wrangler tail`. Emails en échec : `SELECT * FROM email_outbox WHERE status != 'sent'` (via `wrangler d1 execute`).
- **Mises à jour** : `git pull && npm install && npm run check && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
- Ne modifie jamais une migration déjà appliquée : ajoute `migrations/000N_….sql`.
