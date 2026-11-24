-- PNK — suivi de la fermeture côté prestataire de paiement des réservations expirées
-- (Mollie ne permet pas de fixer l'expiration d'un paiement : on le ferme nous-mêmes).
-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE orders ADD COLUMN provider_closed INTEGER NOT NULL DEFAULT 0 CHECK (provider_closed IN (0, 1));
