# PNK — billetterie punk, in-house

Une billetterie pour salle de concert : **robuste, dématérialisée, imprimable, pas chère**, sans commission de plateforme.
Tourne sur Cloudflare (Workers + D1), logiciel libre sous **GNU AGPL-3.0**.

*Du bruit. Des gens. Des places.*

## Ce que ça fait

**Public (FR / EN / NL)**
- Page par concert : infos, prix, places restantes, achat en 2 clics ; liste des prochains concerts.
- Paiement par **Stripe Checkout** : cartes, **Apple Pay**, **Google Pay**, et selon ta config Bancontact / iDEAL / etc. (appli bancaire).
- Billet avec **QR code** (page web + email), **imprimable** (A4, 3 billets par page) ; **facture** (HT/TVA/TTC) imprimable.
- Facture au nom d'une société sur demande (n° TVA, adresse).

**Back-office** (protégé par Cloudflare Access + rôles)
- Concerts, **salles** (ajout libre), catégories de places (au départ *Standard* et *NIP*, extensibles), prix, quotas, ouverture/fermeture des ventes.
- **Tableau de bord** : recettes, billets vendus, panier moyen, courbe par jour, canaux, remplissage par concert, liste de tâches de mise en route.
- **Caisse / invités** : vente à l'entrée (espèces, terminal) et listes d'invités → billets générés et imprimés tout de suite.
- **Commandes** : recherche, remboursement, renvoi d'email. **Rapports** + exports CSV (Excel). **Journal d'audit**.
- **Scanner d'entrée** (téléphone) : caméra ou saisie du code, anti double passage, compteur d'entrées.
- **Équipe** : propriétaire / gestionnaire / contrôle (scanner seul).

**Fiabilité** : jamais de survente (même avec des centaines d'achats simultanés), paiement idempotent (webhook + page de retour),
numérotation des factures sans trou, remboursement automatique si un paiement arrive trop tard, emails mis en file et réessayés.

## Démarrer en local

Prérequis : Node ≥ 20.

```bash
npm install
cp .dev.vars.example .dev.vars     # réglages de développement (faux paiement, emails journalisés)
npm run db:reset:local             # crée la base locale + 3 concerts de démo
npm run dev                        # http://localhost:8787  (back-office : /admin)
```

En local, `/admin` s'ouvre directement (identité `dev@pnk.local`, propriétaire) et le paiement est un **faux écran** « Payer / Échouer ».
Ces deux facilités sont **désactivées automatiquement** hors `ENVIRONMENT=development` et hors `localhost`.

```bash
npm run check    # typecheck + 122 tests (vrai runtime Workers, vraie base D1 locale)
```

## Déployer

Voir **[docs/DEPLOY.md](docs/DEPLOY.md)** : base D1, secrets, Stripe (webhook), Cloudflare Access, emails, domaine, recette.
Les questions encore ouvertes pour finir (TVA, identité légale, sens de « NIP », domaine…) : **[docs/QUESTIONS.md](docs/QUESTIONS.md)**.

## Documentation

| | |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Mise en production pas à pas + recette |
| [docs/QUESTIONS.md](docs/QUESTIONS.md) | Décisions à prendre / infos manquantes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modèle de données, flux d'achat, sécurité |
| [docs/DEBUG-LOG.md](docs/DEBUG-LOG.md) | Passes de debug : bugs trouvés, ce qui reste non vérifié |
| [SECURITY.md](SECURITY.md) | Modèle de sécurité, signalement de failles |
| [CLAUDE.md](CLAUDE.md) | Suivi technique pour Claude Code (état, règles, pièges) |
| [THIRD_PARTY.md](THIRD_PARTY.md) | Licences des composants tiers |

## Licence

**GNU Affero General Public License v3.0 ou ultérieure** (`AGPL-3.0-or-later`) — voir [LICENSE](LICENSE).
Tu peux utiliser, étudier, modifier et redistribuer PNK. Si tu en fournis une version modifiée à des utilisateurs via un réseau
(c'est un site web), tu dois leur en proposer le code source sous la même licence. Chaque fichier source porte son en-tête SPDX.

Les contributions sont bienvenues : voir [CONTRIBUTING.md](CONTRIBUTING.md).
