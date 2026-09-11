// THE TOOL SURFACE (spec 397 §5, W1): the person's own agent, reached as them. Fixed — never a per-agent tool, never
// a vault read, never a mandate. What comes back is their agent's reply with its evidence; an act that needs their
// authority is said as such, with the page on their Home where they sign.
import { askAsPerson, callAsPerson, isDelegationRefusal, type PersonIdentity } from './a2a.js';

export const TOOLS = [
  {
    name: 'ask',
    description: 'Put the person\'s words to THEIR OWN agent, as them — their records, their organizations, their playbook. Args: message (their ask, in their words); addressee (optional: an organization they stand in, by name, to ask there instead of at home); run (optional: the runRef of a run to continue — a prompt answered with `supplied`, or a run they granted authority for at their Home). Replies carry `kind`: answer | done | prompt | authority_required | refused, the run reference, and where its provenance is.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, addressee: { type: 'string', description: 'an organization name (missio-nexus.org) to ask there; omit for their own agent' }, run: { type: 'string', description: 'a runRef to continue' }, supplied: { type: 'array', items: { type: 'object' }, description: 'answers to a prompt: [{ stepRef, data: { field: value } }]' } }, required: [] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'discover_agents',
    description: 'Find agents in the public registry by what the person wants — a ministry with a study on a doctrine, a service offering a capability — THROUGH THEIR OWN AGENT (the search is a run of theirs, with provenance). Args: intent (what they want, in their words), capability (optional filter: a capability id, or a word the registry resolves to one it knows, e.g. "study plans"; an unknown word is refused with the reason, never widened), language (optional BCP-47), limit (default 5). Returns agents with name, description, capabilities, card and relevance. Then `engage` one by its name.',
    inputSchema: { type: 'object', properties: { intent: { type: 'string' }, capability: { type: 'string' }, language: { type: 'string' }, limit: { type: 'integer' } }, required: ['intent'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'inspect_agent',
    description: 'Look at one agent before engaging it: its public A2A card re-fetched through its registry name\'s own records — who it says it is, its skills and provider, and whether the served card still matches the digest its records pin. Read only, through the person\'s agent. Args: agent (the registry name, e.g. ligonier.svc).',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'engage',
    description: 'Send the person\'s words, as them, to another agent — one `discover_agents` returned or one they named (ligonier.svc, missio-nexus.org) — and get that agent\'s own answer, made under ITS playbook from its own catalog or records (a study plan with links, what it offers). Their agent sends it and records the hop; the other agent sees only the message. Args: agent (name or 0x address as discovery returned it), message (the ask, complete, in the person\'s words). Present the reply as that agent\'s answer, naming it as the source and keeping every link it gave.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, message: { type: 'string' } }, required: ['agent', 'message'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'my_runs',
    description: 'The person\'s recent runs — on their own agent, or at an organization they asked at (addressee) — what they asked (through any surface), what came of it, and which are still waiting on them (a signature at their Home, an answer). Args: limit (default 10), addressee (optional: an organization name). Read from the agent\'s own records; nothing here is a guess.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, addressee: { type: 'string' } }, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run',
    description: 'One run of the person\'s, by runRef: the ask, the plan, every step\'s outcome, the receipts (with the transaction when a step left one) and where its provenance is. Use it after they finished a parked run at their Home, or to answer "what did you do for me". Args: run (the runRef), addressee (the organization the run was asked at, when it was — the same addressee as the ask).',
    inputSchema: { type: 'object', properties: { run: { type: 'string' }, addressee: { type: 'string' } }, required: ['run'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'grant_link',
    description: 'For a run that came back `authority_required`: the page on the person\'s Home where THEY sign the mandate (the assistant never signs). Args: run (the runRef). After they have signed, call `ask` with `run` to finish it.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] },
    annotations: { readOnlyHint: true },
  },
] as const;

export interface ToolEnv { A2A_ORIGIN: string; HOME_ORIGIN: string }
export interface Person { sub: string; identity: PersonIdentity; agentName?: string }

/** The wire itself was refused by her agent: revoked or expired at her Home. The server turns this into a 401 with the
 *  resource metadata, so a conformant host re-runs authorization by itself; the words are for a host that shows them. */
export function wireRefused(error: string): Record<string, unknown> {
  return { error: `the person's agent refused this connection's standing: ${error} — it was revoked or has expired at their Home; they must authorize this connection again`, reauthorize: true };
}
export const needsReauthorization = (out: Record<string, unknown>): boolean => out.reauthorize === true;

function summarize(reply: Record<string, unknown>): Record<string, unknown> {
  const { kind, text, error, runRef, prompt, requirement, delegator, summary, capability, parties, receipts, evidence, resumeToken, routed } = reply as Record<string, unknown>;
  return { kind, ...(text ? { text } : {}), ...(summary ? { summary } : {}), ...(error ? { error } : {}), ...(runRef ? { runRef } : {}), ...(prompt ? { prompt } : {}), ...(resumeToken ? { resumeToken } : {}), ...(Array.isArray(routed) && routed.length ? { routed } : {}), ...(requirement ? { requirement } : {}), ...(delegator ? { delegator } : {}), ...(capability ? { capability } : {}), ...(parties ? { parties } : {}), ...(receipts ? { receipts } : {}), ...(evidence ? { evidence } : {}) };
}

/** WHERE the ask (or the read of a run) goes: her own agent, or a ROOM BY NAME (missio-nexus.org) — the registry says which
 *  agent that is; her standing there is derived by THAT agent from its own records. The name resolves, it never admits. */
async function addresseeOf(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<{ addressee: string } | { error: string }> {
  const named = typeof args.addressee === 'string' && args.addressee.trim() ? args.addressee.trim() : person.identity.agent;
  if (/^0x[0-9a-fA-F]{40}$/.test(named)) return { addressee: named.toLowerCase() };
  const info = (await fetchImpl(`${env.HOME_ORIGIN}/connect/name-info?name=${encodeURIComponent(named.toLowerCase())}`).then((r) => r.json()).catch(() => null)) as { exists?: boolean; agent?: string } | null;
  if (!info?.exists || !info.agent) return { error: `no agent is registered as “${named}” — name the organization as its registry name (missio-nexus.org) or its address` };
  return { addressee: info.agent.toLowerCase() };
}

export async function askTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const message = String(args.message ?? '').trim();
  const run = typeof args.run === 'string' ? args.run.trim() : '';
  if (!message && !run) return { error: 'say what to ask (message), or name a run to continue (run)' };
  // The addressee: their own agent unless they named an organization (resolved by the agent's own resolver, by name).
  const where = await addresseeOf(env, person, args, fetchImpl);
  if ('error' in where) return where;
  const addressee = where.addressee;
  // A fresh ask may ADOPT a run reference the caller minted (the streaming path tails its progress by it).
  const adopt = !run && typeof args._runRef === 'string' ? args._runRef : '';
  const out = await askAsPerson(person.identity, env.A2A_ORIGIN, {
    addressee, ...(message ? { message } : {}), ...(run ? { runRef: run } : adopt ? { runRef: adopt } : {}),
    ...(Array.isArray(args.supplied) ? { supplied: args.supplied } : {}),
    ...(args.plan && typeof args.plan === 'object' ? { plan: args.plan } : {}),
  }, fetchImpl);
  if (!out.ok) {
    if (isDelegationRefusal(out.status, out.error)) return wireRefused(out.error);
    // Spec 397 W3 — a run named alone that is no longer waiting was FINISHED (at their Home, by them): the record is the answer.
    if (!message && run && out.status === 404) {
      const rec = await recordOf(env, person, run, fetchImpl, addressee);
      if (rec) return { kind: 'done', ...rec, note: 'This run is no longer waiting — it was finished (at their Home, by them). What follows is its record.' };
    }
    return { error: out.error, status: out.status };
  }
  const reply = summarize(out.reply);
  const hint = reply.kind === 'authority_required'
    ? `The person's agent needs THEIR authority for this: call grant_link with run=${String(out.runRef ?? reply.runRef ?? '')} and tell them to sign there; then ask again with that run.`
    : reply.kind === 'prompt' ? 'Their agent asked a question: answer it with ask { run, supplied: [{ stepRef, data }] } using the prompt\'s stepRef and field names — or ask the person.'
    : undefined;
  return { ...reply, runRef: out.runRef ?? reply.runRef, ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}), ...(hint ? { next: hint } : {}), asked_as: person.agentName ?? person.identity.agent };
}

export function grantLinkTool(env: ToolEnv, person: Person, args: Record<string, unknown>): Record<string, unknown> {
  const run = String(args.run ?? '').trim();
  if (!/^run-[0-9a-f-]+$/i.test(run)) return { error: 'run must be a runRef (run-…)' };
  // The Home's own origin: the page routes by the person's session, whichever host they signed in at.
  return { url: `${env.HOME_ORIGIN}/you?run=${encodeURIComponent(run)}`, note: 'Only the person can sign here, with the credential that custodies their agent. Once they have, call ask with this run to finish it.' };
}

/** Spec 397 W2 — discovery THROUGH the person's agent: one supplied step, no planner; the registry's answer as their run's. */
export async function discoverTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const intent = String(args.intent ?? '').trim();
  if (!intent) return { error: 'say what the person wants (intent)' };
  const stepArgs = { intent, ...(typeof args.capability === 'string' && args.capability.trim() ? { capability: args.capability.trim() } : {}), ...(typeof args.language === 'string' && args.language.trim() ? { language: args.language.trim() } : {}), ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}) };
  const out = await askAsPerson(person.identity, env.A2A_ORIGIN, { addressee: person.identity.agent, message: `find agents: ${intent}`, plan: { steps: [{ toolId: 'discovery.agents.find', args: stepArgs }] } }, fetchImpl);
  if (!out.ok) return isDelegationRefusal(out.status, out.error) ? wireRefused(out.error) : { error: out.error, status: out.status };
  const results = (out.reply.results as Array<{ toolId: string; result: Record<string, unknown> }> | undefined) ?? [];
  const found = results.find((r) => r.toolId === 'discovery.agents.find')?.result ?? {};
  const replyError = typeof out.reply.error === 'string' ? out.reply.error : undefined;
  return { kind: out.reply.kind, ...(found.refused ? { refused: found.refused } : replyError ? { refused: replyError } : {}), agents: found.agents ?? [], referral: found.referral, ...(found.capabilityResolution ? { capabilityResolution: found.capabilityResolution } : {}), text: out.reply.text, runRef: out.runRef, ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}), asked_as: person.agentName ?? person.identity.agent, note: found.note };
}

