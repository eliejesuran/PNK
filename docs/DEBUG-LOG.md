# Journal de debug

Résultat actuel : `npm run check` → typecheck strict propre, **123 tests** verts (runtime Workers réel + base D1 locale).
`npm audit --omit=dev` : 0 vulnérabilité (les alertes restantes sont dans l'outillage de dev).

## Passe 1 — tests d'intégration au premier lancement
| Bug trouvé | Cause | Correction |
|---|---|---|
| **Pages sans `<!DOCTYPE html>`** (navigateur en mode quirks) | Hono `c.html(<JSX/>)` ne l'ajoute pas | doctype injecté dans les 3 gabarits de page |
| Taux de TVA `"21 %"` refusé | `trim()` avant retrait du `%` | ordre corrigé + test |
| Nettoyage du limiteur de débit sans effet | purge basée sur un numéro de fenêtre mélangeant des durées différentes | colonne `at` + purge par date |
| Un caractère BOM littéral dans `text.ts` | l'outil d'écriture avait décodé `﻿` | remplacé par l'échappement, vérifié |
| Attributs `style=""` en vues (bloqués par la CSP) | oubli | classes CSS ; test « aucun style inline » |
| Attributs JSX `maxlength`/`colspan` en chaînes | typage Hono | nombres |

## Passe 2 — revue et robustesse
| Constat | Correction |
|---|---|
| Un JWT d'algorithme `none` déclenchait une récupération de clés réseau avant d'être rejeté | `algorithms: ['RS256']` imposé (rejet avant tout appel réseau) |
| 20 achats simultanés / 5 places : le limiteur de débit masquait l'issue | test réécrit avec IP distinctes ; **exactement 5 passent**, 0 survente |
| `Response.text()` retire le BOM des CSV | test sur les octets bruts (le BOM est bien envoyé pour Excel) |
| `/o/../admin` normalisé en `/admin` par `URL` | cas de test remplacé (`..%2f`), comportement correct |

## Passe 3 — navigateur réel (wrangler dev + navigateur intégré, desktop + mobile 375 px)
Parcours complet joué à la main : achat 2 Standard + 1 NIP → faux paiement → billets QR → facture → dashboard → scanner.
| Constat | Correction |
|---|---|
| Code du billet coupé sur 2 lignes sous le QR | `white-space: nowrap` + taille |
| Scanner : compteur « — / — » jusqu'au 1er scan | endpoint `GET /api/scan/stats`, chargé à l'ouverture + rafraîchi toutes les 15 s |
| Scanner mobile : liste des concerts tronquée | mise en page en colonne |
| CSS mis en cache 1 h (invisible après modification) | cache assets 5 min (`public/_headers`) |
| Bouton « Payer » resté grisé au retour arrière depuis Stripe (bfcache) | réactivé sur `pageshow` |
| Champ slug refusé par le navigateur avant normalisation serveur | `pattern` retiré |
| Facture caisse sans nom d'acheteur | repli « — » |
Vérifié : aucune erreur ni violation CSP dans la console ; aucune page testée ne déborde horizontalement en mobile ; QR décodés par
jsQR (SVG et PNG) et PNG validé par `file`/`sips`/CRC/zlib.

## Passe 4 — chaos
`test/invariants.test.ts` : 4 graines × 50 tours de jusqu'à 5 opérations **simultanées** (achat, paiement, annulation, expiration, paiement
tardif, remboursement, caisse, invitation, scan) sur des quotas minuscules. Invariants vérifiés à chaque tour : jamais plus de places prises
que le quota ; billets cohérents avec le statut de chaque commande ; factures uniques et sans trou ; pas de facture pour du gratuit ;
codes uniques. Scénarios réellement atteints : commandes payées/remboursées/expirées, **remboursement automatique pour survente**,
3 canaux, scans. Aucune violation.

## Non vérifié en réel (aucun accès aux comptes — à faire à la recette)
- Vrai Stripe (paiement, webhook, remboursement, Apple/Google Pay, Bancontact) : testé contre une **API simulée** qui vérifie le contenu exact des requêtes.
- Vrai JWT Cloudflare Access : seuls les rejets (en-têtes forgés, `alg:none`, JWT invalide, config absente) sont testés.
- Vrai envoi d'email (Cloudflare Email Service / Resend) et rendu dans les clients mail.
- Caméra sur vrai téléphone ; impression papier ; performance CPU sur le plan Workers gratuit.
