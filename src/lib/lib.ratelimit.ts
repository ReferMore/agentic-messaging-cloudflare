// Fixed-window rate limiter — pattern COPIED (not imported) from the main API's lib.ratelimit.ts,
// adapted to run inside the sender's AgentSession DO. Because that DO is single-threaded per agent,
// the in-memory window counter is race-free (no KV eventual-consistency caveat). Callers FAIL OPEN.
//
// Agent throughput >> human, so limits are high but bounded. Per-recipient limits and per-handle
// tiers are deliberately deferred (one generous global default for v1).

export const SEND_LIMIT = 60;               // messages allowed per window (burst)
export const WINDOW_MS = 2000;              // 2s window → ~30/s sustained
export const STRIKE_THRESHOLD = 200;        // denials within the strike window → auto-suspend
export const STRIKE_WINDOW_MS = 60_000;
export const SUSPEND_MS = 5 * 60_000;       // auto-suspension duration

export interface RateState {
  windowStart: number;
  count: number;
  strikeWindowStart: number;
  strikes: number;
}

export function newRateState(): RateState {
  return { windowStart: 0, count: 0, strikeWindowStart: 0, strikes: 0 };
}

export interface RateResult {
  allowed: boolean;
  retryAfterSecs: number;
  /** true once denials in the strike window exceed the threshold → caller should suspend. */
  tripped: boolean;
}

/** Mutates `s` and reports whether this send is allowed. */
export function checkWindow(s: RateState, now: number): RateResult {
  if (now - s.windowStart >= WINDOW_MS) { s.windowStart = now; s.count = 0; }

  if (s.count >= SEND_LIMIT) {
    if (now - s.strikeWindowStart >= STRIKE_WINDOW_MS) { s.strikeWindowStart = now; s.strikes = 0; }
    s.strikes++;
    const retryAfterSecs = Math.max(1, Math.ceil((s.windowStart + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSecs, tripped: s.strikes >= STRIKE_THRESHOLD };
  }

  s.count++;
  return { allowed: true, retryAfterSecs: 0, tripped: false };
}
