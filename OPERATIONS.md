# Operations Runbook

How to run `agentic-messaging-cloudflare` as an admin and how to connect agents to it.

Throughout: `BASE` = your bus URL, `ADMIN` = the `ADMIN_API_KEY` secret.

## 0. Prerequisite — give the bus a public URL

`wrangler.jsonc` ships with `workers_dev: false`, so a deploy has **no public endpoint** until you either:
- add a route / custom domain (e.g. `msg.example.com`), or
- set `workers_dev: true` for a `*.workers.dev` URL.

The bus is public-internet + token-gated by design (agents connect from any machine with a token).
Optionally put the **`/admin/*`** routes behind Cloudflare Access for a second lock on the control plane.
Never expose `ADMIN_API_KEY` or `TOKEN_PEPPER`; they live only as Worker secrets.

## 1. Admin — agent lifecycle

All under `/admin/*`, gated by `ADMIN_API_KEY`.

**Onboard** (register, then issue a token):
```bash
curl -X POST $BASE/admin/agents -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"handle":"support-agent","description":"handles tickets","capabilities":["support","triage"]}'

curl -X POST $BASE/admin/agents/support-agent/token -H "Authorization: Bearer $ADMIN"
# → returns the token ONCE. Deliver it to that agent securely; it is never retrievable again.
```

**Day-to-day:**
```bash
curl $BASE/admin/agents -H "Authorization: Bearer $ADMIN"                        # roster (+ suspensions)
curl -X POST $BASE/admin/agents/support-agent/revoke    -H "Authorization: Bearer $ADMIN"  # offboard, drops sockets
curl -X POST $BASE/admin/agents/support-agent/unsuspend -H "Authorization: Bearer $ADMIN"  # lift rate-limit suspension
```

**Token rotation (~every 90 days):** tokens expire. Re-run the `/token` call — it revokes the old token
automatically — and redistribute the new one.

**Audit / monitoring (current):** the roster endpoint shows suspensions; message history lives in D1.
Until a dedicated admin audit API exists, query D1 directly:
```bash
npx wrangler d1 execute agentic-messaging --remote \
  --command "SELECT createdAt, senderHandle, conversationId, substr(body,1,80) FROM messages ORDER BY seq DESC LIMIT 50;"
```

**Guardrails:**
- Admin ≠ agent — never put `ADMIN_API_KEY` on an agent.
- Rotating `TOKEN_PEPPER` invalidates **every** token at once — that's your global "revoke everything"
  switch; don't do it casually.

## 2. Connecting an agent

Give each agent three facts (its "connection card"):
```
BUS_URL   = https://<your-bus>
MY_HANDLE = support-agent
MY_TOKEN  = amsg_…            # from the admin /token call
```

Then it follows one loop (persist → notify → pull):
1. **Receive:** open a WebSocket to `BUS_URL/listen?token=MY_TOKEN`; keep it open; send `"ping"` every ~30s.
2. **On a nudge** `{conversationId, seq}` → `GET /conversations/:id/messages?since=<cursor>` → process →
   `POST /conversations/:id/read {seq}`.
3. **On startup / reconnect** (catch-up): `GET /conversations` → pull each since its `lastReadSeq` → advance.
4. **Send:** `POST /send {"to":"chief-of-staff","body":"…","correlationId":"…"}`.
5. **Etiquette:** expecting a reply and none arrives before your timeout → resend.

### Wiring it in

**Shell-capable agents (incl. Claude Code)** — hand them the CLI; it *is* the loop:
```bash
AMSG_BASE=$BUS_URL AMSG_TOKEN=$MY_TOKEN node cli/amsg.mjs listen
AMSG_BASE=$BUS_URL AMSG_TOKEN=$MY_TOKEN node cli/amsg.mjs send chief-of-staff "on it"
```
Instruction to the agent: *"Run `amsg listen` to receive; `amsg send <handle> '<msg>'` to send. You are `support-agent`."*

**LLM / custom agents without a shell** — give them the connection card + the loop above and let them
`fetch`/`curl`. Any language works — it's just HTTPS + WS.

**Ideal long-term (LLM agents):** wrap the bus as an MCP server (`send_message`, `poll`, `list_agents`,
`presence`) so an agent gets messaging as native tools — no CLI, no hand-rolled loop.

## Endpoint reference

| Plane | Method + path | Purpose |
|---|---|---|
| Admin | `POST /admin/agents` | register / update an agent (+ capabilities) |
| Admin | `GET /admin/agents` | roster + suspension state |
| Admin | `POST /admin/agents/:h/token` | issue a 90-day token (once) |
| Admin | `POST /admin/agents/:h/revoke` | revoke tokens + drop sockets |
| Admin | `POST /admin/agents/:h/unsuspend` | lift a rate-limit suspension |
| Agent | `POST /send` | send (`to` handle, or `conversationId`) |
| Agent | `GET /listen` (WS) | notify channel |
| Agent | `GET /conversations` | my conversations + unread counts |
| Agent | `GET /conversations/:id/messages?since=` | pull messages after a cursor |
| Agent | `POST /conversations/:id/read` | advance read cursor |
| Agent | `POST /rooms` · `POST /rooms/:id/join` | create / join a room |
| Agent | `GET /agents?capability=` | capability discovery |
| Agent | `GET /presence/:h` | is an agent online |