/** Spec 397 W2 — engagement THROUGH the person's agent: their agent sends the message as them; the reply is the other agent's. */
export async function engageTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const agent = String(args.agent ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!agent || !message) return { error: 'agent and message are required' };
  const out = await askAsPerson(person.identity, env.A2A_ORIGIN, { addressee: person.identity.agent, message: `ask ${agent}: ${message}`, plan: { steps: [{ toolId: 'engagement.agent.invoke', args: { agent, message } }] }, ...(typeof args._runRef === 'string' ? { runRef: args._runRef } : {}) }, fetchImpl);
  if (!out.ok) return isDelegationRefusal(out.status, out.error) ? wireRefused(out.error) : { error: out.error, status: out.status };
  const reply = summarize(out.reply);
  const results = (out.reply.results as Array<{ toolId: string; result: Record<string, unknown> }> | undefined) ?? [];
  const hop = results.find((r) => r.toolId === 'engagement.agent.invoke')?.result ?? {};
  return { ...reply, ...(hop.refused ? { refused: hop.refused } : {}), ...(hop.via ? { via: hop.via } : {}), ...(hop.said ? { said: hop.said } : hop.text ? { said: hop.text } : {}), ...(hop.source ? { source: hop.source } : {}), ...(hop.drewOn ? { drewOn: hop.drewOn } : {}), runRef: out.runRef ?? reply.runRef, ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}), asked_as: person.agentName ?? person.identity.agent };
}

