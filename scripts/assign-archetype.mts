/**
 * Assign a catalog archetype to a SCRIPT-CHARTERED agent — the headless twin of the Home's K3 ceremony
 * (spec 354 §4; `BehaviourPlaybook.tsx` is the one a steward clicks).
 *
 *   npx tsx scripts/assign-archetype.mts <address|name> <archetype-key> --by <steward handle>
 *
 * An assignment GRANTS NOTHING (spec 354 §1). It writes one `archetype.assignment` record into the
 * agent's own vault saying which definition it runs under, pinned to that definition's digest; run
 * admission re-derives the digest and falls back to a bare harness if it does not match. What changes is
 * what the agent knows how to do — the mandate still decides what it may do.
 *
 * Steward-gated, like the ceremony: the write goes through `/connect/channels`
 * (`archetypeAssignmentPut`), which resolves the stewardship wire. This script holds no custody key; the
 * steward's Home session is the only authority here.
 */
import { definitionDigest, validateAgentHarnessDefinition } from '@agenticprimitives/capability-claims';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
// WHICH CHAIN'S CONTRACTS THIS WIRE NAMES. The Home's delegation library reads `NEXT_PUBLIC_CHAIN_ID` and
// defaults to Base Sepolia, so a script run with no env minted a stewardship wire whose allowedTargets were
// BASE SEPOLIA's governance registries and whose digest was hashed for 84532. Faithnet's runtime checks
// faithchain's, found neither registry in the targets, and refused every assignment with "only the agent's
// custodian may assign an archetype" — a custody error for what was a chain mismatch, and an hour of looking
// at custodians that were all correct. Set BEFORE the library is imported; the sibling interactions scripts
// carry the same line.
if (/faithnet\.me$/.test(new URL(HOME).host)) process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { ARCHETYPE_CATALOG } = await import('../apps/home/src/lib/archetype-catalog');
const { issueSiteDelegation, toWire } = await import('../apps/home/src/lib/delegation');
const args = process.argv.slice(2);
const target = (args.find((a) => !a.startsWith('--')) ?? '').toLowerCase();
const key = args.filter((a) => !a.startsWith('--'))[1];
const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : undefined;
if (!/^0x[0-9a-f]{40}$/.test(target) || !key || !by) {
  console.error('usage: assign-archetype.mts <0xaddress> <archetype-key> --by <steward handle>');
  console.error(`  archetypes: ${ARCHETYPE_CATALOG.map((a) => a.key).join(', ')}`);
  process.exit(2);
}
const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
const chosen = ARCHETYPE_CATALOG.find((a) => a.key === key);
if (!chosen) throw new Error(`no archetype "${key}" — have ${ARCHETYPE_CATALOG.map((a) => a.key).join(', ')}`);

// The same two refusals the ceremony makes before it writes: a definition this Home cannot validate, and
// one that does not apply to this class, are both refused HERE rather than written and refused at run time.
const check = validateAgentHarnessDefinition(chosen.definition);
if (!check.ok) throw new Error(`${key} is not a valid definition: ${check.errors[0]}`);
const digest = definitionDigest(chosen.definition);

const j = async (r: Response): Promise<Record<string, unknown>> => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-web' }) }));
const token = signin.homeSession as string | undefined;
if (!token) throw new Error(`no session for ${by}: ${JSON.stringify(signin).slice(0, 160)}`);

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, authorization: `Bearer ${token}`, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };

// THE PROOF OF CUSTODY, in the shape this gate recognises. The DO takes a STEWARDSHIP WIRE — agent →
// steward, governance targets, no allowedMethods, no record scope — and nothing else; being the agent's
// custodian on chain is not something it reads from the chain. An agent chartered by a script has no such
// wire, which is why a plain assignment is refused "only the agent's custodian may assign an archetype".
// Minted here, signed by the custodian through the Home, and presented with the write.
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
  return b.signature as Hex;
};
const stewardSa = String(signin.agent ?? '').toLowerCase() as Address;
if (!/^0x[0-9a-f]{40}$/.test(stewardSa)) throw new Error(`demo-signin ${by} returned no agent`);
const stewardship = toWire(await issueSiteDelegation(target as Address, stewardSa, sign as never));

// AND THE LINK THE HOME LOOKS THE WIRE UP BY. `/connect/channels` resolves stewardship from its own
// record (`related:<person>:<agent>`), not from the body — so a wire presented without a link is a wire
// nobody reads. An agent chartered by a script has no link at all; recording one is idempotent and is
// what the charter ceremony does for an agent it creates. The wire is the authority; this is the index.
const linked = await j(await fetch(`${HOME}/connect/related-orgs`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ person: stewardSa, orgAgent: target, orgName: name ?? target, purpose: 'archetype-assignment', requestedBy: '', kind: 'workspace', parent: stewardSa, relationship: 'steward', stewardshipDelegation: stewardship }),
}));
if (linked.ok !== true) console.error(`  note: related-orgs said ${JSON.stringify(linked).slice(0, 160)}`);

const before = await j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: target, stewardship }) }));
const put = await j(await fetch(`${HOME}/connect/channels`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    action: 'archetypeAssignmentPut',
    communityId: target,
    stewardship,
    record: { type: 'ap.archetype-assignment.v1', archetypeId: chosen.definition.archetypeId, archetypeVersion: chosen.definition.archetypeVersion, definitionDigest: digest, definition: chosen.definition },
  }),
}));
const after = await j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: target, stewardship }) }));
const idOf = (o: unknown): string => String((o as { record?: { archetypeId?: string } })?.record?.archetypeId ?? '(none)');
console.log(`${target} by ${by}: ${idOf(before)} → ${put.ok === true ? 'written' : `REFUSED ${JSON.stringify(put).slice(0, 160)}`} → ${idOf(after)} @ ${digest.slice(0, 14)}…`);
if (put.ok !== true) process.exit(1);
