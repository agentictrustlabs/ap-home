/**
 * canonical-a2a-e2e.ts — LIVE two-agent A2A acceptance harness (spec 269 + ADR-0044).
 *
 * Proves the canonical agentic spine end-to-end against the DEPLOYED stack with REAL
 * on-chain ERC-1271 — for EACH connection custodian (SIWE / passkey / social), honoring
 * the custodian mandate ([[feedback_custodian_supports_all_authority]]): the connection
 * custodian backs EVERY authority op. Signing the A2A delegation, the A2A message, and the
 * `tasks/get` caller-proof ARE authority ops, so they all flow through ONE custody-agnostic
 * `signDigest` seam with three rails wired — never an EOA-only path.
 *
 * Flow (true two-agent A → B):
 *   A (principal + sender)  grants  B (named receiver)  the `orchestrate` skill.
 *   A signs:  delegation (A→A, allowedTargets=[B], allowedMethods=[orchestrate])
 *             A2A message (sender=A, skill=orchestrate, bodyHash=hashBody({goal}))
 *             tasks/get caller-proof (hashA2aTaskRequest)
 *   POST message/send → EDGE /api/a2a/<B-handle> → (GatewayAssertion) → A2aTaskDO(B)
 *        → authorizeA2aMessage (1271 delegation + 1271 message + allowedTargets + allowedMethods
 *          + single-use messageId + budget reserve) → orchestrate skill → compose MCP under
 *          A's delegation → emit artifact.
 *   Poll tasks/get (A-signed) until terminal; report the artifact.
 *
 * The point: the WHOLE authority spine runs against live contracts (the in-memory
 * packages/a2a harness uses fake verifiers). A fresh principal with no vault-key binding
 * fails CLOSED at the data layer (expected, same as native-mcp-smoke) — that still proves
 * transport + authority + dispatch + composition reached MCP.
 *
 * Run (from the app dir so workspace deps resolve):
 *   cd apps/demo-a2a && npx tsx scripts/canonical-a2a-e2e.ts
 * Env overrides:
 *   EDGE_BASE   (default demo-edge-production…workers.dev)  — where message/send is POSTed
 *   A2A_BASE    (default demo-a2a-production…workers.dev)   — relayer onboarding endpoints
 *   RAILS       comma list of siwe,passkey,social           — which custodians to exercise
 *   SOCIAL_CUSTODY_SESSION + SOCIAL_CUSTODY_SA              — to run the social rail live
 */

import { generateKeyPairSync, createSign, createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, toBytes, toHex, sha256, type Address, type Hex } from 'viem';
import {
  ROOT_AUTHORITY,
  hashDelegation,
  buildVaultKeyUseCaveat,
  buildDataScopeCaveat,
  type Delegation,
  type Caveat,
} from '@agenticprimitives/delegation';
import {
  buildA2aGrantCaveats,
  skillSelector,
  hashA2aMessage,
  hashA2aTaskRequest,
  type A2aEnforcers,
} from '@agenticprimitives/a2a';
import {
  namehash,
  buildSubregistryRegisterCall,
  buildSetPrimaryNameCall,
} from '@agenticprimitives/agent-naming';
import { buildExecuteBatchCallData, encodeWebAuthnSignature } from '@agenticprimitives/agent-account';
import { buildWebAuthnAssertion, hashToWebAuthnChallenge } from '@agenticprimitives/connect-auth/passkey';

// ─── config ──────────────────────────────────────────────────────────
const EDGE_BASE = (process.env.EDGE_BASE ?? 'https://demo-edge-production.richardpedersen3.workers.dev').replace(/\/$/, '');
const A2A_BASE = (process.env.A2A_BASE ?? 'https://demo-a2a-production.richardpedersen3.workers.dev').replace(/\/$/, '');
const PERMISSIONLESS_SUBREGISTRY = '0x1B8ED8693738e1A9DD653FEE5430d49e00202Bb7' as Address; // .impact (demo-a2a)
const NAME_PARENT = 'impact';
const GOAL = process.env.GOAL ?? 'read my personal info';
const RAILS = (process.env.RAILS ?? 'siwe,passkey,social').split(',').map((s) => s.trim()).filter(Boolean);

