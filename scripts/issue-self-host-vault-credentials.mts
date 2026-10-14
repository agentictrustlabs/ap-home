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
 *
 * TWO GENERALIZATIONS, both for a worker that is not a harness host (ap-federation's projector, spec 439):
 *   --scope vault:<family>:*   one or more record families instead of the run records. Repeatable. The grant stays
 *                              least-privilege: name the families this worker writes and nothing else.
 *   --ops read,write           a worker that REBUILDS from its own records needs to read them back, not only write.
 *   --delegate 0x…             when the worker publishes no `/vault/signer` because it is not an MCP host, name its
 *                              key directly. The key still never appears here: only its address.
 *   HOME_URL=…                 the steward's own Home, which for an agent of another estate is that estate's Home.
 *   --interactions 0x…         THAT estate's interactions-execution SA — the grant's delegate. Required whenever
 *                              HOME_URL is not this deployment's own Home, and refused rather than defaulted:
 *                              the compiled-in address is faithnet's, and a grant naming the wrong estate's
 *                              service is refused at the vault door with nothing to say why (spec 439).
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
const delegateOpt = opt('delegate')?.toLowerCase();
const scopeOpts = args.flatMap((a, i) => (a === '--scope' && args[i + 1] ? [args[i + 1]] : []));
const ops = (opt('ops') ?? 'write').split(',').map((o) => o.trim()).filter(Boolean) as ('read' | 'write')[];
if (!target || !by || !(origin || delegateOpt)) { console.error('usage: issue-self-host-vault-credentials.mts <address|name> --by <steward> (--origin <https://host> | --delegate 0x…) [--scope vault:<family>:* …] [--ops read,write] [--days 365] [--out file]'); process.exit(2); }
for (const o of ops) if (o !== 'read' && o !== 'write') { console.error(`--ops takes read and/or write, not ${o}`); process.exit(2); }
for (const sc of scopeOpts) if (!sc.startsWith('vault:')) { console.error(`--scope must name a vault record family, e.g. vault:federation.projection-submission:* (got ${sc})`); process.exit(2); }
const DEFAULT_HOME = 'https://www.faithnet.me';
// REFUSE AN UNSET CHAIN. `CHAIN_ID` in `lib/chain.ts` falls back to Base Sepolia when
// `NEXT_PUBLIC_CHAIN_ID` is absent, and the delegation digest is signed over that chain id and ITS
// DelegationManager. Run this script without the env and it cheerfully issues a grant for a chain the
// estate left behind: valid-looking, 65 bytes, and refused at the vault as `signature validation failed`
// with nothing to say why. Cost: one afternoon. The fix is to say the chain or write nothing.
if (!process.env.NEXT_PUBLIC_CHAIN_ID) {
  console.error('NEXT_PUBLIC_CHAIN_ID is unset, and the delegation digest is signed over the chain id and that chain\'s DelegationManager.');
  console.error('Set it (faithchain is 34348) — e.g. NEXT_PUBLIC_CHAIN_ID=34348 NEXT_PUBLIC_RPC_URL=… npx tsx scripts/issue-self-host-vault-credentials.mts …');
  process.exit(2);
}
const interactionsOpt = opt('interactions')?.toLowerCase();
if (interactionsOpt && !/^0x[0-9a-f]{40}$/.test(interactionsOpt)) { console.error('--interactions must be an address'); process.exit(2); }
// Fail closed rather than default: this Home's interactions SA is compiled in, and silently using it for an agent
// of another estate issues a grant that estate's vault refuses (ADR-0013 — one mechanism, no quiet substitution).
if (HOME !== DEFAULT_HOME && !interactionsOpt) { console.error(`HOME_URL is ${HOME}, not ${DEFAULT_HOME} — name that estate's interactions SA with --interactions 0x… (the compiled-in one is this deployment's)`); process.exit(2); }
const interactions = (interactionsOpt ?? INTERACTIONS_SERVICE_SA) as Address | undefined;
if (!interactions) throw new Error('no interactions service: pass --interactions 0x… or set NEXT_PUBLIC_INTERACTIONS_SERVICE_SA');
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

let delegate: Address;
if (delegateOpt) {
  if (!/^0x[0-9a-f]{40}$/.test(delegateOpt)) throw new Error('--delegate must be an address');
  delegate = delegateOpt as Address;
} else {
  const signer = await j(await fetch(`${origin!.replace(/\/$/, '')}/vault/signer`));
  if (!signer.ok || !/^0x[0-9a-fA-F]{40}$/.test(String(signer.address))) throw new Error(`${origin} publishes no vault signer: ${JSON.stringify(signer).slice(0, 160)}`);
  delegate = String(signer.address).toLowerCase() as Address;
}

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
const RUN_RECORD_SCOPES = scopeOpts.length ? scopeOpts : [RUN_PROVENANCE_RESOURCE_SCOPE, 'vault:run.anchor:*', 'vault:run.measures:*'];
const grant = toWire(await issueVaultRecordScopeDelegation(who.address as Address, interactions, [{ server: MCP_SERVER_ID, resources: RUN_RECORD_SCOPES, ops }], sign, days * 86_400));
// The leaf admits presenting to the interactions service. The delivery service is named only when it is THIS
// deployment's own, because another estate's delivery SA is not something this script can know.
const leafAudience = [interactions, ...(!interactionsOpt && DELIVERY_SERVICE_SA ? [DELIVERY_SERVICE_SA] : [])];
const leaf = toWire(await issueSessionDelegation(who.address as Address, delegate, sign, leafAudience, days * 86_400));
const creds = { agent: who.address, delegate, interactionsService: interactions, server: MCP_SERVER_ID, scopes: RUN_RECORD_SCOPES, ops, home: HOME, issuedBy: by, issuedAt: new Date().toISOString(), days, grant, sessionLeaf: leaf };
if (out) { writeFileSync(out, `${JSON.stringify(creds, null, 2)}\n`); console.log(`${who.label} → vault credentials for ${delegate} (grant to ${interactions} for ${RUN_RECORD_SCOPES.join(' ')} ${ops.join('+')}, leaf ${days} days) by ${by} at ${HOME} → ${out}`); }
else console.log(JSON.stringify(creds));
