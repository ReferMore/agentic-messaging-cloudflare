#!/usr/bin/env node
// amsg — reference CLI for agentic-messaging. Dependency-free (Node 22+ globals: fetch, WebSocket).
//
//   AMSG_BASE=https://msg.example.com AMSG_TOKEN=amsg_... node cli/amsg.mjs listen
//   AMSG_BASE=... AMSG_TOKEN=... node cli/amsg.mjs send <to-handle> "your message"
//   AMSG_BASE=... AMSG_TOKEN=... node cli/amsg.mjs agents [capability]
//
// `listen` demonstrates persist->notify->pull: it opens the WS, and on each { conversationId, seq }
// nudge it PULLS the new messages over REST and advances its cursor.

const BASE = (process.env.AMSG_BASE || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.AMSG_TOKEN;
const WS_BASE = BASE.replace(/^http/, 'ws');

if (!TOKEN) { console.error('set AMSG_TOKEN'); process.exit(1); }

const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const cursors = new Map(); // conversationId -> last seq pulled

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: auth, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === 0) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

async function pull(conversationId) {
  const since = cursors.get(conversationId) ?? 0;
  const { messages, cursor } = await api('GET', `/conversations/${encodeURIComponent(conversationId)}/messages?since=${since}`);
  if (messages.length) {
    cursors.set(conversationId, cursor);
    for (const m of messages) console.log(`[${conversationId}] ${m.senderHandle}: ${fmt(m.body)}`);
    await api('POST', `/conversations/${encodeURIComponent(conversationId)}/read`, { seq: cursor });
  }
}

const fmt = (b) => (typeof b === 'string' ? b : JSON.stringify(b));

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'send') {
  const [to, ...rest] = args;
  const data = await api('POST', '/send', { to, type: 'text', body: rest.join(' ') });
  console.log('sent', data);
} else if (cmd === 'agents') {
  const q = args[0] ? `?capability=${encodeURIComponent(args[0])}` : '';
  console.log(JSON.stringify((await api('GET', `/agents${q}`)).agents, null, 2));
} else if (cmd === 'listen') {
  // Catch up first, then stream.
  for (const c of (await api('GET', '/conversations')).conversations) cursors.set(c.conversationId, c.lastReadSeq ?? 0);
  for (const c of (await api('GET', '/conversations')).conversations) await pull(c.conversationId);
  const ws = new WebSocket(`${WS_BASE}/listen?token=${encodeURIComponent(TOKEN)}`);
  ws.addEventListener('open', () => console.log('listening…'));
  ws.addEventListener('message', async (e) => {
    if (e.data === 'pong') return;
    try { const n = JSON.parse(e.data); if (n.type === 'notify') await pull(n.conversationId); } catch {}
  });
  ws.addEventListener('close', () => { console.log('disconnected'); process.exit(0); });
  setInterval(() => { try { ws.send('ping'); } catch {} }, 30000);
} else {
  console.log('usage: amsg <listen|send <to> <msg>|agents [capability]>');
}
