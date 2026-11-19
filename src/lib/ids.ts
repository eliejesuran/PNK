// SPDX-License-Identifier: AGPL-3.0-or-later
// Génération d'identifiants aléatoires : codes de billets, jetons de commande.

/** Alphabet Crockford base32 : pas de I, L, O, U (évite les confusions à la saisie manuelle). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TICKET_CODE_LENGTH = 16; // 16 x 5 bits = 80 bits d'entropie
const QR_PREFIX = 'PNK:';

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Code de billet : 16 caractères Crockford base32 (80 bits), ex. "7K3M9QX2VD4TH8NB". */
export function newTicketCode(): string {
  const bytes = randomBytes(10); // 80 bits exactement
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // ne garde que les bits non consommés
  }
  return out;
}

/** "7K3M9QX2VD4TH8NB" -> "7K3M-9QX2-VD4T-H8NB" pour l'affichage. */
export function formatTicketCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/** Contenu encodé dans le QR code d'un billet. */
export function qrPayload(code: string): string {
  return QR_PREFIX + code;
}

/**
 * Accepte ce que le scanner ou le clavier renvoie ("PNK:7K3M-9QX2-VD4T-H8NB", espaces, minuscules,
 * O/I/L confondus) et renvoie le code canonique, ou null si ce n'est pas un code PNK valide.
 */
export function normalizeTicketCode(input: string): string | null {
  let s = String(input ?? '').trim().toUpperCase();
  if (s.startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  s = s.replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== TICKET_CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** Jeton public de commande : 192 bits en base64url (URL /o/:token). */
export function newOrderToken(): string {
  return base64url(randomBytes(24));
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isOrderToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(s);
}

/** Comparaison en temps constant de deux chaînes (signatures, secrets). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
