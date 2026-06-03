// Browser orchestration for the real wallet (SIWE) connect → resolve → bootstrap
// → PII, all against the live broker + the deployed demo-a2a worker (via /a2a).
import { buildMessage } from '@agenticprimitives/connect-auth/siwe';
import { buildSubregistryRegisterCall, buildSetPrimaryNameCall } from '@agenticprimitives/agent-naming';
import { buildExecuteCallData, buildExecuteBatchCallData, AgentAccountClient } from '@agenticprimitives/agent-account';
import {
  buildProposeEdgeCall,
  buildConfirmEdgeCall,
  computeEdgeId,
  RELATIONSHIP_TYPE,
  type RelationshipType,
} from '@agenticprimitives/agent-relationships';
import type { Address, Hex } from '@agenticprimitives/types';
import { encodeFunctionData, createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { connectWallet, personalSign } from './lib/wallet';
import { registerPasskey, signWithPasskey, signWithDiscoverablePasskey, loadPasskey, type DemoPasskey } from './lib/passkey';
import { ensureCsrfToken, csrfHeaders } from './csrf';
import { CONTRACTS, DEFAULT_RPC_URL } from './lib/chain';
import { issueSiteDelegation, toWire, type DelegationWire } from './lib/delegation';
import { buildRelatedAgentCredential, relatedAgentProofHash } from '@agenticprimitives/related-agents';

/** A function that signs a 32-byte hash (EOA personal_sign or WebAuthn). */
export type SignHash = (hash: Hex) => Promise<Hex>;

export const AUD = 'demo-sso';
const CHAIN_ID = 84532;

export type SiweOutcome =
  | { status: 'issued'; token: string; address: Address; agent: Address }
  | { status: 'bootstrap'; address: Address }
  | { status: 'disambiguate' | 'rejected'; address?: Address; reason?: string };

async function getNonce(): Promise<string> {
  const r = await fetch('/connect/nonce');
  if (!r.ok) throw new Error('nonce fetch failed');
  return ((await r.json()) as { nonce: string }).nonce;
}

/** Connect a wallet, sign SIWE, resolve to an AgentSession (or signal bootstrap). */
export async function siweLogin(): Promise<SiweOutcome> {
  const address = await connectWallet();
  const nonce = await getNonce();
  const message = buildMessage({
    domain: window.location.host,
    address,
    uri: window.location.origin,
    chainId: CHAIN_ID,
    nonce,
    statement: 'Sign in to Agentic Connect — proving you control this wallet.',
  });
  const signature = await personalSign(address, message);
  const r = await fetch('/connect/siwe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature, aud: AUD }),
  });
  const body = (await r.json()) as { status: string; token?: string; agent?: string; reason?: string };
  if (body.status === 'issued' && body.token) {
    return { status: 'issued', token: body.token, address, agent: (body.agent ?? address) as Address };
  }
  if (body.status === 'bootstrap') return { status: 'bootstrap', address };
  return { status: (body.status as 'disambiguate' | 'rejected') ?? 'rejected', address, reason: body.reason };
}

/** Bootstrap: deploy a person SA (EOA custodian) via demo-a2a, then enroll the facet. */
export async function bootstrapWithWallet(
  address: Address,
  onStep?: (s: string) => void,
): Promise<{ ok: true; agent: Address } | { ok: false; error: string }> {
  await ensureCsrfToken();
  onStep?.('Preparing your workspace…');
  const buildRes = await fetch('/a2a/session/deploy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ initMethod: 'eoa', owner: address }),
  });
  if (buildRes.status === 409) {
    return { ok: false, error: 'Gas sponsorship is not enabled on the backend (paymaster).' };
  }
  const built = (await buildRes.json()) as {
    ok?: boolean;
    sender?: Address;
    userOpHash?: Hex;
    userOp?: Record<string, unknown>;
    error?: string;
  };
  if (!buildRes.ok || !built.ok || !built.userOpHash || !built.userOp) {
    return { ok: false, error: built.error ?? `deploy build failed (HTTP ${buildRes.status})` };
  }
  onStep?.('Confirm in your wallet…');
  const signature = await personalSign(address, built.userOpHash);
  onStep?.('Securing on the network…');
  const submitRes = await fetch('/a2a/session/deploy/submit', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ userOp: { ...built.userOp, signature } }),
  });
  const submitted = (await submitRes.json()) as {
    ok?: boolean;
    deployedAddress?: Address;
    error?: string;
    detail?: string;
  };
  if (!submitRes.ok || !submitted.ok || !submitted.deployedAddress) {
    return {
      ok: false,
      error: [submitted.error, submitted.detail].filter(Boolean).join(' — ') || `deploy submit failed (HTTP ${submitRes.status})`,
    };
  }
  const agent = submitted.deployedAddress;
  // No separate enroll step: /connect/siwe derives the SA + records the facet on
  // the reconnect (with a post-deploy poll for RPC lag), so this is just the deploy.
  return { ok: true, agent };
}

/** Execute a call FROM a deployed agent: build userOp -> sign hash -> submit (via /a2a).
 *
 *  The hard part is the nonce. A just-deployed SA consumed nonce 0 in its deploy op, so its
 *  first post-deploy op needs nonce 1 — but the relayer's `getNonce` read can lag and return
 *  0, producing `AA25 invalid account nonce` (the wrong nonce is baked into the signature, so
 *  resubmitting the same op can't fix it). `minNonce` gates this: we poll the BUILD (no
 *  signing — no credential prompt) until the relayer's view reaches the expected nonce, THEN
 *  sign ONCE and submit. So we never sign a stale-nonce op, and the passkey/wallet is prompted
 *  exactly once. If a submit still fails (residual simulation lag, or an unexpected AA25), we
 *  rebuild+resign on the next loop with a fresh nonce. */
async function executeCall(
  sender: Address,
  signHash: SignHash,
  callData: Hex,
  opts: { minNonce?: bigint; attempts?: number } = {},
): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }> {
  const { minNonce, attempts = 4 } = opts;
  await ensureCsrfToken();
  let lastErr = 'execute failed';

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2500));

    // Build (no signing yet → no credential prompt on this step).
    const buildRes = await fetch('/a2a/account/build-call-userop', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ sender, callData }),
    });
    const b = (await buildRes.json()) as {
      ok?: boolean;
      userOpHash?: Hex;
      userOp?: (Record<string, unknown> & { nonce?: string });
      error?: string;
      detail?: string;
    };
    if (!buildRes.ok || !b.ok || !b.userOpHash || !b.userOp) {
      lastErr = [b.error, b.detail].filter(Boolean).join(' — ') || `build-call failed (HTTP ${buildRes.status})`;
      continue;
    }

    // Nonce gate: don't sign until the relayer's nonce view reflects the deploy.
    if (minNonce !== undefined && BigInt(b.userOp.nonce ?? '0') < minNonce) {
      lastErr = `relayer nonce ${b.userOp.nonce} < ${minNonce} — deploy not yet propagated`;
      continue; // rebuild next loop; still no prompt
    }

    // Sign ONCE for this (correct-nonce) op, then submit.
    const signature = await signHash(b.userOpHash);
    const submitRes = await fetch('/a2a/account/submit-call-userop', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ userOp: { ...b.userOp, signature } }),
    });
    const submitted = (await submitRes.json()) as { ok?: boolean; transactionHash?: Hex; error?: string; detail?: string };
    if (submitRes.ok && submitted.ok) return { ok: true, txHash: submitted.transactionHash };
    lastErr =
      [submitted.error, submitted.detail].filter(Boolean).join(' — ') || `submit-call failed (HTTP ${submitRes.status})`;
  }
  return { ok: false, error: lastErr };
}

