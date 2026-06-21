// /connect/skills — the person's PRIVATE skill claims (spec 282 Phase 2b).
//
// Two-tier (spec 282): the full skill-claim set is PRIVATE, held in the person's Connect-home vault (KV,
// the same private-VC store as related-orgs); the agent publicly asserts only a chosen subset via its
// `atl:skills` profile property (owner-signed, separate). This route is the PRIVATE tier: session-
// authorized read/write of the claim set, keyed by the person SA. Never public; never travels as graph
// state (ADR-0025/0040). The public assertion is a separate on-chain write the SA signs.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

/** Verify the home-session token and return the person SA (lowercased), or null. */
async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: resolveOrigin(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

interface SkillRecord { label: string; skillId?: string; relation?: string; proficiency?: number; asserted: boolean; createdAt?: number }

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const skills = JSON.parse((await env.AUTH_CODES.get(`skills:${person}`)) ?? '[]') as SkillRecord[];
  return jsonCors({ skills }, request);
};

// POST — replace the person's full managed claim set (the UI sends the whole list; small + atomic).
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as { skills?: SkillRecord[] } | null;
  if (!Array.isArray(body?.skills)) return jsonCors({ error: 'skills[] required' }, request, 400);
  // Sanitize: keep only well-formed records; cap the set.
  const clean: SkillRecord[] = body!.skills
    .filter((s) => s && typeof s.label === 'string' && s.label.trim())
    .slice(0, 64)
    .map((s) => ({
      label: String(s.label).trim().slice(0, 80),
      skillId: typeof s.skillId === 'string' ? s.skillId : undefined,
      relation: typeof s.relation === 'string' ? s.relation : 'hasSkill',
      proficiency: typeof s.proficiency === 'number' ? Math.max(0, Math.min(10000, s.proficiency)) : undefined,
      asserted: s.asserted === true,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    }));
  await env.AUTH_CODES.put(`skills:${person}`, JSON.stringify(clean));
  return jsonCors({ ok: true, count: clean.length }, request);
};
