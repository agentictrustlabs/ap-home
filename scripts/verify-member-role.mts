/**
 * Spec 427, LIVE: A STEWARD SETS A MEMBER'S ROLE THROUGH THE ASK, and the member's own agent reads it back.
 *
 * `organization.member.role.set` is the ORGANIZATION's act under its own mandate. A supplied plan (the button's
 * deterministic entry) parks `authority_required`; the steward approves the mandate digest in ONE organization userOp
 * (one custodian signature); the resumed run writes the role on the member's membership record, in-Worker, at the
 * organization's own object. Then `person.roles.list` — asked of the MEMBER's own agent, as the member — returns it.
 *
 *   npx tsx scripts/verify-member-role.mts [steward=nathan] [member=nathan] [org=<sa>] [--role coordinator|member] [--outsider bob]
 *
 * THE GATES: (1) without a mandate the act is not done; (2) the whole act costs exactly ONE signature; (3) the role
 * the member's agent reports is the one that was set, with the offer's skill pack; (4) somebody who does NOT steward
 * the organization, asking the same act, is never offered a way to grant it (`canGrant` false).
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = {
  delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const STEWARD = args[0] ?? 'nathan';
const MEMBER = args[1] ?? 'nathan';
const OUTSIDER = flag('outsider') ?? 'bob';
const ORG = (args[2] ?? '0x8e32c713f44c7747d97a589522806a8e1dd810fb').toLowerCase() as Address; // Northern Colorado Field — Game Night (organization)
const ROLE = flag('role') ?? 'coordinator';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250) }; } };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
const si = await signin(STEWARD);
const mi = await signin(MEMBER);
const oi = await signin(OUTSIDER);
const member = String(mi.agent).toLowerCase() as Address;
let signCount = 0;
const sign = async (digest: Hex): Promise<Hex> => {
  signCount++;
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 150)}`);
  return b.signature;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const OFFERS: Record<string, unknown> = {
  coordinator: { type: 'ap.org.role-offer.v1', roleDefinitionId: `roledef:${ORG}:coordinator@1`, name: 'Coordinator', description: 'Keeps the picture across the teams: reads what each records, reconciles phases and reports progress.', scope: 'organization', accessRole: 'progress-steward', skillPackRefs: [{ context: 'field-operations', archetype: 'role-coordinator' }] },
  member: 'member',
};
const role = OFFERS[ROLE];
if (role === undefined) throw new Error(`--role is one of ${Object.keys(OFFERS).join(' | ')}`);
const plan = { steps: [{ toolId: 'organization.member.role.set', args: { org: ORG, member, role } }] };
const message = `set ${MEMBER}'s role to ${ROLE}`;

// 0 — somebody who does not steward the organization is told what the act needs and is never offered a way to grant it.
const r0 = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: oi.homeSession, addressee: ORG, message, rowsOnly: true, plan }) }));
const rep0 = r0.reply;
if (rep0?.kind === 'done' || rep0?.kind === 'answer') throw new Error(`${OUTSIDER} set a role with no mandate: ${JSON.stringify(r0).slice(0, 300)}`);
if (rep0?.kind === 'authority_required' && rep0.standing?.canGrant) throw new Error(`${OUTSIDER} was told they can grant the organization's mandate: ${JSON.stringify(rep0.standing)}`);
console.log(`${OUTSIDER} asking ✓  ${rep0?.kind}${rep0?.standing ? ` (standing: ${rep0.standing.relation}, canGrant ${rep0.standing.canGrant})` : ''}${rep0?.error ? ` — ${String(rep0.error).slice(0, 120)}` : ''}`);

// 1 — the steward's deterministic entry, no mandate: the act parks.
const r1 = await post('/harness/ask', { session: si.homeSession, addressee: ORG, message, rowsOnly: true, plan });
const rep = r1.reply;
if (rep?.kind !== 'authority_required') throw new Error(`expected authority_required: ${JSON.stringify(r1).slice(0, 400)}`);
if (String(rep.delegator).toLowerCase() !== ORG) throw new Error(`the mandate must be the ORGANIZATION's: delegator ${rep.delegator}`);
console.log(`authority_required ✓  the organization's mandate for ${rep.capability} (you: ${rep.standing?.relation}, canGrant ${rep.standing?.canGrant})`);

// 2 — the mandate, approved on chain AS THE ORGANIZATION in one userOp = ONE signature.
const req = rep.requirement as MandateRequirementV1;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
const bytes = crypto.getRandomValues(new Uint8Array(16));
let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const mandateDigest = hashDelegation(mandate, CHAIN, DM);
const a = await post('/harness/authorize', { session: si.homeSession, delegator: rep.delegator, digests: [mandateDigest, ...((rep.alsoApprove ?? []) as Array<{ digest: Hex }>).map((x) => x.digest)] });
if (a.ok !== true) throw new Error(`authorize build failed: ${JSON.stringify(a).slice(0, 300)}`);
const sig = await sign(a.userOpHash as Hex);
const b2 = await post('/harness/authorize', { session: si.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: sig });
if (b2.ok !== true) throw new Error(`authorize submit failed: ${JSON.stringify(b2).slice(0, 300)}`);
console.log(`mandate approved on chain ✓ (tx ${String(b2.txHash).slice(0, 18)}…)`);
mandate.signature = '0x03';

// 3 — resumed: the organization's own object writes the role.
const r2 = await post('/harness/ask', { session: si.homeSession, addressee: ORG, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
const rep2 = r2.reply;
if (rep2?.kind !== 'done' && rep2?.kind !== 'answer') throw new Error(`expected done: ${JSON.stringify(r2).slice(0, 600)}`);
const res = (rep2.result ?? rep2.results?.find((x: { toolId: string }) => x.toolId === 'organization.member.role.set')?.result) as { set?: boolean; role?: string; roleName?: string; previous?: string; refused?: string } | undefined;
if (!res?.set) throw new Error(`the role was not set: ${JSON.stringify(rep2).slice(0, 500)}`);
console.log(`role set ✓  ${res.previous} → ${res.role}${res.roleName ? ` (${res.roleName})` : ''}`);

// 4 — the MEMBER's own agent, asked as the member, reports it — the read the Playbook page reconciles from.
const r3 = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: mi.homeSession, addressee: member, message: 'what roles do i hold', background: true, rowsOnly: true, plan: { steps: [{ toolId: 'person.roles.list', args: { org: ORG } }] } }) }));
const held = (r3.reply?.results?.find((x: { toolId: string }) => x.toolId === 'person.roles.list')?.result as { roles?: Array<{ org: string; assignedRole: string; roleName?: string; skillPackRefs?: unknown[] }> } | undefined)?.roles?.find((x) => x.org === ORG);
if (!held) throw new Error(`${MEMBER}'s agent did not report a membership at the organization: ${JSON.stringify(r3).slice(0, 500)}`);
const want = ROLE === 'member' ? 'member' : ROLE;
if (held.assignedRole !== want) throw new Error(`${MEMBER}'s agent reports ${held.assignedRole}, expected ${want}`);
console.log(`${MEMBER}'s own agent reports ✓  ${held.assignedRole}${held.roleName ? ` (${held.roleName})` : ''} · packs ${JSON.stringify(held.skillPackRefs ?? [])}`);

console.log(`\nSIGNATURES USED: ${signCount}`);
if (signCount !== 1) throw new Error(`the whole act must cost exactly ONE signature; it cost ${signCount}`);
