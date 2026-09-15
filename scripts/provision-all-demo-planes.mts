/**
 * Turn on the interactions + delivery planes for EVERY demo agent — persons AND everything they custody
 * (orgs, teams, workspaces, treasuries) — so no demo surface shows "Enable (steward)" or answers
 * "auth failed — mcp: auth failed" again.
 *
 *   NEXT_PUBLIC_CHAIN_ID=34348 NEXT_PUBLIC_CONTRACTS_JSON="$(cat packages/contracts/deployments-faithchain.json)" \
 *     npx tsx scripts/provision-all-demo-planes.mts [--dry-run] [handle…]
 *
 * WHY THIS IS LEGITIMATE. Enabling a plane is a custody act: the agent's ERC-1271 accepts its custodian's
 * signature over the grant digest. For the demo estate the Home HOLDS the personas' keys and exposes
 * `/connect/persona-sign`, so the script makes exactly the signature the person's own click would — the
 * same argument reissue-interactions-grants.mts already makes. Nothing here mints authority a custodian
 * does not have; an agent custodied by someone else's credential simply fails ERC-1271 and stays off.
 *
 * Going forward this is BELT to the genesis's SUSPENDERS: team-create now folds the planes into the one
 * genesis signature, and Home org-create always provisioned them — this script closes out the agents
 * created before either.
 */
import { toWire, issueInteractionsDelegation, issueInboxDeliveryDelegation, issueSessionDelegation } from '../apps/home/src/lib/delegation';
import { buildVaultKeyAuthorization } from '../apps/home/src/lib/delegation';
import { keccak256, toBytes } from 'viem';
import { MCP_SERVER_ID } from '../apps/home/src/lib/inbox-delivery';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const INTERACTIONS_SERVICE_SA = (process.env.INTERACTIONS_SERVICE_SA ?? '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a') as Address;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = process.argv.includes('--dry-run');
/** Agents this persona is listed against but does not custody — their ERC-1271 refuses the signature,
 *  which is the system working. Counted apart from failures so a real one is visible. */
let notMineCount = 0;
const notMine = (why: string): boolean => /signature failed verification against the delegator|proof_invalid|not a custodian/i.test(why);
/** Re-sign interactions grants even when /status says current — for a SCOPE WIDENING the staleness gate
 *  deliberately does not force (blanket-staling the estate is the named hazard; this flag is the
 *  explicit, targeted alternative). */
const RESIGN = process.argv.includes('--resign');
const HANDLES = args.length ? args : ['alice', 'bob', 'carol', 'dave', 'elena', 'nathan', 'david'];

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 160) }; } };

let fixedCount = 0; let failCount = 0;

