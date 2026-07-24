import { Context, Next } from 'hono';
import { responseError } from '../utility/helper';
import type { Env } from '../types';

// Gates the admin plane (issue/revoke/register) with a shared admin key.
// Matches the platform's admin-key middleware pattern.
export async function adminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return responseError(c, 'Unauthorized', 401);
  }
  const key = authHeader.slice(7);
  if (!c.env.ADMIN_API_KEY || key !== c.env.ADMIN_API_KEY) {
    return responseError(c, 'Unauthorized', 401);
  }
  await next();
}