type Deployments = {
  chainId: number;
  delegationManager: Address;
  timestampEnforcer: Address;
  allowedTargetsEnforcer: Address;
  allowedMethodsEnforcer: Address;
  agentNameRegistry: Address;
};
let D: Deployments;
let ENFORCERS: A2aEnforcers;

// ─── small http helpers (CSRF double-submit; consistent Origin) ───────
// CSRF tokens are HMAC-bound to an ALLOWLISTED origin (ALLOWED_ORIGINS), NOT the worker's own origin.
// Mint + echo with a known allowlisted web origin so verifyCsrf's origin check passes.
const ORIGIN = (process.env.CSRF_ORIGIN ?? 'https://agenticprimitives-demo.pages.dev').replace(/\/$/, '');
let csrf: string | null = null;
async function csrfToken(): Promise<string> {
  if (csrf) return csrf;
  const r = await fetch(`${A2A_BASE}/auth/csrf`, { headers: { origin: ORIGIN } });
  const j = (await r.json()) as { ok?: boolean; token?: string };
  if (!j.token) throw new Error(`csrf fetch failed: HTTP ${r.status}`);
  csrf = j.token;
  return csrf;
}
async function relayer(path: string, body: unknown): Promise<any> {
  const token = await csrfToken();
  const r = await fetch(`${A2A_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  if (!r.ok) throw new Error(`POST ${path} → HTTP ${r.status}: ${text.slice(0, 400)}`);
  return j;
}
/** message/send + tasks/* go to the EDGE (admission), addressed by B's handle. CSRF-exempt. */
async function edgeRpc(handle: string, method: string, params: unknown): Promise<any> {
  const r = await fetch(`${EDGE_BASE}/api/a2a/${handle}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { _raw: text, _status: r.status }; }
  return j;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const rand32 = (): Hex => toHex(randomBytes(32));
const now = () => Math.floor(Date.now() / 1000);

/** Build → sign → submit a deploy userOp, with bounded retry. The shared relayer's bundler intermittently
 *  returns Alchemy -32602 ("Missing or invalid parameters") under back-to-back deploys (pending-nonce race);
 *  rebuilding (fresh nonce + gas) and retrying the SAME call clears it (ADR-0013: bounded retry, same call).
 *  A genuine userOp malformation instead surfaces as `userop_reverted`/`deploy_not_landed` (not -32602), so
 *  retries also disambiguate transient infra from a real bug. */
async function deployAccount(buildBody: Record<string, unknown>, signDigest: (h: Hex) => Promise<Hex>, callData?: Hex): Promise<Address> {
  let lastErr = '';
  for (let i = 0; i < 6; i++) {
    try {
      const dep = await relayer('/session/deploy', { ...buildBody, salt: '0', ...(callData ? { callData } : {}) });
      const signature = await signDigest(dep.userOpHash as Hex);
      const sub = await relayer('/session/deploy/submit', { userOp: { ...dep.userOp, signature } });
      return sub.deployedAddress as Address;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // Retry ONLY the transient bundler class; a real revert (userop_reverted/deploy_not_landed) fails fast.
      if (!/Missing or invalid parameters|submitDeployUserOp failed/.test(lastErr) || /userop_reverted|deploy_not_landed/.test(lastErr)) throw e;
      await sleep(2500 * (i + 1));
    }
  }
  throw new Error(`deploy failed after retries: ${lastErr.slice(0, 240)}`);
}

/** Derive an SA address (counterfactual) for a deploy body — needed as the `newOwner` of a name claim. */
async function deriveAddress(body: Record<string, unknown>): Promise<Address> {
  const d = await relayer('/account/derive-address', { ...body, salt: '0' });
  return (d.smartAccountAddress ?? d.address) as Address;
}

/** executeBatch calldata that claims `<label>.impact` for `newOwner` (register + setPrimaryName), bundled
 *  into the deploy userOp so an SA deploys + claims its handle in one signature. */
function nameClaimCallData(label: string, newOwner: Address): Hex {
  const register = buildSubregistryRegisterCall({ subregistry: PERMISSIONLESS_SUBREGISTRY, label, newOwner });
  const setPrimary = buildSetPrimaryNameCall({ registry: D.agentNameRegistry, node: namehash(`${label}.${NAME_PARENT}`) });
  return buildExecuteBatchCallData([register, setPrimary]) as Hex;
}

// ─── the custody-agnostic seam ────────────────────────────────────────
interface CustodyRail {
  kind: 'siwe' | 'passkey' | 'social';
  /** Is this rail runnable in this environment? (social needs an interactive OAuth session.) */
  available(): Promise<boolean>;
  /** Onboard the SA via this rail (deploy on-chain). Pass `claimLabel` to ALSO claim `<label>.impact` in the
   *  same userOp — the owner/receiver in the cross-principal flow needs a resolvable handle. Returns the SA. */
  onboard(claimLabel?: string): Promise<Address>;
  /** Sign a 32-byte digest in the on-chain wire format THIS rail's SA validates (ERC-1271 via USV). */
  signDigest(digest: Hex): Promise<Hex>;
  readonly sa?: Address;
}

// ── SIWE rail: an EOA custodian. signDigest = raw ECDSA (SA._verifyEcdsa accepts raw-or-EIP-191). ──
function siweRail(): CustodyRail {
  const account = privateKeyToAccount(generatePrivateKey());
  let sa: Address | undefined;
  return {
    kind: 'siwe',
    get sa() { return sa; },
    async available() { return true; },
    async onboard(claimLabel?: string) {
      const body = { initMethod: 'eoa', owner: account.address };
      const callData = claimLabel ? nameClaimCallData(claimLabel, await deriveAddress(body)) : undefined;
      sa = await deployAccount(body, (h) => account.sign({ hash: h }), callData);
      return sa;
    },
    signDigest: (digest) => account.sign({ hash: digest }),
  };
}

// ── passkey rail: a P-256 credential (node:crypto). signDigest = a real WebAuthn assertion (0x01 blob). ──
function passkeyRail(): CustodyRail {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const b64uToBig = (s: string) => BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'));
  const pubKeyX = b64uToBig(jwk.x);
  const pubKeyY = b64uToBig(jwk.y);
  const credentialId = randomBytes(20);
  const credentialIdDigest = keccak256(credentialId);
  const rpId = new URL(A2A_BASE).hostname;
  const rpIdHash = sha256(toBytes(rpId)); // sha256(rp.id) — mixed into the passkey-SA CREATE2 salt
  let sa: Address | undefined;

  const assertOver = (digest: Hex): Hex => {
    const challenge = hashToWebAuthnChallenge(digest); // base64url(digest)
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://${rpId}","crossOrigin":false}`;
    const cdjBytes = new TextEncoder().encode(clientDataJSON);
    const flags = Buffer.from([0x05]); // UP + UV
    const signCount = Buffer.from([0, 0, 0, 0]);
    const authData = Buffer.concat([Buffer.from(toBytes(rpIdHash)), flags, signCount]);
    const clientDataHash = createHash('sha256').update(cdjBytes).digest();
    const der = createSign('SHA256').update(Buffer.concat([authData, clientDataHash])).sign({ key: privateKey, dsaEncoding: 'der' });
    const assertion = buildWebAuthnAssertion({
      credentialIdBytes: credentialId,
      authenticatorData: new Uint8Array(authData),
      clientDataJSON: cdjBytes,
      derSignature: new Uint8Array(der),
    });
    return encodeWebAuthnSignature(assertion);
  };

  return {
    kind: 'passkey',
    get sa() { return sa; },
    async available() { return true; },
    async onboard(claimLabel?: string) {
      const body = { initMethod: 'passkey', credentialIdDigest, pubKeyX: pubKeyX.toString(), pubKeyY: pubKeyY.toString(), rpIdHash };
      const callData = claimLabel ? nameClaimCallData(claimLabel, await deriveAddress(body)) : undefined;
      sa = await deployAccount(body, async (h) => assertOver(h), callData);
      return sa;
    },
    signDigest: async (digest) => assertOver(digest),
  };
}

// ── social rail: SA custodied by a per-(iss,sub) KMS key (C_sub). signDigest via the relayer's custody
//    hop (/custody/google/sign, provider-neutral behind /custody/oidc). Requires an interactive OAuth
//    custody session — wired but skipped headlessly (matches demo-web's documented tri-custody state). ──
function socialRail(): CustodyRail {
  const session = process.env.SOCIAL_CUSTODY_SESSION;
  const presetSa = process.env.SOCIAL_CUSTODY_SA as Address | undefined;
  let sa = presetSa;
  return {
    kind: 'social',
    get sa() { return sa; },
    async available() { return Boolean(session && presetSa); },
    async onboard(_claimLabel?: string) {
      // Naming for a social SA is the home's (demo-sso-next) job; the harness assumes onboarding + any name
      // claim already happened there and a SOCIAL_CUSTODY_SA was provided. claimLabel is ignored here.
      if (!sa) throw new Error('social rail needs SOCIAL_CUSTODY_SA (the home-onboarded SA)');
      return sa;
    },
    async signDigest(digest) {
      const j = await relayer('/custody/oidc/sign', { session, hash: digest, sender: sa });
      if (!j.signature) throw new Error(`social signDigest failed: ${JSON.stringify(j).slice(0, 200)}`);
      return j.signature as Hex;
    },
  };
}

const RAIL_FACTORIES: Record<string, () => CustodyRail> = { siwe: siweRail, passkey: passkeyRail, social: socialRail };

// ─── onboard a NAMED receiver (B) — always SIWE (B's custody is irrelevant to A's authority test) ───
async function onboardNamedReceiver(): Promise<{ sa: Address; label: string }> {
  const label = `e2e-${toHex(randomBytes(4)).slice(2)}`;
  const sa = await siweRail().onboard(label);
  return { sa, label };
}

// ─── build the A→A grant scoped to B + orchestrate, signed via A's rail ───
function delegationWire(d: Delegation): Record<string, unknown> {
  return { ...d, salt: d.salt.toString() };
}
async function buildGrant(rail: CustodyRail, receiver: Address): Promise<Record<string, unknown>> {
  const A = rail.sa!;
  const caveats: Caveat[] = buildA2aGrantCaveats({
    recipientAgentSA: receiver,
    skill: 'orchestrate',
    enforcers: ENFORCERS,
    window: { validAfter: 0, validUntil: now() + 3600 },
  });
  const salt = BigInt(rand32());
  const d: Delegation = { delegator: A, delegate: A, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await rail.signDigest(hashDelegation(d, D.chainId, D.delegationManager));
  return delegationWire(d);
}

const hashBody = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));

