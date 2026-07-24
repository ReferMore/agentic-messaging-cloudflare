import { Context, Next } from 'hono';
import { responseError } from '../utility/helper';
import { hashToken } from '../lib/lib.token';
import type { Env, Vars } from '../types';

// Validates an agent bearer token: hash matches a stored token, not revoked, not expired.
// Sets c.var.handle for downstream handlers.
export async function agentAuth(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) {
  // Prefer the Authorization header; fall back to ?token= for WebSocket upgrades, where
  // browser/Node WebSocket clients cannot set headers. (Internal bus, always over TLS.)
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : c.req.query('token');
  if (!token) {
    return responseError(c, 'Unauthorized', 401);
  }
  const tokenHash = await hashToken(token, c.env.TOKEN_PEPPER);

  const row = await c.env.DB.prepare(
    'SELECT handle, expires_at, revoked FROM tokens WHERE token_hash = ?;'
  ).bind(tokenHash).first<{ handle: string; expires_at: number; revoked: number }>();

  if (!row || row.revoked === 1) {
    return responseError(c, 'Unauthorized', 401);
  }
  if (Number(row.expires_at) < Date.now()) {
    return responseError(c, 'Token expired — reissue required', 401);
  }

  c.set('handle', row.handle);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?;')
      .bind(Date.now(), tokenHash).run()
  );

  await next();
}
