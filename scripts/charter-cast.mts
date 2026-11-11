/**
 * CHARTER THE BELVEDERE'S CAST — each character as a PERSON of a real demo person, the way that person would.
 *
 *   npx tsx scripts/charter-cast.mts            (the whole cast)
 *   npx tsx scripts/charter-cast.mts concierge  (one part)
 *
 * `person.create { parent: <handle>'s own agent, label }` → `<label>.me`, chartered under the PERSON and
 * custodied by that person's own credential. NEVER their default: their own name stays the one their Home
 * opens as. The act waits on a mandate the person signs at home; nothing is minted by a script key.
 *
 * WHY A PERSON, NOT A SERVICE. A character speaks, remembers and is somebody — and eight characters sharing
 * one service agent share one memory and one bill. Each gets its own card, its own vault and its own
 * custodian, and every screen in the game names the human answerable for it.
 *
 * IDEMPOTENT BY NAME, which is the same property the game relies on when a player takes a part: a name that
 * already resolves is kept, so running this twice does not charter a twin with an empty vault.
 *
 * The addresses are written to demo/cast.faithnet.json — an operator note, not a persona — and the script
 * prints the `MYSTERY_CAST` line the card room's Worker config wants.
 */
import { hashDelegation, buildCaveat, buildDigestBindingCaveat, capabilityHandler, encodeTimestampTerms, encodeValueTerms, encodeAllowedTargetsTerms, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import type { Address, Hex } from 'viem';

// Addresses come from the pinned deployment record (DEPLOYMENT, default faithchain) — never a hard-coded generation. The
// gen-1 literals that stood here chartered against a record the estate had left (spec 445 gen-4 rebuild, 2026-11-11).
const HOME = (process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const A2A_URL = (process.env.A2A_URL ?? 'https://a2a.faithnet.io').replace(/\/$/, '');
// A2A_DIRECT=1 talks to the runtime at A2A_URL instead of through the Home's /a2a rewrite (Vercel answers 502 while a receipt is awaited).
const A2A_BASE = process.env.A2A_DIRECT ? A2A_URL : `${HOME}/a2a`;
const D = getDeployments((process.env.DEPLOYMENT ?? 'faithchain') as never) as unknown as Record<string, string | undefined> & { chainId: number };
const CHAIN = Number(D.chainId);
const DM = D.delegationManager as Address;
// The GOVERNANCE contracts a stewardship wire pins, and nothing else. `hasStewardshipShape` in the InteractionsDO identifies a
// steward POSITIVELY by exactly this set. A generation-4 chain has NO legacy `permissionlessSubregistry`: absent means absent.
const GOVERNANCE = { agentRelationship: D.agentRelationship, agentNameRegistry: D.agentNameRegistry, permissionlessSubregistry: D.permissionlessSubregistry && !/^0x0{40}$/i.test(D.permissionlessSubregistry) ? D.permissionlessSubregistry : undefined } as const;
const ENFORCERS = { delegationManager: DM, timestamp: D.timestampEnforcer as Address, allowedTargets: D.allowedTargetsEnforcer as Address, allowedMethods: D.allowedMethodsEnforcer as Address, value: D.valueEnforcer as Address, payment: D.paymentEnforcer as Address, digestBinding: D.digestBindingEnforcer as Address } as const;
for (const [k, v] of Object.entries({ ...ENFORCERS, agentRelationship: GOVERNANCE.agentRelationship, agentNameRegistry: GOVERNANCE.agentNameRegistry })) if (!/^0x[0-9a-fA-F]{40}$/.test(String(v))) throw new Error(`the deployment record has no ${k}`);

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const naming = new AgentNamingClient({ rpcUrl: `${A2A_URL}/rpc`, chainId: CHAIN, registry: D.agentNameRegistry as Address, universalResolver: D.agentNameUniversalResolver as Address });

// The credential that will custody what each person charters — that demo persona's own EOA, the one the Home
// holds for them. Only the ADDRESS is read here; the key stays in the Home, which signs via /connect/persona-sign.
const personaKeys = (() => {
  // ROSTER=<personas json> (name, sa, eoaPrivateKey, eoaAddress) — the estate's roster; DEMO_PERSONA_KEYS in an env file is the older road.
  if (process.env.ROSTER) {
    const r = JSON.parse(readFileSync(process.env.ROSTER, 'utf8')) as Record<string, { eoaAddress?: string; eoaPrivateKey?: Hex }>;
    return Object.fromEntries(Object.entries(r).map(([h, p]) => [h, { eoaAddress: p.eoaAddress ?? (p.eoaPrivateKey ? privateKeyToAccount(p.eoaPrivateKey).address : undefined) }])) as Record<string, { eoaAddress?: string }>;
  }
  for (const p of [resolvePath('apps/home/.env.local'), process.env.PERSONA_ENV ?? '', resolvePath(process.env.HOME ?? '', 'agenticprimitives/apps/home/.env.local')]) {
    try { if (!p) continue; const env = readFileSync(p, 'utf8'); const m = /^DEMO_PERSONA_KEYS=(.*)$/m.exec(env); if (m) return JSON.parse(m[1]!.trim().replace(/^['"]|['"]$/g, '')) as Record<string, { eoaAddress?: string }>; } catch { /* next */ }
  }
  return {};
})();

interface Who { handle: string; sa: Address; session: string; eoa: string; headers: Record<string, string> }
class MisreportedApproval extends Error {}

/** Sign in as one demo person and take a CSRF token for their Home session. One trip per custodian. */
async function signIn(handle: string): Promise<Who> {
  const eoa = (personaKeys[handle]?.eoaAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(eoa)) fail(`${handle}'s custodian EOA is not in DEMO_PERSONA_KEYS (apps/home/.env.local, or PERSONA_ENV=<path>)`);
  const me = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!me.agent || !me.homeSession) fail(`demo-signin ${handle}: ${JSON.stringify(me).slice(0, 200)}`);
  const csrfRes = await fetch(`${A2A_BASE}/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  return {
    handle, eoa, sa: String(me.agent).toLowerCase() as Address, session: me.homeSession,
    headers: { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' },
  };
}

type Reply = { kind?: string; result?: { agent?: string }; error?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; signer?: string; payload?: unknown; fields?: unknown } };

/**
 * ONE ACT THROUGH THAT PERSON'S OWN ASK: the plan supplied, the mandate they sign, the prompts they answer.
 * The plan is supplied rather than described so no model is asked to guess which tool a script meant — the
 * same reason the Home admits a screen's plan verbatim.
 */
async function actAs(who: Who, message: string, toolId: string, args: Record<string, unknown>): Promise<{ agent?: string } | undefined> {
  const post = async (path: string, body: unknown) => j(await fetch(`${A2A_BASE}${path}`, { method: 'POST', headers: who.headers, body: JSON.stringify(body) }));
  const sign = async (digest: Hex): Promise<Hex> => {
    const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.session}` }, body: JSON.stringify({ digest }) }));
    if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
    return b.signature as Hex;
  };
  let r = await post('/harness/ask', { session: who.session, addressee: who.sa, message, plan: { steps: [{ toolId, args }] } });
  let rep = r.reply as Reply | undefined;
  console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
  for (let round = 0; round < 6; round++) {
    if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const req = rep.requirement;
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
      let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { session: who.session, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { session: who.session, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
      // THE CHAIN IS THE AUTHORITY, NOT THE REPORT. The Home's authorize step looks for OUR sender's
      // UserOperationEvent in the bundler's receipt and calls its absence a revert; a shared bundler that
      // batches shows another sender's, and a userOp that is `success = true` on chain is reported as "the
      // approval batch reverted: no revert reason". Believing it aborts the run BEFORE the act it authorized,
      // so the agent is never created and there is nothing for `landedAnyway` to find — which is how one
      // misreport stopped a seven-part charter at part two. So a reported failure is checked against the
      // receipt, and a landed approval carries on. (Fixed at the Home in dd6a3298; not deployed.)
      if (b2.ok !== true) {
        const tx = String(b2.error ?? '').match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;
        if (!tx || !(await approvalLanded(tx))) throw new MisreportedApproval(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
        console.log(`  the Home called it reverted; the chain says it landed (tx ${tx.slice(0, 18)}…) — carrying on`);
      }
      mandate.signature = '0x03';
      console.log(`  ${who.handle} signed the mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = r.reply as Reply | undefined;
      console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
      const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
      const cred = fields.find((f) => f.type === 'credential');
      if (!cred || fields.length !== 1) fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: { [cred!.name]: { kind: 'eoa', address: who.eoa } } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  custodian supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt as { digest: Hex; signer?: string; payload?: unknown; stepRef?: string };
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? who.eoa, signature: await sign(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    break;
  }
  if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`${toolId} did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  return rep?.result;
}

/**
 * THE HOME CAN MISREPORT A LANDED APPROVAL (2026-09-17). Its authorize step reads the bundler's receipt and
 * looks for OUR sender's UserOperationEvent; a shared bundler that batched or swapped the receipt shows it
 * another sender's, the filter matches nothing, and it answers "the approval batch reverted: no revert
 * reason" for a userOp that is `success = true` on chain. So a reported failure is not the last word: the
 * name is. Wait a little and ask the naming service whether the agent exists before calling it a failure.
 */
/** Did this approval actually land? `status 0x1` and at least one UserOperationEvent that succeeded, whoever sent it. */
async function approvalLanded(tx: Hex): Promise<boolean> {
  const UOE = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${A2A_URL}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] }) });
    const body = (await res.json().catch(() => ({}))) as { result?: { status?: string; logs?: Array<{ topics: string[]; data: string }> } | null };
    const r = body.result ?? null;
    if (r?.status === '0x1') return (r.logs ?? []).some((l) => l.topics[0] === UOE && /1$/.test(l.data.slice(2, 66).replace(/^0+/, '') || '0'));
    if (r?.status === '0x0') return false;
    await new Promise((x) => setTimeout(x, 2500));
  }
  return false;
}