/** Claim a forced-unique `<base>[N].demo.agent` for the agent + set it as primary.
 *  register + setPrimaryName are BATCHED into one execute UserOp (one nonce, one signature):
 *  they must land together, and the batch avoids an inter-userOp race where the second op
 *  sees a stale view of the first's state. `minNonce` rides out the post-deploy nonce lag
 *  (pass the nonce the SA must be at after its deploy, e.g. 1n right after a fresh deploy). */
export async function claimName(
  agent: Address,
  signHash: SignHash,
  base: string,
  onStep?: (s: string) => void,
  minNonce?: bigint,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  onStep?.('Finding a free name…');
  const nameRes = await fetch(`/connect/name?base=${encodeURIComponent(base)}`);
  const picked = (await nameRes.json()) as { label?: string; name?: string; node?: Hex; error?: string };
  if (!nameRes.ok || !picked.name || !picked.node || !picked.label) {
    return { ok: false, error: picked.error ?? 'no free name' };
  }

  onStep?.(`Claiming ${picked.name}…`);
  const register = buildSubregistryRegisterCall({
    subregistry: CONTRACTS.permissionlessSubregistry,
    label: picked.label,
    newOwner: agent,
  });
  const setPrimary = buildSetPrimaryNameCall({ registry: CONTRACTS.agentNameRegistry, node: picked.node });
  const batch = buildExecuteBatchCallData([register, setPrimary]);
  const res = await executeCall(agent, signHash, batch, { minNonce, attempts: 10 });
  if (!res.ok) return { ok: false, error: `name claim failed: ${res.error}` };
  return { ok: true, name: picked.name };
}

// ── Passkey (WebAuthn) ──────────────────────────────────────────────
export type { DemoPasskey };
export type PasskeyOutcome =
  | { status: 'issued'; token: string; passkey: DemoPasskey }
  | { status: 'bootstrap'; passkey: DemoPasskey }
  | { status: 'disambiguate' | 'rejected'; passkey?: DemoPasskey; reason?: string };

/** A signHash backed by the ROOT passkey via a DISCOVERABLE WebAuthn assertion
 *  (spec 233, Mechanism A): empty allowCredentials, no localStorage — the platform
 *  offers the (possibly synced) passkey for this RP, so ROOT-signed ceremonies work
 *  on any device that has the passkey, not just the one that created it. The SA
 *  verifies the signature on-chain by credentialIdDigest, so a discovered key only
 *  works if it is genuinely a custodian. (`signWithPasskey` — localStorage-cached —
 *  is retained for callers that already hold the local passkey object.) */
export const passkeySignHash: SignHash = (hash) => signWithDiscoverablePasskey(hash);

// ── Google × KMS custody (spec 235): the server signs with the per-subject custodian ──
//
// A Google-only member never holds a key. demo-a2a derives their per-(iss,sub) custodian
// C_sub and signs on their behalf, gated by the custody session (verified vs the broker
// JWKS). So securing a home + giving permission are SERVER round-trips, not device gestures —
// their only gesture was signing in with Google.

/** A SignHash that has demo-a2a sign a digest with the member's KMS custodian. The custody
 *  session proves the member; demo-a2a derives C_sub + signs for `sender` (their SA). */
export function googleSignHash(sender: Address, sessionToken: string): SignHash {
  return async (hash: Hex): Promise<Hex> => {
    await ensureCsrfToken();
    const res = await fetch('/a2a/custody/google/sign', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ session: sessionToken, hash, sender }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; signature?: Hex; error?: string; detail?: string };
    if (!res.ok || !body.ok || !body.signature) {
      throw new Error([body.error, body.detail].filter(Boolean).join(' — ') || `custody sign failed (HTTP ${res.status})`);
    }
    return body.signature;
  };
}

/** Secure a home for a Google-only member: pick a free name, then have demo-a2a deploy their
 *  KMS-custodied SA + claim the name in ONE server-signed, sponsored userOp. */
export async function secureHomeWithGoogle(
  sessionToken: string,
  base: string,
  onStep?: (s: string) => void,
): Promise<{ ok: true; agent: Address; name: string } | { ok: false; error: string }> {
  onStep?.('Finding a free name…');
  const picked = (await (await fetch(`/connect/name?base=${encodeURIComponent(base)}`)).json()) as {
    label?: string;
    name?: string;
    node?: Hex;
    error?: string;
  };
  if (!picked.label || !picked.name || !picked.node) return { ok: false, error: picked.error ?? 'no free name' };
  onStep?.('Securing your home on the network…');
  await ensureCsrfToken();
  const res = await fetch('/a2a/custody/google/bootstrap-and-claim', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: sessionToken, label: picked.label, node: picked.node }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; agent?: Address; name?: string; error?: string; detail?: string };
  if (!res.ok || !body.ok || !body.agent) {
    return { ok: false, error: [body.error, body.detail].filter(Boolean).join(' — ') || `secure-home failed (HTTP ${res.status})` };
  }
  return { ok: true, agent: body.agent, name: body.name ?? picked.name };
}

/** Sign in with a passkey (registering one first if none on this device), then resolve. */
export async function passkeyLogin(registerIfMissing = true): Promise<PasskeyOutcome> {
  let passkey = loadPasskey();
  if (!passkey) {
    if (!registerIfMissing) return { status: 'rejected', reason: 'no passkey on this device' };
    passkey = await registerPasskey('Agentic Connect passkey');
  }
  const { challenge } = (await (await fetch('/connect/passkey-challenge')).json()) as { challenge: Hex };
  const signature = await signWithPasskey(challenge);
  const r = await fetch('/connect/passkey', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credentialIdDigest: passkey.credentialIdDigest,
      pubKeyX: passkey.pubKeyX.toString(),
      pubKeyY: passkey.pubKeyY.toString(),
      challenge,
      signature,
      aud: AUD,
    }),
  });
  const body = (await r.json()) as { status: string; token?: string };
  if (body.status === 'issued' && body.token) return { status: 'issued', token: body.token, passkey };
  if (body.status === 'bootstrap') return { status: 'bootstrap', passkey };
  return { status: (body.status as 'disambiguate' | 'rejected') ?? 'rejected', passkey };
}

// ── Deploy + claim in ONE userOp (ERC-4337 initCode + callData) ─────
// One signature instead of deploy-then-claim. The freshly-deployed account executes the name
// claim (register + set-primary) in the same op. Needs the SA address up front (the claim's
// newOwner) — derived deterministically from the passkey + salt (a factory view, no signature).

