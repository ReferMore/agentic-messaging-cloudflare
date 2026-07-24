-- agentic-messaging D1 schema (self-contained).
-- Model: persist -> notify -> pull. D1 is the source of truth; the socket only carries nudges.
-- Rooms = conversations (rooms-as-topics): 1:1 is a 2-participant conversation, a room has N.

-- Agent identity + capability registry (Model C: admin owns these durable fields).
CREATE TABLE IF NOT EXISTS agents (
  handle         TEXT PRIMARY KEY,
  description    TEXT,
  capabilities   TEXT,               -- JSON array of tags, e.g. ["fraud-analysis"]
  metadata       TEXT,               -- JSON object (model, version, ...)
  active         INTEGER NOT NULL DEFAULT 1,
  suspendedUntil INTEGER,            -- rate-limit auto-suspend backstop (epoch ms), NULL = not suspended
  created_at     INTEGER NOT NULL
);
-- Existing dev DBs: `ALTER TABLE agents ADD COLUMN suspendedUntil INTEGER;` (rate limiting fails open
-- without it, so this is non-blocking).

-- Tokens: one active per agent, 90-day expiry, stored as a one-way HMAC hash.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash   TEXT PRIMARY KEY,     -- HMAC-SHA256(token, TOKEN_PEPPER), base64
  handle       TEXT NOT NULL,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  FOREIGN KEY (handle) REFERENCES agents(handle)
);
CREATE INDEX IF NOT EXISTS idx_tokens_handle ON tokens(handle);

-- Conversations. kind='direct' (1:1, canonical id per handle-pair) or 'room' (N participants).
CREATE TABLE IF NOT EXISTS conversations (
  conversationId TEXT PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT 'direct',
  name           TEXT,
  createdBy      TEXT,
  createdAt      INTEGER NOT NULL,
  updatedAt      INTEGER NOT NULL
);

-- Participants + per-participant read cursor (shared across an identity's sessions).
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversationId TEXT NOT NULL,
  handle         TEXT NOT NULL,
  joinedAt       INTEGER NOT NULL,
  lastReadSeq    INTEGER NOT NULL DEFAULT 0,   -- highest message seq this handle has read here
  PRIMARY KEY (conversationId, handle)
);
CREATE INDEX IF NOT EXISTS idx_participants_handle ON conversation_participants(handle);

-- Messages. `seq` (AUTOINCREMENT) = global monotonic order; ordering within a conversation
-- is seq ASC. `messageId` = public uuid for dedup/idempotency. This IS the audit log.
CREATE TABLE IF NOT EXISTS messages (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  messageId      TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL,
  senderHandle   TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'text',
  body           TEXT,
  correlationId  TEXT,
  createdAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId, seq);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(senderHandle, seq);