async function landedAnyway(name: string, seconds = 90): Promise<Address | null> {
  for (let i = 0; i < seconds / 5; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sa = (await naming.resolveName(name).catch(() => null))?.toLowerCase() as Address | null;
    if (sa) return sa;
  }
  return null;
}

/**
 * THE STEWARDSHIP WIRE — the persona's own grant to the human who custodies it.
 *
 * WHY IT HAS TO EXIST. Every steward-gated act at the Home is proved by a wire, never by a word: the
 * InteractionsDO reads `related:<person>:<agent>` for a `stewardshipDelegation`, checks it on chain, and
 * answers "only the agent's custodian may assign an archetype" when there is none. A browser ceremony gets
 * one for free — the genesis builder mints it inside the deploy userOp and the surface stores it — and a
 * script driving `/harness/ask` throws that answer away. So the cast could be chartered, named, carded and
 * still have no playbook, because nothing could prove to the Home what the chain already said.
 *
 * WHY MINTING ONE LATER IS HONEST. The wire is the PERSONA granting its custodian oversight of it, and the
 * persona's account accepts exactly one signer — the custodian's own credential, set at the charter. So this
 * is the custodian signing for their own second name, which is the same act the ceremony performs, done at a
 * different moment. It is `siteCaveats`: time-boxed, value 0, and pinned to the three governance contracts —
 * no methods and no record scope, which is what makes it recognisable as custody rather than as a payment
 * mandate or a data grant.
 */
