// Token lifecycle: high-entropy random token, one-way HMAC hash at rest, 90-day expiry.
// We NEVER store the token itself — only HMAC-SHA256(token, pepper). On auth we hash the
// presented token and compare. A D1 leak yields no usable token.

export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const TOKEN_PREFIX = 'amsg_';

/** Generate a new opaque bearer token (shown to the admin once, at issuance). */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64url = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${b64url}`;
}

/** One-way hash of a token, keyed by a server-side pepper (Worker secret). */
export async function hashToken(token: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
