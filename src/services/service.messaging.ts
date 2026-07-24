import { Hono } from 'hono';
import { responseError, responseSuccess } from '../utility/helper';
import { agentAuth } from '../middleware/middleware.agentAuth';
import { listAgents } from '../models/model.registry';
import {
  ensureDirectConversation, createRoom, addParticipant, isParticipant, getParticipants,
  writeMessage, getMessagesSince, advanceCursor, listConversations,
} from '../models/model.conversations';
import type { Env, Vars, Notification } from '../types';

// Agent plane — gated by per-agent bearer token.
export const serviceMessaging = new Hono<{ Bindings: Env; Variables: Vars }>();

serviceMessaging.use('*', agentAuth);

// Fire a { conversationId, seq } nudge to each participant's AgentSession DO (best-effort).
async function notifyParticipants(env: Env, participants: string[], conversationId: string, seq: number) {
  const note: Notification = { type: 'notify', conversationId, seq };
  const body = JSON.stringify(note);
  await Promise.all(participants.map((handle) => {
    const stub = env.AGENT.get(env.AGENT.idFromName(handle));
    return stub.fetch('https://do/notify', { method: 'POST', body }).catch(() => {});
  }));
}

// Send a message. Target a `to` handle (1:1) OR an existing `conversationId` (room/1:1).
serviceMessaging.post('/send', async (c) => {
  const from = c.get('handle');

  // Per-sender rate limit, enforced in the sender's own DO (fail-open on any error).
  const senderStub = c.env.AGENT.get(c.env.AGENT.idFromName(from));
  const rl = await senderStub
    .fetch(`https://do/allow?handle=${encodeURIComponent(from)}`)
    .then((r) => r.json() as Promise<{ allowed: boolean; suspended: boolean; retryAfterSecs: number }>)
    .catch(() => ({ allowed: true, suspended: false, retryAfterSecs: 0 }));
  if (!rl.allowed) {
    c.header('Retry-After', String(rl.retryAfterSecs || 1));
    return responseError(c, rl.suspended ? 'temporarily suspended for excessive sending' : 'rate limited — slow down', 429);
  }

  const { to, conversationId: convIdIn, type, body, correlationId } = await c.req.json().catch(() => ({}));

  let conversationId: string;
  if (convIdIn) {
    if (!(await isParticipant(c.env, convIdIn, from))) return responseError(c, 'not a participant', 403);
    conversationId = convIdIn;
  } else if (to && typeof to === 'string') {
    conversationId = await ensureDirectConversation(c.env, from, to);
  } else {
    return responseError(c, 'provide `to` (handle) or `conversationId`', 400);
  }

  const { seq, messageId } = await writeMessage(
    c.env, conversationId, from, typeof type === 'string' ? type : 'text', body ?? null, correlationId ?? null
  );

  // Notify all participants (including sender's other sessions) off the hot path.
  const participants = await getParticipants(c.env, conversationId);
  c.executionCtx.waitUntil(notifyParticipants(c.env, participants, conversationId, seq));

  return responseSuccess(c, 'sent', { messageId, seq, conversationId });
});

// Notify channel: WebSocket upgrade → the agent's own AgentSession DO.
serviceMessaging.get('/listen', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return responseError(c, 'expected websocket upgrade', 426);
  const handle = c.get('handle');
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(handle));
  const url = new URL(c.req.url);
  url.pathname = '/connect';
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// List my conversations (with unread counts).
serviceMessaging.get('/conversations', async (c) => {
  const conversations = await listConversations(c.env, c.get('handle'));
  return responseSuccess(c, 'ok', { conversations });
});

// Pull messages in a conversation after a cursor. ?since=<seq>&limit=<n>
serviceMessaging.get('/conversations/:id/messages', async (c) => {
  const handle = c.get('handle');
  const conversationId = c.req.param('id');
  if (!(await isParticipant(c.env, conversationId, handle))) return responseError(c, 'not a participant', 403);
  const since = Number(c.req.query('since') ?? '0') || 0;
  const limit = Number(c.req.query('limit') ?? '100') || 100;
  const messages = await getMessagesSince(c.env, conversationId, since, limit);
  return responseSuccess(c, 'ok', { conversationId, messages, cursor: messages.length ? messages[messages.length - 1].seq : since });
});

// Advance my read cursor for a conversation.
serviceMessaging.post('/conversations/:id/read', async (c) => {
  const handle = c.get('handle');
  const conversationId = c.req.param('id');
  const { seq } = await c.req.json().catch(() => ({}));
  if (typeof seq !== 'number') return responseError(c, 'seq (number) required', 400);
  await advanceCursor(c.env, conversationId, handle, seq);
  return responseSuccess(c, 'cursor advanced', { conversationId, seq });
});

// Create a room (multi-participant conversation).
serviceMessaging.post('/rooms', async (c) => {
  const from = c.get('handle');
  const { conversationId, name, participants } = await c.req.json().catch(() => ({}));
  const id = conversationId || `room:${crypto.randomUUID()}`;
  await createRoom(c.env, id, name ?? null, from, Array.isArray(participants) ? participants : []);
  return responseSuccess(c, 'room created', { conversationId: id });
});

// Join a room.
serviceMessaging.post('/rooms/:id/join', async (c) => {
  await addParticipant(c.env, c.req.param('id'), c.get('handle'));
  return responseSuccess(c, 'joined', { conversationId: c.req.param('id') });
});

// Is a given agent currently online?
serviceMessaging.get('/presence/:handle', async (c) => {
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(c.req.param('handle')));
  const res = await stub.fetch('https://do/presence');
  const { online } = await res.json() as { online: boolean };
  return responseSuccess(c, 'ok', { handle: c.req.param('handle'), online });
});

// Contact list / capability discovery. ?capability=<tag> filters the roster.
serviceMessaging.get('/agents', async (c) => {
  const agents = await listAgents(c.env, c.req.query('capability') || undefined);
  return responseSuccess(c, 'ok', { agents });
});