/** Spec 397 W3 — a run's RECORD from her agent, shaped for a host: no mandates, no keyring, the facts and the receipts. */
async function recordOf(env: ToolEnv, person: Person, runRef: string, fetchImpl: typeof fetch, addressee = person.identity.agent): Promise<Record<string, unknown> | null> {
  const r = await callAsPerson(person.identity, env.A2A_ORIGIN, '/harness/records', { addressee, runRef }, fetchImpl);
  if (!r.ok) return null;
  const rec = r.body.record as { runRef?: string; at?: number; intent?: { goal?: string }; outcome?: string; plan?: { steps?: Array<{ toolId: string; args?: unknown }> }; steps?: Array<{ stepRef?: string; toolId: string; ok?: boolean; result?: unknown }>; receipts?: Array<{ stepRef: string; toolId: string; status: string; risk?: string; binding?: { mandateRef?: string }; outputDigest?: string }>; export?: unknown } | undefined;
  if (!rec) return null;
  const tx = (v: unknown): string | undefined => { const o = v && typeof v === 'object' ? (v as { txHash?: unknown; facts?: { txHash?: unknown } }) : null; const t = o?.txHash ?? o?.facts?.txHash; return typeof t === 'string' ? t : undefined; };
  return {
    runRef: rec.runRef ?? runRef, at: rec.at, asked: rec.intent?.goal, outcome: rec.outcome,
    steps: (rec.steps ?? []).map((s) => ({ stepRef: s.stepRef, toolId: s.toolId, ok: s.ok, ...(tx(s.result) ? { txHash: tx(s.result) } : {}), summary: JSON.stringify(s.result ?? null).slice(0, 400) })),
    receipts: (rec.receipts ?? []).map((rc) => ({ stepRef: rc.stepRef, toolId: rc.toolId, status: rc.status, risk: rc.risk, ...(rc.binding?.mandateRef ? { mandateRef: rc.binding.mandateRef } : {}) })),
    hasProvenance: { agent: addressee, recordType: `run.provenance:${rec.runRef ?? runRef}`, route: '/harness/provenance' },
    asked_as: person.agentName ?? person.identity.agent,
  };
}

