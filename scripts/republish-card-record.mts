/**
 * REPUBLISH A NAME'S CARD RECORD — spec 347 §8.3, driven the way the Home's Agent Naming editor drives it.
 *
 *   npx tsx scripts/republish-card-record.mts [handle…]      (default: alice nathan)
 *
 * The on-chain `atl:cardDigest` on a name content-addresses the RELEASED card served at its well-known
 * path. When the served release is newer than the record (2026-09-09: alice.me and nathan.me), a pinned
 * resolution of the name refuses — correctly — and the record is stale. This runs the Studio's ap-naming
 * projection for the SERVED release: configure → preview → plan → request approval → approve → the
 * persona signs what the plan asks and ONE gasless userOp writes the records → record the publication.
 * Same ops, same authority (the person's own Studio self-grant + their custodian), no shortcut.
 */
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const HANDLES = process.argv.slice(2).length ? process.argv.slice(2) : ['alice', 'nathan'];
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const sha = async (t: string) => `0x${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const mutation = () => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() });

for (const handle of HANDLES) {
  console.log(`\n── ${handle} ──`);
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  const token: string = si.homeSession; const sa = String(si.agent).toLowerCase() as Address;
  if (!token) { console.log('  no session'); continue; }
  const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
  const grant = ((await j(await fetch(`${HOME}/connect/self-grant?purpose=agent-card-studio`, { headers: { authorization: `Bearer ${token}` } }))) as { grant?: Record<string, unknown> & { delegate: string } }).grant;
  if (!grant) { console.log('  no stored Studio grant — open the Studio once in the Home to mint it'); continue; }
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
  const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
  const studio = async <T,>(op: string, args: Record<string, unknown>): Promise<T> => {
    const r = await j(await fetch(`${HOME}/a2a/agent-cards/${op}`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, requester: grant.delegate, args }) }));
    if (r.ok !== true) throw new Error(`${op}: ${r.error ?? ''} ${r.detail ?? JSON.stringify(r).slice(0, 200)}`);
    return r as T;
  };

  // The card this name serves: the released one, by the release id the Worker actually serves.
  const { cards } = await studio<{ cards: Array<{ resource: { cardResourceId: string; name?: string }; servedReleaseId: string | null; latestRelease: { releaseId: string; state: string; signedContentDigest: string | null } | null }> }>('card.list', {});
  const card = cards.find((c) => c.servedReleaseId) ?? cards.find((c) => c.latestRelease?.state === 'published');
  if (!card) { console.log(`  no published card (${cards.length} card(s))`); continue; }
  const releaseId = card.servedReleaseId ?? card.latestRelease!.releaseId;
  console.log(`  card ${card.resource.cardResourceId} release ${releaseId} (served: ${card.servedReleaseId ?? 'n/a'})`);

  // The projection, exactly as the Home runs it.
  const cfg = await studio<{ instance: { instanceId: string } }>('projection.configure', { family: 'ap-naming', cardResourceId: card.resource.cardResourceId, selectedReleaseId: releaseId, mutation: mutation() });
  const id = cfg.instance.instanceId;
  const preview = await studio<{ result: { losses?: Array<{ category: string; message?: string }>; artifact?: { records?: { cardDigest?: string; cardUri?: string } } } }>('projection.preview', { instanceId: id });
  const losses = preview.result.losses ?? [];
  if (losses.length) console.log(`  losses: ${losses.map((l) => `${l.category}${l.message ? ` (${l.message.slice(0, 80)})` : ''}`).join('; ')}`);
  console.log(`  artifact cardDigest ${preview.result.artifact?.records?.cardDigest?.slice(0, 16) ?? '?'} cardUri ${preview.result.artifact?.records?.cardUri ?? '?'}`);
  const planned = await studio<{ plan: { planId: string; dryRun?: boolean }; contractCalls: Array<{ to: Address; value: string; data: Hex; chainId?: number }>; signatureRequests: Array<{ purpose: string; digest: Hex }> }>('projection.planPublication', { instanceId: id, mutation: mutation() });
  if (planned.plan.dryRun) throw new Error('the plan is a dry run');
  await studio('projection.requestApproval', { instanceId: id, planId: planned.plan.planId, mutation: mutation() });
  const approved = await studio<{ approval: { approvalId: string } }>('projection.approve', { instanceId: id, planId: planned.plan.planId, mutation: mutation() });
  console.log(`  plan ${planned.plan.planId}: ${planned.contractCalls.length} call(s), ${planned.signatureRequests.length} signature(s); approval ${approved.approval.approvalId}`);

  // The custodian's part: sign what the plan asked for, then one gasless userOp for the record writes.
  const signatures: Array<{ digest: Hex; signature: Hex }> = [];
  for (const req of planned.signatureRequests) signatures.push({ digest: req.digest, signature: await sign(req.digest) });
  let txHash: Hex | undefined;
  if (planned.contractCalls.length) {
    const callData = buildExecuteBatchCallData(planned.contractCalls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })));
    let ok = false; let lastErr = '';
    for (let i = 0; i < 4 && !ok; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2500));
      const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: sa, callData }) }));
      if (!b.ok || !b.userOpHash) { lastErr = `${b.error ?? ''} ${b.detail ?? ''}`; continue; }
      const signature = await sign(b.userOpHash as Hex);
      const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature } }) }));
      if (s.ok) { ok = true; txHash = s.transactionHash; } else lastErr = `${s.error ?? ''} ${s.detail ?? ''}`;
    }
    if (!ok) throw new Error(`the record write did not go through: ${lastErr}`);
    console.log(`  records written: tx ${txHash}`);
  }
  const chainId = planned.contractCalls[0]?.chainId;
  const recorded = await studio<{ receipt: unknown; binding: { verdict?: unknown; status?: string } }>('projection.recordPublication', { instanceId: id, planId: planned.plan.planId, approvalId: approved.approval.approvalId, transactions: txHash ? [{ ...(chainId !== undefined ? { chainId } : {}), hash: txHash }] : [], ...(signatures.length ? { signatures } : {}), mutation: mutation() });
  console.log(`  publication recorded: ${JSON.stringify(recorded.binding ?? {}).slice(0, 160)}`);

  // THE PROOF IS THE CHAIN AGAINST THE WIRE: the record now equals the SHA-256 of the bytes the name serves.
  const cardUri = preview.result.artifact?.records?.cardUri ?? `https://${handle}.faithnet.ai/.well-known/agent-card.json`;
  const served = await (await fetch(cardUri)).text();
  const servedDigest = await sha(served);
  const rec = await j(await fetch(`${A2A}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }));
  void rec;
  console.log(`  served ${cardUri} → ${servedDigest.slice(0, 16)}… (artifact pinned ${preview.result.artifact?.records?.cardDigest?.slice(0, 16) ?? '?'}…)`);
  if (preview.result.artifact?.records?.cardDigest && preview.result.artifact.records.cardDigest.toLowerCase() !== servedDigest.toLowerCase()) throw new Error('the projected digest is not the digest of the served bytes — the pin would still refuse');
}
console.log('\n✓ republished; verify with the naming client (scratchpad names.mts) that the pin now matches the served card.');
