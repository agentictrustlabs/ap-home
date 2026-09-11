/**
 * Spec 372 S3 — an OUTSIDE RUNTIME as a member: the service agent it will act as, chartered on faithchain.
 *
 *   npx tsx scripts/verify-runtime-member.mts [label]        (from the repo root)
 *
 * Plays the ASK SURFACE as Alice (a demo persona: the Home holds her custodian key, so every signature is a
 * real one). Her own agent mints a MANDATE for the a2a's harness SA — capability `service.create`, location =
 * Alice herself (the parent), bound to this intent — and the conversation the button would be:
 *
 *   run 1  → the harness ASKS which credential will custody the service agent (the surface answers)
 *   run 2  → the harness derives the genesis (deploy + <label>.svc + typed declaration + stewardship child →
 *            Alice) and ASKS the connected credential to sign its hash, userOp in the open
 *   run 3  → the surface signs; the harness re-derives, checks the signed op IS the derived one, submits
 *
 * Then the chain agrees (code, custody = the connected user, the typed name resolves both ways), the link is
 * recorded in Alice's vault as the Home would, and the twins: a different ask under the same mandate is
 * denied; the identical ask again finds the agent and charters none.
 *
 * What this does NOT yet do (spec 372 §3.1): invite the service agent into an organization, delegate to it
 * narrowly, have it speak on the standard surface as itself, and revoke. Those are the next halves.
 */
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import {
  intentDigest, buildDigestBindingCaveat, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY,
  CAPABILITY_RAR_TYPE, type Delegation, type MandateRequirementV1,
} from '@agenticprimitives/delegation';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';

registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const HARNESS_SA = '0xD34c3Fbc89706dd57d426546DCEBD3bA926eDE35' as Address;
const LABEL = process.argv[2] ?? `runtime-${Date.now().toString(36).slice(-4)}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });

// ── Alice: a Home session, her connected credential, the persona signer ──
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session for alice');
const ALICE = String(signin.agent).toLowerCase() as Address;
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const custodianEoa = (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === ALICE)?.custodian as Address;
if (!custodianEoa) throw new Error('no custodian for alice');
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
console.log(`alice ${ALICE}  connected credential ${custodianEoa}`);

const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, digestBinding: D.digestBinding } as const;
const now = Math.floor(Date.now() / 1000);

// ── The INTENT — the ask, canonically; the parent is Alice's own realm ──
const intent = { goal: `create a service agent called ${LABEL}`, context: { parent: ALICE, label: LABEL, nonce: toHex(crypto.getRandomValues(new Uint8Array(8))) } };

// ── The MANDATE: Alice → harness SA, `service.create` AT Alice, for THIS intent ──
const req: MandateRequirementV1 = {
  type: CAPABILITY_RAR_TYPE, actions: ['service.create'], locations: [ALICE],
  intentDigest: intentDigest(intent), validAfter: now - 60, validUntil: now + 3600,
};
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const mandate: Delegation = { delegator: ALICE, delegate: HARNESS_SA, authority: ROOT_AUTHORITY, caveats: [...capabilityHandler.toCaveats(req, enforcers as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest)], salt, signature: '0x' };
const mandateRef = hashDelegation(mandate, CHAIN, D.dm);
mandate.signature = await sign(mandateRef);
console.log(`mandate  ${mandateRef}\n  alice → harness ${HARNESS_SA}, service.create, intent ${req.intentDigest.slice(0, 18)}…`);
const wire = { ...mandate, salt: salt.toString() };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const runRef = `svc-${Date.now()}`;
const run = async (runIntent: typeof intent, supplied: unknown[] = [], presented = wire) =>
  j(await fetch(`${HOME}/a2a/harness/run`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: token, intent: runIntent, presented, supplied, runRef }) }));
const show = (r: any) => {
  console.log(`outcome ${r.outcome}  planner ${r.plannerKind}${r.prompt ? `  → prompt: ${r.prompt.kind} — "${r.prompt.prompt}"` : ''}${r.error ? `\n  error ${r.error}` : ''}${r.detail ? `\n  detail ${r.detail}` : ''}`);
  for (const rc of r.receipts ?? []) console.log(`  ${rc.stepRef} ${rc.toolId} ${rc.status} risk=${rc.risk} decision=${rc.authority?.decision?.decision ?? '-'}${rc.pendingInput ? ` pending=${rc.pendingInput.kind}` : ''}${rc.error ? ` — ${rc.error}` : ''}`);
};

console.log(`\n── run 1: "${intent.goal}" ──`);
const r1 = await run(intent);
show(r1);
if (r1.outcome !== 'suspended' || r1.prompt?.kind !== 'data') throw new Error(`expected a data prompt: ${JSON.stringify(r1).slice(0, 600)}`);
const asked = (r1.prompt.fields as Array<{ name: string; type: string }>).map((f) => `${f.name}:${f.type}`);
console.log(`  fields asked: ${asked.join(', ')}`);
if (asked.includes('label:text')) throw new Error('the label was in the ask; it must not be asked for');
if (asked.includes('parent:text')) throw new Error('the parent is the realm the ask was made in; it must not be asked for');
if (!asked.includes('custodian:credential')) throw new Error('the credential must be asked for (the surface answers it)');

const supplied: unknown[] = [{ stepRef: r1.resumeToken, data: { custodian: { kind: 'eoa', address: custodianEoa } } }];
console.log(`\n── run 2: + credential ──`);
const r2 = await run(intent, supplied);
show(r2);
if (r2.outcome !== 'suspended' || r2.prompt?.kind !== 'signature') throw new Error(`expected a signature prompt: ${JSON.stringify(r2).slice(0, 600)}`);
const p = r2.prompt as { digest: Hex; signer: string; payload: { child: Address; name: string; userOp: unknown } };
console.log(`  to sign: ${p.digest}  by ${p.signer}\n  genesis of ${p.payload.name} at ${p.payload.child}`);
if (p.signer.toLowerCase() !== custodianEoa.toLowerCase()) throw new Error('the signer must be the connected credential');
if (!p.payload.name.endsWith('.svc')) throw new Error(`a service agent is named <label>.svc, got ${p.payload.name}`);

supplied.push({ stepRef: r2.resumeToken, signature: { digest: p.digest, signer: custodianEoa, signature: await sign(p.digest), payload: { userOp: p.payload.userOp } } });
console.log(`\n── run 3: + signature ──`);
const r3 = await run(intent, supplied);
show(r3);
if (r3.outcome !== 'completed') throw new Error(`expected completed: ${JSON.stringify(r3).slice(0, 800)}`);
const svc = (r3.result.agent ?? r3.result.team) as Address;
console.log(`tx ${r3.result.txHash}\n  service agent ${svc} = ${r3.result.name}  kind ${r3.result.kind}`);
if (r3.result.kind !== 'service') throw new Error(`recorded kind must be "service", got ${r3.result.kind}`);

// ── the chain agrees ──
const code = await pub.getBytecode({ address: svc });
if (!code || code === '0x') throw new Error('the service SA has no code');
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: CHAIN, registry: '0x60E949D52660A9D4143ecB0fdA56c0457f20aED9' as Address, universalResolver: '0xF343054e046A4145ccae499ECB28197394eE0798' as Address });
const isCustodian = await pub.readContract({ address: svc, abi: [{ type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }], functionName: 'isCustodian', args: [custodianEoa] });
console.log(`  custodied by the connected user: ${isCustodian ? '✓' : '✗'}`);
if (!isCustodian) throw new Error('custody is always the connected user — and it is not');
const resolved = await naming.resolveName(r3.result.name);
const reverse = await naming.reverseResolve(svc);
console.log(`  ${r3.result.name} → ${resolved}   ${svc} → ${reverse}`);
if (resolved?.toLowerCase() !== svc.toLowerCase() || reverse !== r3.result.name) throw new Error('the typed name does not resolve both ways');

// ── the surface finishes as the Home does: the private related-agent link in Alice's vault ──
const saved = await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ person: ALICE, orgAgent: svc, orgName: r3.result.name, purpose: 'service', kind: 'service', relationship: 'steward' }) });
console.log(`  related-agent link saved to Alice's vault: ${saved.ok ? '✓' : `✗ ${saved.status} ${(await saved.text()).slice(0, 160)}`}`);

// ── negative twin: same mandate, a different ask — denied at the step ──
console.log('\n── negative twin: same mandate, different ask ──');
const other = { ...intent, goal: `create a service agent called ${LABEL}-2`, context: { ...intent.context, label: `${LABEL}-2`, nonce: '0x01' } };
const n1 = await run(other);
show(n1);
if (n1.outcome !== 'denied' || !/intent-mismatch/.test(n1.error ?? '')) throw new Error('the twin was not denied for the reason');

// ── replay: the identical ask again finds the agent, charters no twin ──
console.log('\n── replay: the identical ask with all answers ──');
const n2 = await run(intent, supplied);
show(n2);
if (n2.outcome !== 'completed' || n2.result?.alreadyCreated !== true || String(n2.result?.agent ?? n2.result?.team).toLowerCase() !== svc.toLowerCase()) throw new Error(`a replay must find the agent, not charter a twin: ${JSON.stringify(n2).slice(0, 400)}`);

console.log(`\n✓ spec 372 S3a on faithchain: ask → mandate verified → credential asked → genesis derived → signature asked → re-derived + checked → submitted → ${r3.result.name} (service class, custodied by the connected user); twins refused.`);
