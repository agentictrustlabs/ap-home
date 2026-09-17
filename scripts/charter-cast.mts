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
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import { AgentNamingClient } from '../packages/agent-naming/src/index.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const naming = new AgentNamingClient({ rpcUrl: 'https://a2a.faithnet.io/rpc', chainId: CHAIN, registry: '0x60E949D52660A9D4143ecB0fdA56c0457f20aED9', universalResolver: '0xF343054e046A4145ccae499ECB28197394eE0798' });

// The credential that will custody what each person charters — that demo persona's own EOA, the one the Home
// holds for them. Only the ADDRESS is read here; the key stays in the Home, which signs via /connect/persona-sign.
const personaKeys = (() => {
  for (const p of [resolvePath('apps/home/.env.local'), process.env.PERSONA_ENV ?? '', resolvePath(process.env.HOME ?? '', 'agenticprimitives/apps/home/.env.local')]) {
    try { if (!p) continue; const env = readFileSync(p, 'utf8'); const m = /^DEMO_PERSONA_KEYS=(.*)$/m.exec(env); if (m) return JSON.parse(m[1]!.trim().replace(/^['"]|['"]$/g, '')) as Record<string, { eoaAddress?: string }>; } catch { /* next */ }
  }
  return {};
})();

interface Who { handle: string; sa: Address; session: string; eoa: string; headers: Record<string, string> }

/** Sign in as one demo person and take a CSRF token for their Home session. One trip per custodian. */
async function signIn(handle: string): Promise<Who> {
  const eoa = (personaKeys[handle]?.eoaAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(eoa)) fail(`${handle}'s custodian EOA is not in DEMO_PERSONA_KEYS (apps/home/.env.local, or PERSONA_ENV=<path>)`);
  const me = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!me.agent || !me.homeSession) fail(`demo-signin ${handle}: ${JSON.stringify(me).slice(0, 200)}`);
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  return {
    handle, eoa, sa: String(me.agent).toLowerCase() as Address, session: me.homeSession,
    headers: { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' },
  };
}

type Reply = { kind?: string; error?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; signer?: string; payload?: unknown; fields?: unknown } };

/**
 * ONE ACT THROUGH THAT PERSON'S OWN ASK: the plan supplied, the mandate they sign, the prompts they answer.
 * The plan is supplied rather than described so no model is asked to guess which tool a script meant — the
 * same reason the Home admits a screen's plan verbatim.
 */
async function actAs(who: Who, message: string, toolId: string, args: Record<string, unknown>): Promise<void> {
  const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: who.headers, body: JSON.stringify(body) }));
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
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
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

const ONLY = process.argv[2];
const wanted = ONLY ? CAST.filter((c) => c.role === ONLY || c.label === ONLY) : CAST;
if (wanted.length === 0) fail(`no part called "${ONLY}" — one of ${CAST.map((c) => c.role).join(', ')}`);

const NOTE_PATH = process.env.NOTE ?? 'demo/cast.faithnet.json';
const note: Record<string, unknown> = existsSync(NOTE_PATH)
  ? JSON.parse(readFileSync(NOTE_PATH, 'utf8'))
  : { purpose: 'the cast of Snowfall at the Belvedere — each character a PERSON agent of a real demo person, never their default (an operator note, not a persona)', chainId: CHAIN };

// One sign-in per custodian, not per part: Alice holds two of these, and signing in twice for her would be
// two sessions doing one person's work.
const sessions = new Map<string, Who>();
const parts: Array<Record<string, unknown>> = [];

for (const part of wanted) {
  const name = `${part.label}.me`;
  let sa = (await naming.resolveName(name).catch(() => null))?.toLowerCase() as Address | null;
  if (sa) {
    console.log(`${name} already resolves → ${sa}  (${part.character})`);
  } else {
    console.log(`\n── ${part.character} · ${part.role}: ${part.handle} charters ${name} ──`);
    if (!sessions.has(part.handle)) sessions.set(part.handle, await signIn(part.handle));
    const who = sessions.get(part.handle)!;
    await actAs(who, `add another person of my own called ${part.label}`, 'person.create', { parent: who.sa, label: part.label });
    for (let i = 0; i < 10 && !sa; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      sa = (await naming.resolveName(name).catch(() => null))?.toLowerCase() as Address | null;
    }
    if (!sa) fail(`${name} does not resolve after the charter`);
    console.log(`  ${name} → ${sa}`);
  }
  parts.push({ role: part.role, character: part.character, name, sa, custodian: part.handle });
}

Object.assign(note, { cast: parts, charteredAt: new Date().toISOString() });
writeFileSync(NOTE_PATH, JSON.stringify(note, null, 2) + '\n');
console.log(`\n✓ ${parts.length} part(s) written to ${NOTE_PATH}`);
console.log('\nMYSTERY_CAST = "' + parts.map((p) => `${p.role}=${p.name}@${p.custodian}`).join(',') + '"');
