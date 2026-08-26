/**
 * akcs-shadow-check.mts — REMOTE RESOLVE-ONLY / SHADOW ADDRESS COMPARISON (AKCS design §21.3, §21.5).
 *
 * Proves, before any cutover, that the `agentic-kms` backend derives the SAME per-subject custodian
 * addresses (and byte-identical signatures) as the existing `local-aes` derivation from
 * A2A_MASTER_PRIVATE_KEY, and that envelope + MAC work against the configured AKCS.
 *
 *   pnpm --filter @agenticprimitives-demo/a2a exec tsx scripts/akcs-shadow-check.mts                       # reads apps/demo-a2a/.dev.vars
 *   pnpm --filter @agenticprimitives-demo/a2a exec tsx scripts/akcs-shadow-check.mts subjects.json         # [{iss,sub,rotation}] to compare
 *
 * Exit code 1 on any mismatch. Never prints key material.
 */
import { readFileSync } from 'node:fs';
import { buildKeyProvider, buildMacProvider, deriveSubjectSigner, loadSecret, staticTokenProvider } from '@agenticprimitives/key-custody';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
for (const k of ['AKCS_BASE_URL', 'AKCS_TENANT_ID', 'AKCS_TOKEN', 'A2A_MASTER_PRIVATE_KEY']) {
  if (!vars[k]) throw new Error(`missing ${k} in apps/demo-a2a/.dev.vars (run faithkms: just demo-stack-init)`);
}
process.env.NODE_ENV = 'development';
const agenticKms = {
  baseUrl: vars.AKCS_BASE_URL!,
  tenantId: vars.AKCS_TENANT_ID!,
  tokenProvider: staticTokenProvider(loadSecret(vars.AKCS_TOKEN!)),
  acceptedProtectionLevels: (vars.AKCS_ACCEPTED_PROTECTION_LEVELS ?? 'CVM_DERIVED,CVM_WRAPPED').split(',') as never,
};

const subjects: Array<{ iss: string; sub: string; rotation?: number }> = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : [
      { iss: 'https://accounts.google.com', sub: '108125' },
      { iss: 'https://accounts.google.com', sub: '108125', rotation: 1 },
      { iss: 'http://localhost:5373', sub: 'alice' },
      { iss: 'https://login.microsoftonline.com/common/v2.0', sub: 'AAAAAAAAAAAAAAAAAAAAAI-example', rotation: 3 },
    ];

let failures = 0;
const digest = new Uint8Array(32).fill(7);
for (const subject of subjects) {
  const remote = deriveSubjectSigner({ backend: 'agentic-kms', agenticKms, subject });
  const local = deriveSubjectSigner({ backend: 'local-aes', developmentMode: true, config: { derivationSecretHex: vars.A2A_MASTER_PRIVATE_KEY! }, subject });
  const [ra, la] = [await remote.getSignerAddress(), await local.getSignerAddress()];
  const [rs, ls] = [await remote.signA2AAction({ digest }), await local.signA2AAction({ digest })];
  const addrOk = ra.toLowerCase() === la.toLowerCase();
  const sigOk = Buffer.from(rs.signature).equals(Buffer.from(ls.signature));
  if (!addrOk || !sigOk) failures++;
  console.log(`${addrOk && sigOk ? 'ok  ' : 'FAIL'} sub=${subject.sub}${subject.rotation ? `#${subject.rotation}` : ''} C_sub=${ra} ${addrOk ? '(matches local-aes)' : `(local-aes ${la})`} sig=${sigOk ? 'identical' : 'DIFFERENT'} keyId=${rs.keyId}`);
}

const aad = { purpose: 'fed-token', provider: 'youversion', sa: '0x000000000000000000000000000000000000abcd' };
const p = buildKeyProvider({ backend: 'agentic-kms', agenticKms: { ...agenticKms, envelopePurpose: 'fed-token' } });
const g = await p.generateSessionDataKey({ aadContext: aad });
const d = await p.decryptSessionDataKey({ encryptedDataKey: g.encryptedDataKey, aadContext: aad, keyId: g.keyId, keyVersion: g.keyVersion });
const envOk = Buffer.from(d).equals(Buffer.from(g.plaintextDataKey));
const tamper = await p.decryptSessionDataKey({ encryptedDataKey: g.encryptedDataKey, aadContext: { ...aad, sa: '0x000000000000000000000000000000000000dcba' }, keyId: g.keyId, keyVersion: g.keyVersion }).then(() => false, () => true);
if (!envOk || !tamper) failures++;
console.log(`${envOk && tamper ? 'ok  ' : 'FAIL'} envelope fed-token keyId=${g.keyId} v${g.keyVersion} roundtrip=${envOk} tamperRejected=${tamper}`);

const mac = buildMacProvider('urn:mcp:server:person', { backend: 'agentic-kms', agenticKms });
const m = await mac.generateMac!({ canonicalMessage: new TextEncoder().encode('shadow'), service: 'a2a-to-mcp', audience: 'urn:mcp:server:person' });
console.log(`ok   mac ${m.mac.length} bytes keyId=${m.keyId}`);

console.log(failures ? `\nSHADOW CHECK FAILED (${failures})` : '\nSHADOW CHECK OK — agentic-kms matches local-aes for every subject');
process.exit(failures ? 1 : 0);
