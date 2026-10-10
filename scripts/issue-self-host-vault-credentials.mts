/**
 * Issue a SELF-HOSTED agent's VAULT WRITE CREDENTIALS — spec 433 W2 (the provenance slice): what a service that keeps
 * its runs at its own host presents at ITS vault's public door to write `run.provenance:<runRef>` (and the anchor and
 * measures beside it) as itself. Two delegations, both signed by the steward as the agent's custodian (persona-sign —
 * the same signature its storage grant carries):
 *
 *   1. the GRANT   — agent → the vault's interactions service (`INTERACTIONS_SERVICE_SA`), scoped to the RUN RECORDS ONLY
 *                    (`vault:run.provenance:*` · `run.anchor:*` · `run.measures:*`, write), one year. Not a copy of the
 *                    agent's full interactions grant: that one names every record type the Home knows and weighs 20 KB,
 *                    four times a Worker secret's 5 KB limit — and a worker that writes its own run records needs nothing
 *                    else. Least privilege and it fits.
 *   2. the LEAF    — agent → the worker's own signing key (DEL-001): the token the worker mints is signed by that key, and
 *                    the vault admits it only because this principal-signed leaf binds the key to the agent and admits
 *                    presenting the grant to the interactions service. One year.
 *
 * The worker's key is published at `GET <origin>/vault/signer` (the MCP's AKCS delegate for the agent's name). The
 * credentials are written to `--out <file>` (default stdout) and become the worker's secrets:
 *
 *   npx tsx scripts/issue-self-host-vault-credentials.mts scripture-resolver.svc --by ruth --origin https://scripture.faithnet.io --out /tmp/creds.json
 *   jq -c .grant /tmp/creds.json | wrangler secret put VAULT_GRANT --env faithnet
 *   jq -c .sessionLeaf /tmp/creds.json | wrangler secret put VAULT_SESSION_LEAF --env faithnet
 *
 * Never a read wire (that one cannot write) and never the runtime's leaf (that one binds the runtime's key). Revoke on
 * chain like any delegation of the agent's; re-run after a rotation (spec 410 §1).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Address, Hex } from '@agenticprimitives/types';
import { issueVaultRecordScopeDelegation, issueSessionDelegation, toWire, RUN_PROVENANCE_RESOURCE_SCOPE } from '../apps/home/src/lib/delegation';
import { INTERACTIONS_SERVICE_SA, DELIVERY_SERVICE_SA, MCP_SERVER_ID } from '../apps/home/src/lib/inbox-delivery';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (k: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : undefined);
const by = opt('by'); const origin = opt('origin'); const out = opt('out'); const days = Number(opt('days') ?? 365);
if (!target || !by || !origin) { console.error('usage: issue-self-host-vault-credentials.mts <address|name> --by <steward> --origin <https://host> [--days 365] [--out file]'); process.exit(2); }
if (!INTERACTIONS_SERVICE_SA) throw new Error('NEXT_PUBLIC_INTERACTIONS_SERVICE_SA is unset');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

function resolveTarget(t: string): { address: string; label: string } {
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { address: t.toLowerCase(), label: t.toLowerCase() };
  for (const f of readdirSync('demo').filter((x) => x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(`demo/${f}`, 'utf8')) as Record<string, { name?: string; sa?: string }>;
    for (const v of Object.values(doc)) if (v && typeof v === 'object' && v.name === t && typeof v.sa === 'string') return { address: v.sa.toLowerCase(), label: `${t} (${v.sa.toLowerCase()})` };
  }
  throw new Error(`${t} is neither an address nor a name in demo/*.json`);
}
const who = resolveTarget(target);

const signer = await j(await fetch(`${origin.replace(/\/$/, '')}/vault/signer`));
if (!signer.ok || !/^0x[0-9a-fA-F]{40}$/.test(String(signer.address))) throw new Error(`${origin} publishes no vault signer: ${JSON.stringify(signer).slice(0, 160)}`);
const delegate = String(signer.address).toLowerCase() as Address;

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error(`no session for ${by}`);
const sign = async (digest: string): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
  return b.signature as Hex;
};

// The grant: the run records, write only, at this estate's vault server. The anchor citation and the measurements sit beside
// the provenance under their own keys (`run.anchor:<runRef>`, `run.measures:<runRef>` — service-host's provenance sink).
const RUN_RECORD_SCOPES = [RUN_PROVENANCE_RESOURCE_SCOPE, 'vault:run.anchor:*', 'vault:run.measures:*'];
const grant = toWire(await issueVaultRecordScopeDelegation(who.address as Address, INTERACTIONS_SERVICE_SA, [{ server: MCP_SERVER_ID, resources: RUN_RECORD_SCOPES, ops: ['write'] }], sign, days * 86_400));
const leaf = toWire(await issueSessionDelegation(who.address as Address, delegate, sign, [INTERACTIONS_SERVICE_SA, ...(DELIVERY_SERVICE_SA ? [DELIVERY_SERVICE_SA] : [])], days * 86_400));
const creds = { agent: who.address, delegate, interactionsService: INTERACTIONS_SERVICE_SA, server: MCP_SERVER_ID, scopes: RUN_RECORD_SCOPES, issuedBy: by, issuedAt: new Date().toISOString(), days, grant, sessionLeaf: leaf };
if (out) { writeFileSync(out, `${JSON.stringify(creds, null, 2)}\n`); console.log(`${who.label} → vault credentials for ${delegate} (grant to ${INTERACTIONS_SERVICE_SA}, leaf ${days} days) by ${by} → ${out}`); }
else console.log(JSON.stringify(creds));
