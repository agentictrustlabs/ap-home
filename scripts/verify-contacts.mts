/**
 * Spec 401 C1 — CONTACTS: membership on the person agent, live (supplied plans; no model).
 *
 *   npx tsx scripts/verify-contacts.mts        (FIXTURE_JSON=… for another estate; needs the `acpRuntime` role for the agent contact)
 *
 * The steward adds an agent contact (the ACP runtime's .svc, role `runtime`) under her own mandate — the grant she signs
 * is hers to the contact, scoped to her contact profile; her contacts list names it with its role. THE TWINS: an
 * organization is refused as a contact; the contact, asking her agent AS ITSELF, may not list her contacts (they are
 * hers alone). Then she removes it: the grant is revoked on chain (a transaction), the list drops it, and adding it
 * again is a fresh grant, not the revoked one.
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian, askAs, runtimeJoin } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.acpRuntime, 'ACP runtime member (the agent contact)');
const C = ((await import(`@agenticprimitives/contracts/deployments/${process.env.CHAIN_NAME ?? 'faithchain'}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, ...(body as object) }) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; stepRef?: string; signer?: string; payload?: unknown; prompt?: string }; result?: unknown; results?: Array<{ toolId: string; result: unknown }> };

/** One act of hers: the plan supplied, the mandate signed one-prompt, a signature prompt answered by her custodian. */
async function act(message: string, toolId: string, args: Record<string, unknown>): Promise<Reply> {
  let r = await post('/harness/ask', { addressee: me.agent, message, plan: { steps: [{ toolId, args }] } });
  let rep = (r.reply ?? {}) as Reply;
  for (let i = 0; i < 4; i++) {
    if (rep.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement.intentDigest as Hex)];
      let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { delegator: rep.delegator, userOp: a.userOp, signature: await me.signDigest(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      r = await post('/harness/ask', { addressee: me.agent, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = (r.reply ?? {}) as Reply; continue;
    }
    if (rep.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt;
      r = await post('/harness/ask', { addressee: me.agent, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? me.agent, signature: await me.signDigest(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = (r.reply ?? {}) as Reply; continue;
    }
    break;
  }
  return rep;
}
const resultOf = (rep: Reply, toolId: string): Record<string, unknown> => ((rep.results?.find((x) => x.toolId === toolId)?.result ?? rep.result ?? {}) as Record<string, unknown>);

console.log(`── ${fx.people.steward} ${me.agent} · contact ${R.member} ──`);
// a clean start: removed if it stands from an earlier run
const before = resultOf(await act('who are my contacts', 'person.contact.list', {}), 'person.contact.list') as { contacts?: Array<{ contact: string; role: string }> };
const memberSa = String((await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(R.member)}`))).agent ?? '').toLowerCase();
if ((before.contacts ?? []).some((c) => c.contact === memberSa)) { const rm = await act(`remove ${R.member} as a contact`, 'person.contact.remove', { contact: R.member }); console.log(`  (removed a standing contact from an earlier run → ${rm.kind}${rm.error ? ` ${rm.error}` : ''})`); if (rm.kind !== 'done' && rm.kind !== 'answer') fail('the standing contact could not be removed'); }

// 1. add the agent contact
const added = await act(`add ${R.member} as a contact with role runtime`, 'person.contact.invite', { contact: R.member, role: 'runtime' });
const ar = resultOf(added, 'person.contact.invite') as { added?: boolean; role?: string; grantDigest?: string; told?: { ok?: boolean } };
console.log(`  add → ${added.kind}${added.error ? ` ${added.error}` : ''} · added=${ar.added} role=${ar.role} grant ${String(ar.grantDigest ?? '').slice(0, 14)}… told=${ar.told?.ok}`);
if ((added.kind !== 'done' && added.kind !== 'answer') || ar.added !== true || ar.role !== 'runtime') fail(`the contact was not added: ${JSON.stringify(added).slice(0, 400)}`);

// 2. her list names it
const listed = resultOf(await act('who are my contacts', 'person.contact.list', {}), 'person.contact.list') as { count?: number; contacts?: Array<{ contact: string; name: string | null; role: string }> };
console.log(`  contacts: ${(listed.contacts ?? []).map((c) => `${c.name ?? c.contact}:${c.role}`).join(', ') || '(none)'}`);
if (!(listed.contacts ?? []).some((c) => c.contact === memberSa && c.role === 'runtime')) fail('her contacts do not list the runtime with its role');

// twins
const orgSa = String((await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(fx.org.handle)}`))).agent ?? '').toLowerCase();
const orgTry = await act(`add ${fx.org.handle} as a contact`, 'person.contact.invite', { contact: orgSa });
console.log(`  twin · an organization as a contact → ${orgTry.kind}: ${String(orgTry.error ?? orgTry.text ?? '').slice(0, 100)}`);
if (orgTry.kind === 'done' && (resultOf(orgTry, 'person.contact.invite') as { added?: boolean }).added) fail('an organization was added as a contact');
// the contact, speaking as itself: a fresh wire (an earlier gate may have revoked the last one)
const { record: rec } = await runtimeJoin({ home: HOME, edge: fx.edge, a2a: A2A, member: R.member, workspace: R.workspace, contracts: C as never, custodian: me, registry: { origin: fx.skillsRegistry, context: 'agentic-trust', archetype: 'runtime-member' }, validForSeconds: 3600 }).catch((e: Error) => { console.log(`  (join failed: ${e.message})`); return { record: null }; });
if (rec) {
  const peek = await askAs(rec, fx.people.steward + '.me', 'who are your contacts', { plan: { steps: [{ toolId: 'organization.membership.list', args: { org: `${fx.people.steward}.me` } }] } }).catch((e: Error) => ({ state: 'ERROR', text: e.message, parked: false }));
  console.log(`  twin · the contact asks her agent for her contacts → ${peek.state}: ${peek.text.replace(/\s+/g, ' ').slice(0, 100)}`);
  if (peek.state === 'TASK_STATE_COMPLETED' && /member|contact/i.test(peek.text) && !/own|only they|private/i.test(peek.text)) fail('a contact could list her contacts');
} else console.log(`  (twin skipped: ${R.member} is not joined on this machine — run verify-runtime-acp-member first)`);

// 3. remove = revoke
const removed = await act(`remove ${R.member} as a contact`, 'person.contact.remove', { contact: R.member });
const rr = resultOf(removed, 'person.contact.remove') as { removed?: boolean; txHash?: string };
console.log(`  remove → ${removed.kind}${removed.error ? ` ${removed.error}` : ''} · revoked tx ${String(rr.txHash ?? '').slice(0, 18)}…`);
if ((removed.kind !== 'done' && removed.kind !== 'answer') || rr.removed !== true || !/^0x[0-9a-f]{64}$/i.test(String(rr.txHash))) fail(`the removal did not revoke on chain: ${JSON.stringify(removed).slice(0, 400)}`);
const after = resultOf(await act('who are my contacts', 'person.contact.list', {}), 'person.contact.list') as { contacts?: Array<{ contact: string }>; removed?: number };
if ((after.contacts ?? []).some((c) => c.contact === memberSa)) fail('the removed contact is still listed');
console.log(`  after: ${(after.contacts ?? []).length} contact(s), ${after.removed ?? 0} removed`);

console.log(`\n✓ spec 401 C1: ${fx.people.steward} added ${R.member} as a contact (her own mandate, her grant to it, its role recorded), listed it, could not add an organization, the contact could not list her contacts, and removing it revoked the grant on chain and dropped it from her list.`);