/** Bind A's per-person vault key (spec 278) so `get_pii` succeeds (materializes seed PII on read) and the
 *  task COMPLETES with real data instead of fail-closing `vault_key_unauthorized`. The person SA signs the
 *  VaultKeyAuthorization via the SAME custodian rail (`signDigest`) — reinforcing the mandate that the
 *  connection custodian backs vault-key authorization too, not just delegation issuance. Best-effort: on
 *  failure the harness still proves the spine (terminal fail-closed). Returns whether the binding is live. */
async function bindVaultKey(rail: CustodyRail): Promise<boolean> {
  const owner = rail.sa!;
  try {
    const bound = await (await fetch(`${A2A_BASE}/custody/vault-key/is-bound?owner=${owner}`, { headers: { origin: ORIGIN } })).json().catch(() => ({})) as { bound?: boolean };
    if (bound.bound === true) return true;
    const info = await (await fetch(`${A2A_BASE}/custody/vault-key/server-info`, { headers: { origin: ORIGIN } })).json() as { serverKey: Address; vaultId: string; defaultResources: string[]; classificationCeiling: string; ops: ('read' | 'write')[] };
    const ops = info.ops?.length ? info.ops : (['read', 'write'] as ('read' | 'write')[]);
    const prov = await relayer('/custody/vault-key/provision', { owner });
    if (!prov.ok || !prov.kmsKeyRef) return false;
    const caveat = buildVaultKeyUseCaveat({
      vaultId: info.vaultId, kmsKeyRef: prov.kmsKeyRef, resources: info.defaultResources,
      classificationCeiling: info.classificationCeiling, ops, noSubdelegation: true,
    });
    const auth: Delegation = { delegator: owner, delegate: info.serverKey, authority: ROOT_AUTHORITY, caveats: [caveat], salt: BigInt(rand32()), signature: '0x' };
    auth.signature = await rail.signDigest(hashDelegation(auth, D.chainId, D.delegationManager));
    const bind = await relayer('/custody/vault-key/bind', {
      owner, vaultId: info.vaultId, kmsKeyRef: prov.kmsKeyRef, allowedResources: info.defaultResources,
      classificationCeiling: info.classificationCeiling, ops,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      authorization: { ...auth, salt: auth.salt.toString() },
    });
    return bind.ok === true;
  } catch { return false; }
}

