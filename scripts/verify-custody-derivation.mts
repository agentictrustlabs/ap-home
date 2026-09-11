/**
 * Does the custody service still derive the SAME per-subject custodian it used to?
 *
 *   MASTER=0x… npx tsx scripts/verify-custody-derivation.mts <iss> <sub> [rotation]
 *   AKCS_TOKEN=… npx tsx scripts/verify-custody-derivation.mts <iss> <sub> [rotation]
 *   # both set → derives twice and COMPARES: that is the acceptance test for a re-seed.
 *
 * WHY THIS EXISTS. A person's KMS-custodied home IS a CREATE2 address over their derived custodian
 * `C_sub`, so the derivation root can never move: a different root derives a different custodian,
 * which is a different Smart Agent — an empty one. `assertSubjectSaStable` in demo-a2a refuses to
 * route to it (`custody_root_changed`, D-P0-1), which is correct and is also the whole failure: the
 * member is locked out of a home that still exists and still holds their data.
 *
 * The GCP→AKCS migration is exactly that hazard. AKCS is supposed to hold the LEGACY master as its
 * OIDC-custodian derivation seed and run the identical `ap-oidc-custodian-secp256k1-v1` scheme, so
 * every existing subject keeps deriving the same address. This checks whether it does — before
 * trusting it, and after re-seeding it.
 *
 * The scheme, so a re-seed can be checked against something concrete rather than a claim:
 *   canonical = `kms-custodian:v1:<encodeURIComponent(iss)>:<encodeURIComponent(sub)>:<rotation>`
 *   okm       = HKDF-SHA256(ikm = master, salt = "kms-custodian:v1", info = canonical, 32 bytes)
 *   priv      = (okm mod (n-1)) + 1        // secp256k1, uniform in [1, n-1]
 *   C_sub     = address(priv);  SA = factory.getAddressForAgentAccount([C_sub], salt 0)
 *
 * MASTER is read from the environment and never written anywhere. It is the custody root: whoever
 * holds it can sign for every KMS-custodied member.
 */
import { createPublicClient, http, type Address } from 'viem';
import { deriveSubjectSigner } from '@agenticprimitives/key-custody';

const RPC = process.env.RPC_URL ?? 'https://rpc.faithnet.io/';
const FACTORY = (process.env.AGENT_ACCOUNT_FACTORY ?? '0x464eEe7518c3c97DA570592481329E0627E9a3B8') as Address;
const AKCS_BASE = process.env.AKCS_BASE_URL ?? 'https://akcs-pilot.faithnet.io';
const AKCS_TENANT = process.env.AKCS_TENANT_ID ?? 'faithnet';

const [iss, sub, rotationRaw] = [process.argv[2], process.argv[3], process.argv[4]];
if (!iss || !sub) {
  console.error('usage: verify-custody-derivation.mts <iss> <sub> [rotation]');
  console.error("  google:  'https://accounts.google.com' <google subject id>");
  console.error("  email:   'email' <sha256(lowercased email) hex>");
  console.error("  phone:   'phone' <sha256(E.164) hex>");
  process.exit(2);
}
const rotation = Number(rotationRaw ?? 0);

const FACTORY_ABI = [{
  type: 'function', name: 'getAddressForAgentAccount', stateMutability: 'view',
  inputs: [
    { type: 'tuple', components: [
      { name: 'mode', type: 'uint8' }, { name: 'custodians', type: 'address[]' },
      { name: 'threshold', type: 'uint256' }, { name: 'guardians', type: 'address[]' },
      { name: 'guardianThreshold', type: 'uint256' },
    ] },
    { type: 'tuple', components: [
      { name: 'custodyDelay', type: 'uint256' }, { name: 'guardianDelay', type: 'uint256' },
    ] },
    { name: 'salt', type: 'uint256' },
  ],
  outputs: [{ type: 'address' }],
}] as const;

const client = createPublicClient({ transport: http(RPC) });
async function saFor(custodian: Address): Promise<Address | string> {
  try {
    return (await client.readContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: 'getAddressForAgentAccount',
      args: [{ mode: 0, custodians: [custodian], threshold: 1n, guardians: [], guardianThreshold: 0n },
             { custodyDelay: 0n, guardianDelay: 0n }, 0n],
    })) as Address;
  } catch (e) {
    return `(could not predict: ${e instanceof Error ? e.message.split('\n')[0] : String(e)})`;
  }
}

console.log(`subject  iss=${iss} sub=${sub} rotation=${rotation}\n`);

let local: Address | null = null;
if (process.env.MASTER) {
  // The PUBLIC surface: the derived signer's address is C_sub; the raw key never leaves the package
  // (`deriveSubjectPrivateKeyHex` is deliberately not exported — audit ARCH-006 / PKG-KEY-CUSTODY-002).
  const signer = deriveSubjectSigner({
    backend: 'local-aes',
    config: { derivationSecretHex: process.env.MASTER.startsWith('0x') ? process.env.MASTER : `0x${process.env.MASTER}` },
    subject: { iss, sub, rotation },
  });
  local = await signer.getSignerAddress();
  console.log(`LOCAL  (candidate master)  C_sub=${local}`);
  console.log(`                           SA   =${await saFor(local)}`);
}

let remote: Address | null = null;
if (process.env.AKCS_TOKEN) {
  const body = JSON.stringify({ subject: { iss, sub, rotation }, derivationScheme: 'ap-oidc-custodian-secp256k1-v1' });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(`${AKCS_BASE}/v1/derived-signers/resolve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.AKCS_TOKEN}`,
      'x-akcs-tenant-id': AKCS_TENANT,
      'x-akcs-request-id': crypto.randomUUID(),
      'x-akcs-timestamp': new Date().toISOString(),
      'x-akcs-body-sha256': b64url(digest),
    },
    body,
  });
  const j = (await res.json().catch(() => ({}))) as { address?: string; publicKeyAddress?: string; error?: unknown };
  remote = (j.address ?? j.publicKeyAddress ?? null) as Address | null;
  if (!remote) { console.log(`AKCS   HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`); }
  else {
    console.log(`AKCS   (tenant ${AKCS_TENANT})     C_sub=${remote}`);
    console.log(`                           SA   =${await saFor(remote)}`);
  }
}

if (local && remote) {
  const same = local.toLowerCase() === remote.toLowerCase();
  console.log(`\n${same ? '✓ MATCH' : '✗ MISMATCH'} — AKCS ${same ? 'holds' : 'does NOT hold'} this master as its OIDC-custodian seed.`);
  if (!same) console.log('  Every subject that existed before the cutover derives a different, empty Smart Agent.');
  process.exit(same ? 0 : 1);
}
if (!local && !remote) console.log('Set MASTER and/or AKCS_TOKEN — with neither there is nothing to compare.');
