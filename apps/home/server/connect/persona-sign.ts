// POST /connect/persona-sign — the custodian signature for a DEMO person's own ceremonies.
//
//   {}          → { ok, persona }            probe: is this session a demo account?
//   { digest }  → { ok, persona, signature } EIP-191 over the 32-byte digest
//
// A demo person's custodian is a seeded EOA held in this Home's `DEMO_PERSONA_KEYS` (see
// server/_lib/demo-custody.ts), not in a browser wallet. Without this, every portal ceremony that
// needs custody — enable vault storage, publish a directory listing, post in a discussion, claim a
// name — opens a wallet prompt nobody can satisfy. With it, those ceremonies run the same way a
// KMS-custodied (Google/email) home's do: server-side, no device prompt, in any tab.
//
// Gates, fail-closed: a valid Home session is required and the signature is ALWAYS for the SA in
// that session's own `sub` — the request never names a subject, so no one can ask to be signed for
// as someone else. A session whose SA isn't in the registry gets `persona: false` and the client
// falls back to the real wallet path (never a silent substitution).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import type { Hex } from '@agenticprimitives/types';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { demoPersonaFor, signDigestAsDemoPersona, signTypedDataAsDemoPersona } from '../_lib/demo-custody';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);

  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, {
    keys,
    expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso',
    expectedIss: ownIssuer(request, env),
  });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return json({ error: 'no person address in token sub' }, 401);

  const persona = demoPersonaFor(env, person);
  if (!persona) return json({ ok: true, persona: false });

  const body = (await request.json().catch(() => null)) as
    | { digest?: string; typedData?: { domain?: unknown; types?: unknown; primaryType?: string; message?: unknown } }
    | null;

  // EIP-712 typed-data path (demo-web-pro's custody quorum slots sign structured data, not a raw digest).
  if (body?.typedData) {
    const td = body.typedData;
    if (!td.types || !td.primaryType || !td.message) {
      return json({ error: 'typedData requires types, primaryType, message' }, 400);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return json({ ok: true, persona: true, signature: await signTypedDataAsDemoPersona(persona, td as any) });
    } catch (e) {
      return json({ error: `could not sign typed data: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  const digest = (body?.digest ?? '').trim();
  if (!digest) return json({ ok: true, persona: true, handle: persona.handle });
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) return json({ error: 'digest must be a 32-byte hex string' }, 400);

  try {
    return json({ ok: true, persona: true, signature: await signDigestAsDemoPersona(persona, digest as Hex) });
  } catch (e) {
    return json({ error: `could not sign: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
};
