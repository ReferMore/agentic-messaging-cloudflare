#!/usr/bin/env node
// One-command provisioning for agentic-messaging. Idempotent — safe to re-run.
// Assumes: Cloudflare account + Workers Paid + `wrangler login` already done.
// Does NOT deploy (that's your explicit step / CI-CD).
//
//   npm run setup
//
// After this: `npm run dev` (local smoke test) OR set secrets + `npm run deploy` (remote).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DB_NAME = 'agentic-messaging';
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
const log = (m) => console.log(`\n▸ ${m}`);
const rand = () => randomBytes(32).toString('base64url');

// 1. Dependencies
if (!existsSync('node_modules')) { log('installing deps'); run('npm install', { stdio: 'inherit' }); }

// 2. Create the D1 database (skip if it already exists), then resolve its id.
log(`ensuring D1 database "${DB_NAME}"`);
try { run(`npx wrangler d1 create ${DB_NAME}`); console.log('  created'); }
catch (e) { console.log('  already exists (ok)'); }

const list = JSON.parse(run('npx wrangler d1 list --json'));
const db = list.find((d) => d.name === DB_NAME);
if (!db?.uuid) { console.error('could not resolve D1 id from `wrangler d1 list`'); process.exit(1); }
console.log(`  database_id = ${db.uuid}`);

// 3. Patch wrangler.jsonc with the real database_id (regex — file is JSONC with comments).
log('patching wrangler.jsonc');
let wj = readFileSync('wrangler.jsonc', 'utf8');
wj = wj.replace(/("database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`);
writeFileSync('wrangler.jsonc', wj);

// 4. Generate secrets → .dev.vars (for local dev). Never clobber existing secrets.
if (!existsSync('.dev.vars')) {
  log('generating secrets → .dev.vars');
  const adminKey = rand();
  const pepper = rand();
  writeFileSync('.dev.vars', `ADMIN_API_KEY=${adminKey}\nTOKEN_PEPPER=${pepper}\n`);
  console.log('  wrote .dev.vars (ADMIN_API_KEY, TOKEN_PEPPER)');
  globalThis.__secrets = { adminKey, pepper };
} else {
  console.log('  .dev.vars exists — leaving it');
}

// 5. Apply schema to local + remote D1 (CREATE TABLE IF NOT EXISTS — idempotent).
log('applying schema (local)');
run(`npx wrangler d1 execute ${DB_NAME} --local --file=./schema.sql`, { stdio: 'inherit' });
log('applying schema (remote)');
try { run(`npx wrangler d1 execute ${DB_NAME} --remote --file=./schema.sql`, { stdio: 'inherit' }); }
catch { console.log('  remote schema skipped (run later if needed)'); }

// 6. Next steps
const s = globalThis.__secrets;
console.log(`
✅ Provisioned. Verify it end-to-end (spawns a local dev worker, tests, tears down):

    npm run smoketest                 # ← proves persist→notify→pull + offline catch-up

  Or drive it by hand:

  LOCAL (no deploy):
    npm run dev                       # terminal 1 (http://localhost:8787)
    # then use the CLI from terminal 2/3 (see README "Reference CLI")

  REMOTE (two-machine test):
    ${s ? `echo '${s.adminKey}' | npx wrangler secret put ADMIN_API_KEY
    echo '${s.pepper}' | npx wrangler secret put TOKEN_PEPPER` : '# set ADMIN_API_KEY + TOKEN_PEPPER via `wrangler secret put` (values in .dev.vars)'}
    npm run deploy                    # or push to CI/CD

  Then register an agent + issue a token (admin key = ADMIN_API_KEY):
    curl -X POST $BASE/admin/agents -H "Authorization: Bearer $ADMIN" \\
      -H 'content-type: application/json' -d '{"handle":"chief-of-staff"}'
    curl -X POST $BASE/admin/agents/chief-of-staff/token -H "Authorization: Bearer $ADMIN"
`);
