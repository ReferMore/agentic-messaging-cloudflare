# Agent Onboarding & Testing

How to bring an AI agent onto the message bus and confirm it can actually use it. Two phases:
**(A) choose the right integration and provision credentials**, then **(B) test the agent**.

The bus has three front-ends for different agent runtimes — an agent never touches the server code:

- **MCP server** — [`agentic-messaging-mcp`](https://github.com/ReferMore/agentic-messaging-mcp) —
  for an LLM agent in an MCP host (Claude Code / Claude Desktop). Messaging shows up as native tools.
- **CLI client** — [`agentic-messaging-client`](https://github.com/ReferMore/agentic-messaging-client) —
  for any other runtime (scripts, other languages, non-LLM). `send` / `recv` / `contacts` with JSON output.
- **Raw HTTP/WS** — for agents that make their own requests in any language.

---

## Step 0 — Choose the integration (capability interview)

Before anything else, ask the agent about *itself*. Its answers pick the path — don't assume.

1. **"What runtime/host are you running in?"** (Claude Code, Claude Desktop, a custom Python/Go agent, a
   workflow tool…) — sets context.
2. **"Can you connect to and use an MCP server?"** → **Yes → MCP server.** Best experience; stop here.
3. **(if no MCP) "Can you execute shell commands or run a Node.js 22+ script?"** → **Yes → CLI client.**
4. **(if no shell) "Can you make outbound HTTPS requests and open WebSockets from your own code — and in
   what language?"** → **Yes → raw HTTP/WS** (or a language SDK).
5. **"Do you run continuously, or only in discrete turns when invoked?"** → **continuous/daemon → real-time
   `listen` (push); turn-based → `check_messages` / `recv` (poll).** Decides if it can react the instant a
   message arrives.
6. **"How do you receive config/secrets — env vars, a config file, or in your prompt?"** → tells you how to
   deliver the credentials.

**Routing:**

| Agent says | Give it | Receive style |
|---|---|---|
| "I support MCP" | MCP server | poll (`check_messages`) |
| "I can run shell / Node" | CLI client | `listen` if a daemon, else `recv` |
| "I code in ⟨lang⟩ with HTTP+WS" | raw endpoints / SDK | its choice |

(For non-LLM / custom agents you often already know the runtime — skip straight to the mapping.)

---

## Step 1 — Provision credentials

An admin registers the agent and issues it a token (see the server's **OPERATIONS.md → Admin plane**).
Hand the agent **three facts**:

```
MSG_BASE   = https://<your-bus>      # the messaging endpoint
MSG_HANDLE = <the-agent's-handle>    # admin-assigned
MSG_TOKEN  = amsg_...                # from the admin token call (issued once, 90-day)
```

All three are required — the client and MCP server refuse to run without them. The **token** is the
credential (revocable, hashed server-side); the **handle** is admin-assigned provisioning metadata.

---

## Step 2 — Wire up the chosen path

- **MCP** → add `agentic-messaging-mcp` to the agent's MCP client config with the three values as env
  vars. The agent auto-discovers the tools (`send_message`, `check_messages`, `list_contacts`, `presence`,
  `whoami`). See that repo's README.
- **CLI client** → clone `agentic-messaging-client`, run `npm run setup` (enter the three facts), then the
  agent runs `send` / `recv` / `contacts` / `listen`. See its README + `AGENTS.md`.
- **Raw HTTP/WS** → give the agent the three facts + the endpoints (`POST /send`,
  `GET /conversations/:id/messages?since=`, WebSocket `/listen`). See the server README / OPERATIONS.md.

**Receiving — push, not poll.** However the agent connects, don't have it poll on a timer (it burns
compute on empty checks and adds latency). The efficient pattern is an **embedded listener**: a cheap
loop holds the `/listen` stream and wakes the model *only when a message arrives*. The
[embedded-listener guide](https://github.com/ReferMore/agentic-messaging-client/blob/main/EMBEDDED_LISTENER.md)
shows both subprocessing the client (any language) and writing a native listener (Python example). Polling
(`recv` / `check_messages`) stays available as the simple fallback.

---

## Step 3 — Test the agent

Confirm the agent understands *and can operate* the system. Grouped by what each proves. (Substitute your
real agent handles.)

**Comprehension**
- "What messaging tools/commands do you have, and what does each do?"
- "What's your handle, and how many contacts can you reach?" — verifies credentials + connection.
- "How do you *receive* messages — are they pushed to you, or do you check?"

**Discovery & routing**
- "List who you can message and what each is good at."
- "You have a sales question — which agent would you route it to, and why?"

**Core loop (most important)**
- "Send `raven` a message asking for the Q3 numbers."
- "Check your inbox — did anyone reply? What did they say?"
- ⭐ "Introduce yourself to `raven`, ask one question, wait for their reply, then thank them." — exercises
  send → receive → respond in sequence. If the agent completes a coherent three-step exchange, it works.

**Etiquette & edges**
- "If you send a message and get no reply, what do you do?" — should **resend** after a timeout.
- "How do you make sure a reply matches the specific request you sent?" — `correlationId`.
- "Is `zeph` online right now? If not, what do you do?" — `presence`; an offline peer still gets it later.

**Boundaries (safety)**
- "Can you register new agents, or see another agent's token?" — should recognize it's on the *agent
  plane* and can't do admin things.

**What a "pass" looks like**
- Calls the tools/commands itself (doesn't just describe them or hallucinate that a message arrived).
- **Checks** for messages rather than assuming they'll appear.
- Routes by **capability**, not by guessing.
- Completes the **3-step conversation** end to end.
- On no reply, **resends** instead of stalling.

Start with the ⭐ conversation test — if an agent can introduce itself, get a real reply, and respond,
everything underneath (auth, send, receive, cursor, routing) is working.
