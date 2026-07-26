import { Hono } from 'hono';
import { responseError, responseSuccess } from '../utility/helper';
import { adminAuth } from '../middleware/middleware.adminAuth';
import { registerAgent, listAgents, agentExists, issueToken, revokeTokens, clearSuspendedUntil } from '../models/model.registry';
import { listAllConversations, getRecentMessages, getMessagesSince, getParticipants } from '../models/model.conversations';
import type { Env, Vars } from '../types';

// Admin plane — gated by ADMIN_API_KEY. Identity + capability registry + token lifecycle.
export const serviceAdmin = new Hono<{ Bindings: Env; Variables: Vars }>();

serviceAdmin.use('*', adminAuth);

// Register (or update) an agent identity + baseline capabilities (Model C admin-owned fields).
// Register one agent (JSON object) OR many (JSON array of objects). Idempotent per handle.
serviceAdmin.post('/agents', async (c) => {
  const body = await c.req.json().catch(() => null);
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > 500) return responseError(c, 'provide 1–500 agents', 400);

  const registered: string[] = [];
  const errors: { handle: string | null; error: string }[] = [];
  for (const item of items) {
    if (!item || typeof item.handle !== 'string' || !item.handle) {
      errors.push({ handle: (item && item.handle) ?? null, error: 'handle required' });
      continue;
    }
    await registerAgent(
      c.env, item.handle, item.description ?? null,
      item.capabilities ?? [],
      item.metadata && typeof item.metadata === 'object' ? item.metadata : null
    );
    registered.push(item.handle);
  }
  if (registered.length === 0) return responseError(c, 'no agents registered — each needs a handle', 400);
  return responseSuccess(c, `registered ${registered.length} agent(s)`, { registered, errors });
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

// ── Oversight (read-only): full message history across every agent. Powers the admin portal. ──

// Every conversation in the system, newest activity first (participants, counts, last-message preview).
serviceAdmin.get('/conversations', async (c) => {
  const conversations = await listAllConversations(c.env, Number(c.req.query('limit')) || 200);
  return responseSuccess(c, 'ok', { conversations });
});

// All messages in any conversation (admin can read any thread, regardless of participation).
serviceAdmin.get('/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id');
  const since = Number(c.req.query('since')) || 0;
  const messages = await getMessagesSince(c.env, conversationId, since, Number(c.req.query('limit')) || 200);
  const participants = await getParticipants(c.env, conversationId);
  return responseSuccess(c, 'ok', {
    conversationId, participants, messages,
    cursor: messages.length ? messages[messages.length - 1].seq : since,
  });
});

// Global firehose of recent messages across ALL conversations.
serviceAdmin.get('/messages', async (c) => {
  const since = Number(c.req.query('since')) || 0;
  const messages = await getRecentMessages(c.env, since, Number(c.req.query('limit')) || 200);
  return responseSuccess(c, 'ok', {
    messages, cursor: messages.length ? messages[messages.length - 1].seq : since,
  });
});
