// SPDX-License-Identifier: AGPL-3.0-or-later
// Copie les polices (OFL) et jsQR (Apache-2.0) depuis node_modules vers public/assets.
// Les fichiers copiés sont commités : le déploiement ne dépend pas de ce script.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'assets');
mkdirSync(join(out, 'fonts'), { recursive: true });

const fonts = [
  ['@fontsource/anton', 'anton-latin-400-normal.woff2'],
  ['@fontsource/courier-prime', 'courier-prime-latin-400-normal.woff2'],
  ['@fontsource/courier-prime', 'courier-prime-latin-700-normal.woff2'],
  ['@fontsource/permanent-marker', 'permanent-marker-latin-400-normal.woff2'],
];
for (const [pkg, file] of fonts) {
  copyFileSync(join(root, 'node_modules', pkg, 'files', file), join(out, 'fonts', file));
}
copyFileSync(join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), join(out, 'jsQR.js'));
console.log('assets copiés dans public/assets');