async function mintStewardship(who: Who, sa: Address): Promise<unknown> {
  const validUntil = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = {
    delegator: sa,
    delegate: who.sa,
    authority: ROOT_AUTHORITY,
    caveats: [
      buildCaveat(ENFORCERS.timestamp as Address, encodeTimestampTerms(0, validUntil)),
      buildCaveat(ENFORCERS.value as Address, encodeValueTerms(0n)),
      buildCaveat(ENFORCERS.allowedTargets as Address, encodeAllowedTargetsTerms([GOVERNANCE.agentRelationship, GOVERNANCE.agentNameRegistry, GOVERNANCE.permissionlessSubregistry].filter((a): a is string => !!a) as Address[])),
    ] as Caveat[],
    salt,
    signature: '0x',
  };
  const digest = hashDelegation(d, CHAIN, DM);
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.session}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) fail(`persona-sign for ${sa}: ${JSON.stringify(b).slice(0, 160)}`);
  d.signature = b.signature as Hex;
  // The wire form: salt as a decimal STRING, because JSON has no bigint and every reader of this record
  // expects the string.
  return { ...d, salt: d.salt.toString() };
}

/**
 * WRITE THE LINK INTO THE CUSTODIAN'S OWN HOME — the step a browser ceremony does and a script does not.
 *
 * Chartering mints the agent ON CHAIN; it does not put it in anybody's tree. Recording a created agent in
 * the owner's Home has always been the SURFACE's job (the ceremony posts `/connect/related-orgs` after the
 * userOp lands), and a script driving `/harness/ask` is not a surface — which is why eight cast agents
 * existed, resolved, and were invisible under Alice's People tab.
 *
 * `relationship: 'self'` is the whole point: this is another name for the SAME human, not an organization
 * they steward. `kind: 'person'` is what puts it under People rather than Organizations, and `parent` is
 * the custodian's own agent, so it hangs off them in the tree.
 *
 * Idempotent — the endpoint MERGES onto any existing record, so running this over a cast that is already
 * linked rewrites the same row rather than adding one.
 */