/** Deterministic passkey-direct SA address (mode 0, no custodians, the passkey, given salt). */
/** SHA-256 of `window.location.hostname` as a 32-byte hex string. The on-chain
 *  factory mixes `rpIdHash` into the CREATE2 salt for passkey-direct SAs, so
 *  predicting the SA address client-side MUST use the SAME value the server uses
 *  for the deploy userOp. The server defaults to `sha256(originHostname)` when
 *  the client doesn't pass an `rpIdHash` — historically the client passed
 *  nothing, the prediction used `ZERO_BYTES32`, and the deploy used
 *  `sha256(hostname)` → derived address mismatch → register fired on the
 *  predicted address while the deploy created an SA at a different address
 *  (orphan registry entry root cause, live-debug 2026-06-01).
 *
 *  By passing this value on every prediction AND every deploy POST body, both
 *  computations use the same `rpIdHash` and the SA address that gets registered
 *  is the SA address that actually deploys. (No fallback — ADR-0013 single
 *  mechanism: one consistent value end-to-end.) */
async function derivePasskeyRpIdHash(): Promise<Hex> {
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'impact-agent.me';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostname));
  const arr = Array.from(new Uint8Array(buf));
  return ('0x' + arr.map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

async function derivePasskeySa(passkey: DemoPasskey, salt: bigint): Promise<Address> {
  const accounts = new AgentAccountClient({
    rpcUrl: DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  const rpIdHash = await derivePasskeyRpIdHash();
  return accounts.getAddressForAgentAccount({
    custodians: [],
    passkey: {
      credentialIdDigest: passkey.credentialIdDigest,
      x: passkey.pubKeyX,
      y: passkey.pubKeyY,
      rpIdHash,
    },
    salt,
  });
}

/** Pick a free name + build the `executeBatch(register, setPrimary)` calldata the new SA runs
 *  to claim it (newOwner = the SA itself). Returned to ride along in the deploy userOp. */
async function buildClaimCallData(
  base: string,
  sa: Address,
  onStep?: (s: string) => void,
): Promise<{ ok: true; callData: Hex; name: string } | { ok: false; error: string }> {
  onStep?.('Finding a free name…');
  const picked = (await (await fetch(`/connect/name?base=${encodeURIComponent(base)}`)).json()) as {
    label?: string;
    name?: string;
    node?: Hex;
    error?: string;
  };
  if (!picked.name || !picked.node || !picked.label) return { ok: false, error: picked.error ?? 'no free name' };
  const register = buildSubregistryRegisterCall({ subregistry: CONTRACTS.permissionlessSubregistry, label: picked.label, newOwner: sa });
  const setPrimary = buildSetPrimaryNameCall({ registry: CONTRACTS.agentNameRegistry, node: picked.node });
  return { ok: true, callData: buildExecuteBatchCallData([register, setPrimary]), name: picked.name };
}

/** Bootstrap a passkey-direct person SA (no server custodian ever, P0-A). When `callData` is
 *  given, the deploy userOp ALSO executes it (e.g. claim the name) — one signature, not two. */
export async function bootstrapWithPasskey(
  passkey: DemoPasskey,
  onStep?: (s: string) => void,
  callData?: Hex,
): Promise<{ ok: true; agent: Address } | { ok: false; error: string }> {
  await ensureCsrfToken();
  onStep?.('Preparing your workspace…');
  // `rpIdHash` MUST match the value used in `derivePasskeySa` (sha256(hostname)).
  // The server's `/session/deploy` accepts an explicit `rpIdHash`; passing it
  // here removes the server's Origin-based fallback path so both sides use the
  // same value end-to-end (closes the orphan-registry root cause 2026-06-01).
  const rpIdHash = await derivePasskeyRpIdHash();
  const buildRes = await fetch('/a2a/session/deploy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({
      initMethod: 'passkey',
      credentialIdDigest: passkey.credentialIdDigest,
      pubKeyX: passkey.pubKeyX.toString(),
      pubKeyY: passkey.pubKeyY.toString(),
      rpIdHash,
      ...(callData ? { callData } : {}),
    }),
  });
  if (buildRes.status === 409) return { ok: false, error: 'Gas sponsorship is not enabled on the backend (paymaster).' };
  const built = (await buildRes.json()) as { ok?: boolean; userOpHash?: Hex; userOp?: Record<string, unknown>; error?: string };
  if (!buildRes.ok || !built.ok || !built.userOpHash || !built.userOp) {
    return { ok: false, error: built.error ?? `deploy build failed (HTTP ${buildRes.status})` };
  }
  onStep?.('Confirm with your device…');
  const signature = await signWithPasskey(built.userOpHash);
  onStep?.('Securing on the network…');
  const submitRes = await fetch('/a2a/session/deploy/submit', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ userOp: { ...built.userOp, signature } }),
  });
  const submitted = (await submitRes.json()) as {
    ok?: boolean;
    deployedAddress?: Address;
    error?: string;
    detail?: string;
  };
  if (!submitRes.ok || !submitted.ok || !submitted.deployedAddress) {
    return {
      ok: false,
      error: [submitted.error, submitted.detail].filter(Boolean).join(' — ') || `deploy submit failed (HTTP ${submitRes.status})`,
    };
  }
  const agent = submitted.deployedAddress;
  // No separate enroll step: /connect/passkey derives the SA + records the facet on
  // the reconnect (with a post-deploy poll for RPC lag), so this is just the deploy.
  return { ok: true, agent };
}

// ── A2A service agent + relationship edge (spec 227 §6 / M5) ────────

/** Deploy a Smart Agent via demo-a2a (no facet enroll). Used for the A2A agent. */
async function deployAgent(
  deployBody: Record<string, unknown>,
  signHash: SignHash,
): Promise<{ ok: true; agent: Address } | { ok: false; error: string }> {
  await ensureCsrfToken();
  const buildRes = await fetch('/a2a/session/deploy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(deployBody),
  });
  if (buildRes.status === 409) return { ok: false, error: 'paymaster not enabled' };
  const built = (await buildRes.json()) as { ok?: boolean; userOpHash?: Hex; userOp?: Record<string, unknown>; error?: string };
  if (!buildRes.ok || !built.ok || !built.userOpHash || !built.userOp) {
    return { ok: false, error: built.error ?? `deploy build failed (HTTP ${buildRes.status})` };
  }
  const signature = await signHash(built.userOpHash);
  const submitRes = await fetch('/a2a/session/deploy/submit', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ userOp: { ...built.userOp, signature } }),
  });
  const submitted = (await submitRes.json()) as {
    ok?: boolean;
    deployedAddress?: Address;
    error?: string;
    detail?: string;
  };
  if (!submitRes.ok || !submitted.ok || !submitted.deployedAddress) {
    return {
      ok: false,
      error: [submitted.error, submitted.detail].filter(Boolean).join(' — ') || `deploy submit failed (HTTP ${submitRes.status})`,
    };
  }
  return { ok: true, agent: submitted.deployedAddress };
}

export interface ProvisionResult {
  a2aAgent: Address;
  edgeId: Hex;
}

