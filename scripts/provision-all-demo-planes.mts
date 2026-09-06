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
import { toWire, issueInteractionsDelegation, issueInboxDeliveryDelegation, issueSessionDelegation } from '../apps/demo-sso-next/src/lib/delegation';
import { MCP_SERVER_ID } from '../apps/demo-sso-next/src/lib/inbox-delivery';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const INTERACTIONS_SERVICE_SA = (process.env.INTERACTIONS_SERVICE_SA ?? '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a') as Address;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = process.argv.includes('--dry-run');
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
    ...orgs
      .filter((o) => o.relationship !== 'member')
      .map((o) => ({ sa: o.orgAgent.toLowerCase(), label: `${o.orgName} [${o.kind ?? 'org'}]` })),
  ];

  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };

  const sk = await j(await fetch(`${HOME}/a2a/agent/interactions-session-key`)) as { ok?: boolean; address?: string };
  if (!sk?.ok || !sk.address) throw new Error('no interactions-session key advertised — grants would store and 409');

  for (const t of targets) {
    const st = await j(await fetch(`${HOME}/a2a/interactions/${t.sa}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: token }) })) as { granted?: boolean; current?: boolean; deliveryGranted?: boolean };
    const needIx = st.granted !== true || st.current !== true;
    const needDl = st.deliveryGranted !== true;
    if (!needIx && !needDl) { console.log(`  ✓ ${t.label} — both planes on`); continue; }
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
      console.log(`  ✗ ${t.label}: ${e instanceof Error ? e.message : String(e)}`);
      failCount++;
    }
  }
}
console.log(`\n${fixedCount} fixed, ${failCount} failed${DRY ? ' (dry run)' : ''}`);
if (failCount) process.exit(1);
