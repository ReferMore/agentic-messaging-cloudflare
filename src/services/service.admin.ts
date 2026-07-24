import { Hono } from 'hono';
import { responseError, responseSuccess } from '../utility/helper';
import { adminAuth } from '../middleware/middleware.adminAuth';
import { registerAgent, listAgents, agentExists, issueToken, revokeTokens, clearSuspendedUntil } from '../models/model.registry';
import type { Env, Vars } from '../types';

// Admin plane — gated by ADMIN_API_KEY. Identity + capability registry + token lifecycle.
export const serviceAdmin = new Hono<{ Bindings: Env; Variables: Vars }>();

serviceAdmin.use('*', adminAuth);

// Register (or update) an agent identity + baseline capabilities (Model C admin-owned fields).
serviceAdmin.post('/agents', async (c) => {
  const { handle, description, capabilities, metadata } = await c.req.json().catch(() => ({}));
  if (!handle || typeof handle !== 'string') return responseError(c, 'handle required', 400);
  await registerAgent(
    c.env, handle, description ?? null,
    Array.isArray(capabilities) ? capabilities : [],
    metadata && typeof metadata === 'object' ? metadata : null
  );
  return responseSuccess(c, 'agent registered', { handle });
});

// List agents (+ capabilities). ?capability=<tag> filters.
serviceAdmin.get('/agents', async (c) => {
  const agents = await listAgents(c.env, c.req.query('capability') || undefined);
  return responseSuccess(c, 'ok', { agents });
});

// Issue a token (revokes any existing). Returns the plaintext token ONCE.
serviceAdmin.post('/agents/:handle/token', async (c) => {
  const handle = c.req.param('handle');
  if (!(await agentExists(c.env, handle))) return responseError(c, 'unknown agent — register first', 404);
  const { token, expiresAt } = await issueToken(c.env, handle);
  return responseSuccess(c, 'token issued (store it now — not retrievable again)', { handle, token, expiresAt });
});

// Lift a rate-limit auto-suspension.
serviceAdmin.post('/agents/:handle/unsuspend', async (c) => {
  const handle = c.req.param('handle');
  await clearSuspendedUntil(c.env, handle);
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(handle));
  c.executionCtx.waitUntil(stub.fetch('https://do/refresh', { method: 'POST' }).then(() => {}));
  return responseSuccess(c, 'unsuspended', { handle });
});

// Revoke all tokens for an agent + close any live socket.
serviceAdmin.post('/agents/:handle/revoke', async (c) => {
  const handle = c.req.param('handle');
  await revokeTokens(c.env, handle);
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(handle));
  c.executionCtx.waitUntil(stub.fetch('https://do/close', { method: 'POST' }).then(() => {}));
  return responseSuccess(c, 'tokens revoked', { handle });
});
