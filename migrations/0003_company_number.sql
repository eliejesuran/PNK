-- PNK — numéro d'entreprise (BCE) distinct du numéro de TVA : une ASBL non assujettie n'a pas de n° de TVA,
-- mais son n° d'entreprise doit figurer sur les factures.
-- SPDX-License-Identifier: AGPL-3.0-or-later

INSERT OR IGNORE INTO settings (key, value) VALUES ('org_company_number', '');