/** Provision a 2nd SA (the A2A service agent) custodied by the same credential, and
 *  link `a2a --OPERATES_ON_BEHALF_OF--> person` (a2a proposes as subject; person
 *  confirms as object — architect F1). Both txs signed by the user's one credential. */
export async function provisionA2aAgent(
  via: 'wallet' | 'passkey',
  personAgent: Address,
  onStep?: (s: string) => void,
): Promise<{ ok: true; result: ProvisionResult } | { ok: false; error: string }> {
  const A2A_SALT = '1'; // distinct from the person SA (salt 0) -> distinct address
  let signHash: SignHash;
  let deployBody: Record<string, unknown>;
  if (via === 'wallet') {
    const addr = await connectWallet();
    signHash = (h) => personalSign(addr, h);
    deployBody = { initMethod: 'eoa', owner: addr, salt: A2A_SALT };
  } else {
    const pk = loadPasskey();
    if (!pk) return { ok: false, error: 'no passkey on this device' };
    signHash = passkeySignHash;
    deployBody = {
      initMethod: 'passkey',
      credentialIdDigest: pk.credentialIdDigest,
      pubKeyX: pk.pubKeyX.toString(),
      pubKeyY: pk.pubKeyY.toString(),
      salt: A2A_SALT,
    };
  }

  onStep?.('Deploying your agent service…');
  const dep = await deployAgent(deployBody, signHash);
  if (!dep.ok) return { ok: false, error: `agent deploy failed: ${dep.error}` };
  const a2aAgent = dep.agent;
  if (a2aAgent.toLowerCase() === personAgent.toLowerCase()) {
    return { ok: false, error: 'agent service collided with the person agent (salt)' };
  }

  const relationships = CONTRACTS.agentRelationship;
  const relationshipType = RELATIONSHIP_TYPE.OPERATES_ON_BEHALF_OF as RelationshipType;

  onStep?.('Linking it to operate on your behalf…');
  const propose = buildProposeEdgeCall({ relationships, subject: a2aAgent, object: personAgent, relationshipType });
  // a2a = subject (proposer); freshly deployed (nonce 0 consumed) → first op is nonce 1.
  const p = await executeCall(a2aAgent, signHash, buildExecuteCallData(propose), { minNonce: 1n, attempts: 10 });
  if (!p.ok) return { ok: false, error: `propose edge failed: ${p.error}` };

  onStep?.('Confirming the link…');
  const edgeId = computeEdgeId(a2aAgent, personAgent, relationshipType);
  const confirm = buildConfirmEdgeCall({ relationships, edgeId });
  await executeCall(personAgent, signHash, buildExecuteCallData(confirm), { attempts: 4 }); // person = object (confirmer); best-effort

  return { ok: true, result: { a2aAgent, edgeId } };
}

// ── Create a child agent custodied by the ROOT passkey, on behalf of a relying site ──
//
// The template for ALL agents a relying site asks the central auth to create (organization
// now; Treasury / any service agent later — memory project_demo_org_durable_org_custody).
// Every such agent follows the SAME pattern as the person SA: deployed here, custodied by
// the person's ROOT passkey ONLY (never the relying site's per-origin key, never the person
// SA — the latter is contract-forbidden as a custodian). The relying site is handed back a
// scoped, redeemer-bound delegation (child → the site's delegate SA) so it can operate the
// child without another passkey ceremony (ADR-0019).

export interface CreatedAgent {
  childAgent: Address;
  childName: string;
  edgeId: Hex;
  governed: boolean;
  delegation: DelegationWire; // child → relying site's delegate SA (scoped)
  /** ADR-0025: the person SA + the private related-agent credential (self-issued,
   *  unsigned for the demo — the proofHash anchors integrity; the vault store at
   *  the person's home during the authenticated ceremony provides provenance). */
  person: Address;
  purpose: string;
  requestedBy: string;
  credential: unknown;
  proofHash: Hex;
  /** Optional org → broker-org delegation (so a broker can later list its orgs). */
  brokerDelegation?: DelegationWire;
  /** spec 246 — person↔org scoped read delegations, both signed by the ROOT (custodian
   *  of BOTH SAs). membership = person→org (the created ORG can read the MEMBER person's
   *  data); stewardship = org→person (the PERSON can read / oversee the org's data).
   *  Best-effort: each is a separate signing ceremony, so a cancelled prompt leaves them
   *  undefined rather than orphaning the (already-deployed) org — see createChildAgentForSite. */
  membershipDelegation?: DelegationWire;
  stewardshipDelegation?: DelegationWire;
}

export interface CreateChildOpts {
  /** App-level purpose tag, e.g. `jp-adopter-org` (free string — ADR-0021). */
  purpose?: string;
  /** The relying app's OIDC client_id (who requested the link). */
  requestedBy?: string;
  /** A broker org SA to also grant scoped read access to (org → broker delegation). */
  grantOrg?: Address;
}

/** Deploy a child SA (org / service agent) custodied by the ROOT passkey, claim `<base>.demo.agent`,
 *  record `person --relationshipType--> child` (person proposes, child confirms — both signed by
 *  the ROOT passkey, the person's & child's custodian), and mint the scoped child→site delegation.
 *  `relationshipType` defaults to HAS_GOVERNANCE_OVER (organization). */
