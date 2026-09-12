/**
 * Acceptance for the AKCS per-person vault KEK (spec 278 on `agentic-kms`).
 *
 *   pnpm tsx scripts/verify-akcs-vault.mts [handle]      # default: alice
 *
 * Drives the SAME endpoints the Home drives, for a demo persona whose custodian key the Home holds
 * (`/connect/persona-sign`), so every signature is a real ERC-1271-valid custodian signature rather
 * than a fixture: server-info → provision → bind → vault write → vault read.
 *
 * The write/read round trip is the point. Provision and bind can both succeed while UNWRAP fails, and
 * the two look identical until a value comes back — which is how a broken KEK path stays invisible
 * until a member opens their records. It also asserts nothing about GCP: with `A2A_KMS_BACKEND =
 * agentic-kms` there is no GCP branch to fall back to (ADR-0013), so a pass here means AKCS did it.
 *
 * Per-person separation is NOT asserted here (this script sees one owner at a time). Verify it by
 * running two handles and comparing `crypto_meta.dekKid` in `vault_objects` — different owners must
 * show different AKCS key ids. AKCS resolves `data-keys/generate` by PURPOSE, so a per-person purpose
 * yields a per-person KEY; one tenant key separated by AAD would NOT satisfy VKB-D1.
 *
 * Leaves an `akcs-verification` record behind in the persona's vault — delete it when done.
 */
import { keccak256, toBytes, toHex } from 'viem';
import { buildVaultKeyUseCaveat, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const MCP = process.env.MCP_URL ?? 'https://mcp.faithnet.io';
const CHAIN_ID = 34348;
const DELEGATION_MANAGER = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7';
const handle = process.argv[2] ?? 'alice';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };

// 1. A real Home session for the persona.
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle, client_id: 'demo-jp' }),
}));
const token: string = signin.homeSession;
const owner: string = String(signin.agent ?? '').toLowerCase();
if (!token || !owner) throw new Error(`demo-signin gave no session: ${JSON.stringify(signin).slice(0, 300)}`);
console.log(`persona ${handle} → ${owner}`);

const sign = async (digest: string): Promise<string> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ digest }),
  }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 300)}`);
  return b.signature;
};

// 2. The server's terms + the deterministic per-person KEK ref.
const info = await j(await fetch(`${MCP}/custody/vault-key/server-info?owner=${owner}`));
console.log(`server-info kmsKeyRef = ${info.kmsKeyRef}`);
if (!String(info.kmsKeyRef ?? '').startsWith('akcs:')) throw new Error('server-info did not return an AKCS ref');

// 3. Provision — mints the person's own ENVELOPE key in AKCS, idempotently.
const issuedAt = Math.floor(Date.now() / 1000);
const provChallenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', owner, String(issuedAt)].join('\n')));
const prov = await j(await fetch(`${MCP}/custody/vault-key/provision`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ owner, issuedAt, proof: await sign(provChallenge) }),
}));
console.log('provision →', JSON.stringify(prov));
if (!prov.ok) throw new Error('provision failed');

// 4. Bind: the person SA authorizes demo-mcp to wield that KEK.
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const delegation: Delegation = {
  delegator: owner as `0x${string}`,
  delegate: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as `0x${string}`,
  authority: ROOT_AUTHORITY,
  caveats: [buildVaultKeyUseCaveat({
    vaultId: String(info.serverId ?? '').trim() || 'demo-mcp', kmsKeyRef: prov.kmsKeyRef, resources: info.defaultResources,
    classificationCeiling: info.classificationCeiling, ops: info.ops, noSubdelegation: true,
  })],
  salt, signature: '0x',
};
delegation.signature = await sign(hashDelegation(delegation, CHAIN_ID, DELEGATION_MANAGER as `0x${string}`)) as `0x${string}`;
const bind = await j(await fetch(`${MCP}/custody/vault-key/bind`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    owner, vaultId: String(info.serverId ?? '').trim() || 'demo-mcp', kmsKeyRef: prov.kmsKeyRef,
    allowedResources: info.defaultResources, classificationCeiling: info.classificationCeiling,
    ops: info.ops, expiresAt: new Date(Date.now() + 90 * 864e5).toISOString(),
    authorization: { ...delegation, salt: salt.toString() },
  }),
}));
console.log('bind →', JSON.stringify(bind).slice(0, 300));
if (!bind.ok) throw new Error('bind failed');

const bound = await j(await fetch(`${MCP}/custody/vault-key/is-bound?owner=${owner}`));
console.log('is-bound →', JSON.stringify(bound));
// 5. THE ACTUAL GATE — write then read a record. Provisioning and binding can both succeed while
//    unwrap fails; only a value that comes back proves the KEK is wielded end to end.
// The a2a vault routes require a gateway assertion (edge admission), which only the Home's proxy
// carries — a direct call from here is correctly refused. So go through the Home, exactly as the
// browser does: mint a CSRF token, then POST /a2a/mcp/vault/*.
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
if (!csrf.token) throw new Error(`no CSRF token: ${JSON.stringify(csrf).slice(0, 200)}`);
const selfSalt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const self: Delegation = {
  delegator: owner as `0x${string}`, delegate: owner as `0x${string}`,
  authority: ROOT_AUTHORITY, caveats: [], salt: selfSalt, signature: '0x',
};
self.signature = await sign(hashDelegation(self, CHAIN_ID, DELEGATION_MANAGER as `0x${string}`)) as `0x${string}`;
const wire = { ...self, salt: selfSalt.toString() };

const marker = `akcs-roundtrip-${Date.now()}`;
const vault = async (op: 'set' | 'get', extra: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a/mcp/vault/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token! },
    body: JSON.stringify({ delegation: wire, requester: owner, recordType: 'akcs-verification', ...extra }),
  }));

const wrote = await vault('set', { data: { marker } });
console.log('vault set →', JSON.stringify(wrote).slice(0, 250));
const read = await vault('get', {});
console.log('vault get →', JSON.stringify(read).slice(0, 250));
if ((read as { data?: { marker?: string } }).data?.marker !== marker) {
  throw new Error('ROUND TRIP FAILED — the value written did not come back');
}
console.log(`\n✓ AKCS per-person vault KEK works end to end for ${handle}: provision → bind → wrap → unwrap.`);
