// Spec 287 live smoke: mint a delegation token + build an invocation proof with
// a session key, POST to the deployed /mcp/native, assert the proof+delegation
// path is accepted (HTTP 200). Uses two EOAs (delegator + session key); the
// on-chain UniversalSignatureValidator does ECDSA recover for both.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  ROOT_AUTHORITY,
  buildMcpToolScopeCaveat,
  hashDelegation,
  mintDelegationToken,
  buildInvocationProof,
  type Delegation,
} from '@agenticprimitives/delegation';

// Override with NATIVE_MCP_BASE to drive the same flow through the Agentic Edge
// (demo-edge) instead of hitting demo-mcp directly — proves the edge admits + dispatches
// the native delegation-token + invocation-proof path end-to-end.
const BASE = process.env.NATIVE_MCP_BASE ?? 'https://demo-mcp-production.richardpedersen3.workers.dev';
const CHAIN_ID = 84532;
const AUDIENCE = 'urn:mcp:server:person';
// The EIP-712 verifying contract for the delegation this script mints, so it MUST match the
// DELEGATION_MANAGER the target verifies against or the digests differ and the run fails on a
// signature mismatch that says nothing about the path under test. Canonical Base Sepolia value
// (packages/contracts/deployments-base-sepolia.json) — it sat a generation behind, harmlessly while
// demo-mcp had no DelegationManager configured at all, and wrongly the moment one was set.
const DELEGATION_MANAGER = '0x9eD1dC0FD2284fcd4967beeF3317129fee7a92e5';

// FRESH random EOAs each run — well-known anvil addresses carry EIP-7702
// delegation code (0xef0100…) on Base Sepolia, which would route signature
// verification down the contract/USV branch. The session key in real use is a
// fresh ephemeral EOA. NOTE: a fully-green happy path additionally requires the
// DELEGATOR to be a deployed Smart Account (the delegation signature is validated
// via the on-chain UniversalSignatureValidator, which reverts on a bare EOA) —
// principals are SAs per ADR-0010. With EOAs here, the PROOF step passes and the
// delegation-verify step is the expected stopping point.
const delegator = privateKeyToAccount(generatePrivateKey());
const sessionKey = privateKeyToAccount(generatePrivateKey());

async function main() {
  // 1. Delegation: delegator → sessionKey, scoped to get_pii, signed by delegator EOA.
  const unsigned: Omit<Delegation, 'signature'> = {
    delegator: delegator.address,
    delegate: sessionKey.address,
    authority: ROOT_AUTHORITY,
    caveats: [buildMcpToolScopeCaveat(['get_pii'])],
    salt: 1n,
  };
  const delHash = hashDelegation(unsigned as Delegation, CHAIN_ID, DELEGATION_MANAGER);
  const delSig = await delegator.sign({ hash: delHash });
  const delegation: Delegation = { ...unsigned, signature: delSig };

  // 2. Token: session-key-signed claims (EIP-191), sub = delegator.
  const { token } = await mintDelegationToken(
    {
      iss: 'spec287-smoke',
      aud: AUDIENCE,
      sub: delegator.address,
      delegation,
      sessionKeyAddress: sessionKey.address,
    },
    (msg) => sessionKey.signMessage({ message: msg }),
  );

  // 3. Invocation proof — bound to the EXACT handler arg object the route builds:
  //    rest = { args: <toolArgs> }.
  const now = Date.now();
  const toolArgs = { fields: ['email'], purpose: 'smoke' };
  const proof = await buildInvocationProof({
    chainId: CHAIN_ID,
    audience: AUDIENCE,
    principal: delegator.address,
    sessionKey: sessionKey.address,
    operation: 'get_pii',
    args: { args: toolArgs },
    rawDelegationToken: token,
    requestId: `smoke-${now}`,
    issuedAt: now,
    expiresAt: now + 60_000,
    sign: (digest) => sessionKey.sign({ hash: digest }),
  });

  // 4. POST to the public native ingress.
  const res = await fetch(`${BASE}/mcp/native`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, invocationProof: proof, tool: 'get_pii', args: toolArgs }),
  });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);
  console.log(
    res.status === 200
      ? '\n✅ PASS — proof + delegation + policy accepted (200; data-layer ok flag is independent).'
      : res.status === 401
        ? '\n❌ FAIL — auth/proof rejected. Check wrangler tail for the private reason.'
        : `\n⚠ unexpected status ${res.status}`,
  );
}
main().catch((e) => { console.error('smoke error:', e); process.exit(1); });
