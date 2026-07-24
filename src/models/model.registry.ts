// D1 registry: agent identity + capabilities (Model C admin-owned fields) and tokens.
import type { Env } from '../types';
import { generateToken, hashToken, TOKEN_TTL_MS } from '../lib/lib.token';

export interface AgentRow {
  handle: string;
  description: string | null;
  capabilities: string[];
  metadata: Record<string, unknown> | null;
  suspendedUntil: number | null;
}

function parseAgent(row: Record<string, unknown>): AgentRow {
  return {
    handle: row.handle as string,
    description: (row.description as string) ?? null,
    capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : [],
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    suspendedUntil: (row.suspendedUntil as number) ?? null,
  };
}

export async function registerAgent(
  env: Env,
  handle: string,
  description: string | null,
  capabilities: string[] = [],
  metadata: Record<string, unknown> | null = null
) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO agents (handle, description, capabilities, metadata, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(handle) DO UPDATE SET
       description = excluded.description,
       capabilities = excluded.capabilities,
       metadata = excluded.metadata,
       active = 1;`
  ).bind(handle, description, JSON.stringify(capabilities), metadata ? JSON.stringify(metadata) : null, now).run();
}

export async function listAgents(env: Env, capability?: string): Promise<AgentRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT handle, description, capabilities, metadata, suspendedUntil FROM agents WHERE active = 1 ORDER BY handle;'
  ).all();
  const agents = (results as Record<string, unknown>[]).map(parseAgent);
  // Discovery filter: the roster is small and internal, so filter in JS (robust across JSON shapes).
  return capability ? agents.filter((a) => a.capabilities.includes(capability)) : agents;
}

export async function agentExists(env: Env, handle: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM agents WHERE handle = ?;').bind(handle).first();
  return !!row;
}

/** Issue a token (revokes existing), 90-day expiry, store only the HMAC hash. Returns plaintext ONCE. */
export async function issueToken(env: Env, handle: string): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;
  const token = generateToken();
  const tokenHash = await hashToken(token, env.TOKEN_PEPPER);
  await env.DB.batch([
    env.DB.prepare('UPDATE tokens SET revoked = 1 WHERE handle = ? AND revoked = 0;').bind(handle),
    env.DB.prepare(
      'INSERT INTO tokens (token_hash, handle, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0);'
    ).bind(tokenHash, handle, now, expiresAt),
  ]);
  return { token, expiresAt };
}

export async function revokeTokens(env: Env, handle: string) {
  await env.DB.prepare('UPDATE tokens SET revoked = 1 WHERE handle = ? AND revoked = 0;').bind(handle).run();
}

// --- Rate-limit auto-suspend backstop (durable + admin-visible). ---
export async function getSuspendedUntil(env: Env, handle: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT suspendedUntil FROM agents WHERE handle = ?;')
    .bind(handle).first<{ suspendedUntil: number | null }>();
  return row?.suspendedUntil ?? null;
}

export async function setSuspendedUntil(env: Env, handle: string, until: number) {
  await env.DB.prepare('UPDATE agents SET suspendedUntil = ? WHERE handle = ?;').bind(until, handle).run();
}

export async function clearSuspendedUntil(env: Env, handle: string) {
  await env.DB.prepare('UPDATE agents SET suspendedUntil = NULL WHERE handle = ?;').bind(handle).run();
}
