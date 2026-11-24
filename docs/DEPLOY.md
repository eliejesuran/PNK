# Déployer PNK sur Cloudflare

Durée : ~1 h la première fois. Rien n'est facturé hors du forfait Workers (recommandé : **Workers Payant**, ≈ 5 $/mois — la page « billets » fait du
calcul de QR, le plan gratuit limite le CPU à 10 ms par requête) et des frais de transaction Stripe.

> ⚠️ Ne déploie qu'après avoir répondu aux questions 🔴 de [QUESTIONS.md](QUESTIONS.md) (TVA, identité légale…) : elles s'impriment sur de vraies factures.

## 0. Prérequis
- Compte Cloudflare, `npm install` fait, `npx wrangler login` effectué (une fenêtre de navigateur s'ouvre : tu cliques « Autoriser »).
- **Un nom de domaine** (≈ 10–15 €/an) géré par Cloudflare : pas nécessaire pour développer et tester sur `*.workers.dev`, mais **indispensable avant d'ouvrir la vente** (emails d'expédition, protection du back-office par chemin, confiance des acheteurs).
- Compte Stripe (de l'organisateur légal), en **mode test** d'abord.

## 1. Base de données D1 et configuration locale
Le dépôt est public : les identifiants propres à ton compte ne vont **jamais** dans `wrangler.jsonc`. On les met dans `wrangler.local.jsonc`
(copie de `wrangler.jsonc`, **ignorée par git**), utilisée par `npm run deploy` et `npm run db:migrate:remote`.
```bash
npx wrangler d1 create pnk --location weur     # base en Europe de l'Ouest
cp wrangler.jsonc wrangler.local.jsonc          # puis colle le "database_id" affiché dans wrangler.local.jsonc
npm run db:migrate:remote
```
Ne lance **jamais** `seed/dev.sql` en production (données de démonstration).
La configuration de l'installation (raison sociale, adresse, TVA par défaut) se pose avec un fichier **non commité** :
`seed/instance.local.sql` (ignoré par git) puis `npx wrangler d1 execute DB --remote -c wrangler.local.jsonc --file=seed/instance.local.sql`.
Tout reste modifiable ensuite dans *Réglages*.

## 2. Variables (`wrangler.local.jsonc` → `vars`)
| Variable | Valeur |
|---|---|
| `BASE_URL` | `https://billets.tondomaine.be` (sans slash final) |
| `MAIL_FROM` | `PNK <billets@tondomaine.be>` |
| `MAIL_DRIVER` | `cloudflare` (défaut) ou `resend` |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | voir §4 |
| `PAYMENT_PROVIDER` | `mollie` (défaut) ou `stripe` (ne jamais mettre `mock` en prod : il est refusé) |

Domaine personnalisé : ajoute dans `wrangler.jsonc` : `"routes": [{ "pattern": "billets.tondomaine.be", "custom_domain": true }]`.

## 3. Secrets
```bash
npx wrangler secret put HASH_SECRET -c wrangler.local.jsonc            # openssl rand -hex 32
npx wrangler secret put BOOTSTRAP_OWNERS -c wrangler.local.jsonc       # emails (séparés par des virgules) des 1ers PROPRIÉTAIRES, ex. toi@exemple.be
                                               # (en secret et non dans wrangler.jsonc : le dépôt est public)
npx wrangler secret put MOLLIE_API_KEY -c wrangler.local.jsonc         # test_… pour essayer, puis live_… pour de vrais paiements (voir §5)
# (seulement si PAYMENT_PROVIDER=stripe : STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET)
# facultatifs : TURNSTILE_SECRET (+ TURNSTILE_SITE_KEY en var), RESEND_API_KEY
```

## 3 bis. Sans nom de domaine : test privé sur `*.workers.dev`
Avant d'avoir un domaine, on peut déjà tout tester sur l'adresse `https://pnk.<ton-sous-domaine>.workers.dev` (la première fois, `wrangler deploy`
te demande de choisir ce sous-domaine). La protection se fait alors **au niveau du Worker** :
1. Cloudflare → *Zero Trust* (première fois : choisir un nom d'équipe et l'offre gratuite) ;
2. *Workers & Pages* → ton Worker `pnk` → onglet **Access** → *Protect this Worker behind Access* → **All traffic** → une politique
   (membres du compte Cloudflare, ou des emails) → *Apply Access* ;
3. Noter le **domaine d'équipe** (`xxxx.cloudflareaccess.com`) et l'**AUD tag** de l'application Access créée (ou affichés dans la fenêtre d'activation),
   les mettre dans `ACCESS_TEAM_DOMAIN` et `ACCESS_AUD` de `wrangler.local.jsonc`, puis `npm run deploy`.

**Limites de ce mode (test privé uniquement)** : Access protège **tout** le site, public compris (il faut être connecté pour voir les concerts) ;
et **les notifications de paiement sont bloquées** (Mollie / Stripe ne peuvent pas se connecter à Access). Les achats d'essai fonctionnent quand même :
si Mollie refuse l'adresse de notification, PNK recrée le paiement sans elle, et le paiement est confirmé par la vérification faite au retour de
l'acheteur (page de commande). Ce qui manque : la confirmation automatique si l'acheteur ferme son navigateur avant le retour. Pour ouvrir au public :
un nom de domaine, puis l'application Access limitée à `/admin*`, `/scan*`, `/api/*` (§4).