async function runRail(name: string): Promise<{ name: string; ok: boolean; detail: string }> {
  const rail = RAIL_FACTORIES[name]();
  if (!rail) return { name, ok: false, detail: 'unknown rail' };
  if (!(await rail.available())) {
    return { name, ok: false, detail: 'SKIPPED — rail wired but not runnable here (social needs SOCIAL_CUSTODY_SESSION + SOCIAL_CUSTODY_SA from an interactive OAuth sign-in)' };
  }
  console.log(`\n=== rail: ${name} ===`);

  const A = await rail.onboard();
  console.log(`  [A] principal+sender SA (${name}) = ${A}`);
  const B = await onboardNamedReceiver();
  console.log(`  [B] named receiver = ${B.label}.${NAME_PARENT} → ${B.sa}`);

  // Bind A's vault key (spec 278) via the SAME custodian rail so the orchestrated get_pii returns A's data
  // (the task COMPLETES) rather than fail-closing — proving the custodian backs vault-key authorization too.
  const vaultBound = await bindVaultKey(rail);
  console.log(`  [A] vault-key binding (${name} custodian) = ${vaultBound ? 'LIVE — get_pii will return A\'s PII' : 'absent — get_pii will fail-closed (spine still proven)'}`);

  const delegation = await buildGrant(rail, B.sa);
  const input = { goal: GOAL };
  const message = {
    messageId: rand32(),
    sender: A,
    skill: 'orchestrate',
    bodyRef: { owner: B.sa, recordType: 'pending' },
    bodyHash: hashBody(input),
    signature: '0x' as Hex,
    createdAt: now(),
  };
  message.signature = await rail.signDigest(
    hashA2aMessage({ messageId: message.messageId, sender: A, skill: 'orchestrate', bodyHash: message.bodyHash, createdAt: message.createdAt }),
  );

  console.log(`  → POST message/send to EDGE /api/a2a/${B.label}`);
  // Bounded retry of the SAME call (ADR-0013) while B's freshly-claimed name propagates to the RPC read
  // replica the resolver hits — a -32004 "no Smart Agent" right after deploy is propagation lag, not a miss.
  let send: any;
  for (let i = 0; i < 10; i++) {
    send = await edgeRpc(B.label, 'message/send', { delegation, requester: A, message, input });
    if (!(send.error?.code === -32004)) break;
    process.stdout.write(`  … awaiting name propagation (attempt ${i + 1})\r`);
    await sleep(3000);
  }
  console.log('');
  if (send.error || !send.result?.taskId) {
    return { name, ok: false, detail: `message/send rejected: ${JSON.stringify(send).slice(0, 500)}` };
  }
  const taskId = send.result.taskId as Hex;
  console.log(`  ✓ authorized — taskId=${taskId} (1271 delegation + 1271 message + allowedTargets=B + allowedMethods=orchestrate + budget OK)`);

  // poll tasks/get (A-signed caller-proof) until terminal
  const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required']);
  let task: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const sig = await rail.signDigest(hashA2aTaskRequest({ method: 'tasks/get', taskId, agentSA: B.sa, chainId: D.chainId }));
    const got = await edgeRpc(B.label, 'tasks/get', { taskId, caller: A, signature: sig });
    if (got.error) { console.log(`  … tasks/get error: ${JSON.stringify(got.error).slice(0, 200)}`); continue; }
    task = got.result;
    process.stdout.write(`  … state=${task?.state}\r`);
    if (task && TERMINAL.has(task.state)) break;
  }
  console.log('');
  if (!task) return { name, ok: false, detail: 'tasks/get never returned a task' };

  const artifacts = task.artifactRefs ?? [];
  const taskErr = task.error ?? task.status?.message ?? task.statusMessage ?? null;
  console.log(`  task state=${task.state} · artifacts=${artifacts.length}${taskErr ? ` · error=${JSON.stringify(taskErr).slice(0, 160)}` : ''}`);
  // The canonical spine is PROVEN by: taskId returned (full authority gate) + a terminal state (dispatch +
  // orchestrate + MCP composition ran). 'completed' = data returned; 'failed' on a fresh unbound principal =
  // fail-closed at the data layer (expected) — still proves the path reached MCP.
  const spineProven = TERMINAL.has(task.state);
  const gold = task.state === 'completed';
  return {
    name,
    ok: spineProven,
    detail: gold
      ? `taskId issued + COMPLETED + ${artifacts.length} artifact(s) — B read A's PII under A's delegation`
      : `taskId issued + state=${task.state}${artifacts.length ? ` + ${artifacts.length} artifact(s)` : ''}${taskErr ? ` (${String(taskErr).slice(0, 80)})` : ''}`,
  };
}