export async function runTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const run = String(args.run ?? '').trim();
  if (!run) return { error: 'run (a runRef) is required' };
  const where = await addresseeOf(env, person, args, fetchImpl);
  if ('error' in where) return where;
  const rec = await recordOf(env, person, run, fetchImpl, where.addressee);
  if (rec) return rec;
  // Still waiting: the checkpoint says on what.
  const waiting = await callAsPerson(person.identity, env.A2A_ORIGIN, '/harness/runs', { addressee: where.addressee }, fetchImpl);
  if (!waiting.ok && isDelegationRefusal(waiting.status, waiting.error)) return wireRefused(waiting.error);
  const row = waiting.ok ? ((waiting.body.runs as Array<{ runRef: string; message?: string; awaiting?: unknown; updatedAt?: number }> | undefined) ?? []).find((x) => x.runRef === run) : undefined;
  if (row) return { runRef: run, asked: row.message, waiting: row.awaiting ?? null, updatedAt: row.updatedAt, note: 'This run is parked on their agent — see `waiting`; a signature is given at their Home (grant_link), an answer with ask { run, supplied }.' };
  return { error: `no run ${run} of theirs — their agent holds no record and nothing is waiting under that reference` };
}

export async function myRunsTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const limit = Number.isInteger(args.limit) && (args.limit as number) > 0 ? Math.min(args.limit as number, 50) : 10;
  const where = await addresseeOf(env, person, args, fetchImpl);
  if ('error' in where) return where;
  const [records, waiting] = await Promise.all([
    callAsPerson(person.identity, env.A2A_ORIGIN, '/harness/records', { addressee: where.addressee }, fetchImpl),
    callAsPerson(person.identity, env.A2A_ORIGIN, '/harness/runs', { addressee: where.addressee }, fetchImpl),
  ]);
  if (!records.ok) return isDelegationRefusal(records.status, records.error) ? wireRefused(records.error) : { error: records.error, status: records.status };
  const rows = ((records.body.records as Array<{ runRef: string; at?: number; intent?: { goal?: string }; outcome?: string; receipts?: unknown[] }> | undefined) ?? [])
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit)
    .map((r) => ({ runRef: r.runRef, at: r.at, asked: r.intent?.goal, outcome: r.outcome, receipts: (r.receipts ?? []).length }));
  const parked = waiting.ok ? ((waiting.body.runs as Array<{ runRef: string; message?: string; awaiting?: unknown; updatedAt?: number }> | undefined) ?? []).map((x) => ({ runRef: x.runRef, asked: x.message, waiting: x.awaiting ?? null, updatedAt: x.updatedAt })) : [];
  return { runs: rows, waitingOnThem: parked, retention: records.body.retention ?? null, asked_as: person.agentName ?? person.identity.agent };
}

/** Spec 397 — inspect THROUGH the person's agent: one supplied step; the card's public facts as her run's observation. */
export async function inspectTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const agent = String(args.agent ?? '').trim();
  if (!agent) return { error: 'agent (a registry name) is required' };
  const out = await askAsPerson(person.identity, env.A2A_ORIGIN, { addressee: person.identity.agent, message: `inspect ${agent}`, plan: { steps: [{ toolId: 'discovery.agent.inspect', args: { agent } }] } }, fetchImpl);
  if (!out.ok) return isDelegationRefusal(out.status, out.error) ? wireRefused(out.error) : { error: out.error, status: out.status };
  const results = (out.reply.results as Array<{ toolId: string; result: Record<string, unknown> }> | undefined) ?? [];
  const found = results.find((r) => r.toolId === 'discovery.agent.inspect')?.result ?? {};
  const replyError = typeof out.reply.error === 'string' ? out.reply.error : undefined;
  return { kind: out.reply.kind, ...(found.refused ? { refused: found.refused } : replyError ? { refused: replyError } : {}), ...found, runRef: out.runRef, ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}), asked_as: person.agentName ?? person.identity.agent };
}
