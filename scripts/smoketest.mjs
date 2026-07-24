#!/usr/bin/env node
// End-to-end smoke test for agentic-messaging. Proves the full persist->notify->pull loop
// plus offline catch-up, against a running instance.
//
//   npm run smoketest                     # spawns a local `wrangler dev`, tests it, tears down
//   AMSG_BASE=https://msg.example.com npm run smoketest   # tests an already-running/deployed URL
//
// Requires `npm run setup` to have been run first (schema + .dev.vars/secrets in place).
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomUUID().slice(0, 8);

// --- config: admin key from env or .dev.vars ---
function devVar(key) {
  if (process.env[key]) return process.env[key];
  if (existsSync('.dev.vars')) {
    const m = readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) return m[1].trim();
  }
  return undefined;
}
const ADMIN = devVar('ADMIN_API_KEY');
if (!ADMIN) { console.error('✗ ADMIN_API_KEY not found (run `npm run setup` first, or set it)'); process.exit(1); }

let BASE = process.env.AMSG_BASE?.replace(/\/$/, '');
let dev; // spawned wrangler dev, if any

async function up(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${base}/`); if (r.ok) return true; } catch {}
    await sleep(1000);
  }
  return false;
}

async function api(base, method, path, token, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === 0) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j.data;
}

function waitForNotify(ws, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for notify')), ms);
    ws.addEventListener('message', (e) => {
      if (e.data === 'pong') return;
      try { const n = JSON.parse(e.data); if (n.type === 'notify') { clearTimeout(t); resolve(n); } } catch {}
    });
  });
}
const openWs = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => resolve(ws));
  ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'connect failed'))));
});

let failed = false;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); failed = true; };

async function main() {
  // 1. Ensure a running instance.
  if (!BASE) {
    BASE = 'http://localhost:8787';
    console.log('▸ spawning local `wrangler dev`…');
    dev = spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  console.log(`▸ waiting for ${BASE}`);
  if (!(await up(BASE))) throw new Error(`could not reach ${BASE}`);

  const WS = BASE.replace(/^http/, 'ws');
  const A = `smoke-a-${nonce()}`, B = `smoke-b-${nonce()}`;

  // 2. Register two agents + issue tokens.
  await api(BASE, 'POST', '/admin/agents', ADMIN, { handle: A, capabilities: ['smoke'] });
  await api(BASE, 'POST', '/admin/agents', ADMIN, { handle: B, capabilities: ['smoke'] });
  const { token: tokA } = await api(BASE, 'POST', `/admin/agents/${A}/token`, ADMIN);
  const { token: tokB } = await api(BASE, 'POST', `/admin/agents/${B}/token`, ADMIN);
  ok('registered 2 agents + issued tokens');

  // 3. Discovery.
  const { agents } = await api(BASE, 'GET', '/agents?capability=smoke', tokA);
  agents.some((a) => a.handle === B) ? ok('capability discovery finds peer') : bad('discovery missing peer');

  // 4. ONLINE delivery: B listens, A sends, B gets nudge → pulls → content matches.
  const msg1 = `online-${nonce()}`;
  const wsB = await openWs(`${WS}/listen?token=${tokB}`);
  const gotNotify = waitForNotify(wsB);
  const sent = await api(BASE, 'POST', '/send', tokA, { to: B, body: msg1 });
  const note = await gotNotify;
  (note.conversationId === sent.conversationId && note.seq === sent.seq)
    ? ok('online: notification received') : bad('online: notification mismatch');
  const pulled = await api(BASE, 'GET', `/conversations/${encodeURIComponent(note.conversationId)}/messages?since=0`, tokB);
  pulled.messages.at(-1)?.body === msg1 ? ok('online: pulled message matches') : bad('online: message body mismatch');
  await api(BASE, 'POST', `/conversations/${encodeURIComponent(note.conversationId)}/read`, tokB, { seq: pulled.cursor });
  wsB.close();
  await sleep(300);

  // 5. OFFLINE catch-up: B disconnected, A sends, B reconnects → pull-since-cursor sees it.
  const msg2 = `offline-${nonce()}`;
  await api(BASE, 'POST', '/send', tokA, { to: B, body: msg2 });
  const convs = await api(BASE, 'GET', '/conversations', tokB);
  const conv = convs.conversations.find((c) => c.conversationId === sent.conversationId);
  conv?.unread >= 1 ? ok('offline: unread count reflects missed message') : bad('offline: unread not counted');
  const after = await api(BASE, 'GET', `/conversations/${encodeURIComponent(sent.conversationId)}/messages?since=${conv.lastReadSeq}`, tokB);
  after.messages.some((m) => m.body === msg2) ? ok('offline: caught up on reconnect (pull-since-cursor)') : bad('offline: missed message not caught up');

  // 6. RATE LIMIT: a rapid burst from one sender trips the per-sender window limit (429).
  const burst = await Promise.all(Array.from({ length: 100 }, () =>
    fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, body: 'burst' }),
    }).then((r) => r.status).catch(() => 0)
  ));
  burst.includes(429) ? ok('rate limit: burst trips 429') : bad('rate limit: no 429 under 100-msg burst');

  // 7. Cleanup tokens (leave agents; they're uniquely named).
  await api(BASE, 'POST', `/admin/agents/${A}/revoke`, ADMIN);
  await api(BASE, 'POST', `/admin/agents/${B}/revoke`, ADMIN);
  ok('revoked test tokens');
}

main()
  .then(() => { console.log(failed ? '\n✗ SMOKE TEST FAILED' : '\n✅ SMOKE TEST PASSED'); })
  .catch((e) => { console.error(`\n✗ SMOKE TEST ERROR: ${e.message}`); failed = true; })
  .finally(() => {
    if (dev) { try { dev.kill('SIGINT'); } catch {} }
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
