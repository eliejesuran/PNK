# Questions ouvertes — ce qu'il faut décider pour terminer PNK

Chaque question indique **ce que j'ai supposé en attendant** (le comportement actuel), pour que tu puisses juste dire « OK » quand
c'est bon. Les 🔴 bloquent la mise en vente réelle, les 🟠 changent le résultat, les 🟢 sont du confort.

## 🔴 Bloquantes avant de vendre pour de vrai

1. ✅ **« NIP » = « Not Very Important Person »** (répondu : clin d'œil punk au VIP). Implémenté : chaque catégorie de places peut avoir un
   *petit texte* facultatif sous son nom (affiché sur la page d'achat et sur le billet, même texte dans toutes les langues). Il est
   **pré‑rempli « Not Very Important Person »** pour NIP à la création d'un concert, modifiable ou effaçable. **Reste à confirmer :**
   NIP est‑il **moins cher ou plus cher** que Standard (ou même prix) ? Les prix proposés par défaut (Standard 15 €, NIP 30 €) ne sont que
   des exemples à saisir de toute façon. Et NIP se vend‑il en ligne (supposé) ou seulement à la caisse ?
2. **Qui est l'organisateur légal ?** Raison sociale, forme (ASBL, SRL, asso 1901…), adresse, n° de TVA / d'entreprise, et est-il
   assujetti à la TVA ? Ces infos s'impriment sur les factures (page *Réglages*).
   → *Supposé :* champs vides ; le tableau de bord affiche un bandeau jaune « il reste… » tant que ce n'est pas rempli.
3. **Quel taux de TVA sur les billets ?** Les prix sont saisis **TTC**, la TVA est extraite. → *Supposé :* **6 %** (taux réduit
   spectacles en Belgique) — **à valider avec ton comptable**, ce n'est qu'un défaut. Modifiable globalement (*Réglages*) ou par concert.
4. **Pays / juridiction ?** (Belgique, France, Suisse… — je vois du Infomaniak dans tes autres projets.) Impacte la TVA, les mentions
   obligatoires de facture, les moyens de paiement utiles (Bancontact/Payconiq en BE, iDEAL en NL, TWINT en CH…) et la monnaie.
   → *Supposé :* Belgique, EUR, fuseau Europe/Brussels.
5. **Paiement : Stripe, ça te va ?** C'est ce que j'ai branché (Stripe Checkout : cartes, **Apple Pay, Google Pay** automatiques,
   plus Bancontact/iDEAL/etc. activables dans le tableau de bord Stripe, sans code). Les « appli bancaires » = Bancontact/Payconiq/iDEAL
   selon le pays. Alternatives si tu préfères (Mollie, très répandu BE/NL, sans abonnement) : le code est prévu pour changer de
   fournisseur (`src/services/payments/`), ça se fait en une demi-journée.
   → *Il me faut :* le compte Stripe (au nom de l'organisateur légal) et la liste des moyens de paiement à activer.
6. **Domaine et intégration au site** : sous quelle adresse la billetterie ? (ex. `billets.tonsite.be`). Le domaine est-il déjà dans
   Cloudflare (DNS) ? Le site de la salle va-t-il **faire un lien** vers la billetterie (cas le plus simple, supposé) ou veut-il
   **l'intégrer dans la page** (iframe) ? L'iframe est volontairement bloquée par sécurité ; si tu la veux, je l'autorise pour ton seul domaine.
7. **Accès à ton compte Cloudflare pour déployer.** Je ne peux pas déployer sans connexion. Il faut : (a) `npx wrangler login`
   depuis ton ordinateur, ou me donner un jeton d'API limité ; (b) créer l'application **Cloudflare Access** (voir `docs/DEPLOY.md`)
   car c'est elle qui protège le back-office. Veux-tu que je te guide pas à pas, ou que je déploie quand tu m'as connecté ?
8. **Qui entre dans le back-office, et avec quel rôle ?** Emails des personnes : *propriétaire* (tout), *gestionnaire* (concerts, ventes,
   rapports), *contrôle* (scanner à l'entrée uniquement). Comment se connectent-elles : code reçu par email (supposé), compte Google ?
9. **Textes légaux** : conditions générales de vente (annulation / remboursement / report d'un concert), politique de confidentialité
   (RGPD : on stocke nom, email, IP hachée), mentions légales. Le site affiche un lien « Conditions de vente » (réglage), mais **le texte doit venir de toi/de la salle**.
   Je peux te préparer un brouillon à faire valider.
10. **Email d'expédition** : adresse `billets@ton-domaine` ? Le plus simple est **Cloudflare Email Service** (sans clé API, il faut que le
    domaine soit sur Cloudflare — la disponibilité/tarif de cette offre est à vérifier dans ton compte). Sinon Resend (gratuit jusqu'à un quota).

## 🟠 Importantes (le comportement actuel est un choix par défaut)

11. **Forfait Cloudflare** : le plan Workers gratuit limite le temps de calcul par requête (10 ms) — la page « billets » génère des QR et
    pourrait être limite ; le plan **Workers Payant (≈ 5 $/mois)** est recommandé pour la fiabilité. D1 (base) : le gratuit suffit largement.
12. **Remboursements et factures** : aujourd'hui le remboursement est **total** (le billet est annulé, la facture est tamponnée « REMBOURSÉE »).
    Faut-il une **note de crédit numérotée** (souvent obligatoire légalement) et/ou des **remboursements partiels** ? Question à poser au comptable.
13. **Frais de service** : aucun (prix affiché = prix payé). Veux-tu en ajouter (fixe/%), pour couvrir les frais Stripe ?
14. **Billets nominatifs et revente** : aujourd'hui le nom du billet = nom de l'acheteur, le QR est transmissible (le premier qui passe, passe).
    Veux-tu un nom par billet, une interdiction de transfert, une limite par personne ?
15. **Contrôle à l'entrée** : le réseau (wifi/4G) est-il fiable dans la salle ? Sinon je développe un **mode hors-ligne** (liste des codes
    pré-chargée). Combien de portes/scanners ? Avec quels téléphones (iPhone = lecture par jsQR, Android Chrome = lecture native, tous deux prévus) ?
16. **Impression** : le billet s'imprime en A4 (jusqu'à 3 par page, noir et blanc OK). Besoin d'un format **ticket thermique 80 mm** (imprimante de
    caisse) ou d'un **PDF** joint à l'email ?
17. **Jauge et placement** : seulement des quotas par catégorie (debout / général), pas de plan de salle numéroté. C'est bon ?
18. **Affiche des concerts** : actuellement on colle l'URL d'une image hébergée ailleurs. Veux-tu pouvoir **envoyer l'image** directement (stockage R2) ?
19. **Ton et langues** : le public est **tutoyé** (« Tes billets pour… ») — ça colle au punk mais est-ce voulu pour tout le monde ? Le back-office
    est en français seulement : à traduire en EN/NL ?

## 🟢 Confort / plus tard

20. **Titulaire du copyright** dans `LICENSE`/en-têtes : j'ai mis « PNK contributors » (neutre). Un nom (toi ? l'asso ?) à y mettre ?
21. **Dépôt GitHub** : créé en **public** sous ton compte (AGPL-3.0). Le nom `PNK` te convient ? Souhaites-tu l'héberger plutôt dans une organisation ?
22. **Apple Wallet / Google Wallet** (billet dans le portefeuille du téléphone), **codes promo**, **pré-ventes**, **abonnements/pass**, **liste d'attente** : hors périmètre actuel.
23. **Alertes** : être prévenu (email) si un envoi échoue ou si un webhook de paiement ne passe pas ? Aujourd'hui tout est visible dans la table `email_outbox`/journal mais pas notifié.
24. **Données personnelles** : durée de conservation (ex. 3 ans), procédure d'effacement sur demande ; inscription newsletter (opt-in) ?
25. **Données de démonstration** : `seed/dev.sql` sert au développement local uniquement. À supprimer du déploiement (déjà non utilisé en prod).

## Ce que je ne peux pas vérifier seul (recette à faire avec toi au déploiement)
Voir `docs/DEPLOY.md`, section *Recette* : vrai paiement Stripe (mode test), vraie connexion Cloudflare Access, vrai email reçu,
scan avec un vrai téléphone, impression papier réelle.
