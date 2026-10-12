/**
 * CHARTER A SERVICE AGENT, the way a person would — their own Ask, their own mandate, their own credential.
 *
 *   npx tsx scripts/charter-service.mts --persona demo-admin --label people-groups \
 *     --note demo/people-groups.faithnet.json [--under <org-label>] [--dry-run]
 *
 * `service.create` takes "a person or an organization" as its parent (`CHILD_AGENT_KINDS`, harness-run.ts).
 * `charter-ligonier.mts` only ever does the ORG shape — alice charters `globalchurch.org`, then the service
 * under it — so there was no way to charter a service directly under a person without editing that script.
 * This is the same ceremony with the parent as a choice: `--under <label>` charters (or reuses) that
 * organization first and parents the service there; omitted, the PERSON is the parent and no org is created.
 *
 * Nothing is minted by a script key. Each act waits on a mandate the persona signs at their Home, and the
 * custodian is supplied as a credential — this script holds no authority and creates none.
 *
 * `.svc` IS PRICED AND PERMANENT: 10 SHQ from the agent's own treasury in the same signed operation that
 * registers the name, one name per agent, and it "never expires and is never resold" (the root's own rule).
 * There is no undo, which is why --dry-run prints the plan and stops.
 *
 * Idempotent: a name that already resolves is kept, never re-bought.
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

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PERSONA = arg('persona') ?? 'alice';
const LABEL = arg('label');
const UNDER = arg('under');                       // an org label, or absent ⇒ the person is the parent
const NOTE = arg('note') ?? process.env.NOTE;
const DRY = process.argv.includes('--dry-run');
/**
 * Re-run the (idempotent) charter even when the name already resolves, to recover the act's own result.
 *
 * The stewardship wire lives only in that result, and the Home's link is where it is cached — so an agent
 * chartered before the link was written has no wire in its link, and the Home can list it but not act as
 * it. `service.create` derives the same agent and deploys nothing; what it costs is the mandate the
 * persona signs, which is one transaction and no new authority.
 */
const RELINK = process.argv.includes('--relink');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
if (!LABEL) fail('--label <service-label> is required');
if (!NOTE) fail('--note <path> is required (the operator note this writes)');
if (!/^[a-z0-9][a-z0-9-]*$/.test(LABEL)) fail(`--label must be a name label: ${LABEL}`);

const naming = new AgentNamingClient({ rpcUrl: 'https://a2a.faithnet.io/rpc', chainId: CHAIN, registry: '0x60E949D52660A9D4143ecB0fdA56c0457f20aED9', universalResolver: '0xF343054e046A4145ccae499ECB28197394eE0798' });

/**
 * THE CREDENTIAL THAT WILL CUSTODY WHAT IS CHARTERED — the persona's own EOA, the one their Home holds.
 * Two places carry it on a developer machine and neither is in git: `demo/personas.*.json` (where the demo
 * roster lives) and `apps/home/.env.local`'s `DEMO_PERSONA_KEYS`. Only the ADDRESS is read, and only the
 * address is ever printed; a private key in either file is none of this script's business.
 */
