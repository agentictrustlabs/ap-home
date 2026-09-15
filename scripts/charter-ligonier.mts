/**
 * Spec 386 A — CHARTER THE FIXTURE AGENTS in the faithnet estate, the way a person would: alice's own Ask.
 *
 *   npx tsx scripts/charter-ligonier.mts [org-label] [service-label]      (default globalchurch ligonier)
 *
 * 1. `organization.create { parent: alice, label }` → <label>.org, alice its steward (the product's org charter).
 * 2. `service.create { parent: <label>.org, label }` → <label>.svc chartered under the organization (spec 372 S3).
 * Each act waits on a mandate alice signs at home; nothing is minted by a script key. Addresses are written to
 * demo/ligonier.faithnet.json — an operator note, not a persona. Idempotent: names already resolving are kept.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const ORG_LABEL = process.argv[2] ?? 'globalchurch';
const SVC_LABEL = process.argv[3] ?? 'ligonier';
const NOTE = process.env.NOTE ?? 'demo/ligonier.faithnet.json';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const naming = new AgentNamingClient({ rpcUrl: 'https://a2a.faithnet.io/rpc', chainId: CHAIN, registry: '0x60E949D52660A9D4143ecB0fdA56c0457f20aED9', universalResolver: '0xF343054e046A4145ccae499ECB28197394eE0798' });
// The credential that will custody what alice charters — the demo persona's own EOA, the one the Home holds
// for her (what the flyout fills into a `credential` field via `connectedCredential`).
const personaKeys = (() => { try { const env = readFileSync(resolvePath('apps/home/.env.local'), 'utf8'); const m = /^DEMO_PERSONA_KEYS=(.*)$/m.exec(env); return m ? JSON.parse(m[1]!.trim().replace(/^['"]|['"]$/g, '')) as Record<string, { eoaAddress?: string }> : {}; } catch { return {}; } })();
const ALICE_EOA = (personaKeys.alice?.eoaAddress ?? '').toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(ALICE_EOA)) fail('alice\'s custodian EOA is not in apps/home/.env.local (DEMO_PERSONA_KEYS)');
// CUSTODIAN=0x… names another credential to custody what is chartered (spec 387: the gateway agent's own key).
const CUSTODIAN = (process.env.CUSTODIAN ?? ALICE_EOA).toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(CUSTODIAN)) fail('CUSTODIAN must be an EOA address');
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ME = String(alice.agent).toLowerCase() as Address;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; fields?: unknown }; result?: unknown; routed?: unknown[] };

/** One act through alice's agent: the plan supplied, the mandate she signs, the prompts she answers. */
async function act(message: string, toolId: string, args: Record<string, unknown>): Promise<Reply> {
  let r = await post('/harness/ask', { session: alice.homeSession, addressee: ME, message, plan: { steps: [{ toolId, args }] } });
  let rep = r.reply as Reply | undefined;
  console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.delegator ? ` (delegator ${rep.delegator.slice(0, 10)}…)` : ''}`);
  for (let round = 0; round < 6; round++) {
    if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const req = rep.requirement;
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
      let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      console.log(`  alice signed the mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
      r = await post('/harness/ask', { session: alice.homeSession, addressee: ME, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = r.reply as Reply | undefined;
      console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
      const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
      const cred = fields.find((f) => f.type === 'credential');
      if (!cred || fields.length !== 1) fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
      r = await post('/harness/ask', { session: alice.homeSession, addressee: ME, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: { [cred!.name]: { kind: 'eoa', address: CUSTODIAN } } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  custodian supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      // The Home's shape: the digest, the signer the prompt named, the signature, and the PAYLOAD the prompt
      // carried (a genesis userOp) — the harness checks the signed op is the one this ask derives.
      const p = rep.prompt as { digest: Hex; signer?: string; payload?: unknown; stepRef?: string };
      r = await post('/harness/ask', { session: alice.homeSession, addressee: ME, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? ALICE_EOA, signature: await sign(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    break;
  }
  if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`${toolId} did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  return rep!;
}

const note: Record<string, unknown> = existsSync(NOTE) ? JSON.parse(readFileSync(NOTE, 'utf8')) : { purpose: 'spec 386 fixture — the Ligonier service agent in the faithnet estate (an operator note, not a persona)', chainId: CHAIN };
const orgName = `${ORG_LABEL}.org`; const svcName = `${SVC_LABEL}.svc`;
let org = (await naming.resolveName(orgName).catch(() => null))?.toLowerCase() as Address | null;
if (org) console.log(`${orgName} already resolves → ${org}`);
else {
  console.log(`── ${orgName}: alice charters the organization ──`);
  await act(`create an organization called ${ORG_LABEL}`, 'organization.create', { parent: ME, label: ORG_LABEL });
  for (let i = 0; i < 10 && !org; i++) { await new Promise((r) => setTimeout(r, 4000)); org = (await naming.resolveName(orgName).catch(() => null))?.toLowerCase() as Address | null; }
  if (!org) fail(`${orgName} does not resolve after the charter`);
  console.log(`  ${orgName} → ${org}`);
}
let svc = (await naming.resolveName(svcName).catch(() => null))?.toLowerCase() as Address | null;
if (svc) console.log(`${svcName} already resolves → ${svc}`);
else {
  console.log(`── ${svcName}: alice charters the service under ${orgName} ──`);
  await act(`create a service agent called ${SVC_LABEL} under ${orgName}`, 'service.create', { parent: org, label: SVC_LABEL });
  for (let i = 0; i < 10 && !svc; i++) { await new Promise((r) => setTimeout(r, 4000)); svc = (await naming.resolveName(svcName).catch(() => null))?.toLowerCase() as Address | null; }
  if (!svc) fail(`${svcName} does not resolve after the charter`);
  console.log(`  ${svcName} → ${svc}`);
}
Object.assign(note, { org: { name: orgName, sa: org, steward: 'alice' }, service: { name: svcName, sa: svc, charteredUnder: orgName }, charteredAt: new Date().toISOString() });
writeFileSync(NOTE, JSON.stringify(note, null, 2) + '\n');
console.log(`\n✓ ${orgName} ${org} · ${svcName} ${svc} — written to ${NOTE}`);
