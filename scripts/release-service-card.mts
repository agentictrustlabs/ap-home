/**
 * RELEASE A SERVICE AGENT'S CARD — the Agent Card Studio for an agent that is not a person.
 *
 * WHY THIS SCRIPT HAD TO EXIST. The Studio keeps a card's drafts, releases, approvals and bindings in THE
 * AGENT'S OWN VAULT, and authorizes every operation with a delegation whose delegator is that agent. For a person
 * the Home mints it at `/connect/self-grant`: a SELF-delegation, `delegator = delegate = personSA`, scoped to the
 * four Studio record families and nothing else. That endpoint derives the agent from the SESSION, so it can only
 * ever mint a person's own grant — and a service agent has no session, no password and no mailbox. The result was
 * that a service's card could be served but never released, so the agents doing the actual work were the ones
 * whose cards nobody could verify.
 *
 * WHAT THIS DOES INSTEAD, and why it is not a bypass. It mints a STEWARDSHIP delegation — delegator = the service
 * agent, delegate = the steward's own agent — signed by the service's CUSTODIAN, so the grant is the service's
 * statement made by the only party entitled to make it (validated against the service's account through ERC-1271).
 * The scopes are the same four record families the Home's own endpoint allows, and nothing wider.
 *
 * AND THE PRINCIPAL MATTERS, which is the part worth knowing. The Studio reads the scopes from WHO IS ASKING:
 * a principal that is itself a service agent gets `STEWARD_DEFAULT_SCOPES` — read, draft, validate — and is
 * refused `agent.card.approve`. A self-delegation therefore cannot release a service's card, and that refusal is
 * the doctrine working: approving, signing and publishing a card is an accountable act and a service may not
 * perform it on its own behalf. So the principal here is the STEWARD, a person, who answers for the approval.
 *
 *   RPC_URL=… NEXT_PUBLIC_CHAIN_ID=34348 npx tsx scripts/release-service-card.mts <name> --by <steward handle> \
 *     --card-host <host> [--import-from <url>] [--home https://www.faithnet.me] [--out bundle.json] [--dry-run]
 *
 * `--out` writes the SERVING BUNDLE: the signed card, the public key set, and the binding. A SELF-HOSTED service
 * (its own Worker, its own origin — spec 433's shape B) serves those three files itself, and the Studio's publish
 * step cannot reach a host it does not control. The public JWK is written HERE because the Studio stores it in the
 * vault and exposes no operation to read it back: a release whose key nobody can fetch is a signature nobody can
 * check, which is the whole failure this exercise is about.
 *
 * Example: scripture-resolver.svc --by ruth --card-host scripture.faithnet.io
 */
import { issueVaultRecordScopeDelegation, toWire } from '../apps/home/src/lib/delegation';
import { MCP_SERVER_ID } from '../apps/home/src/lib/inbox-delivery';
import { generateA2ACardSigningKey, signA2ACard, signedCardContentDigest, smartAgentCardBindingDigest } from '@agenticprimitives/agent-profile/a2a';
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, namehash, type Address, type Hex } from 'viem';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
/** The LIVE-TRUTH card to release, when the service builds its own (spec 433 shape B). Without it the Studio
 *  seeds the draft from the RUNTIME's profile, which for a self-hosted service is its generic surface — so the
 *  release would be a correct signature over a card that misdescribes the agent. That is strictly worse than an
 *  unsigned card, because it is authoritative misinformation. Found the hard way: the first release of
 *  scripture-resolver.svc carried the runtime's eight generic skills and the edge's URL instead of the seven
 *  scripture skills and its own endpoint. */
const name = process.argv[2];
const by = arg('by'); const cardHost = arg('card-host');
const HOME = (arg('home') ?? process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const out = arg('out');
const dry = process.argv.includes('--dry-run');
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.CHAIN_ID ?? 34348);
const RPC = process.env.RPC_URL ?? process.env.FEDERATION_RPC_URL;
if (!name || name.startsWith('--') || !by || !cardHost) {
  console.error('usage: release-service-card.mts <agent-name> --by <steward handle> --card-host <host> [--home https://…] [--dry-run]');
  process.exit(2);
}
if (!RPC) { console.error('RPC_URL is required — custody is checked on chain before anything is signed'); process.exit(2); }

/** The four record families a Studio grant may cover, mirroring the Home's `PURPOSE_RESOURCES['agent-card-studio']`.
 *  Anything wider would make this a way to mint a full-vault self-delegation for a service, which is the thing the
 *  Home's own endpoint refuses. */
const STUDIO_RESOURCES = ['vault:agent-cards:*', 'vault:projections:*', 'vault:bindings:*', 'vault:approvals:*'];
const cardUriOf = () => `https://${cardHost}/.well-known/agent-card.json`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const mutation = (extra: Record<string, unknown> = {}) => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), ...extra });

