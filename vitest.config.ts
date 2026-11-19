// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Les tests tournent comme un développement local : faux paiement, emails journalisés, auth locale.
            ENVIRONMENT: 'development',
            PAYMENT_PROVIDER: 'mock',
            MAIL_DRIVER: 'log',
            MAIL_FROM: 'PNK <billets@pnk.test>',
            BASE_URL: 'http://localhost',
            DEV_USER_EMAIL: 'owner@pnk.test',
            BOOTSTRAP_OWNERS: 'owner@pnk.test',
            HASH_SECRET: 'test-secret-test-secret-test-secret',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
    },
  };
});