for (const handle of HANDLES) {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, client_id: 'demo-jp' }),
  }));
  const token: string = si.homeSession;
  const person = String(si.agent ?? '').toLowerCase();
  if (!token || !person) { console.log(`${handle}: no session`); continue; }

  const sign = async (digest: Hex): Promise<Hex> => {
    const b = await j(await fetch(`${HOME}/connect/persona-sign`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ digest }),
    }));
    if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
    return b.signature as Hex;
  };

  // The person's own agent, plus every agent their Home lists them as steward of. 'any' surface so an
  // inactive org is still repaired — Settings must work there too.
  const related = await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${token}` } }));
  const orgs = (related.orgs ?? []) as Array<{ orgAgent: string; orgName: string; kind?: string; relationship?: string }>;
  const targets: Array<{ sa: string; label: string }> = [
    { sa: person, label: `${handle} (person)` },
    // EVERY related agent, whatever the relationship LABEL says. The label is a display projection; the
    // authority to enable a plane is the persona's key passing the agent's ERC-1271, which fail-closes
    // on its own. Filtering on the word skipped a team the persona CUSTODIED but was listed as a mere
    // member of — and it stayed broken while everything the filter liked got fixed.
    // THE ADDRESS IS PART OF THE LABEL. A failure that names only "Field Workspace" cannot be chased:
    // two of these are custodied by a credential this persona does not hold, and telling them apart from
    // a real breakage takes the address to look up on chain.
    ...orgs.map((o) => ({ sa: o.orgAgent.toLowerCase(), label: `${o.orgName || o.orgAgent.slice(0, 10)} [${o.kind ?? 'org'}] ${o.orgAgent.slice(0, 10)}…` })),
  ];

  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };

  const sk = await j(await fetch(`${HOME}/a2a/agent/interactions-session-key`)) as { ok?: boolean; address?: string };
  if (!sk?.ok || !sk.address) throw new Error('no interactions-session key advertised — grants would store and 409');

  for (const t of targets) {
    const st = await j(await fetch(`${HOME}/a2a/interactions/${t.sa}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: token }) })) as { granted?: boolean; current?: boolean; deliveryGranted?: boolean };
    let needIx = RESIGN || st.granted !== true || st.current !== true;
    let needDl = st.deliveryGranted !== true;
    // THE THIRD LEG — the VAULT KEY (spec 278). Grants authorize the read; the KEK is what decrypts it.
    // rich-big-thompson-team had both planes ON and every read still failing, because nothing had ever
    // bound its key: an agent created outside the Home's org-create ceremony gets grants from this sweep
    // and no KEK from anywhere. Both proofs are ERC-1271 against the owner, so the persona key makes them.
    const kb = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/is-bound?owner=${t.sa}`)) as { bound?: boolean; allowedResources?: string[] };
    const needKey = kb.bound !== true || !(kb.allowedResources ?? []).includes('vault:*');
    if (!needIx && !needDl && !needKey) { console.log(`  ✓ ${t.label} — planes + vault key on`); continue; }
    if (!DRY && needKey) {
      try {
        const info = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/server-info`)) as { serverId?: string; serverKey?: string; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[] };
        const issuedAt = Math.floor(Date.now() / 1000);
        const challenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', t.sa, String(issuedAt)].join('\n')));
        const prov = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: t.sa, issuedAt, proof: await sign(challenge) }) })) as { ok?: boolean; kmsKeyRef?: string; error_description?: string; detail?: string };
        if (!prov.ok || !prov.kmsKeyRef) throw new Error(prov.error_description ?? prov.detail ?? 'provision failed');
        const params = { vaultId: String(info.serverId ?? '').trim() || 'demo-mcp', kmsKeyRef: prov.kmsKeyRef, serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address, allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'], classificationCeiling: info.classificationCeiling ?? 'regulated.high', ops: info.ops ?? ['read', 'write'] as ('read' | 'write')[] };
        const { delegation, digest, expiresAt } = buildVaultKeyAuthorization(t.sa as Address, params);
        delegation.signature = await sign(digest);
        const bound = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: t.sa, vaultId: params.vaultId, kmsKeyRef: params.kmsKeyRef, allowedResources: params.allowedResources, classificationCeiling: params.classificationCeiling, ops: params.ops, expiresAt, authorization: toWire(delegation) }) })) as { ok?: boolean; reason?: string; error?: string };
        if (bound.ok !== true) throw new Error(bound.reason ?? bound.error ?? 'bind failed');
        console.log(`  ✚ ${t.label} — vault key bound (${prov.kmsKeyRef.slice(0, 24)}…)`);
        fixedCount++;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (notMine(why)) { console.log(`  · ${t.label} — not yours to enable (you are a member, not its custodian)`); notMineCount++; needIx = false; needDl = false; }
        else { console.log(`  ✗ ${t.label} vault key: ${why}`); failCount++; }
      }
    }
    if (!needIx && !needDl) continue;
    if (DRY) { console.log(`  · ${t.label} — WOULD fix: ${[needIx && 'interactions', needDl && 'delivery'].filter(Boolean).join(' + ')}`); continue; }
    try {
      if (needIx) {
        const d = await issueInteractionsDelegation(t.sa as Address, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID, sign);
        const leaf = await issueSessionDelegation(t.sa as Address, sk.address as Address, sign);
        const res = await j(await fetch(`${HOME}/a2a/interactions/${t.sa}/grant`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: toWire(d), sessionLeaf: toWire(leaf) }) }));
        if (res.ok !== true) throw new Error(`grant: ${res.error ?? JSON.stringify(res).slice(0, 100)}`);
      }
      if (needDl) {
        const d = await issueInboxDeliveryDelegation(t.sa as Address, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID, sign);
        const res = await j(await fetch(`${HOME}/a2a/interactions/${t.sa}/grant.delivery.put`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: toWire(d) }) }));
        if (res.ok !== true) throw new Error(`delivery: ${res.error ?? JSON.stringify(res).slice(0, 100)}`);
      }
      const after = await j(await fetch(`${HOME}/a2a/interactions/${t.sa}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: token }) })) as { granted?: boolean; current?: boolean; deliveryGranted?: boolean };
      const ok = after.granted === true && after.deliveryGranted === true;
      console.log(`  ${ok ? '✚ FIXED' : '✗ STILL OFF'} ${t.label} — granted=${after.granted} current=${after.current} delivery=${after.deliveryGranted}`);
      if (ok) fixedCount++; else failCount++;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // A REFUSAL BY CUSTODY IS NOT A BREAKAGE. This script deliberately tries every agent a person's
      // Home lists — filtering on the relationship label once skipped a team they DID custody — so the
      // agent's own ERC-1271 is what decides, and it fail-closes correctly for one they merely belong
      // to. Reporting that as "failed" ends every run with a number nobody can act on, which is how a
      // real breakage hides among four permanent ones.
      if (notMine(why)) { console.log(`  · ${t.label} — not yours to enable (you are a member, not its custodian)`); notMineCount++; }
      else { console.log(`  ✗ ${t.label}: ${why}`); failCount++; }
    }
  }
}
console.log(`\n${fixedCount} fixed, ${failCount} failed, ${notMineCount} not yours to enable${DRY ? ' (dry run)' : ''}`);
if (failCount) process.exit(1);
