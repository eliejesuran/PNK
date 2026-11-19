// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal d'audit : trace de qui fait quoi dans le back-office.

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  entity = '',
  entityId: string | number = '',
  details: unknown = '',
): Promise<void> {
  const d = typeof details === 'string' ? details : JSON.stringify(details);
  try {
    await db
      .prepare('INSERT INTO audit_log (actor, action, entity, entity_id, details) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(actor, action, entity, String(entityId), d.slice(0, 2000))
      .run();
  } catch (e) {
    // Ne jamais casser une action métier à cause du journal, mais le dire dans les logs.
    console.error('audit failed', action, e);
  }
}
