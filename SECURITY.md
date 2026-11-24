# Sécurité

## Modèle en bref
| Menace | Parade |
|---|---|
| Accès non autorisé au back-office | Cloudflare Access (SSO / code email) **+** vérification du JWT dans le Worker (signature RS256, issuer, audience) **+** rôles `owner` / `manager` / `scanner` en base. Aucune config ⇒ **503** (échoue fermé). Aucun en-tête d'email « de confiance ». |
| Auth de dev oubliée en production | Active seulement si `ENVIRONMENT=development` **et** host `localhost` / `127.0.0.1` / `[::1]`. |
| Faux paiement en production | `PAYMENT_PROVIDER=mock` refusé hors développement. Webhooks Stripe : signature HMAC, tolérance 5 min, idempotence, session vérifiée contre la commande. Webhook Mollie : non signé par conception, donc le paiement est toujours relu chez Mollie avec notre clé et seule une commande portant cet identifiant est touchée (testé : une fausse notification ne valide rien). |
| Survente / double émission | Réservation atomique en SQL, émission idempotente, index UNIQUE (voir `docs/ARCHITECTURE.md`). Testé en charge aléatoire. |
| Billet forgé / deviné | Code aléatoire de 80 bits vérifié en base (pas de « signature » à contourner). Jeton de commande de 192 bits. |
| Double passage à l'entrée | `UPDATE … WHERE checked_in_at IS NULL` atomique. |
| CSRF | Toute requête modifiante doit venir de l'origine du site (`Origin` / `Sec-Fetch-Site`). |
| XSS / injection de contenu | Rendu JSX échappé ; CSP stricte (`default-src 'none'`, scripts et styles `'self'` uniquement, pas d'inline) ; emails échappés ; URLs d'affiche limitées à http(s). |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'`. |
| Injection SQL | Requêtes préparées partout ; recherche `LIKE` échappée. |
| Injection de formules CSV | Cellules commençant par `= + - @` neutralisées. |
| Abus / bots | Limiteur de débit par IP hachée (HMAC, l'IP n'est pas stockée), Turnstile optionnel, quotas par commande. |
| Fuite de données | Pages privées `no-store` + `noindex` ; secrets hors dépôt ; exports et actions sensibles tracés dans le journal d'audit. |

## Données personnelles
Stockées : nom, email, (société/adresse de facturation si fournis), empreinte HMAC de l'IP de l'acheteur. Pas de données bancaires
(Mollie / Stripe les traitent). Durée de conservation et procédure d'effacement : à définir avec l'organisateur (voir `docs/QUESTIONS.md`).

## Limites connues
- Un QR code est transmissible : le premier qui passe, passe (à décider : billets nominatifs ? voir QUESTIONS.md).
- Le comportement face au vrai Cloudflare Access et au vrai Mollie / Stripe est testé par simulation, pas en réel (recette dans `docs/DEPLOY.md`).
- `npm audit` signale des alertes dans l'outillage de développement (wrangler/miniflare), **pas** dans le code déployé (`npm audit --omit=dev` : 0).

## Signaler une faille
Merci de **ne pas** ouvrir d'issue publique : utilise le *signalement privé de vulnérabilité* de GitHub (onglet Security du dépôt)
ou contacte directement l'organisateur. Une réponse sous quelques jours ; correctif et remerciements publics après correction.
