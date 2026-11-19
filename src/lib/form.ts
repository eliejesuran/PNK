// SPDX-License-Identifier: AGPL-3.0-or-later
// Lecture des formulaires (parseBody de Hono) : un champ texte, ou '' s'il est absent ou s'il s'agit d'un fichier.

export type Body = Record<string, string | File | (string | File)[]>;

export const str = (b: Body, k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');
