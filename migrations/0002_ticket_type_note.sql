-- PNK — petit texte facultatif sous le nom d'une catégorie de places
-- (ex. « Not Very Important Person » pour NIP). Identique dans toutes les langues.
-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE ticket_types ADD COLUMN note TEXT NOT NULL DEFAULT '';