// ── the agent, by name, from the chain ────────────────────────────────────────────────────────────────
const pub = createPublicClient({ transport: http(RPC) });
const UR = (process.env.UNIVERSAL_RESOLVER ?? '0xF343054e046A4145ccae499ECB28197394eE0798') as Address;
const ACC = [
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
const sa = String(await pub.readContract({
  address: UR,
  abi: [{ type: 'function', name: 'resolveName', stateMutability: 'view', inputs: [{ name: 'n', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
  functionName: 'resolveName', args: [namehash(name)],
})).toLowerCase() as Address;
if (/^0x0{40}$/.test(sa)) { console.error(`${name} does not resolve on chain ${CHAIN_ID}`); process.exit(1); }

// ── the steward, and PROOF they may speak for this agent ──────────────────────────────────────────────
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-web' }) }));
const token: string = si.homeSession;
if (!token) { console.error(`no session for ${by} at ${HOME}`); process.exit(1); }
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
  return b.signature as Hex;
};
const { recoverMessageAddress, keccak256, toBytes } = await import('viem');
const probe = keccak256(toBytes(`release-service-card custody probe ${Date.now()}`));
const stewardEoa = (await recoverMessageAddress({ message: { raw: probe }, signature: await sign(probe) })).toLowerCase() as Address;
const isCustodian = await pub.readContract({ address: sa, abi: ACC, functionName: 'isCustodian', args: [stewardEoa] }).catch(() => false);
console.log(`${name} ${sa}\n  steward ${by} (${stewardEoa}) custodian=${isCustodian}`);
// FAIL CLOSED. The Studio would accept the grant if the account validated it; checking here means the refusal
// says WHY instead of surfacing as a vault error three calls later.
if (isCustodian !== true) { console.error(`  ${by} is not a custodian of ${name} — only a custodian may make this agent's statements`); process.exit(1); }

// ── the Studio self-grant, signed by the custodian ────────────────────────────────────────────────────
const stewardSa = String(si.agent).toLowerCase() as Address;
if (!/^0x[0-9a-f]{40}$/.test(stewardSa)) { console.error('the steward session carries no agent address'); process.exit(1); }
const grantDoc = await issueVaultRecordScopeDelegation(sa, stewardSa, [{ server: MCP_SERVER_ID, resources: STUDIO_RESOURCES, ops: ['read', 'write'] }], sign, 60 * 60);
const grant = toWire(grantDoc) as Record<string, unknown> & { delegate: string };
console.log(`  stewardship grant minted: ${sa} → ${stewardSa} (${by}), ${STUDIO_RESOURCES.length} record families, 1 hour`);
if (dry) { console.log('  would drive the Studio and release'); process.exit(0); }

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const studio = async <T,>(op: string, args: Record<string, unknown>): Promise<T> => {
  const r = await j(await fetch(`${HOME}/a2a/agent-cards/${op}`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, requester: stewardSa, args }) }));
  if (r.ok !== true) throw new Error(`${op}: ${r.error ?? ''} ${r.detail ?? JSON.stringify(r).slice(0, 240)}`);
  return r as T;
};
type Release = { releaseId: string; cardResourceId: string; state: string; unsignedContentDigest: string; unsignedCard: Record<string, unknown>; signedCard?: Record<string, unknown> };

const { cards } = await studio<{ cards: Array<{ resource: { cardResourceId: string }; servedReleaseId: string | null }> }>('card.list', {});
let cardId = cards[0]?.resource.cardResourceId;
if (!cardId) {
  cardId = (await studio<{ resource: { cardResourceId: string } }>('card.create', { environment: 'production', primary: true, mutation: mutation() })).resource.cardResourceId;
  console.log(`  created card ${cardId} (seeded from the live profile)`);
} else console.log(`  card ${cardId} exists (served release: ${cards[0]!.servedReleaseId ?? 'none'})`);

const importFrom = arg('import-from');
if (importFrom) {
  const r = await fetch(importFrom, { headers: { accept: 'application/json' } });
  if (!r.ok) { console.error(`  ${importFrom} answered ${r.status} — nothing imported`); process.exit(1); }
  const source = await r.text();
  const got = await studio<{ draft?: { revision?: number } }>('card.get', { cardResourceId: cardId });
  // The import's EVIDENCE is append-only, keyed by the source digest. Re-importing the same bytes is therefore a
  // conflict, not a failure: the draft already holds this card. Treat it as done and go on — the alternative is a
  // ceremony that can only ever be run once.
  try {
    const imported = await studio<{ diagnostics?: Array<{ severity?: string; code?: string }> }>('card.import', { cardResourceId: cardId, source, uri: cardUriOf(), mutation: mutation({ expectedRevision: got.draft?.revision }) });
    const errs = (imported.diagnostics ?? []).filter((d) => d.severity === 'error');
    console.log(`  imported the live-truth card from ${importFrom}${errs.length ? ` — ${errs.length} error diagnostic(s)` : ''}`);
  } catch (e) {
    if (!String(e).includes('append_only')) throw e;
    console.log('  the live-truth card was already imported (same bytes) — using the draft as it stands');
  }
}

const v = await studio<{ errors: number; warnings?: number; diagnostics?: unknown }>('card.validate', { cardResourceId: cardId });
console.log(`  validated: ${v.errors} error(s)${v.warnings !== undefined ? `, ${v.warnings} warning(s)` : ''}`);
if (v.errors > 0) {
  // GROUPED, because a wall of pointers hides the shape of the problem. One line per code tells you whether the
  // card claims something it cannot prove, is missing a required field, or diverges from the catalog.
  const ds = (v.diagnostics ?? []) as Array<{ code?: string; severity?: string; sourcePointer?: string; message?: string }>;
  const by = new Map<string, { n: number; where: string[]; message: string }>();
  for (const d of ds) {
    const k = `${d.severity ?? '?'} ${d.code ?? '?'}`;
    const e = by.get(k) ?? { n: 0, where: [], message: d.message ?? '' };
    e.n++; if (e.where.length < 4) e.where.push(d.sourcePointer ?? '');
    by.set(k, e);
  }
  console.error(`  the draft does not validate — ${ds.length} diagnostic(s):`);
  for (const [k, e] of [...by].sort()) console.error(`    ${String(e.n).padStart(3)}  ${k}  ${e.where.join(' ')}${e.where.length < e.n ? ' …' : ''}\n         ${e.message.slice(0, 150)}`);
  process.exit(1);
}

let release = (await studio<{ release: Release }>('card.createRelease', { cardResourceId: cardId, mutation: mutation() })).release;
release = (await studio<{ release: Release }>('release.requestApproval', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() })).release;
release = (await studio<{ release: Release }>('release.approve', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() })).release;
console.log(`  release ${release.releaseId} approved`);

