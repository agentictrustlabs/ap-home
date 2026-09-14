// Spec 400 W1b — the RUNTIME's two moves on a pairing code, proxied to the agent runtime so a runtime needs only
// the Home's URL and the code the custodian showed it. No session, no secret: the code names the custodian's handle,
// the custodian's own object decides, and the record it hands back holds only what the custodian signed.
export const runtime = 'nodejs';

const a2aOrigin = (env: { A2A_CUSTODY_URL?: string }): string =>
  (env.A2A_CUSTODY_URL ?? process.env.DEMO_A2A_URL ?? 'https://demo-a2a-production.richardpedersen3.workers.dev').replace(/\/$/, '');

export async function onRequestPost(move: 'claim' | 'take', { request, env }: { request: Request; env: { A2A_CUSTODY_URL?: string } }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== 'string' || typeof body.address !== 'string') return Response.json({ ok: false, error: 'code and address are required' }, { status: 400 });
  const r = await fetch(`${a2aOrigin(env)}/runtime/pair/${move}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
}
