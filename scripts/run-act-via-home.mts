/**
 * RUN ONE ACT THROUGH A PERSON'S OWN HOME — her Ask, her mandate signature, her credential when a prompt asks for it
 * (spec 444 W3). The generic form of create-organization-via-home: `--tool <capability> --args <json> [--addressee <agent>]`.
 * The act runs at the ADDRESSEE (the person's own agent by default; an organization she stewards for an org act).
 *
 * CREATE AN ORGANIZATION AGENT the way its person would — her own Ask at her own Home, her mandate, her credential
 * (spec 444 W3: the organization that issues its members' credentials must exist as an agent first).
 *
 *   npx tsx scripts/create-organization-via-home.mts --home https://www.impact-agent.me --by maya \
 *     --roster demo/personas.imbnet.hopechain.json --deployment hopechain --label imbnet [--note demo/org.imbnet.json]
 *
 * `organization.create { parent: <person>, label }` — the person's realm is the only parent an organization has. On a
 * chain whose names are rooted elsewhere (hopechain: `namesRootedAt: faithchain`, local roots closed), the runtime
 * charters the agent and DEFERS the name (`nameLater`): the organization exists, is typed and stewarded, and has no name
 * yet — a name is a facet (ADR-0010), never the identity. Nothing is minted by a script key: every act waits on the
 * mandate the person signs at her Home (persona-sign), and the custodian is her own EOA.
 *
 * Idempotent through the note: an organization already recorded there is reported, not re-created.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const HOME = (arg('home') ?? fail('--home is required')).replace(/\/$/, '');
const BY = arg('by') ?? fail('--by <handle> is required');
const ROSTER = arg('roster') ?? fail('--roster <personas json> is required');
const DEPLOYMENT = arg('deployment') ?? fail('--deployment <chain record, e.g. hopechain> is required (no default chain: a digest is signed over the chain id)');
const TOOL = arg('tool') ?? fail('--tool <capability id> is required');
const ARGS = JSON.parse(arg('args') ?? '{}') as Record<string, unknown>;
const MESSAGE = arg('message') ?? `${TOOL} ${JSON.stringify(ARGS)}`;
const OUT = arg('out');

const D = getDeployments(DEPLOYMENT as never) as unknown as Record<string, string> & { chainId: number };
const CHAIN = Number(D.chainId);
const DM = D.delegationManager as Address;
const ENFORCERS = { delegationManager: DM, timestamp: D.timestampEnforcer, allowedTargets: D.allowedTargetsEnforcer, allowedMethods: D.allowedMethodsEnforcer, value: D.valueEnforcer, payment: D.paymentEnforcer, digestBinding: D.digestBindingEnforcer, ...(D.payloadClassesEnforcer ? { payloadClasses: D.payloadClassesEnforcer } : {}) } as Record<string, Address>;
// A generation-3 estate (hopechain) has the payload-classes enforcer, and a requirement that names payload classes needs it;
// a generation-1 estate has none, and the mandate handler refuses such a requirement there, by name.
for (const [k, v] of Object.entries(ENFORCERS)) if (!/^0x[0-9a-fA-F]{40}$/.test(String(v))) fail(`deployments-${DEPLOYMENT} has no ${k}`);

const roster = JSON.parse(readFileSync(ROSTER, 'utf8')) as Record<string, { sa: string; eoaPrivateKey: Hex }>;
const persona = roster[BY] ?? fail(`${BY} is not in ${ROSTER}`);
const CUSTODIAN = privateKeyToAccount(persona.eoaPrivateKey).address.toLowerCase() as Address;


const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: BY, client_id: 'demo-web' }) }));
const session = String(si.homeSession ?? ''); const ME = String(si.agent ?? '').toLowerCase() as Address;
if (!session || !/^0x[0-9a-f]{40}$/.test(ME)) fail(`no session for ${BY} at ${HOME}: ${JSON.stringify(si).slice(0, 200)}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ digest }) })); if (!b.signature) fail(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature as Hex; };
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; prompt?: string; fields?: unknown; digest?: Hex; signer?: string; payload?: unknown; stepRef?: string }; result?: Record<string, unknown> };

const ADDRESSEE = (arg('addressee') ?? ME).toLowerCase() as Address;
console.log(`${BY} (${ME}) at ${HOME} on eip155:${CHAIN}: ${TOOL} at ${ADDRESSEE} — custodian ${CUSTODIAN}`);
let r = await post('/harness/ask', { session, addressee: ADDRESSEE, message: MESSAGE, plan: { steps: [{ toolId: TOOL, args: ARGS }] } });
let rep = r.reply as Reply | undefined;
console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
for (let round = 0; round < 8; round++) {
  if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
    const req = rep.requirement;
    const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding!, 'intent', req.intentDigest as Hex)];
    let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
    const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
    const a = await post('/harness/authorize', { session, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
    if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
    const b2 = await post('/harness/authorize', { session, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
    if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
    mandate.signature = '0x03';
    console.log(`  ${BY} signed the mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
    r = await post('/harness/ask', { session, addressee: ADDRESSEE, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
    rep = r.reply as Reply | undefined;
    console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
    continue;
  }
  if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
    const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
    const cred = fields.find((f) => f.type === 'credential');
    if (!cred || fields.length !== 1) fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
    r = await post('/harness/ask', { session, addressee: ADDRESSEE, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: { [cred!.name]: { kind: 'eoa', address: CUSTODIAN } } }] });
    rep = r.reply as Reply | undefined;
    console.log(`  custodian supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
    continue;
  }
  if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
    const p = rep.prompt;
    r = await post('/harness/ask', { session, addressee: ADDRESSEE, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? CUSTODIAN, signature: await sign(p.digest!), payload: p.payload } }] });
    rep = r.reply as Reply | undefined;
    console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
    continue;
  }
  break;
}
if (!rep || (rep.kind !== 'done' && rep.kind !== 'answer')) fail(`${TOOL} did not finish: ${JSON.stringify(r).slice(0, 1200)}`);
const finished = rep as Reply;
console.log(`\n✓ ${TOOL} → ${finished.kind}: ${String(finished.text ?? '').slice(0, 300)}`);
console.log(JSON.stringify(finished.result ?? {}).slice(0, 1500));
if (OUT) { writeFileSync(OUT, JSON.stringify({ tool: TOOL, args: ARGS, result: finished.result ?? null, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 }); console.log(`written ${OUT}`); }
