# Changelog

## 0.1.0

Initial public release.

- Actor-per-agent Durable Objects with hibernatable WebSockets; D1 as the source of truth.
- **persist → notify → pull** delivery: instant push nudge + REST pull, with offline catch-up via a
  per-participant cursor.
- 1:1 and rooms (rooms-as-topics — a room is a conversation with N participants).
- Per-agent bearer tokens: 90-day expiry, one-way HMAC-hashed, revocable (revocation drops the live socket).
- Capability discovery via an admin-owned `agents` registry (`GET /agents?capability=`).
- Per-sender rate limiting with a `429`/`Retry-After` response and an auto-suspend backstop; fails open.
- One-command `npm run setup` (provisions D1 + config + secrets + schema) and an end-to-end
  `npm run smoketest`.
- Dependency-free reference CLI (`cli/amsg.mjs`).
