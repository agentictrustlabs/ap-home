// PROBING CANDIDATES — spec 384 W2, the requester's half. A READ: "would these agents take this intent, and on
// what terms?" Each candidate gets its own engagement (336 §3.3: one conversation per candidate), a probe
// carrying a minimized projection (the capability and the person's words — never the payee's address, never
// the vault), and answers with one of the six kinds. Offers come back as documents with their digests; nothing
// here accepts one. Acceptance is the person's mandate naming the offer (`offerDigest` on the act's step),
// which the verifier requires (spec 384: `offer-not-bound`).
import type { Address } from 'viem';
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { engagementProbeMessage, engagementOf } from '@agenticprimitives/a2a';
import type { MessageV1 } from '@agenticprimitives/a2a/standard';
import {
  initialEngagement, stepEngagement, digestOf, projectionDigest, offerDigest, type IntentProjectionV1, type EngagementProbeV1, type EngagementResponseV1, type EngagementSituationV1,
} from '@agenticprimitives/intent-engagement';

export const ENGAGEMENT_PROBE_CAPABILITY = 'engagement.probe' as const;

export const ENGAGEMENT_PROBE_TOOL: ToolSpec = {
  id: ENGAGEMENT_PROBE_CAPABILITY,
  answers: ['what offers', 'who would take', 'which agents would', 'who can do', 'on what terms'],
  verbs: ['probe', 'ask for offers', 'get offers from', 'ask who would'],
  description:
    'ASKS OTHER AGENTS WHETHER THEY WOULD TAKE THIS WORK, AND ON WHAT TERMS — an engagement probe (spec 336). Each '
    + 'candidate answers with an offer, a decline, a question, a referral or an unavailability; an offer is the '
    + 'provider\'s signed commitment to these terms and is NOT accepted here — accepting one is a later act whose mandate '
    + 'names the offer. Args: capability (the capability id the work needs, e.g. treasury.payment.execute), candidates '
    + '(the agents to ask, by name or address), words (what is to be done, in the person\'s words).',
  inputSchema: {
    type: 'object',
    properties: {
      capability: { type: 'string', description: 'The capability the work needs (an ADR-0051 id).' },
      candidates: { type: 'array', items: { type: 'string' }, description: 'The agents to ask, exactly as named.' },
      words: { type: 'string', description: 'What is to be done, in plain words.' },
    },
    required: ['capability', 'candidates', 'words'],
  },
};

export interface ProbeDeps {
  resolveName?: (name: string) => Promise<string | null>;
  nameOf?: (address: string) => Promise<string | null>;
  /** Send ONE probe message to a candidate; the reply is the candidate's message (or an error). */
  sendProbe: (candidate: Address, message: MessageV1) => Promise<{ ok: true; message: MessageV1 } | { ok: false; refused: string }>;
  requester: Address;
  now?: () => number;
}

export interface ProbeRow {
  agent: Address; name: string | null; engagementId: string; state: string; kind?: string;
  offer?: { offerId: string; offerDigest: string; expiresAt: string; terms: unknown; requirement: unknown; provider: Address };
  reason?: string; question?: unknown; referral?: Address; until?: string; refused?: string;
}

