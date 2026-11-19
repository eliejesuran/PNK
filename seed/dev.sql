-- PNK — données de démonstration pour le développement LOCAL uniquement (npm run db:seed:local).
-- Ne jamais exécuter sur la base de production.
-- SPDX-License-Identifier: AGPL-3.0-or-later

INSERT INTO venues (id, name, address, city, capacity) VALUES (1, 'La Cave (démo)', '12 rue du Vacarme', 'Bruxelles', 180);

INSERT INTO events (id, slug, title, subtitle, description_fr, description_en, description_nl, venue_id, starts_at, doors_at, status, max_per_order) VALUES
  (1, 'les-sales-gosses', 'Les Sales Gosses', '+ Bruit Blanc + DJ Pogo',
   'Trois groupes, zéro prétention.' || char(10) || 'Bières pas chères, son trop fort, bouchons d’oreille au bar.',
   'Three bands, zero pretension.' || char(10) || 'Cheap beer, loud sound, earplugs at the bar.',
   'Drie bands, nul pretentie.' || char(10) || 'Goedkoop bier, te luid geluid, oordoppen aan de bar.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days', 'start of day', '+19 hours'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days', 'start of day', '+17 hours', '+30 minutes'), 'published', 6),
  (2, 'cafards-et-fils', 'Les Cafards', '+ Fils de Pute Sauvage',
   'Soirée presque complète. Dépêche-toi.', 'Almost sold out. Hurry up.', 'Bijna uitverkocht. Schiet op.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 days', 'start of day', '+20 hours'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 days', 'start of day', '+19 hours'), 'published', 4),
  (3, 'soiree-secrete', 'Soirée secrète', 'line-up à annoncer',
   'Brouillon : pas encore visible du public.', '', '',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+40 days', 'start of day', '+20 hours'), NULL, 'draft', 6);

INSERT INTO ticket_types (id, event_id, name_fr, name_en, name_nl, price_cents, quota, sort, online) VALUES
  (1, 1, 'Standard', 'Standard', 'Standard', 1500, 140, 0, 1),
  (2, 1, 'NIP', 'NIP', 'NIP', 3000, 20, 1, 1),
  (3, 2, 'Standard', 'Standard', 'Standard', 1200, 6, 0, 1),
  (4, 2, 'NIP', 'NIP', 'NIP', 2500, 4, 1, 1),
  (5, 3, 'Standard', 'Standard', 'Standard', 1000, 80, 0, 1);

-- Commandes payées de démonstration (jours variés pour que le graphique ait du relief)
INSERT INTO orders (id, token, event_id, status, channel, payment_method, provider, email, name, lang, total_cents, vat_rate_bp, invoice_year, invoice_seq, created_at, paid_at) VALUES
  (1, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'camille@example.com',  'Camille Dupont',  'fr', 3000, 600, CAST(strftime('%Y','now') AS INTEGER), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days')),
  (2, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'jan@example.com',     'Jan Peeters',     'nl', 1500, 600, CAST(strftime('%Y','now') AS INTEGER), 2, strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 days')),
  (3, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'sam@example.com',     'Sam Taylor',      'en', 4500, 600, CAST(strftime('%Y','now') AS INTEGER), 3, strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days')),
  (4, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'lou@example.com',     'Lou Martin',      'fr', 3000, 600, CAST(strftime('%Y','now') AS INTEGER), 4, strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days')),
  (5, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'ines@example.com',    'Inès Lambert',    'fr', 6000, 600, CAST(strftime('%Y','now') AS INTEGER), 5, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days')),
  (6, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'noa@example.com',     'Noa Vermeulen',   'nl', 3000, 600, CAST(strftime('%Y','now') AS INTEGER), 6, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days')),
  (7, substr(hex(randomblob(16)), 1, 32), 1, 'paid', 'online', 'online', 'mock', 'vip@example.com',     'Alex Vandenberghe','fr', 3000, 600, CAST(strftime('%Y','now') AS INTEGER), 7, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')),
  (8, substr(hex(randomblob(16)), 1, 32), 2, 'paid', 'online', 'online', 'mock', 'bande@example.com',   'Marie Leroy',     'fr', 4800, 600, CAST(strftime('%Y','now') AS INTEGER), 8, strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'),  strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'));

INSERT INTO order_items (order_id, ticket_type_id, qty, unit_price_cents) VALUES
  (1, 1, 2, 1500), (2, 1, 1, 1500), (3, 1, 3, 1500), (4, 1, 2, 1500), (5, 1, 4, 1500), (6, 1, 2, 1500), (7, 2, 1, 3000), (8, 3, 4, 1200);

-- Un billet par place, avec des codes aléatoires
INSERT INTO tickets (code, order_id, event_id, ticket_type_id)
SELECT upper(hex(randomblob(8))), oi.order_id, o.event_id, oi.ticket_type_id
FROM order_items oi JOIN orders o ON o.id = oi.order_id
JOIN (SELECT 1 AS n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) k ON k.n <= oi.qty;
