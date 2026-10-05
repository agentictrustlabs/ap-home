/**
 * REBUILD A PERSON'S RELEASED CARD — the Home's Agent Card Studio publish chain, driven from a script.
 *
 *   npx tsx scripts/rebuild-card-release.mts <handle>
 *
 * For an agent whose Studio holds NO card while the serving plane still serves one (2026-09-09: nathan.me —
 * the release cache outlived a reset vault): create a card seeded from the live profile, validate, release,
 * request + record approval, sign it HERE with a fresh ES256 key (the server verifies, never holds the key)
 * plus the Smart Agent binding the persona's custodian signs, publish to the well-known path, verify.
 * Then `republish-card-record.mts <handle>` points the name at it. Same ops, same authority, no shortcut.
 */
import { generateA2ACardSigningKey, signA2ACard, signedCardContentDigest, smartAgentCardBindingDigest } from '@agenticprimitives/agent-profile/a2a';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const handle = process.argv[2];
if (!handle) throw new Error('usage: rebuild-card-release.mts <handle>');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const mutation = (extra: Record<string, unknown> = {}) => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), ...extra });

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const token: string = si.homeSession; const sa = String(si.agent).toLowerCase() as Address;
if (!token) throw new Error('no session');
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const grant = ((await j(await fetch(`${HOME}/connect/self-grant?purpose=agent-card-studio`, { headers: { authorization: `Bearer ${token}` } }))) as { grant?: Record<string, unknown> & { delegate: string } }).grant;
if (!grant) throw new Error('no stored Studio grant — open the Studio once in the Home to mint it');
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const studio = async <T,>(op: string, args: Record<string, unknown>): Promise<T> => {
  const r = await j(await fetch(`${HOME}/a2a/agent-cards/${op}`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, requester: grant.delegate, args }) }));
  if (r.ok !== true) throw new Error(`${op}: ${r.error ?? ''} ${r.detail ?? JSON.stringify(r).slice(0, 240)}`);
  return r as T;
};
type Release = { releaseId: string; cardResourceId: string; state: string; unsignedContentDigest: string; unsignedCard: Record<string, unknown>; signedCard?: Record<string, unknown> };

console.log(`${handle} ${sa}`);
const { cards } = await studio<{ cards: Array<{ resource: { cardResourceId: string }; servedReleaseId: string | null }> }>('card.list', {});
let cardId = cards[0]?.resource.cardResourceId;
if (!cardId) {
  const created = await studio<{ resource: { cardResourceId: string }; inheritedFrom?: unknown }>('card.create', { environment: 'production', primary: true, mutation: mutation() });
  cardId = created.resource.cardResourceId;
  console.log(`  created card ${cardId} (seeded from the live profile)`);
} else console.log(`  card ${cardId} exists (served release: ${cards[0]!.servedReleaseId ?? 'none'})`);

const v = await studio<{ errors: number; warnings?: number; findings?: Array<{ severity: string; message: string }> }>('card.validate', { cardResourceId: cardId });
console.log(`  validated: ${v.errors} error(s)${v.warnings !== undefined ? `, ${v.warnings} warning(s)` : ''}`);
if (v.errors > 0) throw new Error(`the draft does not validate: ${JSON.stringify(v.findings ?? v).slice(0, 400)}`);

let release = (await studio<{ release: Release }>('card.createRelease', { cardResourceId: cardId, mutation: mutation() })).release;
console.log(`  release ${release.releaseId} (${release.state})`);
release = (await studio<{ release: Release }>('release.requestApproval', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() })).release;
release = (await studio<{ release: Release }>('release.approve', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() })).release;
console.log(`  approved (${release.state})`);

// Sign here: the JWS with a fresh key, the binding with the persona's custodian.
const key = await generateA2ACardSigningKey('ES256');
const base = release.signedCard ?? release.unsignedCard;
const signed = await signA2ACard(base as never, { privateKey: key.privateKey, kid: key.kid, alg: key.alg });
const cardUri = `https://${handle}.faithnet.ai/.well-known/agent-card.json`;
const binding = {
  canonicalAgentId: `eip155:${CHAIN_ID}:${sa}`, cardResourceId: release.cardResourceId, cardReleaseId: release.releaseId, cardUri,
  unsignedCardDigest: release.unsignedContentDigest, signedCardDigest: signedCardContentDigest(signed.card as never), signerKeyThumbprint: key.kid, validFrom: 0, validUntil: 0,
};
const bindingDigest = smartAgentCardBindingDigest(binding as never, CHAIN_ID, sa);
const smartAgentBinding = { binding, chainId: CHAIN_ID, verifyingContract: sa, signature: await sign(bindingDigest) };
release = (await studio<{ release: Release; kid: string }>('release.sign', { cardResourceId: cardId, releaseId: release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: key.publicJwk, smartAgentBinding, mutation: mutation() })).release;
console.log(`  signed (${release.state}) kid ${key.kid.slice(0, 12)}…`);

const pub = await studio<{ release: Release; receipt: { verdict?: string; servedDigest?: string; ok?: boolean } }>('release.publish', { cardResourceId: cardId, releaseId: release.releaseId, mutation: mutation() });
release = pub.release;
console.log(`  published (${release.state}) receipt ${JSON.stringify(pub.receipt).slice(0, 160)}`);
if (release.state !== 'published') {
  const ver = await studio<{ release: Release; receipt: unknown }>('release.verifyPublication', { cardResourceId: cardId, releaseId: release.releaseId });
  release = ver.release;
  console.log(`  verified (${release.state}) ${JSON.stringify(ver.receipt).slice(0, 160)}`);
}
const served = await fetch(cardUri);
console.log(`  served now: ${served.headers.get('x-ap-card-release')} ${served.headers.get('x-ap-card-digest')?.slice(0, 24)}`);
if (release.state !== 'published') throw new Error(`the release did not reach published: ${release.state}`);
console.log(`\n✓ ${handle}'s card is released and served; now: npx tsx scripts/republish-card-record.mts ${handle}`);