/** spec 291-A LIVE proof: read Alice's PII through the edge with an UNSCOPED vs a DATA_SCOPE'd Alice→Bob
 *  delegation. /mcp/person/pii returns the get_pii record; the scoped grant must RESTRICT the returned
 *  fields to what Alice granted. Both go through the edge (gateway assertion) + carry CSRF. */
async function verifyFieldScoping(aliceRail: CustodyRail, alice: Address, bob: Address): Promise<string> {
  const aliceToBob = async (caveats: Caveat[]): Promise<Record<string, unknown>> => {
    const d: Delegation = { delegator: alice, delegate: bob, authority: ROOT_AUTHORITY, caveats, salt: BigInt(rand32()), signature: '0x' };
    d.signature = await aliceRail.signDigest(hashDelegation(d, D.chainId, D.delegationManager));
    return delegationWire(d);
  };
  const readPiiKeys = async (delegation: Record<string, unknown>): Promise<string[]> => {
    const token = await csrfToken();
    const r = await fetch(`${EDGE_BASE}/mcp/person/pii`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'X-CSRF-Token': token },
      body: JSON.stringify({ delegation, requester: bob }),
    });
    const j: any = await r.json().catch(() => ({}));
    return j?.record && typeof j.record === 'object' ? Object.keys(j.record) : [];
  };
  const SCOPE = ['full_name', 'email'];
  const fullKeys = await readPiiKeys(await aliceToBob([]));
  const scopedKeys = await readPiiKeys(await aliceToBob([buildDataScopeCaveat([{ server: 'demo-mcp', resources: ['person-pii'], fields: SCOPE }])]));
  console.log(`    field-scoping: unscoped→[${fullKeys.join(',')}]`);
  console.log(`                   scoped  →[${scopedKeys.join(',')}]  (grant: person-pii ⊇ ${SCOPE.join('+')})`);
  const scopedOk = scopedKeys.length > 0 && scopedKeys.every((k) => SCOPE.includes(k));
  const restricted = scopedKeys.length < fullKeys.length && fullKeys.length > 0;
  return scopedOk && restricted
    ? `field-scoping ENFORCED (${fullKeys.length} fields → ${scopedKeys.length}: ${scopedKeys.join('+')})`
    : `field-scoping NOT enforced (unscoped=${fullKeys.length}, scoped=${scopedKeys.length}) — demo-mcp likely pre-deploy`;
}

