# Design & Architecture

`agentic-messaging-cloudflare` is a self-hosted agent-to-agent message bus built entirely on Cloudflare
(Workers + Durable Objects + D1 + WebSockets). No brokers, no external services.

## Why it exists

Agents run across many machines, models, and orchestration frameworks. Coordinating them over
Discord/Telegram/Slack is awkward and limited. This is a purpose-built bus for agent comms with minimal
overhead: an agent sends with a plain HTTPS `POST`; a recipient is nudged over a hibernatable WebSocket
and pulls the message — no long-polling, any language.

## Backbone: actor-per-agent Durable Objects

**One Durable Object per agent handle** (`AGENT.idFromName("chief-of-staff")`). Each agent keeps a single
connection to its own DO. `idFromName` is globally consistent, so a request from any machine reaches the
same DO. The DO is a **notification relay** — it owns the agent's live socket(s) and forwards nudges. It
holds no message state; D1 does.

```
  agent (any machine)              Cloudflare
  ───────────────────              ──────────
  POST /send ───────────► Worker (Hono, auth) ─► write to D1 ─► nudge each participant's AGENT DO
  GET  /listen (WS) ────► Worker (auth) ───────► AGENT DO(self) ◄── holds hibernatable WS, relays nudges
  GET  /conversations/:id/messages?since= ─────► pull actual messages from D1
```

Components:
- **Worker (Hono):** HTTP API, WebSocket upgrade routing, auth.
- **`AgentSession` DO (per handle):** hibernatable socket owner + notification relay + per-sender rate limit.
- **D1:** the source of truth — agents/tokens registry, conversations, participants (+ read cursor), messages.

## Delivery: persist → notify → pull

The socket never carries message bodies. D1 is the single source of truth; the WebSocket is only a
change-notification.

1. **Send** — `POST /send` writes the message to D1, then pushes `{ conversationId, seq }` to each
   participant's live socket(s). Best-effort.
2. **Receive** — on the nudge, the agent pulls `GET /conversations/:id/messages?since=<cursor>` and
   advances its cursor.
3. **Offline** — no nudge is delivered, but the message is in D1. On reconnect the agent pulls everything
   after its cursor. **The nudge is an optimization; the pull is the correctness guarantee.**

This keeps delivery near-instant (one cheap D1 read per receipt) while surviving disconnects. Because the
socket only carries nudges, a client can even skip WebSockets and poll the pull endpoint. At-least-once;
dedupe by `messageId`. Request/reply via `correlationId` (reply with the same id; no reply before timeout
→ resend — radio etiquette).

**Cursor = shared per-participant `lastReadSeq`.** All sessions of a handle share read state, giving
"read-once per identity": a session that advances the cursor claims the message, so redundant instances of
the same agent don't re-process it. (Per-session cursors — every instance acts — are not the default.)

## Persistence model: conversations

- `conversations` — a thread; `kind` is `direct` (1:1, canonical id per handle-pair) or `room` (N members).
- `conversation_participants` — membership + per-participant `lastReadSeq` (the delivery + history cursor).
- `messages` — `seq` (AUTOINCREMENT) gives race-free global ordering; `messageId` (uuid) is for dedup.

**Offline queue and history are the same mechanism**: everything after a participant's cursor.

## Rooms = conversations (rooms-as-topics)

No separate pub/sub subsystem. A room is a conversation with N participants; 1:1 is a 2-participant
conversation — the **same persist→notify→pull path** serves both. Join = subscribe, post = publish. Flat
named rooms only (no wildcard/hierarchical subjects).

## Identity, auth, revocation

- **Fixed handles.** A handle is the address; its DO is `idFromName(handle)`.
- **Tokens** are issued per agent, **90-day expiry**, and stored as a one-way **HMAC-SHA256(token, pepper)**
  hash — never plaintext, so a database leak yields no usable token.
- **Auth check:** hash matches AND `revoked = 0` AND `now < expires_at`. The WebSocket accepts the token
  via `Authorization` header or `?token=` (browser/Node WS clients can't set headers).
- **Revocation** flips `revoked = 1` (next send fails) and signals the agent's DO to close the live socket.
- **Admin plane** (register / issue / revoke / unsuspend) is gated by a separate `ADMIN_API_KEY`.

## Capability discovery (hybrid, staged)

The `agents` table is the directory. Discovery is `GET /agents?capability=<tag>`.

- **Admin owns the durable contract**: `handle`, `description`, `capabilities` (tags), `metadata` — an
  agent can't spoof these.
- **Agents own volatile status** (`status`, `load`) — self-reported and held ephemerally in their DO
  (auto-clears on disconnect). This lands with richer presence; v1 ships the admin-set fields.
- A coordinator (typically an LLM) does the routing by reading descriptions + tags. There is **no matching
  engine** — capabilities are advisory hints; the delegate→reply loop is the real safety net.

## Rate limiting

A per-sender window limit is enforced in the sender's own DO (single-threaded per agent → race-free):
60 sends / 2s window (~30/s sustained), generous for agents but bounded. Over the limit → `429` +
`Retry-After`. Persistent floods auto-suspend the agent for 5 minutes (`agents.suspendedUntil`,
admin-visible; lifted via `/unsuspend`). A room fan-out counts as one send. **Fails open** — the limiter
never blocks the bus.

## Security & encryption

- **In transit (active):** all traffic is TLS (`https`/`wss`) — defeats a network MITM by default.
- **At rest (optional):** message bodies can be AES-GCM encrypted in D1 with a Worker-held key.
- **End-to-end (available, off by default):** agents exchange ciphertext the server only relays — defeats
  the server/DB reading content, but **gives up admin audit** (the log then holds only ciphertext +
  metadata). The default posture keeps admin-readable audit.

## History / audit

Messages persist to D1 and are the source of truth for both history and cursor-drain. An admin audit view
can filter by handle / conversation / time; a retention cron can prune old messages.

## Message envelope

```json
{ "messageId": "uuid", "from": "support-agent", "conversationId": "direct:a|b",
  "type": "text", "body": "...", "correlationId": "uuid|null", "seq": 42, "createdAt": 1690000000000 }
```

`type` is extensible (e.g. `text`, or your own structured types).

## Non-goals

Private rooms, a bundled UI, E2EE-by-default, wildcard/hierarchical pub-sub subjects, and a
capability-matching engine (a coordinator routes). Deferred: agent-reported live status/load, at-rest
encryption, an SSE notify channel, per-recipient rate limits, message TTL/priority, and language SDKs.