export async function createChildAgentForSite(
  personAgent: Address,
  base: string,
  delegateSA: Address,
  onStep?: (s: string) => void,
  relationshipType: RelationshipType = RELATIONSHIP_TYPE.HAS_GOVERNANCE_OVER as RelationshipType,
  cOpts: CreateChildOpts = {},
): Promise<{ ok: true; result: CreatedAgent } | { ok: false; error: string }> {
  const pk = loadPasskey();
  if (!pk) return { ok: false, error: 'Your central-auth passkey isn’t on this device — sign in to Agentic Connect first.' };
  // Name-independent salt (ADR-0010): credential scope + entropy, never the name.
  const saltBytes = crypto.getRandomValues(new Uint8Array(8));
  let salt = 0n;
  for (const b of saltBytes) salt = (salt << 8n) | BigInt(b);

  // Derive the SA up front so we can deploy + claim its name in ONE userOp (one prompt).
  const childAgent = await derivePasskeySa(pk, salt);
  if (childAgent.toLowerCase() === personAgent.toLowerCase()) {
    return { ok: false, error: 'agent collided with your person agent (salt)' };
  }
  const claim = await buildClaimCallData(base, childAgent, onStep);
  if (!claim.ok) return { ok: false, error: claim.error };

  onStep?.('Deploying the agent + claiming its name…');
  // rpIdHash must match `derivePasskeySa`'s value (sha256(hostname)) — passed
  // explicitly so the server doesn't fall back to Origin derivation. Closes the
  // orphan-registry root cause (live-debug 2026-06-01).
  const rpIdHash = await derivePasskeyRpIdHash();
  const dep = await deployAgent(
    {
      initMethod: 'passkey',
      credentialIdDigest: pk.credentialIdDigest,
      pubKeyX: pk.pubKeyX.toString(),
      pubKeyY: pk.pubKeyY.toString(),
      rpIdHash,
      salt: salt.toString(),
      callData: claim.callData, // deploy + claim atomically
    },
    passkeySignHash,
  );
  if (!dep.ok) return { ok: false, error: `agent deploy failed: ${dep.error}` };

  // ADR-0025: person↔org is a PRIVATE vault credential, NOT a public on-chain edge.
  // The control relationship is implicit in custody (the org is custodied by the
  // person's ROOT credential); we do NOT write any AgentRelationship edge. `edgeId`
  // stays as a deterministic local id for back-compat of the return shape only —
  // nothing is recorded on-chain. (The private situation credential + the vault
  // store live in the org-create grant path; see spec 246.)
  const edgeId = computeEdgeId(personAgent, childAgent, relationshipType);

  onStep?.('Granting the site scoped access…');
  // child → relying site's delegate SA, signed by the ROOT passkey (child's custodian).
  const delegation = await issueSiteDelegation(childAgent, delegateSA, passkeySignHash);

  // ADR-0025 / spec 246: the private, self-issued related-agent credential — the
  // person's own vault record of "I have this org, created for this app's flow".
  // Built unsigned (no extra device prompt); the proofHash anchors integrity and
  // the vault store happens at the home during this authenticated ceremony.
  const purpose = cOpts.purpose ?? 'related-org';
  const requestedBy = cOpts.requestedBy ?? '';
  const credential = buildRelatedAgentCredential({
    holder: personAgent,
    relatedAgent: childAgent,
    purpose,
    requestedBy,
    issuerCaip10: `eip155:${CHAIN_ID}:${personAgent}`,
    body: { agentName: claim.name },
    validFrom: new Date().toISOString(),
  });
  const proofHash = relatedAgentProofHash(credential);

  // Optional org → broker-org scoped delegation (the broker can later enumerate its
  // delegated orgs — spec 246 §5). Signed by the ROOT passkey (the org's custodian).
  let brokerDelegation: DelegationWire | undefined;
  if (cOpts.grantOrg && cOpts.grantOrg.toLowerCase() !== delegateSA.toLowerCase()) {
    onStep?.('Granting the broker scoped access…');
    brokerDelegation = toWire(await issueSiteDelegation(childAgent, cOpts.grantOrg, passkeySignHash));
  }

  // spec 246 — the person↔org read delegations. Both are signed by the ROOT passkey,
  // which custodies BOTH the person SA and the org SA (the org is custodied by the
  // person's ROOT), so each side's ERC-1271 validates the same credential.
  //
  // BEST-EFFORT: each is a separate signing ceremony (the org + its site grant are
  // already in place by now). If a prompt is cancelled, we DON'T throw — that would
  // orphan an already-deployed org with no vault link. The grant still persists; the
  // read delegations can be (re)minted later. (Batching the ceremonies into one prompt
  // is the spec-246 follow-up.)
  let membershipDelegation: DelegationWire | undefined;
  let stewardshipDelegation: DelegationWire | undefined;
  try {
    onStep?.('Linking you and your organization…');
    // membership: person → org — the created ORG can read the MEMBER person's data.
    membershipDelegation = toWire(await issueSiteDelegation(personAgent, childAgent, passkeySignHash));
    // stewardship: org → person — the PERSON can read / oversee the org's data.
    stewardshipDelegation = toWire(await issueSiteDelegation(childAgent, personAgent, passkeySignHash));
  } catch {
    onStep?.('Skipped the person↔org read delegations — you can add them later.');
  }

  return {
    ok: true,
    result: {
      childAgent, childName: claim.name, edgeId, governed: false,
      delegation: toWire(delegation),
      person: personAgent, purpose, requestedBy, credential, proofHash, brokerDelegation,
      membershipDelegation, stewardshipDelegation,
    },
  };
}

// ── Add a second custody credential to an existing agent (the unification) ──
//
// The canonical SA address never changes; credentials are facets that can be added.
// `addCustodian` / `addPasskey` are `onlySelf` on AgentAccount, so the EXISTING
// credential signs an `execute(self, addX(...))` UserOp. After this the agent is
// reachable by NAME via either credential (connectWithName verifies isCustodian),
// and name-info reports both. (ADR-0011: credentials rotate, identity persists.)