async function recordAtHome(who: Who, sa: Address, name: string, stewardship: unknown): Promise<void> {
  const r = await fetch(`${HOME}/connect/related-orgs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${who.session}` },
    body: JSON.stringify({
      person: who.sa,
      orgAgent: sa,
      orgName: name,
      purpose: 'persona',
      requestedBy: '',
      kind: 'person',
      parent: who.sa,
      relationship: 'self',
      stewardshipDelegation: stewardship,
    }),
  });
  const b = await j(r);
  if (!r.ok || b?.error) fail(`recording ${name} in ${who.handle}'s Home failed: ${b?.error ?? r.status}`);
  console.log(`  linked into ${who.handle}'s Home as a person (self)`);
}

/** The default cast: which part, whose person, and the name that person's agent is claimed under. */
const CAST = [
  { role: 'concierge',  character: 'Émile Rossi',     handle: 'elena',  label: 'emile-elena' },
  { role: 'heiress',    character: 'Delphine Aubert', handle: 'alice',  label: 'delphine-alice' },
  { role: 'instructor', character: 'Kai Brunner',     handle: 'bob',    label: 'kai-bob' },
  { role: 'doctor',     character: 'Dr Halloran',     handle: 'carol',  label: 'halloran-carol' },
  { role: 'chef',       character: 'Marek Novák',     handle: 'dave',   label: 'marek-dave' },
  { role: 'journalist', character: 'Nadia Kowal',     handle: 'nathan', label: 'nadia-nathan' },
  { role: 'guide',      character: 'Sofia Lindqvist', handle: 'david',  label: 'sofia-david' },
  { role: 'widow',      character: 'Mme Perrin',      handle: 'alice',  label: 'perrin-alice' },
] as const;

/**
 * ANOTHER GAME'S CAST. `--cast <file.json>` reads `{ cast: [{ role, character, handle, label }], note, var }`
 * instead of the Belvedere table above — the Great Commission's seven parts are the first — and writes its
 * note beside this one. Same road, same idempotence; only the names differ.
 */
const argv = process.argv.slice(2);
const castFile = argv.includes('--cast') ? argv[argv.indexOf('--cast') + 1] : undefined;
const castSpec = castFile ? (JSON.parse(readFileSync(castFile, 'utf8')) as { cast: Array<{ role: string; character: string; handle: string; label: string }>; note?: string; var?: string }) : null;
const TABLE: ReadonlyArray<{ role: string; character: string; handle: string; label: string }> = castSpec?.cast ?? CAST;
const VAR = castSpec?.var ?? 'MYSTERY_CAST';
// --adopt <label>=<0x…> names an agent a previous run chartered but could not name (the charter is two acts on a priced root).
// --relabel <label>=<label> swaps a label the gate's DOMAIN RULE refuses (`<label>.com` exists) for one it admits; the part's role is unchanged.
const RELABEL = new Map(argv.flatMap((a, i) => (argv[i - 1] === '--relabel' ? [a.split('=') as [string, string]] : [])));
const ADOPT = new Map(argv.flatMap((a, i) => (argv[i - 1] === '--adopt' ? [a.split('=') as [string, string]] : [])));
const ONLY = argv.find((a, i) => !a.startsWith('--') && a !== castFile && argv[i - 1] !== '--adopt' && argv[i - 1] !== '--handle' && argv[i - 1] !== '--relabel');
// --handle <persona> keeps only that custodian's parts, so one worker per custodian can run beside the others (each pays from its own treasury).
const HANDLE = argv.includes('--handle') ? argv[argv.indexOf('--handle') + 1] : undefined;
const wanted = (ONLY ? TABLE.filter((c) => c.role === ONLY || c.label === ONLY) : TABLE).filter((c) => !HANDLE || c.handle === HANDLE);
if (wanted.length === 0) fail(`no part called "${ONLY}" — one of ${TABLE.map((c) => c.role).join(', ')}`);

const NOTE_PATH = process.env.NOTE ?? castSpec?.note ?? 'demo/cast.faithnet.json';
const note: Record<string, unknown> = existsSync(NOTE_PATH)
  ? JSON.parse(readFileSync(NOTE_PATH, 'utf8'))
  : { purpose: 'the cast of Snowfall at the Belvedere — each character a PERSON agent of a real demo person, never their default (an operator note, not a persona)', chainId: CHAIN };

// One sign-in per custodian, not per part: Alice holds two of these, and signing in twice for her would be
// two sessions doing one person's work.
const sessions = new Map<string, Who>();
const parts: Array<Record<string, unknown>> = [];