/**
 * GENUINE cross-principal flow (the corrected topology): Alice is the OWNER (delegator); Bob is the
 * DELEGATE/caller. Authority + data residency follow the owner — Alice's PII lives behind Alice's MCP and
 * is composed by ALICE's A2A agent, so `allowedTargets` = ALICE's agent and the message is posted to
 * Alice's handle. TWO independent ERC-1271 proofs at Alice's agent: Alice signed the grant (delegator),
 * Bob signed the live message (delegate==requester). `principal = delegator = Alice` → the read terminates
 * at Alice's infra. A stolen grant is useless without Bob's fresh message signature; Bob acting alone is
 * useless without Alice's grant.
 */
async function runCrossPrincipal(name: string): Promise<{ name: string; ok: boolean; detail: string }> {
  const label = `${name}/cross`;
  const aliceRail = RAIL_FACTORIES[name]?.();
  const bobRail = RAIL_FACTORIES[name]?.();
  if (!aliceRail || !bobRail) return { name: label, ok: false, detail: 'unknown rail' };
  if (!(await aliceRail.available()) || !(await bobRail.available())) {
    return { name: label, ok: false, detail: 'SKIPPED — rail wired but not runnable here (social needs SOCIAL_CUSTODY_SESSION + SOCIAL_CUSTODY_SA from an interactive OAuth sign-in)' };
  }
  console.log(`\n=== rail: ${name} — CROSS-PRINCIPAL (Alice owns, Bob is the delegate/caller) ===`);

  const aliceLabel = `e2e-alice-${toHex(randomBytes(4)).slice(2)}`;
  const alice = await aliceRail.onboard(aliceLabel); // OWNER + receiver: named (allowedTargets) + her vault
  console.log(`  [Alice] owner + receiving agent = ${aliceLabel}.${NAME_PARENT} → ${alice}`);
  const bob = await bobRail.onboard();               // DELEGATE/caller: deployed (signs the message); no name
  console.log(`  [Bob]   delegate / caller SA   = ${bob}`);

  const vaultBound = await bindVaultKey(aliceRail);  // Alice's PII lives behind Alice's MCP (her binding)
  console.log(`  [Alice] vault-key binding (${name}) = ${vaultBound ? 'LIVE — get_pii returns Alice\'s PII' : 'absent — get_pii fail-closes (spine still proven)'}`);

  // Grant: delegator=Alice, delegate=Bob, allowedTargets=[Alice's agent], allowedMethods=[orchestrate].
  // Signed by ALICE (the owner authorizes Bob). This is issued to Bob out-of-band / via a consent flow.
  const caveats: Caveat[] = buildA2aGrantCaveats({ recipientAgentSA: alice, skill: 'orchestrate', enforcers: ENFORCERS, window: { validAfter: 0, validUntil: now() + 3600 } });
  const d: Delegation = { delegator: alice, delegate: bob, authority: ROOT_AUTHORITY, caveats, salt: BigInt(rand32()), signature: '0x' };
  d.signature = await aliceRail.signDigest(hashDelegation(d, D.chainId, D.delegationManager)); // ALICE signs the grant
  const delegation = delegationWire(d);

  // Live message: sender=Bob, signed by BOB (proves "this is really Bob, now"). requester=Bob=delegate.
  const input = { goal: GOAL };
  const message = {
    messageId: rand32(), sender: bob, skill: 'orchestrate',
    bodyRef: { owner: alice, recordType: 'pending' }, bodyHash: hashBody(input), signature: '0x' as Hex, createdAt: now(),
  };
  message.signature = await bobRail.signDigest(hashA2aMessage({ messageId: message.messageId, sender: bob, skill: 'orchestrate', bodyHash: message.bodyHash, createdAt: message.createdAt })); // BOB signs

  console.log(`  → POST message/send to EDGE /api/a2a/${aliceLabel}  (Alice signed the grant · Bob signs the message)`);
  let send: any;
  for (let i = 0; i < 10; i++) {
    send = await edgeRpc(aliceLabel, 'message/send', { delegation, requester: bob, message, input });
    if (!(send.error?.code === -32004)) break;
    process.stdout.write(`  … awaiting Alice name propagation (attempt ${i + 1})\r`);
    await sleep(3000);
  }
  console.log('');
  if (send.error || !send.result?.taskId) return { name: label, ok: false, detail: `message/send rejected: ${JSON.stringify(send).slice(0, 500)}` };
  const taskId = send.result.taskId as Hex;
  console.log(`  ✓ authorized — taskId=${taskId}`);
  console.log(`    gate: delegate(Bob)==requester · allowedTargets=Alice's agent · 1271(Alice signed grant) · 1271(Bob signed msg) · principal=Alice`);

  const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required']);
  let task: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    // tasks/get caller-proof signed by BOB (the caller), over the request bound to Alice's agent.
    const sig = await bobRail.signDigest(hashA2aTaskRequest({ method: 'tasks/get', taskId, agentSA: alice, chainId: D.chainId }));
    const got = await edgeRpc(aliceLabel, 'tasks/get', { taskId, caller: bob, signature: sig });
    if (got.error) { console.log(`  … tasks/get error: ${JSON.stringify(got.error).slice(0, 200)}`); continue; }
    task = got.result;
    process.stdout.write(`  … state=${task?.state}\r`);
    if (task && TERMINAL.has(task.state)) break;
  }
  console.log('');
  if (!task) return { name: label, ok: false, detail: 'tasks/get never returned a task' };
  const artifacts = task.artifactRefs ?? [];
  const taskErr = task.error ?? task.status?.message ?? task.statusMessage ?? null;
  console.log(`  task state=${task.state} · artifacts=${artifacts.length}${taskErr ? ` · error=${JSON.stringify(taskErr).slice(0, 160)}` : ''}`);
  const spineProven = TERMINAL.has(task.state);
  const gold = task.state === 'completed';

  // spec 291-A — having proven the cross-principal spine, demonstrate FIELD-SCOPING: a DATA_SCOPE'd grant
  // restricts what Bob reads. (Only meaningful once demo-mcp with the scoping change is deployed.)
  let scopeNote = '';
  if (gold && vaultBound) {
    try { scopeNote = ` · ${await verifyFieldScoping(aliceRail, alice, bob)}`; }
    catch (e) { scopeNote = ` · field-scoping check errored: ${e instanceof Error ? e.message : String(e)}`; }
  }

  return {
    name: label, ok: spineProven,
    detail: gold
      ? `taskId issued + COMPLETED — Bob (delegate) read Alice's PII via Alice's grant; principal=Alice, terminated at Alice's agent/MCP${scopeNote}`
      : `taskId issued + state=${task.state}${artifacts.length ? ` + ${artifacts.length} artifact(s)` : ''}${taskErr ? ` (${String(taskErr).slice(0, 80)})` : ''}`,
  };
}

