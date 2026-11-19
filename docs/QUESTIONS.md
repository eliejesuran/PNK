# Questions ouvertes — ce qu'il faut décider pour terminer PNK

Chaque question indique **ce que j'ai supposé en attendant** (le comportement actuel), pour que tu puisses juste dire « OK » quand
c'est bon. Les 🔴 bloquent la mise en vente réelle, les 🟠 changent le résultat, les 🟢 sont du confort.

## ✅ Déjà répondu

- **NIP = « Not Very Important Person »**, uniquement dans le back-office pour **générer des places gratuites** (invitations). Fait : NIP n'est
  jamais en vente en ligne (même en forçant le formulaire, testé), gratuit, avec un petit texte imprimé sur le billet ; on le génère depuis
  *Caisse / invités → Invitation gratuite*.
- **Organisateur** : raison sociale, siège, n° d'entreprise et email de contact — configurés dans cette installation, **hors du code du dépôt** (fichier local ignoré par git). Le site de démo en ligne les affiche volontairement (choix du propriétaire).
- **TVA : 0 % pour commencer**, modifiable à tout moment (*Réglages*, pour tout le site ; ou concert par concert).
- **Pays : Belgique** (EUR, fuseau Europe/Brussels).
- **Premier propriétaire** du back-office : renseigné (secret Cloudflare, pas dans le dépôt). Les autres personnes s'ajoutent dans *Équipe*.

## 🔴 Encore bloquantes avant de vendre pour de vrai

1. ✅ **Numéro d'entreprise, email de contact, siège et code postal** : renseignés. Reste à confirmer la dénomination exacte sur les factures
   (j'ai ajouté « ASBL » à la fin du nom). Un champ « n° d'entreprise (BCE) » distinct du n° de TVA existe : une organisation non assujettie n'a pas de n° de TVA.
2. **TVA à 0 % : quelle mention sur la facture ?** Si l'ASBL n'est pas assujettie, une mention du type « TVA non applicable » est en général
   requise — **à faire valider par le comptable** ; il y a un champ « mentions de pied de facture » dans *Réglages* pour l'écrire.
3. **Compte Stripe** (le prestataire qui encaisse les paiements) : à créer par un représentant de l'ASBL — voir « Qu'est-ce que Stripe ? » plus bas.
4. **Nom de domaine** : pas urgent pour continuer à construire/tester, **indispensable avant d'ouvrir la vente** (voir plus bas).
5. **Accès à Cloudflare pour déployer** : voir plus bas (sans donner ton mot de passe).
6. **Textes légaux** : conditions générales de vente (annulation / remboursement / report), politique de confidentialité (RGPD : on stocke nom, email,
   IP hachée), mentions légales. Le site affiche un lien « Conditions de vente » (réglage), **le texte doit venir de l'ASBL**. Je peux préparer un brouillon à faire valider.
7. **Email d'expédition** (`billets@ton-domaine`) : dépend du domaine (Cloudflare Email Service ou Resend).

### Qu'est-ce que Stripe ?
Stripe est l'entreprise qui **encaisse les paiements en ligne** à la place de l'ASBL : carte bancaire, Apple Pay, Google Pay, Bancontact… Le
client paie sur une page Stripe sécurisée (PNK ne voit jamais de numéro de carte) et Stripe verse l'argent sur le compte bancaire de l'ASBL.
- **Coût** (barème Belgique consulté le 2026-11-19, à revérifier sur stripe.com/be/pricing) : aucun abonnement ni frais d'ouverture ; environ
  **1,5 % + 0,25 €** par carte européenne standard et **0,35 €** par paiement Bancontact. Exemple : un billet à 15 € payé par carte ≈ 0,48 € de frais.
- **À créer** : un compte sur stripe.com **au nom de l'ASBL** (nom légal, n° BCE, IBAN de l'ASBL, pièce d'identité d'un administrateur). C'est une
  démarche en ligne d'environ 15 minutes, à faire par la personne qui représente légalement l'ASBL.
