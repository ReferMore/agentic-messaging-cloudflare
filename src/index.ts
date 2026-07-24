import { Hono } from 'hono';
import { serviceAdmin } from './services/service.admin';
import { serviceMessaging } from './services/service.messaging';
import type { Env, Vars } from './types';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get('/', (c) => c.json({ service: 'agentic-messaging', status: 'ok' }));

// Admin plane (ADMIN_API_KEY): register agents, issue/revoke tokens.
app.route('/admin', serviceAdmin);

// Agent plane (per-agent bearer token): send, listen, presence, contacts.
app.route('/', serviceMessaging);

// Durable Object export — referenced by wrangler.jsonc class_name.
export { AgentSession } from './durable/AgentSession';

export default app;
