// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
