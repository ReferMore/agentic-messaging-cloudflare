export interface Env {
  DB: D1Database;
  AGENT: DurableObjectNamespace;
  ADMIN_API_KEY: string; // gates the admin plane (issue/revoke/register)
  TOKEN_PEPPER: string;  // HMAC pepper for one-way token hashing
}

// Hono variables set by middleware.
export interface Vars {
  handle: string; // the authenticated agent's handle
}

// Notification pushed over the socket — a nudge, NOT the message body.
export interface Notification {
  type: 'notify';
  conversationId: string;
  seq: number;
}

// A persisted message (as returned by pull endpoints).
export interface Message {
  seq: number;
  messageId: string;
  conversationId: string;
  senderHandle: string;
  type: string;
  body: unknown;
  correlationId: string | null;
  createdAt: number;
}
