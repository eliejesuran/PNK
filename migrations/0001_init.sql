-- PNK — schéma initial (Cloudflare D1 / SQLite)
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Conventions :
--  * dates en UTC, format ISO 8601 ("2026-11-19T20:30:00.000Z"), comparables comme du texte
--  * montants en centimes (INTEGER), jamais de flottants
--  * un billet = une ligne dans `tickets` avec un code aléatoire (80 bits) qui sert de contenu au QR

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('org_name', 'PNK'),
  ('org_legal_name', ''),
  ('org_address', ''),
  ('org_vat_number', ''),
  ('org_email', ''),
  ('org_phone', ''),
  ('org_website', ''),
  ('timezone', 'Europe/Brussels'),
  ('currency', 'EUR'),
  ('default_vat_bp', '600'),        -- 600 = 6 % (À CONFIRMER avec le comptable, voir docs/QUESTIONS.md)
  ('default_lang', 'fr'),
  ('invoice_prefix', 'PNK'),
  ('invoice_footer', ''),
  ('terms_url', '');

-- Équipe : qui peut entrer dans le back-office, avec quel rôle.
--   owner   = tout (réglages, équipe, journal)
--   manager = événements, salles, commandes, rapports, scanner
--   scanner = uniquement le scanner à l'entrée
CREATE TABLE staff (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'scanner')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);

CREATE TABLE venues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  subtitle       TEXT NOT NULL DEFAULT '',          -- ex. line-up : "GROUPE A + GROUPE B"
  description_fr TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  description_nl TEXT NOT NULL DEFAULT '',
  venue_id       INTEGER NOT NULL REFERENCES venues (id),
  starts_at      TEXT NOT NULL,
  doors_at       TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  sales_open_at  TEXT,                              -- NULL = ouvert dès la publication
  sales_close_at TEXT,                              -- NULL = ferme au début du concert
  max_per_order  INTEGER NOT NULL DEFAULT 6 CHECK (max_per_order BETWEEN 1 AND 50),
  image_url      TEXT NOT NULL DEFAULT '',
  vat_rate_bp    INTEGER CHECK (vat_rate_bp IS NULL OR vat_rate_bp BETWEEN 0 AND 3000),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_events_starts ON events (starts_at);
CREATE INDEX idx_events_status ON events (status, starts_at);

-- Catégories de places d'un événement (au début : Standard et NIP, mais on peut en ajouter).
CREATE TABLE ticket_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name_fr     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  name_nl     TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  quota       INTEGER NOT NULL CHECK (quota >= 0),
  sort        INTEGER NOT NULL DEFAULT 0,
  online      INTEGER NOT NULL DEFAULT 1 CHECK (online IN (0, 1)),  -- 0 = pas en vente en ligne (liste invités / caisse)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ticket_types_event ON ticket_types (event_id, sort);

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token               TEXT NOT NULL UNIQUE,         -- identifiant public impossible à deviner (/o/:token)
  event_id            INTEGER NOT NULL REFERENCES events (id),
  status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'expired', 'refunded')),
  channel             TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'door', 'guest')),
  payment_method      TEXT NOT NULL DEFAULT 'online' CHECK (payment_method IN ('online', 'cash', 'terminal', 'free')),
  provider            TEXT NOT NULL DEFAULT 'none',  -- stripe | mock | none
  provider_session_id TEXT,
  provider_payment_id TEXT,
  checkout_url        TEXT,
  email               TEXT NOT NULL DEFAULT '',
  name                TEXT NOT NULL DEFAULT '',
  lang                TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'en', 'nl')),
  billing_name        TEXT NOT NULL DEFAULT '',
  billing_vat         TEXT NOT NULL DEFAULT '',
  billing_address     TEXT NOT NULL DEFAULT '',
  total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),
  vat_rate_bp         INTEGER NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 3000),
  currency            TEXT NOT NULL DEFAULT 'EUR',
  invoice_year        INTEGER,
  invoice_seq         INTEGER,
  created_by          TEXT,                          -- email du staff pour les ventes caisse / invitations
  ip_hash             TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  paid_at             TEXT,
  refunded_at         TEXT,
  UNIQUE (invoice_year, invoice_seq)                 -- numérotation sans doublon (NULL autorisés plusieurs fois)
);
CREATE INDEX idx_orders_event ON orders (event_id, status);
CREATE INDEX idx_orders_status_exp ON orders (status, expires_at);
CREATE INDEX idx_orders_email ON orders (email);
CREATE INDEX idx_orders_paid_at ON orders (paid_at);
CREATE INDEX idx_orders_session ON orders (provider_session_id);

CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  ticket_type_id   INTEGER NOT NULL REFERENCES ticket_types (id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX idx_order_items_order ON order_items (order_id);
CREATE INDEX idx_order_items_type ON order_items (ticket_type_id);

CREATE TABLE tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,               -- 16 caractères Crockford base32 (80 bits), contenu du QR
  order_id       INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  event_id       INTEGER NOT NULL REFERENCES events (id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types (id),
  status         TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
  checked_in_at  TEXT,
  checked_in_by  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tickets_order ON tickets (order_id);
CREATE INDEX idx_tickets_event ON tickets (event_id, status);

-- File d'envoi des emails : on garde une trace et on réessaie en cas d'échec.
CREATE TABLE email_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at    TEXT
);
CREATE INDEX idx_outbox_status ON email_outbox (status, attempts);

-- Journal d'audit : qui a fait quoi dans le back-office.
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  details   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit_log (at);

-- Idempotence des webhooks de paiement (un évènement n'est traité qu'une fois).
CREATE TABLE webhook_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, event_id)
);

-- Limiteur de débit simple (par clé et fenêtre de temps).
CREATE TABLE rate_limits (
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (key, window)
);