export function engagementProbeInvoker(deps: ProbeDeps): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const capability = String(args.capability ?? '').trim();
    const words = String(args.words ?? '').trim();
    const candidatesRaw = Array.isArray(args.candidates) ? args.candidates.map((c) => String(c).trim()).filter(Boolean) : [];
    if (!capability) return { refused: 'capability is required', interpretation: 'no capability named' };
    if (!candidatesRaw.length) return { refused: 'name at least one agent to ask', interpretation: 'no candidates' };
    if (candidatesRaw.length > 5) return { refused: 'every probe is a disclosure to one more party — five candidates at most', interpretation: 'too many candidates' };
    const nowMs = (deps.now ?? Date.now)();
    const runRef = String((ctx.intent.context as { runRef?: unknown } | undefined)?.runRef ?? 'run');
    const campaignId = `camp_${runRef}:${ctx.step.id ?? `s${ctx.index}`}`;
    const intentDigest = digestOf(ctx.intent);
    const rows: ProbeRow[] = [];
    for (const raw of candidatesRaw) {
      const agent = (/^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : (await deps.resolveName?.(raw.toLowerCase()).catch(() => null) ?? null)) as Address | null;
      const name = raw.includes('.') && !/^0x/.test(raw) ? raw.toLowerCase() : (agent ? await deps.nameOf?.(agent).catch(() => null) ?? null : null);
      if (!agent) { rows.push({ agent: raw as Address, name, engagementId: '', state: 'not-resolved', refused: `no agent holds the name "${raw}"` }); continue; }
      const engagementId = `eng_${crypto.randomUUID()}`;
      let s: EngagementSituationV1 = initialEngagement({ engagementId, campaignId, requester: deps.requester, candidate: agent, now: new Date(nowMs).toISOString() });
      // THE PROJECTION — audience-bound to this candidate; the capability and the words, nothing the vault holds.
      const projection: IntentProjectionV1 = { type: 'ap.intent-projection.v1', kind: 'engagement', intentId: runRef, intentVersion: 1, intentDigest, audience: agent, purpose: 'quote', fields: { capability, words }, withholds: ['parties by address', 'the asker\'s records'] };
      const { withholds: _w, ...wire } = projection;
      const probe: EngagementProbeV1 = {
        type: 'ap.engagement-probe.v1', probeId: `probe_${crypto.randomUUID()}`, engagementId, campaignId, requester: deps.requester, candidate: agent,
        projection: wire, projectionDigest: projectionDigest(projection), intentDigest, objective: 'firm-offer',
        interaction: { clarification: 'structured-only', humanChannels: ['external-url'], maxRounds: 1 }, processing: 'direct-message',
        replyBy: new Date(nowMs + 10 * 60_000).toISOString(), probeNonce: crypto.randomUUID(), issuedAt: new Date(nowMs).toISOString(),
      };
      const sent = stepEngagement(s, { kind: 'SendProbe', probe, intentDigest, idempotencyKey: `${probe.probeId}:sent`, now: probe.issuedAt });
      if (!sent.ok) { rows.push({ agent, name, engagementId, state: s.state, refused: `${sent.code}: ${sent.reason}` }); continue; }
      s = sent.state;
      const out = await deps.sendProbe(agent, engagementProbeMessage(probe as never));
      if (!out.ok) { rows.push({ agent, name, engagementId, state: s.state, refused: out.refused }); continue; }
      const doc = engagementOf(out.message);
      if (!doc || 'errors' in doc || !('response' in doc)) { rows.push({ agent, name, engagementId, state: s.state, refused: doc && 'errors' in doc ? doc.errors.join('; ') : 'answered with something that was not an engagement response' }); continue; }
      const response = doc.response as unknown as EngagementResponseV1;
      const got = stepEngagement(s, { kind: 'ReceiveResponse', response, idempotencyKey: `${response.responseId}:got`, now: new Date((deps.now ?? Date.now)()).toISOString() });
      if (!got.ok) { rows.push({ agent, name, engagementId, state: s.state, kind: response.content.kind, refused: `${got.code}: ${got.reason}` }); continue; }
      s = got.state;
      const c = response.content;
      const row: ProbeRow = { agent, name, engagementId, state: s.state, kind: c.kind };
      if (c.kind === 'offer' && c.offer.type === 'ap.fulfillment-offer.v1') row.offer = { offerId: c.offer.offerId, offerDigest: offerDigest(c.offer), expiresAt: c.offer.expiresAt, terms: c.offer.terms, requirement: c.offer.requirement, provider: c.offer.provider };
      if (c.kind === 'decline') row.reason = c.detail ? `${c.reason}: ${c.detail}` : c.reason;
      if (c.kind === 'needs-clarification') row.question = c.questions;
      if (c.kind === 'referral') row.referral = c.to;
      if (c.kind === 'temporarily-unavailable') row.until = c.until;
      rows.push(row);
    }
    const offers = rows.filter((r) => r.offer).length;
    const summary = rows.map((r) => `${r.name ?? r.agent.slice(0, 10)}: ${r.kind ?? r.state}${r.reason ? ` (${r.reason})` : ''}${r.refused ? ` — ${r.refused}` : ''}`).join('; ');
    return {
      capability, words, campaignId, candidates: rows, offers,
      interpretation: `probed ${rows.length} agent(s) for ${capability}: ${summary}`,
      note: 'Each answer is that agent\'s own; an offer is its signed commitment to these terms and is not accepted here. Say who offered, who declined and why, and that accepting an offer is a separate act the person authorizes. Never rank them.',
    };
  };
}