const ADD_CUSTODIAN_ABI = [
  { type: 'function', name: 'addCustodian', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }], outputs: [] },
] as const;
const ADD_PASSKEY_ABI = [
  {
    type: 'function',
    name: 'addPasskey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'credentialIdDigest', type: 'bytes32' },
      { name: 'x', type: 'uint256' },
      { name: 'y', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// Removal is the symmetric `onlySelf` op: the CURRENT credential signs `execute(self, removeX)`.
// The contract refuses to remove the LAST credential (CannotRemoveLastCustodian), so you can't
// lock yourself out. (ADR-0011: credentials rotate; the SA address never changes.)
const REMOVE_CREDENTIAL_ABI = [
  { type: 'function', name: 'removeCustodian', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'removePasskey', stateMutability: 'nonpayable', inputs: [{ name: 'credentialIdDigest', type: 'bytes32' }], outputs: [] },
] as const;
const CREDENTIAL_READ_ABI = [
  { type: 'function', name: 'custodianCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'passkeyCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

/** Live credential counts (custodians = EOA + passkey-identity addresses; passkeys = WebAuthn keys).
 *  A view call through the demo-a2a /rpc proxy — never a log scan (ADR-0012). */
export async function readCredentialCounts(personAgent: Address): Promise<{ custodians: number; passkeys: number }> {
  const pub = createPublicClient({ chain: baseSepolia, transport: http('/a2a/rpc') });
  const [c, p] = await Promise.all([
    pub.readContract({ address: personAgent, abi: CREDENTIAL_READ_ABI, functionName: 'custodianCount' }) as Promise<bigint>,
    pub.readContract({ address: personAgent, abi: CREDENTIAL_READ_ABI, functionName: 'passkeyCount' }) as Promise<bigint>,
  ]);
  return { custodians: Number(c), passkeys: Number(p) };
}

/** The signer for an on-behalf op using the CURRENT credential (the one this session signed in with). */
export async function currentCredentialSignHash(via: 'passkey' | 'wallet'): Promise<SignHash> {
  if (via === 'wallet') {
    const addr = await connectWallet();
    return (h: Hex) => personalSign(addr, h);
  }
  return passkeySignHash;
}

/** Remove a WALLET (EOA) custodian. The current credential signs `execute(self, removeCustodian)`. */
export async function removeWalletCredential(
  personAgent: Address,
  owner: Address,
  signHash: SignHash,
): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }> {
  const inner = encodeFunctionData({ abi: REMOVE_CREDENTIAL_ABI, functionName: 'removeCustodian', args: [owner] });
  return executeCall(personAgent, signHash, buildExecuteCallData({ to: personAgent, value: 0n, data: inner }), { attempts: 5 });
}

/** Remove a PASSKEY by its credentialIdDigest. The current credential signs `execute(self, removePasskey)`. */
export async function removePasskeyCredential(
  personAgent: Address,
  credentialIdDigest: Hex,
  signHash: SignHash,
): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }> {
  const inner = encodeFunctionData({ abi: REMOVE_CREDENTIAL_ABI, functionName: 'removePasskey', args: [credentialIdDigest] });
  return executeCall(personAgent, signHash, buildExecuteCallData({ to: personAgent, value: 0n, data: inner }), { attempts: 5 });
}

// DelegationManager.revokeDelegationByOwner(Delegation) — authenticated revoke: msg.sender
// MUST be the delegation's delegator (or delegate). We route it through the DELEGATOR SA's
// `execute`, so the on-chain msg.sender is the delegator and the gate passes. The contract
// re-verifies the struct's signature before marking the hash revoked. `args` is excluded
// from the signed hash (CAVEAT_TYPEHASH = enforcer+terms), so '0x' here is fine.
const REVOKE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'revokeDelegationByOwner',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'delegation',
        type: 'tuple',
        components: [
          { name: 'delegator', type: 'address' },
          { name: 'delegate', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * Revoke a delegation the person granted (ADR-0019: relying-site authority is a revocable
 * scoped delegation). The DELEGATOR SA (`d.delegator` — the person SA, or an org the person
 * custodies) signs `execute(DelegationManager, revokeDelegationByOwner(d))`, so the on-chain
 * `msg.sender` is the delegator and the authenticated gate passes. After this lands,
 * `isRevoked(hash)` is true and `verifyDelegationToken` rejects the delegation — the grantee's
 * access is gone. `signHash` is the person's credential (it custodies both the person SA and
 * its org SAs as siblings, so the same credential validates either delegator's ERC-1271).
 */
export async function revokeGrantedDelegation(
  d: DelegationWire,
  signHash: SignHash,
): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }> {
  const onchainDelegation = {
    delegator: d.delegator,
    delegate: d.delegate,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
    salt: BigInt(d.salt),
    signature: d.signature,
  } as const;
  const inner = encodeFunctionData({
    abi: REVOKE_DELEGATION_ABI,
    functionName: 'revokeDelegationByOwner',
    args: [onchainDelegation],
  });
  return executeCall(
    d.delegator,
    signHash,
    buildExecuteCallData({ to: CONTRACTS.delegationManager, value: 0n, data: inner }),
    { attempts: 5 },
  );
}

/** Add a WALLET (EOA) custodian to an agent currently controlled by a PASSKEY.
 *  Connects the wallet to add + proves control of it (personal_sign), then the
 *  EXISTING passkey signs `execute(self, addCustodian(newEoa))`. */
export async function addWalletCredential(
  personAgent: Address,
  onStep?: (s: string) => void,
): Promise<{ ok: true; added: Address } | { ok: false; error: string }> {
  onStep?.('Connecting the wallet to add…');
  const addr = await connectWallet();
  onStep?.('Confirm with the wallet you’re adding…');
  await personalSign(addr, `Add this wallet as a custodian of ${personAgent} on Agentic Connect.`);

  const inner = encodeFunctionData({ abi: ADD_CUSTODIAN_ABI, functionName: 'addCustodian', args: [addr] });
  const callData = buildExecuteCallData({ to: personAgent, value: 0n, data: inner });
  onStep?.(`Adding ${addr.slice(0, 6)}…${addr.slice(-4)} — confirm with your passkey…`);
  const res = await executeCall(personAgent, passkeySignHash, callData, { attempts: 5 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, added: addr };
}

/** Add a PASSKEY custodian to an agent currently controlled by a WALLET.
 *  Registers a fresh passkey on this device, then the EXISTING wallet signs
 *  `execute(self, addPasskey(digest, x, y))`. */
export async function addPasskeyCredential(
  personAgent: Address,
  onStep?: (s: string) => void,
): Promise<{ ok: true; credentialIdDigest: Hex } | { ok: false; error: string }> {
  onStep?.('Creating the passkey to add…');
  const pk = await registerPasskey(`${personAgent.slice(0, 8)}… passkey`); // fresh passkey, stored on this device

  const inner = encodeFunctionData({
    abi: ADD_PASSKEY_ABI,
    functionName: 'addPasskey',
    args: [pk.credentialIdDigest, pk.pubKeyX, pk.pubKeyY],
  });
  const callData = buildExecuteCallData({ to: personAgent, value: 0n, data: inner });
  onStep?.('Adding the passkey — confirm with your wallet…');
  const addr = await connectWallet(); // the EXISTING wallet custodian signs the add
  const res = await executeCall(personAgent, (h) => personalSign(addr, h), callData, { attempts: 5 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, credentialIdDigest: pk.credentialIdDigest };
}

/** Central-auth enrollment (spec 229 §5): add a RELYING SITE's PROVIDED local passkey
 *  (PUBLIC key only) as a custodian of `name`'s agent, signed by THIS origin's primary
 *  passkey. The site's private key never leaves the site's device — we only register its
 *  (x, y). This is how a new origin gets its own per-site signer without reusing the
 *  central credential. Fails closed: addPasskey only validates if the primary passkey is
 *  already a custodian of the agent. */
export async function enrollSitePasskey(
  name: string,
  enroll: { credentialIdDigest: Hex; x: bigint; y: bigint },
  onStep?: (s: string) => void,
): Promise<{ ok: true; agent: Address; name: string } | { ok: false; error: string }> {
  onStep?.('Resolving your agent…');
  const r = await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`);
  const info = (await r.json()) as { exists?: boolean; name?: string; agent?: Address };
  if (!info.exists || !info.agent) return { ok: false, error: `no agent named ${name}` };
  const inner = encodeFunctionData({
    abi: ADD_PASSKEY_ABI,
    functionName: 'addPasskey',
    args: [enroll.credentialIdDigest, enroll.x, enroll.y],
  });
  const callData = buildExecuteCallData({ to: info.agent, value: 0n, data: inner });
  onStep?.('Approve with your passkey…');
  const res = await executeCall(info.agent, passkeySignHash, callData, { attempts: 6 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, agent: info.agent, name: info.name ?? name };
}

// ── Cross-device: link a device (spec 233 P2) ───────────────────────────────
// A NEW browser/device with no passkey for this agent (its passkey RP differs)
// creates its OWN local passkey and posts a short-lived REQUEST; the ORIGINAL
// device (which holds the agent's existing passkey) approves by signing
// addPasskey via the ROOT — no self-add (the request is not a grant). Once the
// key lands on-chain, the new device discoverable-signs-in.

export interface DeviceLinkRequest {
  agent: Address;
  name: string;
  credentialIdDigest: Hex;
  x: string;
  y: string;
  label: string;
}

/** NEW DEVICE: create a fresh local passkey at this origin (RP = this host) +
 *  post a link request. Returns a short code to read to the original device. */
export async function requestDeviceLink(
  name: string,
  label?: string,
): Promise<{ ok: true; code: string; agent: Address; credentialIdDigest: Hex } | { ok: false; error: string }> {
  const info = (await (await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`)).json()) as {
    exists?: boolean;
    name?: string;
    agent?: Address;
  };
  if (!info.exists || !info.agent) return { ok: false, error: `no agent named ${name}` };
  const pk = await registerPasskey(label ?? `${name} (new device)`); // fresh passkey, stored on THIS device
  const resp = await fetch('/connect/link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: info.agent,
      name: info.name ?? name,
      credentialIdDigest: pk.credentialIdDigest,
      x: pk.pubKeyX.toString(),
      y: pk.pubKeyY.toString(),
      label: label ?? 'New device',
    }),
  });
  const body = (await resp.json()) as { code?: string; error?: string };
  if (!resp.ok || !body.code) return { ok: false, error: body.error ?? 'link request failed' };
  return { ok: true, code: body.code, agent: info.agent, credentialIdDigest: pk.credentialIdDigest };
}

