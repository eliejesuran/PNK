# Contribuer à PNK

Bienvenue. PNK est un logiciel libre (AGPL-3.0-or-later) : en contribuant, tu acceptes que ta contribution soit publiée sous cette licence.

1. `npm install`, `cp .dev.vars.example .dev.vars`, `npm run db:reset:local`, `npm run dev`.
2. Crée une branche, fais ton changement **avec des tests** (`test/`), puis `npm run check` (typecheck + tests) doit être vert.
3. Règles du projet (détail dans `CLAUDE.md`) :
   - montants en centimes, dates en UTC ;
   - **pas de `style=""` ni de script inline** (CSP) ;
   - toute chaîne publique dans `src/i18n/{fr,en,nl}.ts` (3 langues) ;
   - en-tête `SPDX-License-Identifier: AGPL-3.0-or-later` sur chaque fichier source ;
   - jamais de secret dans le dépôt ; ne modifie pas une migration déjà publiée (ajoute-en une).
4. Vérifie visuellement toute modification d'interface (desktop + mobile) et la console du navigateur.
5. Ouvre une Pull Request en expliquant le *pourquoi*.

Failles de sécurité : voir `SECURITY.md` (pas d'issue publique).
