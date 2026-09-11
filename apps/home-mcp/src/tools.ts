// THE TOOL SURFACE (spec 397 §5, W1): the person's own agent, reached as them. Fixed — never a per-agent tool, never
// a vault read, never a mandate. What comes back is their agent's reply with its evidence; an act that needs their
// authority is said as such, with the page on their Home where they sign.
import { askAsPerson, type PersonIdentity } from './a2a.js';

export const TOOLS = [
  {
    name: 'ask',
    description: 'Put the person\'s words to THEIR OWN agent, as them — their records, their organizations, their playbook. Args: message (their ask, in their words); addressee (optional: an organization they stand in, by name, to ask there instead of at home); run (optional: the runRef of a run to continue — a prompt answered with `supplied`, or a run they granted authority for at their Home). Replies carry `kind`: answer | done | prompt | authority_required | refused, the run reference, and where its provenance is.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, addressee: { type: 'string', description: 'an organization name (missio-nexus.org) to ask there; omit for their own agent' }, run: { type: 'string', description: 'a runRef to continue' }, supplied: { type: 'array', items: { type: 'object' }, description: 'answers to a prompt: [{ stepRef, data: { field: value } }]' } }, required: [] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'grant_link',
    description: 'For a run that came back `authority_required`: the page on the person\'s Home where THEY sign the mandate (the assistant never signs). Args: run (the runRef). After they have signed, call `ask` with `run` to finish it.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] },
    annotations: { readOnlyHint: true },
  },
] as const;

export interface ToolEnv { A2A_ORIGIN: string; HOME_ORIGIN: string }
export interface Person { identity: PersonIdentity; agentName?: string }

function summarize(reply: Record<string, unknown>): Record<string, unknown> {
  const { kind, text, error, runRef, prompt, requirement, delegator, summary, capability, parties, receipts, evidence } = reply as Record<string, unknown>;
  return { kind, ...(text ? { text } : {}), ...(summary ? { summary } : {}), ...(error ? { error } : {}), ...(runRef ? { runRef } : {}), ...(prompt ? { prompt } : {}), ...(requirement ? { requirement } : {}), ...(delegator ? { delegator } : {}), ...(capability ? { capability } : {}), ...(parties ? { parties } : {}), ...(receipts ? { receipts } : {}), ...(evidence ? { evidence } : {}) };
}

export async function askTool(env: ToolEnv, person: Person, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const message = String(args.message ?? '').trim();
  const run = typeof args.run === 'string' ? args.run.trim() : '';
  if (!message && !run) return { error: 'say what to ask (message), or name a run to continue (run)' };
  // The addressee: their own agent unless they named an organization (resolved by the agent's own resolver, by name).
  const addressee = typeof args.addressee === 'string' && args.addressee.trim() ? args.addressee.trim() : person.identity.agent;
  const out = await askAsPerson(person.identity, env.A2A_ORIGIN, {
    addressee, ...(message ? { message } : {}), ...(run ? { runRef: run } : {}),
    ...(Array.isArray(args.supplied) ? { supplied: args.supplied } : {}),
    ...(args.plan && typeof args.plan === 'object' ? { plan: args.plan } : {}),
  }, fetchImpl);
  if (!out.ok) return { error: out.error, status: out.status };
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
  const label = (person.agentName ?? '').replace(/\.me$/, '');
  const home = label ? env.HOME_ORIGIN.replace('://www.', `://${label}.`) : env.HOME_ORIGIN;
  return { url: `${home}/you?run=${encodeURIComponent(run)}`, note: 'Only the person can sign here, with the credential that custodies their agent. Once they have, call ask with this run to finish it.' };
}