## 4. Cloudflare Access (la porte du back-office) — **obligatoire**
Sans ça, `/admin`, `/scan` et `/api/*` répondent **503** (le Worker refuse par sécurité).
1. Zero Trust → Access → Applications → *Add an application* → **Self-hosted**.
2. Domaine : `billets.tondomaine.be`, chemins : `/admin*`, `/scan*`, `/api/*` (trois entrées).
3. Politique *Allow* : les emails de l'équipe (ou ton domaine mail). Méthode de connexion : code à usage unique par email (ou Google).
4. Durée de session : **≥ 24 h** (sinon le scanner est déconnecté en pleine soirée → « ERREUR » à l'écran).
5. Récupère l'**Application Audience (AUD) tag** → `ACCESS_AUD`, et ton domaine d'équipe (`xxxx.cloudflareaccess.com`) → `ACCESS_TEAM_DOMAIN`.
6. Rôles *dans* PNK : page **Équipe** (propriétaire / gestionnaire / contrôle). Access dit **qui** tu es, PNK dit **ce que tu peux faire**.

## 5. Paiement : Mollie (par défaut)
Mollie est une société néerlandaise (UE). Le client paie sur une page Mollie : Bancontact, cartes, Apple Pay, Google Pay, Wero, iDEAL selon ce que tu actives.
1. **Compte** sur mollie.com (pays Belgique), au nom de l'ASBL. Vérification demandée : pièce d'identité des représentants légaux, n° d'entreprise, IBAN.
   Avant de t'engager, **demande au support Mollie qu'une ASBL est bien acceptée** et quels documents fournir.
2. **Clé de test** : Tableau de bord → *Développeurs* → *Clés API* → la clé `test_…` du profil du site. La poser en secret :
   `npx wrangler secret put MOLLIE_API_KEY -c wrangler.local.jsonc` (colle la clé quand il la demande, jamais dans un chat).
3. **Moyens de paiement** : *Paramètres* → *Moyens de paiement* : active Bancontact, cartes, Apple Pay, Google Pay (et Wero / iDEAL). Aucun changement de code.
4. **Notifications** : rien à configurer. PNK envoie l'adresse `/webhooks/mollie` avec chaque paiement. Mollie ne signe pas ses notifications : PNK relit
   donc toujours le paiement chez Mollie avec ta clé avant d'agir (une fausse requête ne valide rien).
5. **Essais** : en mode test, Mollie affiche une page où tu choisis le résultat (payé, annulé, échoué, expiré). Cartes de test : Visa `4543 4740 0224 9996`,
   Mastercard `2223 0000 1047 9399`, date future et code au hasard. Sans clé `test_`, le tableau de bord PNK affiche « Paiements Mollie en mode TEST ».
6. **Vrais paiements** : une fois le compte activé par Mollie, remplace par la clé `live_…` (même commande), puis fais un vrai achat de 1 € et rembourse-le.
Les paiements qui expirent côté PNK (réservation de 32 min) sont fermés automatiquement chez Mollie par la tâche planifiée.

*Alternative Stripe* : `PAYMENT_PROVIDER=stripe`, secrets `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`, webhook `https://…/webhooks/stripe` avec les évènements
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.

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
npm run deploy      # = npm run check puis wrangler deploy -c wrangler.local.jsonc
```
Recette à faire **en mode test Mollie**, avec toi (je ne peux pas la faire seul) :
- [ ] `https://…/` s'affiche ; `/admin` te demande ta connexion Access puis t'ouvre ; un inconnu est refusé.
- [ ] Réglages renseignés (raison sociale, adresse, n° TVA, TVA, lien CGV) → le bandeau jaune disparaît.
- [ ] Salle + concert créés, publié, visible en FR/EN/NL.
- [ ] Achat de test (page de test Mollie : « payé ») : page de confirmation, **email reçu** (Gmail + Outlook), QR lisible.
- [ ] Apple Pay / Google Pay proposés sur téléphone ; Bancontact (mode test) si activé.
- [ ] Facture : mentions correctes ; **faire valider par le comptable**.
- [ ] Billet imprimé sur ton imprimante : QR scannable.
- [ ] Scanner sur un vrai téléphone (iPhone **et** Android) : OK, « déjà entré », mauvais concert.
- [ ] Remboursement depuis la page d'une commande : Mollie rembourse, billet « ANNULÉ ».
- [ ] Notification : dans le tableau de bord Mollie, l'appel `/webhooks/mollie` est livré (statut 200) — impossible tant que le site est derrière Access « All traffic ».
- [ ] Puis seulement : clé **live**, un vrai achat de 1 €, remboursé.

## 9. Exploitation
- **Sauvegardes** : D1 garde l'historique (Time Travel : `npx wrangler d1 time-travel info pnk`). Export manuel :
  `npx wrangler d1 export pnk --remote --output=sauvegarde.sql` (contient des données personnelles : à stocker avec soin).
- **Journaux** : `npx wrangler tail`. Emails en échec : `SELECT * FROM email_outbox WHERE status != 'sent'` (via `wrangler d1 execute`).
- **Mises à jour** : `git pull && npm install && npm run check && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
- Ne modifie jamais une migration déjà appliquée : ajoute `migrations/000N_….sql`.
