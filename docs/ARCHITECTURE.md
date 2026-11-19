# Architecture

## Vue d'ensemble
```
Navigateur ──HTTPS──▶ Cloudflare ──▶ Worker PNK (Hono, SSR) ──▶ D1 (SQLite)
                         │                 │  ├─▶ Stripe API (Checkout, refund)      ◀── Webhook signé
   Access (JWT) devant   │                 │  └─▶ Email Service / Resend
   /admin /scan /api/*   └─ assets statiques (public/) servis avant le Worker
Cron */10 min : libère les réservations expirées, réessaie les emails, purge le limiteur
```
Pas de framework front : pages rendues côté serveur, un peu de JavaScript d'amélioration progressive (`public/assets/*.js`).
Tout fonctionne sans JS sauf le scanner caméra.

## Modèle de données (`migrations/0001_init.sql`)
`venues` 1─n `events` 1─n `ticket_types` ; `orders` (n─1 `events`) 1─n `order_items` (n─1 `ticket_types`) ; `orders` 1─n `tickets`.
Annexes : `settings` (clé/valeur), `staff` (email → rôle), `email_outbox`, `audit_log`, `webhook_events`, `rate_limits`.
- Montants en **centimes**, TTC ; `orders.vat_rate_bp` fige le taux au moment de l'achat.
- `orders.status` : `pending → paid → refunded` ; `pending → expired | cancelled` ; `expired|cancelled → paid` si paiement tardif et places libres.
- `orders.channel` : `online` | `door` (caisse) | `guest` (invitation) ; `payment_method` : `online | cash | terminal | free`.
- Stock d'une catégorie = `quota − (quantités des commandes payées + des commandes en attente non expirées)`.

## Flux d'achat
```
POST /e/:slug/checkout
  valide (nom, email, CGV, quantités) → limiteur + Turnstile
  createOrder : INSERT orders(pending, expire +32 min) ; pour chaque ligne un INSERT…SELECT conditionnel (stock)
                └ échec d'une ligne ⇒ tout est annulé, message « plus assez de places »
  startCheckout : total = 0 ⇒ fulfillOrder direct ; sinon Stripe Checkout (session 31 min) → 303 vers Stripe
Stripe ──webhook checkout.session.completed──▶ /webhooks/stripe ─▶ fulfillOrder ┐
Retour acheteur GET /o/:token (pending) ──interroge Stripe──▶ fulfillOrder     ├─ idempotent
                                                                                ┘
fulfillOrder : (re-réserve si expiré, sinon remboursement auto) → UPDATE orders SET paid, n° facture
               + INSERT tickets (codes 80 bits) dans UN batch ; puis email (file) billets + facture
```
Caisse/invités : même chemin (`createOrder` → `fulfillOrder`) sans paiement externe, redirection vers la page d'impression.

## Billet et contrôle
Le QR contient `PNK:` + 16 caractères Crockford. Pas de signature : le code (80 bits aléatoires) est vérifié en base.
`POST /api/scan` : `UPDATE tickets SET checked_in_at … WHERE code=? AND event_id=? AND status='valid' AND checked_in_at IS NULL RETURNING …`
— une seule instruction, donc deux scans simultanés ne passent jamais tous les deux. Sinon on explique pourquoi (déjà entré, autre concert, annulé, inconnu).

## Sécurité en couches
1. Cloudflare Access devant `/admin*`, `/scan*`, `/api/*` (le Worker revérifie le JWT).
2. `requireRole` : `scanner` < `manager` < `owner`, rôles en base, journal d'audit des actions sensibles.
3. CSP/CSRF/en-têtes (`src/lib/security.ts`), `no-store` sur le dynamique.
4. Échec fermé pour toute configuration manquante.
Détails : `SECURITY.md`.

## Choix et alternatives
- **Stripe REST sans SDK** : bundle minuscule, comportement explicite ; interface `PaymentProvider` pour changer de fournisseur.
- **D1** plutôt que KV/DO : transactions (`batch`) et SQL pour les rapports. Le stock repose sur la sérialisation des écritures SQLite.
- **Pas de PDF** : l'impression passe par le CSS `@media print` (A4, 2 billets/page au maximum) — zéro dépendance, rendu fidèle. PDF joint = amélioration possible.
- **Quotas, pas de plan de salle** : suffisant pour une salle de concerts debout.