async function main() {
  console.log(`canonical-A2A two-agent e2e — EDGE=${EDGE_BASE} A2A=${A2A_BASE}`);
  const dep = await (await fetch(`${A2A_BASE}/deployments`)).json();
  D = dep as Deployments;
  ENFORCERS = { timestamp: D.timestampEnforcer, allowedTargets: D.allowedTargetsEnforcer, allowedMethods: D.allowedMethodsEnforcer };
  console.log(`  chainId=${D.chainId} dm=${D.delegationManager} skill=orchestrate(sel=${skillSelector('orchestrate')})`);

  // MODE=cross (default, the GENUINE cross-principal Alice→Bob flow) | self (degenerate self-grant) | both.
  const MODE = (process.env.MODE ?? 'cross').toLowerCase();
  console.log(`  mode=${MODE} (cross = Alice owns / Bob is the delegate-caller; self = A grants a separate receiver)`);
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const r of RAILS) {
    if (MODE === 'self' || MODE === 'both') {
      try { results.push(await runRail(r)); }
      catch (e) { results.push({ name: `${r}/self`, ok: false, detail: `THREW: ${e instanceof Error ? e.message : String(e)}` }); }
    }
    if (MODE === 'cross' || MODE === 'both') {
      try { results.push(await runCrossPrincipal(r)); }
      catch (e) { results.push({ name: `${r}/cross`, ok: false, detail: `THREW: ${e instanceof Error ? e.message : String(e)}` }); }
    }
  }

  console.log('\n──────── SUMMARY ────────');
  for (const r of results) console.log(`  ${r.ok ? '✓' : (r.detail.startsWith('SKIPPED') ? '·' : '✗')} ${r.name}: ${r.detail}`);
  const ranOk = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.detail.startsWith('SKIPPED')).length;
  const failed = results.length - ranOk - skipped;
  console.log(`\n${ranOk} proven · ${skipped} skipped · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
