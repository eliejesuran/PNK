// SPDX-License-Identifier: AGPL-3.0-or-later
// Garde d'accès du back-office : identité (Cloudflare Access) + rôle minimum requis.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Role } from './env';
import { hasRole, identify, resolveStaff } from './lib/auth';
import { AdminDenied } from './views/errors';

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const wantsJson = c.req.path.startsWith('/api/');
    const deny = (status: 401 | 403 | 503, message: string) =>
      wantsJson ? c.json({ error: message }, status) : c.html(<AdminDenied code={status} message={message} />, status);

    const id = await identify(c.env, c.req.raw);
    if (!id.ok) return deny(id.status, id.message);
    const staff = await resolveStaff(c.env, id.email, new Date().toISOString());
    if (!staff) return deny(403, `${id.email} ne fait pas partie de l’équipe. Demande à un propriétaire de t’ajouter.`);
    if (!hasRole(staff, min)) return deny(403, `Ton rôle (${staff.role}) ne permet pas d’accéder à cette page.`);
    c.set('staff', staff);
    return next();
  };
}