for (const part of wanted) {
  const label = RELABEL.get(part.label) ?? part.label;
  const name = `${label}.me`;
  let sa = (await naming.resolveName(name).catch(() => null))?.toLowerCase() as Address | null;
  // Signed in either way: an agent that already exists on chain may still be missing from its custodian's
  // tree (chartering mints it; only the Home write puts it under People), and that is exactly the gap this
  // run has to close for a cast chartered before the link step existed.
  if (!sessions.has(part.handle)) sessions.set(part.handle, await signIn(part.handle));
  const who = sessions.get(part.handle)!;
  if (sa) {
    console.log(`${name} already resolves → ${sa}  (${part.character})`);
  } else {
    // GENERATION 4: a `.me` is on a PRICED root, so `person.create` DEPLOYS the agent and names nothing (the register call
    // reverts). The charter is two acts: the deploy, then `buy-name.mts` — paid from the custodian's own treasury.
    let agent = (ADOPT.get(part.label) ?? '').toLowerCase() as Address | '';
    if (!agent) {
      console.log(`\n── ${part.character} · ${part.role}: ${part.handle} charters ${name} ──`);
      try {
        const res = await actAs(who, `add another person of my own called ${label}`, 'person.create', { parent: who.sa, label });
        agent = String(res?.agent ?? '').toLowerCase() as Address;
      } catch (e) {
        if (!(e instanceof MisreportedApproval)) throw e;
        fail(`${name}: ${e.message.slice(0, 200)} — the agent may have landed unnamed; find it and re-run with --adopt ${part.label}=<0x…>`);
      }
    }
    if (!/^0x[0-9a-f]{40}$/.test(agent)) fail(`${name}: person.create finished but named no agent`);
    sa = agent as Address;
    console.log(`  ${name} chartered unnamed → ${sa}; buying the name from ${part.handle}'s treasury`);
    const buy = spawnSync('npx', ['tsx', 'scripts/buy-name.mts', '--persona', part.handle, '--owner', sa, '--label', label, '--tld', 'me'], { encoding: 'utf8', env: { ...process.env, A2A_DIRECT: '' }, timeout: 600_000 });
    if (buy.status !== 0) fail(`buying ${name} failed:\n${(buy.stdout + buy.stderr).split('\n').filter((l) => !/npm warn/.test(l)).slice(-12).join('\n')}`);
    for (let i = 0; i < 10; i++) { const r = (await naming.resolveName(name).catch(() => null))?.toLowerCase(); if (r === sa) break; await new Promise((x) => setTimeout(x, 4000)); }
    const resolved = (await naming.resolveName(name).catch(() => null))?.toLowerCase();
    if (resolved !== sa) fail(`${name} resolves to ${resolved ?? 'nothing'}, not ${sa}, after the purchase`);
    console.log(`  ${name} → ${sa}`);
  }
  // Minted fresh on every run rather than reused: the wire is a year-long grant and re-issuing one is
  // cheaper than reasoning about whether the stored one is still live, which is exactly the question its
  // absence made unanswerable.
  await recordAtHome(who, sa, name, await mintStewardship(who, sa));
  parts.push({ role: part.role, character: part.character, name, sa, custodian: part.handle });
  writeNote();
}

// ONE PART AT A TIME MUST NOT FORGET THE OTHERS: the note is re-read and merged by role at every write, so parts chartered
// yesterday (or by a sibling `--handle` worker a moment ago) are not erased, and a crash keeps every part already named.
function writeNote(): number {
  const cur: Record<string, unknown> = existsSync(NOTE_PATH) ? JSON.parse(readFileSync(NOTE_PATH, 'utf8')) : { ...note };
  const prior = ((cur.cast as Array<Record<string, unknown>> | undefined) ?? []).filter((p) => !parts.some((q) => q.role === p.role));
  const merged = [...prior, ...parts].sort((a, b) => TABLE.findIndex((t) => t.role === a.role) - TABLE.findIndex((t) => t.role === b.role));
  writeFileSync(NOTE_PATH, JSON.stringify({ ...cur, cast: merged, charteredAt: new Date().toISOString() }, null, 2) + '\n');
  return merged.length;
}
const n = writeNote();
console.log(`\n\u2713 ${parts.length} part(s) written to ${NOTE_PATH} (${n} on record)`);
console.log(`\n${VAR} = "` + (JSON.parse(readFileSync(NOTE_PATH, 'utf8')).cast as Array<{ role: string; name: string; custodian: string }>).map((p) => `${p.role}=${p.name}@${p.custodian}`).join(',') + '"');
