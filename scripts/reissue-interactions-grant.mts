// Re-sign the interactions grant for orgs whose grant predates a SCOPE WIDENING.
//
// WHY THIS EXISTS. `APP_COORDINATION_READ_SCOPES` is additive and read-only: widening it changes what
// a NEWLY minted grant carries and does nothing at all to grants already signed. Until the steward
// re-signs, demo-mcp refuses the new record types per-record with `record_scope_denied`, the spec-334
// gather turn reads nothing, and the org's agent answers — honestly and uselessly — that no reference
// facts reached it. Nothing in that chain is an error anyone sees; it is a working system enforcing a
// grant that was correct when it was signed.
//
// The UI path is Home → org → Agent → "Enable vault storage", which calls
// `activateInteractionsIfNeeded(principal, via, auth, force = true)`. That needs a browser session
// because the signature normally comes from the steward's passkey. For the DEMO orgs it does not have
// to: the org SA's ERC-1271 accepts its custodian's EOA, which is exactly how migrate-vaults.mjs
// already writes to these same vaults. So this mints the identical delegation and posts it to the
// same endpoint, with no browser.
//
// WHAT IT DOES NOT DO: change any scope. It re-signs whatever `buildInteractionsStruct` currently
// builds. If the scope list is wrong, this faithfully re-issues the wrong scope.
//
//   npx tsx scripts/reissue-interactions-grant.mts --dry-run
//   npx tsx scripts/reissue-interactions-grant.mts [--org <handle>]
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { issueInteractionsDelegation, toWire } from '../apps/demo-sso-next/src/lib/delegation.js';
import { MCP_SERVER_ID } from '../apps/demo-sso-next/src/lib/inbox-delivery.js';
import { decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';

const A2A = process.env.A2A_BASE ?? 'https://demo-a2a-production.richardpedersen3.workers.dev';
const INTERACTIONS_SERVICE_SA = (process.env.INTERACTIONS_SERVICE_SA
  ?? '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a') as Address;
const ACCOUNTS = process.env.TRACKER_ACCOUNTS ?? '/home/barb/uupg/apps/tracker/seed/demo-accounts.json';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

type Person = { handle: string; eoaPrivateKey: string; sa: string };
const m = JSON.parse(readFileSync(ACCOUNTS, 'utf8')) as {
  people: Record<string, Person>;
  org?: { handle?: string; name?: string; sa?: string; custodian?: string };
  hotspotOrgs?: Record<string, string>;
};

// Every org whose vault the tracker reads: the legacy single workspace AND each hotspot, because a
// hotspot IS an organization and its own vault is where its grid lives.
const targets: { handle: string; sa: Address }[] = [];
if (m.org?.sa) targets.push({ handle: m.org.handle ?? 'tracker-org', sa: m.org.sa as Address });
for (const [handle, sa] of Object.entries(m.hotspotOrgs ?? {})) targets.push({ handle, sa: sa as Address });

const custodianHandle = m.org?.custodian ?? Object.keys(m.people)[0]!;
const custodian = m.people[custodianHandle]!;
if (!custodian?.eoaPrivateKey) throw new Error(`no custodian key for "${custodianHandle}" in ${ACCOUNTS}`);

/** The org SA's ERC-1271 accepts its custodian's EOA — the same authority migrate-vaults.mjs uses. */
const signHash = async (digest: Hex): Promise<Hex> =>
  privateKeyToAccount(custodian.eoaPrivateKey as Hex).signMessage({ message: { raw: digest } });

const status = async (sa: string) => {
  const r = await fetch(`${A2A}/interactions/${sa.toLowerCase()}/status`);
  return (await r.json().catch(() => ({}))) as { granted?: boolean; current?: boolean };
};

/** The scopes a delegation actually carries, decoded from its own caveat.
 *
 *  NOT from `/status`, which reports {granted, current, deliveryGranted, gatewayAdoption} and NO
 *  resource list at all — an earlier version of this script asked it for `resources`, got undefined,
 *  and reported "0 uupg scopes, still missing" for grants it had just correctly written. Reading a
 *  field that does not exist looks exactly like a real negative finding. The wire is the authority. */
const scopesOf = (d: { caveats: readonly { enforcer: string; terms: string }[] }) => {
  const cav = d.caveats.find((c) => c.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
  if (!cav) return [];
  return decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g: { resources: string[] }) => g.resources);
};

async function main() {
  console.log(`interactions re-grant → ${A2A}${DRY ? '  [DRY RUN — no writes]' : ''}`);
  console.log(`custodian: ${custodianHandle} (${custodian.sa})   delegate: ${INTERACTIONS_SERVICE_SA}\n`);

  let failed = 0;
  for (const t of targets) {
    if (ONLY && t.handle !== ONLY) continue;
    const before = await status(t.sa);
    process.stdout.write(`── ${t.handle}  ${t.sa}\n   before: granted=${before.granted === true} current=${before.current !== false}\n`);

    const delegation = await issueInteractionsDelegation(t.sa, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID, signHash);
    const scopes = scopesOf(delegation as never);
    const wanted = ['vault:uupg:identity', 'vault:uupg:community', 'vault:uupg:observations'];
    const missing = wanted.filter((w) => !scopes.includes(w));
    if (missing.length) { console.log(`   ✗ the delegation this build produces LACKS ${missing.join(', ')} — fix APP_COORDINATION_READ_SCOPES, not this script\n`); failed++; continue; }
    if (DRY) { console.log(`   [dry] would re-sign with ${scopes.length} scopes (uupg: ${scopes.filter((s) => s.startsWith('vault:uupg:')).length})\n`); continue; }
    const res = await fetch(`${A2A}/interactions/${t.sa.toLowerCase()}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delegation: toWire(delegation) }),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || out.ok !== true) { console.log(`   ✗ ${out.error ?? `HTTP ${res.status}`}\n`); failed++; continue; }

    const after = await status(t.sa);
    console.log(`   ✓ re-signed — ${scopes.length} scopes stored (uupg: ${scopes.filter((s) => s.startsWith('vault:uupg:')).length}, incl. identity + community + observations); granted=${after.granted === true}\n`);
  }
  if (failed) { console.error(`${failed} org(s) did not end up with the widened scope.`); process.exit(1); }
  console.log('done.');
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