const custodianOf = (persona: string): string => {
  for (const p of ['demo/personas.local.json', 'demo/personas.json']) {
    try {
      const roster = JSON.parse(readFileSync(resolvePath(p), 'utf8')) as Record<string, { eoaAddress?: string }>;
      const a = roster[persona]?.eoaAddress?.toLowerCase();
      if (a && /^0x[0-9a-f]{40}$/.test(a)) return a;
    } catch { /* not on this machine */ }
  }
  try {
    const env = readFileSync(resolvePath('apps/home/.env.local'), 'utf8');
    const m = /^DEMO_PERSONA_KEYS=(.*)$/m.exec(env);
    const keys = m ? (JSON.parse(m[1]!.trim().replace(/^['"]|['"]$/g, '')) as Record<string, { eoaAddress?: string }>) : {};
    const a = keys[persona]?.eoaAddress?.toLowerCase();
    if (a && /^0x[0-9a-f]{40}$/.test(a)) return a;
  } catch { /* no env file */ }
  return '';
};
const CUSTODIAN = (process.env.CUSTODIAN ?? custodianOf(PERSONA)).toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(CUSTODIAN)) fail(`no custodian EOA for ${PERSONA} on this machine (demo/personas.local.json or DEMO_PERSONA_KEYS) — pass CUSTODIAN=0x…`);

const svcName = `${LABEL}.svc`;
const already = (await naming.resolveName(svcName).catch(() => null))?.toLowerCase() as Address | null;
console.log(`── ${svcName} ──`);
console.log(`  persona    ${PERSONA}`);
console.log(`  parent     ${UNDER ? `${UNDER}.org (chartered under the persona)` : `${PERSONA} (the person — no organization)`}`);
console.log(`  custodian  ${CUSTODIAN}`);
console.log(`  note       ${NOTE}`);
console.log(`  on chain   ${already ? `ALREADY ${already} — nothing to buy` : 'available — the charter does NOT buy it (priced root); the agent is deployed unnamed'}`);
if (DRY) { console.log('\n--dry-run: nothing was signed and nothing was bought.'); process.exit(0); }

const who = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: PERSONA, client_id: 'demo-web' }) }));
if (!who?.agent || !who?.homeSession) fail(`${PERSONA} could not sign in at ${HOME}: ${JSON.stringify(who).slice(0, 200)}`);
const ME = String(who.agent).toLowerCase() as Address;
console.log(`  ${PERSONA} → ${ME}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
/** What a charter hands back: the agent it deployed, and the stewardship wire that makes the parent its steward. */
interface CharterResult { agent?: Address; name?: string; kind?: string; parent?: Address; person?: Address; stewardshipDelegation?: unknown }
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown; receipts?: unknown[]; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; signer?: string; payload?: unknown; fields?: unknown } };

/**
 * One act through the persona's agent: the plan supplied, the mandate they sign, the prompts they answer.
 *
 * A `done` THAT DID NOTHING IS WHY THIS PRINTS ITS RESULT. The first charter of people-groups.svc reported
 * `signed → done` and left no name and no agent in the owner's tree — and the reply that would have said
 * why was discarded, so the only way to find out was to run the irreversible act again. The step's own
 * receipts are the cheapest diagnostic there is; they cost a line.
 */
async function act(message: string, toolId: string, args: Record<string, unknown>): Promise<CharterResult | undefined> {
  let r = await post('/harness/ask', { session: who.homeSession, addressee: ME, message, plan: { steps: [{ toolId, args }] } });
  let rep = r.reply as Reply | undefined;
  console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
  for (let round = 0; round < 6; round++) {
    if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const req = rep.requirement;
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
      let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { session: who.homeSession, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { session: who.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      console.log(`  ${PERSONA} signed the mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
      r = await post('/harness/ask', { session: who.homeSession, addressee: ME, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = r.reply as Reply | undefined;
      console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
      const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
      const cred = fields.find((f) => f.type === 'credential');
      if (!cred || fields.length !== 1) fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
      r = await post('/harness/ask', { session: who.homeSession, addressee: ME, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: { [cred!.name]: { kind: 'eoa', address: CUSTODIAN } } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  custodian supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt as { digest: Hex; signer?: string; payload?: unknown; stepRef?: string };
      r = await post('/harness/ask', { session: who.homeSession, addressee: ME, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? CUSTODIAN, signature: await sign(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    break;
  }
  if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`${toolId} did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  if (rep.text) console.log(`  said: ${rep.text.slice(0, 300)}`);
  const receipts = ((r.reply as { receipts?: Array<Record<string, unknown>> })?.receipts ?? (r as { receipts?: Array<Record<string, unknown>> }).receipts ?? []);
  for (const rc of receipts) console.log(`  receipt: ${JSON.stringify(rc).slice(0, 400)}`);
  if (rep.result !== undefined) console.log(`  result: ${JSON.stringify(rep.result).slice(0, 600)}`);
  if (rep.runRef) console.log(`  runRef: ${rep.runRef}`);
  return rep.result as CharterResult | undefined;
}

/** Wait for a name to resolve — the charter is a transaction, so the registry lags the reply by a block or two. */
const settle = async (name: string): Promise<Address | null> => {
  for (let i = 0; i < 10; i++) {
    const a = (await naming.resolveName(name).catch(() => null))?.toLowerCase() as Address | null;
    if (a) return a;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
};

// ── the parent: an organization if one was named, otherwise the person themselves ──
let parent: Address = ME;
let parentName = PERSONA;
if (UNDER) {
  parentName = `${UNDER}.org`;
  const org = (await naming.resolveName(parentName).catch(() => null))?.toLowerCase() as Address | null;
  if (org) { parent = org; console.log(`  ${parentName} already resolves → ${org}`); }
  else {
    console.log(`── ${parentName}: ${PERSONA} charters the organization ──`);
    await act(`create an organization called ${UNDER}`, 'organization.create', { parent: ME, label: UNDER });
    const settled = await settle(parentName);
    if (!settled) fail(`${parentName} does not resolve after the charter`);
    parent = settled;
    console.log(`  ${parentName} → ${parent}`);
  }
}

let svc = already;
let named = !!already;
let chartered: CharterResult | undefined;
if (svc && RELINK) {
  console.log(`${svcName} already resolves ${'\u2192'} ${svc} ${'\u2014'} re-running the charter to recover its stewardship wire (--relink)`);
  chartered = await act(`create a service agent called ${LABEL} under ${parentName}`, 'service.create', { parent, label: LABEL });
  if (chartered?.agent && chartered.agent.toLowerCase() !== svc.toLowerCase()) fail(`the charter returned ${chartered.agent}, not the agent ${svcName} resolves to (${svc}) ${'\u2014'} refusing to relink`);
} else if (svc) console.log(`${svcName} already resolves → ${svc}`);
else {
  console.log(`── ${svcName}: ${PERSONA} charters the service under ${parentName} ──`);
  chartered = await act(`create a service agent called ${LABEL} under ${parentName}`, 'service.create', { parent, label: LABEL });
  // THE AGENT IS THE ACT'S RESULT, not the name lookup. Polling the registry and failing when nothing
  // resolved reported a successful charter as a failure and printed no address at all — so the agent that
  // HAD been deployed was invisible, and the only way to learn its address was to run the act again.
  svc = (chartered?.agent ?? null) as Address | null;
  if (!svc) fail(`service.create finished without naming an agent: ${JSON.stringify(chartered).slice(0, 400)}`);
  console.log(`  ${svcName} agent → ${svc}`);
  named = !!(await settle(svcName));
  console.log(named ? `  ${svcName} resolves` : `  ${svcName} is NOT registered — a priced root names nothing at charter (see the header)`);
}

// ── THE HOME'S OWN TREE ──
//
// A charter deploys the agent on chain and the Home learns nothing. `createManagedAgent` (the path the
// Managed Agents page uses) writes a `related-orgs` link as well as deploying — that link is what the
// agent pulldown lists, and what `nameManagedAgent` needs to offer naming. `service.create` on its own
// writes no link, so a service chartered this way is real, named, resolvable, and absent from its own
// steward's Home (seen 2026-10-12: people-groups.svc was in the names app and nowhere in the pulldown).
//
// So the charter writes it. The link carries the stewardship wire the act itself returned — the route's
// own comment says that field "is its cache and carries no authority of its own", which is exactly what
// this is: a record of a relationship the chain already holds, never a grant of one.
if (svc) {
  const link: Record<string, unknown> = {
    person: ME, orgAgent: svc, orgName: named ? svcName : '', kind: 'service', parent,
    ...(chartered?.stewardshipDelegation ? { stewardshipDelegation: chartered.stewardshipDelegation } : {}),
  };
  const saved = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.homeSession}` }, body: JSON.stringify(link) }));
  console.log(saved?.error
    ? `  ✗ the Home would not list it: ${saved.error}`
    : `  ✓ listed under ${PERSONA} (kind service${chartered?.stewardshipDelegation ? ', with its stewardship wire' : ', no stewardship wire in this run'})`);
}

// ── the operator note: what is true now, merged over what was planned ──
const note: Record<string, unknown> = existsSync(NOTE) ? JSON.parse(readFileSync(NOTE, 'utf8')) : { chainId: CHAIN };
const prior = (note.service ?? {}) as Record<string, unknown>;
note.service = { ...prior, name: svcName, sa: svc, charteredUnder: parentName, custodian: CUSTODIAN, named };
if (UNDER) note.org = { name: parentName, sa: parent, steward: PERSONA };
else { delete note.org; note.charteredBy = { persona: PERSONA, sa: ME }; }
note.charteredAt = (note.charteredAt as string | null) ?? new Date().toISOString();
writeFileSync(NOTE, JSON.stringify(note, null, 2) + '\n');
console.log(`\n✓ ${svcName} ${svc} under ${parentName} — written to ${NOTE}`);
if (named) console.log('  Next: set its name records (atl:mcpEndpoint + atl:a2aEndpoint) and its facets, then the indexer projects it.');
else console.log(`  Next: BUY the name — 10 SHQ from the payer's treasury against a gate ticket, then present it and write its records (purchaseName). Until then the agent is real and anonymous, and nothing public lists it.`);