// The JWS with a fresh key; the binding with the service's custodian. Two separate statements: one that these
// bytes were signed, one that THIS AGENT stands behind them (spec 347 §4.2).
const key = await generateA2ACardSigningKey('ES256');
const signed = await signA2ACard((release.signedCard ?? release.unsignedCard) as never, { privateKey: key.privateKey, kid: key.kid, alg: key.alg });
const cardUri = cardUriOf();
const binding = {
  canonicalAgentId: `eip155:${CHAIN_ID}:${sa}`, cardResourceId: release.cardResourceId, cardReleaseId: release.releaseId, cardUri,
  unsignedCardDigest: release.unsignedContentDigest, signedCardDigest: signedCardContentDigest(signed.card as never),
  signerKeyThumbprint: key.kid, validFrom: 0, validUntil: 0,
};
const smartAgentBinding = { binding, chainId: CHAIN_ID, verifyingContract: sa, signature: await sign(smartAgentCardBindingDigest(binding as never, CHAIN_ID, sa)) };
release = (await studio<{ release: Release }>('release.sign', { cardResourceId: cardId, releaseId: release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: key.publicJwk, smartAgentBinding, mutation: mutation() })).release;
console.log(`  signed (${release.state}) kid ${key.kid.slice(0, 12)}…`);

const published = await studio<{ release: Release; receipt: unknown }>('release.publish', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() });
release = published.release;
console.log(`  published (${release.state})`);
if (release.state !== 'published') {
  release = (await studio<{ release: Release }>('release.verifyPublication', { cardResourceId: cardId, releaseId: release.releaseId })).release;
  console.log(`  verified (${release.state})`);
}
if (out) {
  writeFileSync(out, `${JSON.stringify({
    type: 'ap.service-card-release.v1',
    agent: sa, name, releaseId: release.releaseId, cardUri, releasedAt: new Date().toISOString(),
    card: signed.card,
    jwks: { keys: [{ ...key.publicJwk, kid: key.kid, alg: 'ES256', use: 'sig' }] },
    smartAgentBinding,
    verify: [
      'Strip `signatures` from the card, canonicalize with RFC 8785, sha256 it: that is `unsignedCardDigest`.',
      'The key in the key set whose RFC 7638 thumbprint equals the JWS `kid` verifies the detached payload.',
      'The binding names both digests and that same thumbprint.',
      `Verify the binding's EIP-712 digest against ${sa} with ERC-1271 on chain ${CHAIN_ID}. Only then is this that agent's card.`,
      'None of it is authority. A card says what an agent does; it never says you may make it do anything.',
    ],
  }, null, 2)}\n`);
  console.log(`  wrote ${out} — a self-hosted service serves these three documents itself`);
}
const served = await fetch(cardUri);
const body = (await served.json().catch(() => ({}))) as { signatures?: unknown[] };
console.log(`  served now: ${served.headers.get('x-ap-card-source') ?? 'no source header'} · ${(body.signatures ?? []).length} signature(s)`);
if (release.state !== 'published') throw new Error(`the release did not reach published: ${release.state}`);
console.log(`\n✓ ${name}'s card is released, signed, and bound to ${sa} by ${by}`);