/** ORIGINAL DEVICE: fetch a pending link request by code (to show + approve). */
export async function lookupDeviceLink(
  code: string,
): Promise<{ ok: true; req: DeviceLinkRequest } | { ok: false; error: string }> {
  const r = await fetch(`/connect/link/lookup?code=${encodeURIComponent(code.trim())}`);
  const body = (await r.json()) as DeviceLinkRequest & { error?: string };
  if (!r.ok || !body.agent) return { ok: false, error: body.error ?? 'invalid or expired code' };
  return { ok: true, req: body };
}

/** ORIGINAL DEVICE: approve — the ROOT passkey signs addPasskey for the new key. */
export async function approveDeviceLink(
  req: DeviceLinkRequest,
  onStep?: (s: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await enrollSitePasskey(
    req.name,
    { credentialIdDigest: req.credentialIdDigest, x: BigInt(req.x), y: BigInt(req.y) },
    onStep,
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** NEW DEVICE: poll until the new key is a registered passkey on-chain. */
export async function pollDeviceLink(agent: Address, credentialIdDigest: Hex): Promise<boolean> {
  const r = await fetch(`/connect/link/status?agent=${agent}&digest=${credentialIdDigest}`);
  if (!r.ok) return false;
  return ((await r.json()) as { enrolled?: boolean }).enrolled === true;
}

/** SINGLE-DEVICE add (spec 233 P2, the smooth path): on THIS device, create a new
 *  local passkey AND immediately enroll it by signing `addPasskey` with your
 *  EXISTING passkey via a DISCOVERABLE assertion. When this device holds no local
 *  passkey, the browser's discoverable prompt offers "use a passkey from another
 *  device" (WebAuthn hybrid / QR) — so you approve with the phone/computer that has
 *  it, right here, no code + no second tab. Still ROOT-authorized (the hybrid
 *  assertion IS the existing custodian approving — no self-add). Requires the
 *  approving device to be reachable for the QR; falls back to the code flow if not. */
export async function addThisDevicePasskey(
  name: string,
  onStep?: (s: string) => void,
): Promise<{ ok: true; credentialIdDigest: Hex } | { ok: false; error: string }> {
  const info = (await (await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`)).json()) as {
    exists?: boolean;
    name?: string;
    agent?: Address;
  };
  if (!info.exists || !info.agent) return { ok: false, error: `no agent named ${name}` };
  onStep?.('Creating a passkey on this device…');
  const pk = await registerPasskey(`${name} (this device)`);
  const inner = encodeFunctionData({
    abi: ADD_PASSKEY_ABI,
    functionName: 'addPasskey',
    args: [pk.credentialIdDigest, pk.pubKeyX, pk.pubKeyY],
  });
  const callData = buildExecuteCallData({ to: info.agent, value: 0n, data: inner });
  onStep?.('Approve with your existing passkey — choose “another device” if asked, and scan with the device that has it.');
  const res = await executeCall(info.agent, passkeySignHash, callData, { attempts: 6 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, credentialIdDigest: pk.credentialIdDigest };
}

/** Step a Google (login-grade) session UP to custody-grade for the SAME bound agent.
 *  The target agent is the googleToken's sub (server-enforced) — so a Google login can
 *  only ever step up into its one bound workspace; the credential must be a custodian of it. */
export async function stepUpToAgent(
  via: 'wallet' | 'passkey',
  googleToken: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (via === 'wallet') {
    const address = await connectWallet();
    const nonce = await getNonce();
    const message = buildMessage({
      domain: window.location.host,
      address,
      uri: window.location.origin,
      chainId: CHAIN_ID,
      nonce,
      statement: 'Confirm custody of your Agentic Connect workspace.',
    });
    const signature = await personalSign(address, message);
    const r = await fetch('/connect/stepup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ googleToken, kind: 'siwe-eoa', aud: AUD, message, signature }),
    });
    const b = (await r.json()) as { status?: string; token?: string; error?: string };
    if (r.ok && b.status === 'issued' && b.token) return { ok: true, token: b.token };
    return { ok: false, error: b.error ?? `step-up failed (HTTP ${r.status})` };
  }
  const pk = loadPasskey();
  if (!pk) return { ok: false, error: 'no passkey on this device' };
  const { challenge } = (await (await fetch('/connect/passkey-challenge')).json()) as { challenge: Hex };
  const signature = await signWithPasskey(challenge);
  const r = await fetch('/connect/stepup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ googleToken, kind: 'passkey', aud: AUD, credentialIdDigest: pk.credentialIdDigest, challenge, signature }),
  });
  const b = (await r.json()) as { status?: string; token?: string; error?: string };
  if (r.ok && b.status === 'issued' && b.token) return { ok: true, token: b.token };
  return { ok: false, error: b.error ?? `step-up failed (HTTP ${r.status})` };
}

/** Connect to the agent that OWNS `name`, proving control with a custody credential.
 *  Name-first: the agent-service name is the identity; the server resolves name→agent
 *  on-chain and verifies the credential is a custodian of it. */
export async function connectWithName(
  name: string,
  via: 'wallet' | 'passkey',
): Promise<{ ok: true; token: string; name?: string } | { ok: false; error: string }> {
  let proof: Record<string, unknown>;
  if (via === 'wallet') {
    const address = await connectWallet();
    const nonce = await getNonce();
    const message = buildMessage({
      domain: window.location.host,
      address,
      uri: window.location.origin,
      chainId: CHAIN_ID,
      nonce,
      statement: `Connect to ${name} on Agentic Connect.`,
    });
    const signature = await personalSign(address, message);
    proof = { kind: 'siwe-eoa', message, signature };
  } else {
    const pk = loadPasskey();
    if (!pk) return { ok: false, error: 'No passkey on this device — sign up first, or connect with your wallet.' };
    const { challenge } = (await (await fetch('/connect/passkey-challenge')).json()) as { challenge: Hex };
    const signature = await signWithPasskey(challenge);
    proof = { kind: 'passkey', credentialIdDigest: pk.credentialIdDigest, challenge, signature };
  }
  const r = await fetch('/connect/with-name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, aud: AUD, ...proof }),
  });
  const b = (await r.json()) as { status?: string; token?: string; name?: string; error?: string };
  if (r.ok && b.status === 'issued' && b.token) return { ok: true, token: b.token, name: b.name };
  return { ok: false, error: b.error ?? `connect failed (HTTP ${r.status})` };
}

// ── Guided ceremony steps (spec 230 part 2) ─────────────────────────
// Each step is its OWN exported call so the relying UI can gate every WebAuthn prompt behind a
// button with a promise before + a receipt after — no two prompts fire back-to-back. (signupWithName
// runs the same work in one shot; these expose the seams.)

/** Step 1 — create the person's secure-home passkey (ONE WebAuthn create). Stored on this device. */
export async function createSecureHomePasskey(name: string): Promise<DemoPasskey> {
  const base = name.replace(/\.(impact|demo\.agent)$/, '');
  return registerPasskey(`${base}.impact`);
}

/** Step 2 — deploy the person's Smart Agent + claim its name in ONE userOp (ONE WebAuthn sign). */
export async function deployAndClaimAgent(
  passkey: DemoPasskey,
  base: string,
): Promise<{ ok: true; agent: Address; name: string } | { ok: false; error: string }> {
  const sa = await derivePasskeySa(passkey, 0n);
  const claim = await buildClaimCallData(base, sa);
  if (!claim.ok) return { ok: false, error: claim.error };
  const dep = await bootstrapWithPasskey(passkey, undefined, claim.callData);
  if (!dep.ok) return { ok: false, error: dep.error };
  return { ok: true, agent: dep.agent, name: claim.name };
}

/** Sign up: create a workspace named `<base>.demo.agent` with a custody credential,
 *  and CLAIM the name for THAT credential's agent (so connect-by-name later offers the
 *  right credential). Passkey → a FRESH passkey (a new workspace); wallet → the EOA's
 *  agent. The claim runs whether the agent is freshly deployed or reconnected. */
export async function signupWithName(
  base: string,
  via: 'wallet' | 'passkey',
  onStep?: (s: string) => void,
  signIn = true,
): Promise<{ ok: true; token: string; name: string; agent: Address } | { ok: false; error: string }> {
  if (via === 'passkey') {
    onStep?.('Creating your passkey…');
    const pk = await registerPasskey(`${base}.impact`); // FRESH passkey for this workspace
    // Deploy + claim the name in ONE userOp (one device prompt): derive the SA address, build
    // the claim calldata (newOwner = that SA), and deploy with it attached.
    const sa = await derivePasskeySa(pk, 0n);
    const claim = await buildClaimCallData(base, sa, onStep);
    if (!claim.ok) return { ok: false, error: claim.error };
    const dep = await bootstrapWithPasskey(pk, onStep, claim.callData);
    if (!dep.ok) return { ok: false, error: dep.error };
    // The OIDC enrollment ceremony signs the person in via the grant + id_token, so it skips
    // this extra passkeyLogin (its token would be unused) — saving one device prompt. We return
    // the KNOWN agent address (from the deploy) so callers needn't re-resolve by name — the
    // just-claimed name lags on-chain for a moment (RPC), and `sa` is already authoritative.
    if (!signIn) return { ok: true, token: '', name: claim.name, agent: sa };
    onStep?.('Signing you in…');
    const login = await passkeyLogin(false);
    return login.status === 'issued'
      ? { ok: true, token: login.token, name: claim.name, agent: sa }
      : { ok: false, error: `created, but sign-in returned ${login.status}` };
  }
  // wallet: the EOA's deterministic agent (reconnect if it exists, else bootstrap).
  onStep?.('Connecting your wallet…');
  const first = await siweLogin(); // connects wallet + signs
  let agent: Address;
  let address: Address;
  let minNonce: bigint | undefined; // set only on a fresh deploy (nonce 0 just consumed)
  if (first.status === 'issued') {
    agent = first.agent;
    address = first.address;
  } else if (first.status === 'bootstrap') {
    address = first.address;
    const dep = await bootstrapWithWallet(address, onStep);
    if (!dep.ok) return { ok: false, error: dep.error };
    agent = dep.agent;
    minNonce = 1n;
  } else {
    return { ok: false, error: first.reason ?? `sign-in ${first.status}` };
  }
  const signHash: SignHash = (h) => personalSign(address, h);
  const claim = await claimName(agent, signHash, base, onStep, minNonce);
  if (!claim.ok) return { ok: false, error: claim.error };
  onStep?.('Signing you in…');
  const login = await siweLogin();
  return login.status === 'issued'
    ? { ok: true, token: login.token, name: claim.name, agent }
    : { ok: false, error: `created, but sign-in returned ${login.status}` };
}

export interface BasicProfile {
  agent: string;
  name: string | null;
  credential: string;
  access: string;
}

export async function fetchProfile(token: string): Promise<BasicProfile | null> {
  const r = await fetch('/me/profile', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return ((await r.json()) as { profile: BasicProfile }).profile;
}

/** A related org the person holds (spec 246 / ADR-0025) — read from THEIR vault for the
 *  person's own home view (all orgs, all requesting apps). Carries no person→org graph. */
export interface MyOrg {
  orgAgent: Address;
  orgName: string;
  purpose: string;
  requestedBy: string;
  createdAt: number | null;
  proofHash?: string;
  /** The scoped org→site delegation the person granted (absent for self-governed orgs).
   *  Carries the full wire struct so /you can revoke it (revokeGrantedDelegation). */
  delegation?: DelegationWire;
  /** spec 246 person↔org read delegations. stewardship = org→person: the person presents
   *  it to the vault to READ this org's data (the person oversees the org). membership =
   *  person→org: the org reads its member's data. */
  membershipDelegation?: DelegationWire;
  stewardshipDelegation?: DelegationWire;
}

/** An inbound grant one of the person's orgs RECEIVED (spec 247). org↔org only — no
 *  grantor person identity (ADR-0025). `viaOrg` is the person's org that holds it. */
export interface ReceivedDelegation {
  viaOrg: Address;
  viaOrgName: string;
  orgAgent: Address;
  orgName: string;
  delegation?: unknown;
}

/** List the inbound delegations the person's orgs received, for the /you delegations
 *  view. Person-session-authorized (same-origin, the home session token). */
export async function listMyReceivedDelegations(token: string): Promise<ReceivedDelegation[]> {
  const r = await fetch('/connect/received-delegations', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const b = (await r.json().catch(() => ({}))) as { received?: ReceivedDelegation[] };
  return b.received ?? [];
}

/** List ALL the connected person's organizations (private vault credentials), for the
 *  /you portal. Same-origin, authorized by the home session token (aud = the home aud). */
export async function listMyOrgs(token: string): Promise<MyOrg[]> {
  const r = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const b = (await r.json().catch(() => ({}))) as { orgs?: MyOrg[] };
  return b.orgs ?? [];
}

export async function fetchSensitive(
  token: string,
): Promise<{ ok: true; email: string; phone: string } | { ok: false; reason: string }> {
  const r = await fetch('/me/sensitive', { headers: { authorization: `Bearer ${token}` } });
  const body = (await r.json()) as Record<string, unknown>;
  if (r.ok && body.sensitive) {
    const s = body.sensitive as { email: string; phone: string };
    return { ok: true, email: s.email, phone: s.phone };
  }
  return { ok: false, reason: (body.reason as string) ?? 'Sensitive details need a custody-grade sign-in.' };
}
