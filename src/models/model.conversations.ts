// Conversations + messages + read cursor. D1 is the source of truth.
// Rooms-as-topics: a 'direct' conversation has a canonical id per handle-pair; a 'room' has N members.
import type { Env, Message } from '../types';

/** Deterministic id for a 1:1 conversation so repeated sends reuse the same thread. */
export function directConversationId(a: string, b: string): string {
  return 'direct:' + [a, b].sort().join('|');
}

/** Ensure a 1:1 conversation exists between two handles (idempotent), returns its id. */
export async function ensureDirectConversation(env: Env, a: string, b: string): Promise<string> {
  const id = directConversationId(a, b);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversations (conversationId, kind, createdBy, createdAt, updatedAt)
         VALUES (?, 'direct', ?, ?, ?) ON CONFLICT(conversationId) DO NOTHING;`
    ).bind(id, a, now, now),
    env.DB.prepare(
      `INSERT INTO conversation_participants (conversationId, handle, joinedAt)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING;`
    ).bind(id, a, now),
    env.DB.prepare(
      `INSERT INTO conversation_participants (conversationId, handle, joinedAt)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING;`
    ).bind(id, b, now),
  ]);
  return id;
}

/** Create a room (multi-participant conversation) and add participants. */
export async function createRoom(
  env: Env,
  conversationId: string,
  name: string | null,
  createdBy: string,
  participants: string[]
): Promise<void> {
  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO conversations (conversationId, kind, name, createdBy, createdAt, updatedAt)
         VALUES (?, 'room', ?, ?, ?, ?) ON CONFLICT(conversationId) DO UPDATE SET name = excluded.name;`
    ).bind(conversationId, name, createdBy, now, now),
    ...Array.from(new Set([createdBy, ...participants])).map((h) =>
      env.DB.prepare(
        `INSERT INTO conversation_participants (conversationId, handle, joinedAt)
           VALUES (?, ?, ?) ON CONFLICT DO NOTHING;`
      ).bind(conversationId, h, now)
    ),
  ];
  await env.DB.batch(stmts);
}

export async function addParticipant(env: Env, conversationId: string, handle: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO conversation_participants (conversationId, handle, joinedAt)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING;`
  ).bind(conversationId, handle, Date.now()).run();
}

export async function isParticipant(env: Env, conversationId: string, handle: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM conversation_participants WHERE conversationId = ? AND handle = ?;'
  ).bind(conversationId, handle).first();
  return !!row;
}

export async function getParticipants(env: Env, conversationId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT handle FROM conversation_participants WHERE conversationId = ?;'
  ).bind(conversationId).all();
  return (results as { handle: string }[]).map((r) => r.handle);
}

/** Persist a message. Returns its global seq + public id. */
export async function writeMessage(
  env: Env,
  conversationId: string,
  senderHandle: string,
  type: string,
  body: unknown,
  correlationId: string | null
): Promise<{ seq: number; messageId: string }> {
  const messageId = crypto.randomUUID();
  const now = Date.now();
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const res = await env.DB.prepare(
    `INSERT INTO messages (messageId, conversationId, senderHandle, type, body, correlationId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq;`
  ).bind(messageId, conversationId, senderHandle, type, bodyStr, correlationId, now).first<{ seq: number }>();
  await env.DB.prepare('UPDATE conversations SET updatedAt = ? WHERE conversationId = ?;')
    .bind(now, conversationId).run();
  return { seq: res!.seq, messageId };
}

/** Pull messages in a conversation after a cursor (exclusive), ordered, capped. */
export async function getMessagesSince(
  env: Env,
  conversationId: string,
  since = 0,
  limit = 100
): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    `SELECT seq, messageId, conversationId, senderHandle, type, body, correlationId, createdAt
       FROM messages WHERE conversationId = ? AND seq > ? ORDER BY seq ASC LIMIT ?;`
  ).bind(conversationId, since, Math.min(limit, 500)).all();
  return (results as Record<string, unknown>[]).map((r) => ({
    seq: r.seq as number,
    messageId: r.messageId as string,
    conversationId: r.conversationId as string,
    senderHandle: r.senderHandle as string,
    type: r.type as string,
    body: tryParse(r.body as string | null),
    correlationId: (r.correlationId as string) ?? null,
    createdAt: r.createdAt as number,
  }));
}

/** Advance a participant's read cursor (monotonic — never moves backward). */
export async function advanceCursor(env: Env, conversationId: string, handle: string, seq: number) {
  await env.DB.prepare(
    `UPDATE conversation_participants SET lastReadSeq = ?
       WHERE conversationId = ? AND handle = ? AND lastReadSeq < ?;`
  ).bind(seq, conversationId, handle, seq).run();
}

/** List a handle's conversations with unread counts. */
export async function listConversations(env: Env, handle: string) {
  const { results } = await env.DB.prepare(
    `SELECT c.conversationId, c.kind, c.name, c.updatedAt, p.lastReadSeq,
            (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.conversationId AND m.seq > p.lastReadSeq) AS unread
       FROM conversation_participants p
       JOIN conversations c ON c.conversationId = p.conversationId
      WHERE p.handle = ?
      ORDER BY c.updatedAt DESC;`
  ).bind(handle).all();
  return results;
}

function tryParse(s: string | null): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}
