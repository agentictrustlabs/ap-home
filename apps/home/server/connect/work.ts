// /connect/work — PROXY to the managing principal's InteractionsDO `endeavor.*`
// op family (spec 334 §3), exactly the channels.ts pattern: the Home gates and
// persists NOTHING here — the per-principal serialized execution point on
// demo-a2a owns session re-verification, the member/steward/participant gates,
// command validation, the audit row before commit, and the vault writes over
// the interactions grant. This route only extracts the session, attaches the
// steward-wire proof, and forwards. Fail-closed: no execution point ⇒ 503,
// never a local fallback (ADR-0013).
//
// Wire shapes (spec 332 §5 records; the DO is the validator of record):
//   GET  ?org=…                → endeavor.list → { endeavors, requests, mine, steward, you }
//   GET  ?org=…&endeavorId=…   → endeavor.get  → { endeavor, plan, participations, commitments, decisions, events }
//   POST { action:'request', target, goal }                 → endeavor.request (any authenticated session)
//   POST { action:'adopt'|'decline', org, requestId, … }    → endeavor.create (steward triage — adopt or decline, audited, never silent)
//   POST { action:'commit', org, … , signature }            → endeavor.commit (participant-signed; binds exact plan revision hash)
//   POST { action:'decide', org, endeavorId, decisionId, …} → endeavor.decide (declared approver only)
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { callInteractions, stewardWireFor } from './channels';

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

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  const org = (url.searchParams.get('org') ?? '').trim().toLowerCase();
  if (!org) return jsonCors({ error: 'org required' }, request, 400);

  const endeavorId = url.searchParams.get('endeavorId')?.trim();
  const stewardship = await stewardWireFor(env, who.person, org, who.token);
  const r = await callInteractions(env, org, endeavorId ? 'endeavor.get' : 'endeavor.list', {
    session: who.token,
    ...(endeavorId ? { endeavorId } : {}),
    ...(stewardship ? { stewardship } : {}),
  });
  // Attach the steward flag on EVERY status: the stale-grant 409 (needsReEnable) must tell the UI
  // whether this viewer can run the re-enable ceremony.
  if (r.status !== 200) return jsonCors({ ...r.body, steward: r.body.steward === true || !!stewardship }, request, r.status);
  return jsonCors({ ...r.body, steward: r.body.steward === true || !!stewardship }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | {
        action?: string;
        /** The principal whose serving plane receives an endeavor.request (person or org SA). */
        target?: string;
        org?: string;
        goal?: string;
        title?: string;
        reason?: string;
        requestId?: string;
        endeavorId?: string;
        decisionId?: string;
        outcome?: 'approved' | 'rejected';
        allocationRef?: string;
        participant?: string;
        planRef?: { planId: string; revision: number; hash: string };
        steps?: string[];
        signature?: { signer: string; scheme: string; signature: string };
        /** proposePlan: full step records (the DO validates stepId/kind/description). */
        planSteps?: Array<{ stepId: string; kind: string; description: string }>;
        /** Spec 382 W3 — proposePlan: the milestones the plan defines; achieveMilestone: which one was reached. */
        milestones?: Array<{ milestoneId: string; title: string; criteria?: Array<{ criterionId: string }> }>;
        milestoneId?: string;
        proposalRef?: string;
        note?: string;
        stepId?: string;
        evidence?: string; commitmentId?: string;
      }
    | null;
  if (!body?.action) return jsonCors({ error: 'action required' }, request, 400);

  // Home Request (spec 334 §5, entry point 'home-request'): the GOAL travels to
  // the TARGET principal's serving plane; the requester is the session subject.
  if (body.action === 'request') {
    const target = (body.target ?? '').trim().toLowerCase();
    const goal = (body.goal ?? '').trim();
    if (!target) return jsonCors({ error: 'target required' }, request, 400);
    if (!goal) return jsonCors({ error: 'goal required' }, request, 400);
    const r = await callInteractions(env, target, 'endeavor.request', {
      session: who.token,
      goal,
      entryPoint: 'home-request',
    });
    return jsonCors(r.body, request, r.status);
  }

  const org = (body.org ?? '').trim().toLowerCase();
  if (!org) return jsonCors({ error: 'org required' }, request, 400);
  const stewardship = await stewardWireFor(env, who.person, org, who.token);

  // Steward triage (spec 334 §6): adopt runs endeavor.create; decline is the
  // decline command on the same op — both recorded + audited, never silent.
  if (body.action === 'adopt' || body.action === 'decline') {
    if (!body.requestId?.trim()) return jsonCors({ error: 'requestId required' }, request, 400);
    const r = await callInteractions(env, org, 'endeavor.create', {
      session: who.token,
      requestId: body.requestId,
      decision: body.action === 'adopt' ? 'adopt' : 'decline',
      ...(body.title ? { title: body.title } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // Plan authoring (spec 332 §6): proposePlan is participant-or-member gated; adoptPlan is
  // steward-only. Both re-gated by the DO — the stewardship wire lets an unlisted steward act.
  if (body.action === 'proposePlan') {
    if (!body.endeavorId?.trim() || !Array.isArray(body.planSteps) || body.planSteps.length === 0) {
      return jsonCors({ error: 'endeavorId and planSteps required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.proposePlan', {
      session: who.token,
      endeavorId: body.endeavorId,
      steps: body.planSteps,
      ...(Array.isArray(body.milestones) && body.milestones.length ? { milestones: body.milestones } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  if (body.action === 'adoptPlan') {
    if (!body.endeavorId?.trim() || !body.planRef) return jsonCors({ error: 'endeavorId and planRef required' }, request, 400);
    const r = await callInteractions(env, org, 'endeavor.adoptPlan', {
      session: who.token,
      endeavorId: body.endeavorId,
      planRef: body.planRef,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // A participant OFFERS a contribution against plan steps (spec 332 §9.1).
  if (body.action === 'offer') {
    if (!body.endeavorId?.trim() || !body.planRef || !Array.isArray(body.steps) || body.steps.length === 0) {
      return jsonCors({ error: 'endeavorId, planRef, steps required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.propose', {
      session: who.token,
      endeavorId: body.endeavorId,
      planRef: body.planRef,
      steps: body.steps,
      ...(body.note ? { note: body.note } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // Steward SELECTION of a proposal (spec 334 §3 rule 2a — records the decision, grants nothing).
  if (body.action === 'allocate') {
    if (!body.endeavorId?.trim() || !body.proposalRef?.trim() || !body.participant?.trim() || !Array.isArray(body.steps) || body.steps.length === 0) {
      return jsonCors({ error: 'endeavorId, proposalRef, participant, steps required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.allocate', {
      session: who.token,
      endeavorId: body.endeavorId,
      proposalRef: body.proposalRef,
      participant: body.participant,
      steps: body.steps,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // The participant's signed commitment (spec 332 §9.2): binds the EXACT adopted
  // plan revision hash. The DO re-derives the digest and verifies the signature
  // fail-closed; a stale/mismatched hash is a 409, never coerced.
  if (body.action === 'commit') {
    if (!body.endeavorId?.trim() || !body.allocationRef?.trim() || !body.signature) {
      return jsonCors({ error: 'endeavorId, allocationRef, signature required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.commit', {
      session: who.token,
      endeavorId: body.endeavorId,
      allocationRef: body.allocationRef,
      participant: body.participant ?? who.person,
      planRef: body.planRef ?? null,
      steps: body.steps ?? [],
      signature: body.signature,
    });
    return jsonCors(r.body, request, r.status);
  }

  // Execution (spec 332 §6): mark ONE step done with completion evidence — recorded by the
  // managing principal or an active participant (the reducer's gate, not ours).
  // Spec 382 W3 — a milestone of the adopted plan, recorded achieved with evidence (the reducer's gate).
  if (body.action === 'achieveMilestone') {
    if (!body.endeavorId?.trim() || !body.milestoneId?.trim() || !body.evidence?.trim()) {
      return jsonCors({ error: 'endeavorId, milestoneId, evidence required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.milestone.achieve', {
      session: who.token, endeavorId: body.endeavorId, milestoneId: body.milestoneId, evidence: body.evidence,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  if (body.action === 'satisfyStep') {
    if (!body.endeavorId?.trim() || !body.stepId?.trim() || !body.evidence?.trim()) {
      return jsonCors({ error: 'endeavorId, stepId, evidence required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.satisfyStep', {
      session: who.token,
      endeavorId: body.endeavorId,
      stepId: body.stepId,
      evidence: body.evidence,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // Spec 382 W2 — a participant withdraws their commitment (the reducer admits only them); a steward
  // reallocates a commitment to another participant as a NEW allocation they must commit to.
  if (body.action === 'withdraw') {
    if (!body.endeavorId?.trim() || !body.commitmentId?.trim()) return jsonCors({ error: 'endeavorId, commitmentId required' }, request, 400);
    const r = await callInteractions(env, org, 'endeavor.withdrawCommitment', {
      session: who.token, endeavorId: body.endeavorId, commitmentId: body.commitmentId, ...(body.reason ? { reason: body.reason } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  if (body.action === 'reallocate') {
    if (!body.endeavorId?.trim() || !body.commitmentId?.trim() || !body.participant?.trim()) return jsonCors({ error: 'endeavorId, commitmentId, participant required' }, request, 400);
    const r = await callInteractions(env, org, 'endeavor.reallocate', {
      session: who.token, endeavorId: body.endeavorId, commitmentId: body.commitmentId, participant: body.participant,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // Mark the whole endeavor complete (outcome validated) / close it — coordinator or steward.
  if (body.action === 'satisfy' || body.action === 'abandon') {
    if (!body.endeavorId?.trim()) return jsonCors({ error: 'endeavorId required' }, request, 400);
    const r = await callInteractions(env, org, body.action === 'satisfy' ? 'endeavor.satisfy' : 'endeavor.abandon', {
      session: who.token,
      endeavorId: body.endeavorId,
      ...(body.note ? { note: body.note } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // Decision (spec 334 §3): the DO resolves the declared approver and rejects
  // any other session — steward status does not substitute.
  if (body.action === 'decide') {
    if (!body.endeavorId?.trim() || !body.decisionId?.trim() || !body.outcome) {
      return jsonCors({ error: 'endeavorId, decisionId, outcome required' }, request, 400);
    }
    const r = await callInteractions(env, org, 'endeavor.decide', {
      session: who.token,
      endeavorId: body.endeavorId,
      decisionId: body.decisionId,
      outcome: body.outcome,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  return jsonCors({ error: 'unknown action' }, request, 400);
};
