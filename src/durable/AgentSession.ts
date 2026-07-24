// AgentSession — one Durable Object per agent handle (AGENT.idFromName(handle)).
// It is a NOTIFICATION RELAY, not a mailbox: D1 holds all message state. This DO only owns the
// agent's live WebSocket(s) (via the Hibernation API) and forwards lightweight nudges to them.
//
// Internal routes (called by the Worker, never by agents directly):
//   GET  /connect   — WebSocket upgrade from the owning agent (the notify channel)
//   POST /notify    — forward a { conversationId, seq } nudge to all live sockets
//   GET  /presence  — { online }
//   POST /close     — close all sockets (used on token revocation)
import type { Env } from '../types';
import { checkWindow, newRateState, SUSPEND_MS, type RateState } from '../lib/lib.ratelimit';
import { getSuspendedUntil, setSuspendedUntil } from '../models/model.registry';

export class AgentSession {
  private ctx: DurableObjectState;
  private env: Env;
  // Per-sender rate-limit state (in-memory; single-threaded DO → race-free; resets on eviction = fail-open).
  private rate: RateState = newRateState();
  private suspendedUntil: number | null = null;
  private suspensionLoaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/connect': {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('expected websocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server); // hibernatable
        return new Response(null, { status: 101, webSocket: client });
      }

      case '/notify': {
        // Body is the notification JSON; forward verbatim to every live socket.
        const payload = await request.text();
        const sockets = this.ctx.getWebSockets();
        for (const ws of sockets) {
          try { ws.send(payload); } catch { /* drop dead socket */ }
        }
        return Response.json({ notified: sockets.length });
      }

      // Per-sender rate check (called by the Worker on POST /send). ?handle=<sender>.
      case '/allow': {
        const handle = url.searchParams.get('handle') ?? '';
        const now = Date.now();
        // Suspension (durable, D1) — load lazily and treat any failure (e.g. missing column) as
        // "not suspended" so the in-memory window limit below ALWAYS runs.
        if (!this.suspensionLoaded) {
          try { this.suspendedUntil = await getSuspendedUntil(this.env, handle); }
          catch { this.suspendedUntil = null; }
          this.suspensionLoaded = true;
        }
        if (this.suspendedUntil && now < this.suspendedUntil) {
          return Response.json({ allowed: false, suspended: true, retryAfterSecs: Math.ceil((this.suspendedUntil - now) / 1000) });
        }
        // Window limit (in-memory, race-free, never throws).
        const r = checkWindow(this.rate, now);
        if (r.tripped) {
          this.suspendedUntil = now + SUSPEND_MS;
          try { await setSuspendedUntil(this.env, handle, this.suspendedUntil); } catch { /* persistence best-effort */ }
          return Response.json({ allowed: false, suspended: true, retryAfterSecs: Math.ceil(SUSPEND_MS / 1000) });
        }
        return Response.json({ allowed: r.allowed, suspended: false, retryAfterSecs: r.retryAfterSecs });
      }

      // Drop cached suspension (called after an admin unsuspend).
      case '/refresh': {
        this.suspensionLoaded = false;
        this.suspendedUntil = null;
        return Response.json({ ok: true });
      }

      case '/presence':
        return Response.json({ online: this.ctx.getWebSockets().length > 0 });

      case '/close': {
        for (const ws of this.ctx.getWebSockets()) {
          try { ws.close(1008, 'token revoked'); } catch { /* already gone */ }
        }
        return Response.json({ closed: true });
      }

      default:
        return new Response('not found', { status: 404 });
    }
  }

  // --- Hibernation handlers ---

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Notify channel is push-only; agents pull via REST and send via POST /send.
    // Support a keepalive so agents can confirm a live connection.
    if (typeof message === 'string' && message === 'ping') {
      try { ws.send('pong'); } catch { /* noop */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    try { ws.close(code, reason); } catch { /* already closing */ }
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    // Non-fatal; the runtime cleans up the connection.
  }
}
