import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const PORT = Number(process.env.PORT ?? 8787);

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'demo-a2a' }));

// STEP 1: SIWE verify
// TODO: implement once @agenticprimitives/identity-auth and @agenticprimitives/agent-account are real.
app.post('/auth/siwe-verify', (c) => {
  return c.json({ error: 'not implemented' }, 501);
});

// STEP 2a: Session init — generate session keypair, store encrypted-pending row
// TODO: implement once @agenticprimitives/delegation.SessionManager + @agenticprimitives/key-custody are real.
app.post('/session/init', (c) => {
  return c.json({ error: 'not implemented' }, 501);
});

// STEP 2b: Session package — verify user-signed delegation, mark session active
// TODO: implement once @agenticprimitives/delegation.SessionManager + @agenticprimitives/agent-account.isValidSignature are real.
app.post('/session/package', (c) => {
  return c.json({ error: 'not implemented' }, 501);
});

// STEP 3: Tool proxy — decrypt session, mint DelegationToken, call MCP with HMAC envelope
// TODO: implement once @agenticprimitives/delegation.mintDelegationToken + @agenticprimitives/key-custody/mac are real.
app.post('/tools/:name', (c) => {
  return c.json({ error: 'not implemented' }, 501);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`demo-a2a listening on http://127.0.0.1:${info.port}`);
});