- **On commence en mode test** (gratuit, sans argent réel, sans vérification d'identité) : on peut tout essayer avant de passer en réel.
- Alternative : Mollie (très répandu en Belgique, pas d'abonnement non plus). Le code permet d'en changer, mais Stripe est branché et testé.

### Le nom de domaine, est-ce urgent ?
**Non pour avancer, oui avant de vendre.** Sans domaine, la billetterie fonctionne sur une adresse Cloudflare du type `pnk.xxx.workers.dev` : c'est
suffisant pour tester. Mais avant l'ouverture il faut un vrai domaine (≈ 10–15 €/an, un `.be` par exemple) parce que :
- les **emails** (billets, factures) doivent partir d'une adresse à toi (`billets@…`) — sans domaine, pas d'envoi fiable ;
- le **back‑office doit être protégé uniquement sur `/admin`** pendant que le site reste public : Cloudflare ne sait le faire que sur un domaine à toi ;
- les acheteurs font plus confiance à `billets.tonsite.be` qu'à une adresse technique. Le site de l'ASBL peut simplement faire un lien dessus.
Le plus simple : acheter le domaine (ex. via DNS Belgium / un bureau d'enregistrement), l'ajouter à Cloudflare (gratuit), et je configure le reste.

### Comment me donner accès à Cloudflare (sans mot de passe)
**Ne me donne jamais ton mot de passe, et ne colle pas de clé dans la conversation.** Deux façons sûres :
- **(recommandé)** Ouvre le Terminal de cet ordinateur et lance `cd ~/Documents/CODE/PNK && npx wrangler login` : une page Cloudflare s'ouvre, tu cliques
   *Autoriser*. L'outil est alors connecté sur ton Mac ; je ne vois pas ton mot de passe. Pour couper l'accès : `npx wrangler logout`.
- **Jeton d'API limité** : dans Cloudflare → Mon profil → Jetons d'API, créer un jeton avec seulement les droits Workers, D1, Zero Trust (Access) ; tu le mets
   toi‑même dans le Terminal (`export CLOUDFLARE_API_TOKEN=…`), jamais dans le chat.
Dans les deux cas, **je ne déploie rien sans que tu me le demandes explicitement**. Les étapes qui se font dans le tableau de bord Cloudflare
(application Access, Turnstile, domaine) : je te guide pas à pas ou tu les fais toi‑même (voir `docs/DEPLOY.md`).

## 🟠 Importantes (le comportement actuel est un choix par défaut)

8. **Forfait Cloudflare** : le plan Workers gratuit limite le temps de calcul par requête (10 ms) — la page « billets » génère des QR et
    pourrait être limite ; le plan **Workers Payant (≈ 5 $/mois)** est recommandé pour la fiabilité. D1 (base) : le gratuit suffit largement.
9. **Remboursements et factures** : aujourd'hui le remboursement est **total** (le billet est annulé, la facture est tamponnée « REMBOURSÉE »).
    Faut-il une **note de crédit numérotée** (souvent obligatoire légalement) et/ou des **remboursements partiels** ? Question à poser au comptable.
10. **Frais de service** : aucun (prix affiché = prix payé). Veux-tu en ajouter (fixe/%), pour couvrir les frais Stripe ?
11. **Billets nominatifs et revente** : aujourd'hui le nom du billet = nom de l'acheteur, le QR est transmissible (le premier qui passe, passe).
    Veux-tu un nom par billet, une interdiction de transfert, une limite par personne ?
12. **Contrôle à l'entrée** : le réseau (wifi/4G) est-il fiable dans la salle ? Sinon je développe un **mode hors-ligne** (liste des codes
    pré-chargée). Combien de portes/scanners ? Avec quels téléphones (iPhone = lecture par jsQR, Android Chrome = lecture native, tous deux prévus) ?
13. **Impression** : le billet s'imprime en A4 (2 par page au maximum, noir et blanc OK). Besoin d'un format **ticket thermique 80 mm** (imprimante de
    caisse) ou d'un **PDF** joint à l'email ?
14. **Jauge et placement** : seulement des quotas par catégorie (debout / général), pas de plan de salle numéroté. C'est bon ?
15. **Affiche des concerts** : actuellement on colle l'URL d'une image hébergée ailleurs. Veux-tu pouvoir **envoyer l'image** directement (stockage R2) ?
16. **Ton et langues** : le public est **tutoyé** (« Tes billets pour… ») — ça colle au punk mais est-ce voulu pour tout le monde ? Le back-office
    est en français seulement : à traduire en EN/NL ?

## 🟢 Confort / plus tard

17. **Titulaire du copyright** dans `LICENSE`/en-têtes : j'ai mis « PNK contributors » (neutre). Un nom (toi ? l'asso ?) à y mettre ?
18. **Dépôt GitHub** : créé en **public** sous ton compte (AGPL-3.0). Le nom `PNK` te convient ? Souhaites-tu l'héberger plutôt dans une organisation ?
19. **Apple Wallet / Google Wallet** (billet dans le portefeuille du téléphone), **codes promo**, **pré-ventes**, **abonnements/pass**, **liste d'attente** : hors périmètre actuel.
20. **Alertes** : être prévenu (email) si un envoi échoue ou si un webhook de paiement ne passe pas ? Aujourd'hui tout est visible dans la table `email_outbox`/journal mais pas notifié.
21. **Données personnelles** : durée de conservation (ex. 3 ans), procédure d'effacement sur demande ; inscription newsletter (opt-in) ?
22. **Données de démonstration** : `seed/dev.sql` sert au développement local uniquement. À supprimer du déploiement (déjà non utilisé en prod).

## Ce que je ne peux pas vérifier seul (recette à faire avec toi au déploiement)
Voir `docs/DEPLOY.md`, section *Recette* : vrai paiement Stripe (mode test), vraie connexion Cloudflare Access, vrai email reçu,
scan avec un vrai téléphone, impression papier réelle.
