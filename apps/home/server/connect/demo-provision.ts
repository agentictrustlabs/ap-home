// PUT /connect/demo-provision — turn messaging ON for a demo account (person OR an org it custodies).
//
//   { handle|agent, target? }  (Bearer DEMO_SIGNER_SECRET)
//   → { ok, principal, interactions, delivery }
//
// Messaging and discussions need two planes on the principal's InteractionsDO: the INTERACTIONS grant
// (inbox index, conversation board, directory listings, channels) and the inbox-DELIVERY grant (where
// message bodies live). Real people get both at their Home onboarding / org-create. Seeded demo people
// were bootstrapped by scripts instead, so they often have neither — their DMs 409 and the discussion
// board refuses them, which is exactly the "demo users can't really use the app" gap.
//
// Now that the Home custodies the demo keys (server/_lib/demo-custody.ts) it can just sign the two
// grants itself: same artifacts a real user's ceremony produces, verified by the DO on-chain
// (ERC-1271 against the principal) before it stores them. Idempotent — already-granted planes report
// `skipped` unless `force` is set.
//
// `target` lets one call provision an ORG the demo person custodies (a hotspot org's discussion board
// needs the org's own planes); it must be in that person's `custodies` list, so this can never be
// pointed at someone else's agent.
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address, Hex } from '@agenticprimitives/types';
import type { FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { demoCustodianAddress } from '../_lib/demo-custody';
import { demoPersonaFor, signDigestAsDemoPersona } from '../_lib/demo-custody';
import { issueInboxDeliveryDelegation, issueInteractionsDelegation, issueSessionDelegation, toWire } from '../../src/lib/delegation';
import { DELIVERY_SERVICE_SA, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID } from '../../src/lib/inbox-delivery';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const a2aBase = (env: FnContext['env']): string =>
  (env.A2A_CUSTODY_URL ?? process.env.DEMO_A2A_URL ?? 'https://demo-a2a-production.richardpedersen3.workers.dev').replace(/\/$/, '');
const serviceSa = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as Address) : undefined;

export const onRequestPut = async ({ request, env }: FnContext): Promise<Response> => {
  const secret = env.DEMO_SIGNER_SECRET;
  if (!secret) return json({ error: 'demo signer not enabled' }, 404);
  if ((request.headers.get('authorization') ?? '') !== `Bearer ${secret}`) return json({ error: 'unauthorized' }, 401);

  const body = (await request.json().catch(() => null)) as { handle?: string; agent?: string; target?: string; force?: boolean } | null;
  const persona = demoPersonaFor(env, (body?.agent ?? body?.handle ?? '').trim());
  if (!persona) return json({ error: 'unknown demo account' }, 404);

  // The principal is the demo person, or an org THEY custody — never an unrelated agent.
  const target = (body?.target ?? '').trim().toLowerCase();
  let principal = persona.sa as Address;
  if (target) {
    if (!/^0x[0-9a-f]{40}$/.test(target)) return json({ error: 'target must be an address' }, 400);
    // The seed's `custodies` list is a CACHE of what this person held when they were seeded — an org
    // they created since (a new hotspot) can't be in it. The chain is the authority: ask the account
    // whether this demo custodian is one of its custodians. Fail-closed on a read error.
    let owns = target === persona.sa.toLowerCase() || (persona.custodies ?? []).some((o) => o.sa.toLowerCase() === target);
    if (!owns) {
      try {
        const accounts = new AgentAccountClient({
          rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID,
          entryPoint: CONTRACTS.entryPoint, factory: CONTRACTS.agentAccountFactory,
        });
        owns = await accounts.isCustodian(target as Address, demoCustodianAddress(persona) as Address);
      } catch { owns = false; }
    }
    if (!owns) return json({ error: 'that agent is not custodied by this demo account' }, 403);
    principal = target as Address;
  }

  // Take the service SAs from the shared module, not raw env: the interactions SA is a COMMITTED
  // deployment constant there (only the delivery SA comes from a Vercel var), and reading env alone
  // silently reported "service-not-configured" for every principal.
  const interactionsSa = serviceSa(INTERACTIONS_SERVICE_SA);
  const deliverySa = serviceSa(DELIVERY_SERVICE_SA ?? env.DELIVERY_SERVICE_SA);
  const base = a2aBase(env);
  const sign = (digest: Hex): Promise<Hex> => signDigestAsDemoPersona(persona, digest);

  // Presence check first: /status is an open read, and re-issuing is only worth a signature when the
  // plane is missing or the caller forces a scope refresh.
  let status: { granted?: boolean; current?: boolean; deliveryGranted?: boolean } = {};
  try {
    status = (await fetch(`${base}/interactions/${principal.toLowerCase()}/status`).then((r) => r.json())) as typeof status;
  } catch { /* unreachable status → attempt both (the DO upsert is idempotent) */ }

  const out: { interactions: string; delivery: string } = { interactions: 'skipped', delivery: 'skipped' };

  if (!interactionsSa) out.interactions = 'service-not-configured';
  else if (!body?.force && status.granted && status.current !== false) out.interactions = 'already-granted';
  else {
    try {
      const delegation = await issueInteractionsDelegation(principal, interactionsSa, MCP_SERVER_ID, sign);
      // Best-effort DEL-001 session leaf, exactly as the browser ceremony does: with it the DO mints
      // its own bound vault tokens; without it, it falls back to the server-mint bridge.
      let sessionLeaf: unknown;
      try {
        const sk = (await fetch(`${base}/agent/interactions-session-key`).then((r) => r.json())) as { ok?: boolean; address?: string };
        if (sk?.ok && sk.address && /^0x[0-9a-fA-F]{40}$/.test(sk.address)) {
          // Spec 408 §2.1 — the DO's session key presents the persona's grants to the two service agents only.
          sessionLeaf = toWire(await issueSessionDelegation(principal, sk.address as Address, sign, [interactionsSa, ...(deliverySa ? [deliverySa] : [])]));
        }
      } catch { /* no session key configured — the bridge covers it */ }
      const r = await fetch(`${base}/interactions/${principal.toLowerCase()}/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation: toWire(delegation), ...(sessionLeaf ? { sessionLeaf } : {}) }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      out.interactions = r.ok && j.ok ? 'granted' : `failed: ${String(j.error ?? r.status)}`;
    } catch (e) {
      out.interactions = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (!deliverySa) out.delivery = 'service-not-configured';
  else if (!body?.force && status.deliveryGranted) out.delivery = 'already-granted';
  else {
    try {
      const delegation = await issueInboxDeliveryDelegation(principal, deliverySa, MCP_SERVER_ID, sign);
      const r = await fetch(`${base}/interactions/${principal.toLowerCase()}/grant.delivery.put`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation: toWire(delegation) }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      out.delivery = r.ok && j.ok ? 'granted' : `failed: ${String(j.error ?? r.status)}`;
    } catch (e) {
      out.delivery = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return json({ ok: true, handle: persona.handle, principal, ...out });
};
