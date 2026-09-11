/**
 * Spec 361 I4, LIVE: the ONE-PROMPT invitation. Alice invites nathan to rich-big-thompson-team through
 * the harness with a SUPPLIED PLAN (the button's deterministic entry). The run reports
 * authority_required carrying `alsoApprove` (the grant digest); ONE org userOp approveHashes the
 * mandate digest AND the grant digest; ONE custodian signature signs that userOp. The re-run finds the
 * grant approved ON CHAIN and completes without a signature prompt.
 *
 * THE GATE IS THE SIGNATURE COUNT: every persona-sign call is counted, and the whole governed act must
 * cost exactly ONE (the userOp). It also SEEDS the team's roster — the grant store writes the
 * org.invite record this team's empty vault was missing, so "who are the members" starts answering.
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
const TEAM = '0xfC1C328c26505d1AEAb1EAd4a46b3F74981F07a4' as Address;
const INVITEE = (process.argv[2] ?? '0x1dba4a27c53d7babda99513080223fb3bfc4bad1') as Address; // nathan

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250) }; } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
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

const intent = { goal: `invite ${INVITEE} to ${TEAM}`, context: { org: TEAM, invitee: INVITEE } };
const plan = { steps: [{ toolId: 'organization.membership.invite', args: { org: TEAM, invitee: INVITEE } }] };

// 1 — the deterministic entry, no mandate: authority_required names BOTH digests.
// The BUTTON's entry: a supplied plan through the conversational boundary — no model re-derives a click.
const r1 = await post('/harness/ask', { session: si.homeSession, addressee: TEAM, message: intent.goal, plan });
const rep = r1.reply;
if (rep?.kind !== 'authority_required') throw new Error(`expected authority_required: ${JSON.stringify(r1).slice(0, 400)}`);
if (!rep.alsoApprove?.length) throw new Error(`authority_required carries no alsoApprove: ${JSON.stringify(rep).slice(0, 400)}`);
console.log(`authority_required ✓  mandate for ${rep.capability}, alsoApprove: ${rep.alsoApprove[0].purpose}`);

// 2 — build the 0x03 mandate + approve BOTH digests in ONE org userOp = ONE signature.
const req = rep.requirement as MandateRequirementV1;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
const bytes = crypto.getRandomValues(new Uint8Array(16));
let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const mandateDigest = hashDelegation(mandate, CHAIN, DM);
const a = await post('/harness/authorize', { session: si.homeSession, delegator: rep.delegator, digests: [mandateDigest, ...rep.alsoApprove.map((x: { digest: Hex }) => x.digest)] });
if (a.ok !== true) throw new Error(`authorize build failed: ${JSON.stringify(a).slice(0, 300)}`);
const sig = await sign(a.userOpHash as Hex);                       // ← THE prompt
const b2 = await post('/harness/authorize', { session: si.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: sig });
if (b2.ok !== true) throw new Error(`authorize submit failed: ${JSON.stringify(b2).slice(0, 300)}`);
console.log(`approved both digests on chain ✓ (tx ${String(b2.txHash).slice(0, 18)}…)`);
mandate.signature = '0x03';

// 3 — re-run: the invoker finds the grant APPROVED and completes with no signature prompt.
const r2 = await post('/harness/ask', { session: si.homeSession, addressee: TEAM, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
const rep2 = r2.reply;
if (rep2?.kind === 'prompt') throw new Error(`the run still prompted (${rep2.prompt?.kind}) — the one-prompt path did not hold: ${JSON.stringify(rep2.prompt).slice(0, 200)}`);
if (rep2?.kind !== 'done' && rep2?.kind !== 'answer') throw new Error(`expected done: ${JSON.stringify(r2).slice(0, 500)}`);
console.log(`invitation issued ✓ (${rep2.kind})`);

// 4 — THE SURFACE'S HALF: store the invitation in the org's vault (the same call the flyout's
// ask-record hook makes on done). The a2a returned the signed grant; the steward-gated store is what
// turns it into the org.invite record the roster reads.
const inv = rep2.result as { org?: string; invitee?: string; memberAccessDelegation?: unknown; invited?: boolean };
if (inv?.invited && inv.memberAccessDelegation) {
  const stored = await j(await fetch(`${HOME}/connect/org-invite/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` },
    body: JSON.stringify({ org: String(inv.org).toLowerCase(), agent: String(inv.invitee).toLowerCase(), memberAccessDelegation: inv.memberAccessDelegation }),
  }));
  console.log(`invitation recorded in the org's vault: ${stored.ok === true ? '✓' : JSON.stringify(stored).slice(0, 150)}`);
} else {
  console.log(`result carried no recordable invitation: ${JSON.stringify(inv).slice(0, 200)}`);
}
console.log(`\nSIGNATURES USED: ${signCount}`);
if (signCount !== 1) throw new Error(`the whole act must cost exactly ONE signature; it cost ${signCount}`);
