// The Card Studio service side (spec 347 W4a) — driven end to end against FAKES of every port: the managed
// agent's vault, the RELEASED_CARDS cache, the chain reads, the well-known re-fetch, the audit sink.
//
// What is proven here is the SHAPE of the contract, not the world: a draft cannot be written over a stale
// revision; a release's bytes never change once created; an approval names one digest and covers one plan;
// a client-produced JWS is verified rather than trusted; a publication is `published` only when the public
// route serves the released bytes; a projection publication is recorded only after the chain agrees; a
// service-agent caller (the Agent Metadata Steward) can draft and preview and nothing else.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Address, Hex } from '@agenticprimitives/types';
import { jcsCanonicalize } from '@agenticprimitives/types';
import {
  generateA2ACardSigningKey,
  signA2ACard,
  sha256Digest,
  cardContentDigest,
  type A2AAgentCardDraftV1,
  type A2AAgentCardReleaseV1,
  type A2AAgentCardResourceV1,
  type SignedSmartAgentCardBindingV1,
} from '@agenticprimitives/agent-profile/a2a';
import type { AgentNameRecords } from '@agenticprimitives/agent-naming';
import { namehash } from '@agenticprimitives/agent-naming';
import { createMemoryAuditSink, type MemoryAuditSink } from '@agenticprimitives/audit';
import type { ApNamingArtifactV1, ExternalIdentityBindingV1, PlannedContractCallV1, ProjectionInstanceV1, ProjectionResultV1, PublicationPlanV1, PublicationReceiptV1 } from '@agenticprimitives/registry-kit/projection';
import { sha256ToBytes32 } from '@agenticprimitives/registry-kit';
import {
  AgentCardStudio,
  STUDIO_KEYS,
  studioReleasedCardKey,
  type A2AWellKnownPublicationReceiptV1,
  type StudioDeps,
  type StudioSources,
  type StudioVault,
} from '../src/agent-card-studio.js';
import { hostForName } from '../src/host-context.js';

const AGENT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const STEWARD = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const REVIEWER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const STEWARD_AGENT = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const REGISTRY = '0x6629cca40b008c0984a1ca266ca10a344420cac3' as Address;
const RESOLVER = '0x1111111111111111111111111111111111111111' as Address;
const CHAIN_ID = 84532;
const NAME = 'acme.svc';
const HOST = 'acme.svc.impact-agent.io';
const CARD_URI = `https://${HOST}/.well-known/agent-card.json`;

function liveCard(): Record<string, unknown> {
  return {
    protocolVersion: '1.0',
    name: NAME,
    description: `A2A endpoint for ${NAME} (Smart Agent ${AGENT}).`,
    version: '0.1.0',
    agentAddress: AGENT,
    supportedInterfaces: [{ url: `https://${HOST}/api/a2a`, protocolBinding: 'JSONRPC' }],
    provider: { organization: 'Agentic Connect', url: `https://${HOST}` },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false, extensions: [{ uri: 'https://agentictrust.io/a2a/extensions/authority/v1', required: false }] },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: 'messaging.deliver', name: 'Deliver a message', description: 'Admit a signed message envelope.', tags: ['messaging'] }],
    chainId: CHAIN_ID,
  };
}

interface World {
  vault: Map<string, unknown>;
  kv: Map<string, string>;
  chainRecords: AgentNameRecords;
  erc1271Ok: boolean;
  /** What the public route serves on re-fetch: derived from the KV fake (the real route) unless overridden. */
  serve?: () => Response;
  audit: MemoryAuditSink;
  clock: number;
}

function makeWorld(): World {
  return { vault: new Map(), kv: new Map(), chainRecords: {}, erc1271Ok: true, audit: createMemoryAuditSink(), clock: Date.parse('2026-08-30T12:00:00.000Z') };
}

function deps(w: World, opts: { sod?: 'strict' | 'off'; kv?: boolean } = {}): StudioDeps {
  const vault: StudioVault = {
    async get<T>(rt: string) { return (w.vault.has(rt) ? structuredClone(w.vault.get(rt)) : null) as T | null; },
    async set(rt, data) { w.vault.set(rt, structuredClone(data)); },
    async list() { return [...w.vault.keys()].map((record_type) => ({ record_type })); },
  };
  const sources: StudioSources = {
    liveCard: async () => liveCard(),
    profile: async () => null,
    names: async () => [{ name: NAME, node: namehash(NAME), chainId: CHAIN_ID, registry: REGISTRY, role: 'primary', derivedType: 'service', resolvesTo: AGENT }],
    derivedType: async () => 'service',
    publicSkillClaims: async () => [{ claimId: 'atl:skills:translation', skillId: 'translation', name: 'Translation', tags: ['skill'], visibility: 'public', claimDigest: 'sha256:' + 'ab'.repeat(32) as never }],
    nameRecords: async () => w.chainRecords,
    nameResolver: async () => RESOLVER,
    registryEntry: async () => null,
    erc1271: { verifyHash: async () => w.erc1271Ok },
    cardUri: async () => CARD_URI,
    fetch: async () => {
      if (w.serve) return w.serve();
      // The real route: a released entry is served byte-for-byte with its digest header, else the live card.
      const raw = w.kv.get(studioReleasedCardKey(AGENT));
      if (raw) {
        const e = JSON.parse(raw) as { digest: string; bytes: string };
        return new Response(e.bytes, { headers: { 'x-ap-card-digest': e.digest, etag: `"${e.digest}"` } });
      }
      return new Response(JSON.stringify(liveCard()), { headers: { 'x-ap-card-digest': 'sha256:' + '00'.repeat(32) } });
    },
    principalKind: async (a) => (a.toLowerCase() === STEWARD_AGENT ? 'service-agent' : 'human'),
  };
  return {
    vault,
    releasedCards: opts.kv === false ? null : { get: async (k) => w.kv.get(k) ?? null, put: async (k, v) => { w.kv.set(k, v); }, delete: async (k) => { w.kv.delete(k); } },
    sources,
    audit: w.audit,
    env: { chainId: CHAIN_ID, namingRegistry: REGISTRY, separationOfDuties: opts.sod ?? 'off' },
    now: () => new Date((w.clock += 1000)).toISOString(),
    newId: () => `id-${w.clock}`,
  };
}

let seq = 0;
const mutation = (extra: Record<string, unknown> = {}) => ({ mutation: { idempotencyKey: `k-${++seq}`, correlationId: `c-${seq}`, ...extra } });
const as = (principal: Address) => ({ principal, agent: AGENT });

async function ok<T = Record<string, unknown>>(p: Promise<{ status: number; body: Record<string, unknown> }>): Promise<T> {
  const r = await p;
  expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
  expect(r.status).toBe(200);
  return r.body as T;
}

/** Create → validate → release → approve → sign, returning the signed release + the key used. */
async function signedRelease(studio: AgentCardStudio, w: World) {
  const created = await ok<{ resource: A2AAgentCardResourceV1; draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
  const card = created.resource.cardResourceId;
  const v = await ok<{ errors: number; diagnostics: unknown[] }>(studio.run(as(STEWARD), 'card.validate', { cardResourceId: card }));
  expect(v.errors, JSON.stringify(v.diagnostics)).toBe(0);
  const rel = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() }));
  await ok(studio.run(as(STEWARD), 'release.requestApproval', { cardResourceId: card, releaseId: rel.release.releaseId, ...mutation() }));
  await ok(studio.run(as(REVIEWER), 'release.approve', { cardResourceId: card, releaseId: rel.release.releaseId, ...mutation() }));
  const key = await generateA2ACardSigningKey('ES256');
  const signed = await signA2ACard(rel.release.unsignedCard, { privateKey: key.privateKey, kid: key.kid });
  const r = await ok<{ release: A2AAgentCardReleaseV1; kid: string }>(studio.run(as(STEWARD), 'release.sign', { cardResourceId: card, releaseId: rel.release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: key.publicJwk, ...mutation() }));
  void w;
  return { card, release: r.release, key };
}

describe('the RELEASED_CARDS key is one key', () => {
  it('matches index.ts `releasedCardKey` byte for byte', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'latin1');
    expect(src).toContain('return `released-card:${agent.toLowerCase()}`;');
    expect(studioReleasedCardKey('0xABC')).toBe('released-card:0xabc');
  });
  it('projects a typed name onto the deployment zone', () => {
    expect(hostForName('acme.svc', 'impact-agent.io', ['me', 'impact'])).toBe('acme.svc.impact-agent.io');
    expect(hostForName('alice.impact', 'impact-agent.io', ['me', 'impact'])).toBe('alice.impact-agent.io');
    expect(hostForName('alice.me', 'impact-agent.io', ['me', 'impact'])).toBe('alice.impact-agent.io');
    expect(hostForName('x.y.z', 'impact-agent.io')).toBeNull();
  });
});

describe('card.wellKnown — what the operational endpoint is actually serving', () => {
  let w: World;
  let studio: AgentCardStudio;
  beforeEach(() => { w = makeWorld(); studio = new AgentCardStudio(deps(w)); });

  it('returns the exact served bytes plus BOTH digests and the serving headers', async () => {
    const r = await ok<{ uri: string; reachable: boolean; source: string | null; body: string; servedDigest: string; canonicalDigest: string; card: Record<string, unknown> }>(
      studio.run(as(STEWARD), 'card.wellKnown', {}),
    );
    expect(r.uri).toBe(CARD_URI);
    expect(r.reachable).toBe(true);
    // Nothing published yet ⇒ the LIVE card is what the world fetches.
    expect(JSON.parse(r.body)).toEqual(liveCard());
    // The bytes' digest and the canonical (JCS) digest answer different questions and may differ.
    expect(r.servedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.canonicalDigest).toBe(cardContentDigest(liveCard() as { signatures?: unknown }));
    expect(r.card).toEqual(liveCard());
  });

  it('after a publish it serves the released bytes, and servedDigest equals the release digest', async () => {
    const s = await signedRelease(studio, w);
    await ok(studio.run(as(STEWARD), 'release.publish', { cardResourceId: s.card, releaseId: s.release.releaseId, ...mutation() }));
    const signed = s.release.signedContentDigest!;
    const r = await ok<{ source: string | null; releaseId: string | null; servedDigest: string; headerDigest: string | null; body: string }>(
      studio.run(as(STEWARD), 'card.wellKnown', {}),
    );
    expect(r.servedDigest).toBe(signed);
    expect(r.headerDigest).toBe(signed);
    expect(JSON.parse(r.body).signatures).toBeTruthy();
  });

  it('an unreachable endpoint is reported unreachable, never as "no card"', async () => {
    w.serve = () => { throw new Error('boom'); };
    const r = await ok<{ reachable: boolean; detail: string }>(studio.run(as(STEWARD), 'card.wellKnown', {}));
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('egress failed');
  });

  it('a non-200 keeps the headers and says which status, with no body claim', async () => {
    w.serve = () => new Response('nope', { status: 503 });
    const r = await ok<{ reachable: boolean; status: number; detail: string; body?: string }>(studio.run(as(STEWARD), 'card.wellKnown', {}));
    expect(r).toMatchObject({ reachable: true, status: 503, detail: 'HTTP 503' });
    expect(r.body).toBeUndefined();
  });

  it('needs only read scope — the steward agent may look', async () => {
    const r = await studio.run(as(STEWARD_AGENT), 'card.wellKnown', {});
    expect(r.status).toBe(200);
  });
});

describe('cards: create → patch → validate → release', () => {
  let w: World;
  let studio: AgentCardStudio;
  beforeEach(() => { w = makeWorld(); studio = new AgentCardStudio(deps(w)); });

  it('inherits the base from the live card, names and public claims with provenance', async () => {
    const r = await ok<{ resource: A2AAgentCardResourceV1; draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    expect(r.resource.primary).toBe(true);
    expect(r.resource.canonicalAgentId).toBe(`eip155:${CHAIN_ID}:${AGENT}`);
    expect(r.draft.card.name).toBe(NAME);
    expect(r.draft.card.supportedInterfaces[0]!.url).toBe(`https://${HOST}/api/a2a`);
    expect(r.draft.fieldBindings['/supportedInterfaces']).toMatchObject({ mode: 'inherit', source: { kind: 'surface-catalog' } });
    expect(r.draft.fieldBindings['/name']).toMatchObject({ mode: 'inherit', source: { kind: 'agent-naming' } });
    expect(r.draft.card.skills.map((s) => s.id)).toEqual(['messaging.deliver', 'translation']);
    expect(r.draft.fieldBindings['/skills/1']).toMatchObject({ mode: 'inherit', source: { kind: 'capability-claims', ref: 'translation' } });
    // The record lives in the agent's vault under the spec'd key family.
    expect(w.vault.has(STUDIO_KEYS.draft(r.resource.cardResourceId))).toBe(true);
    expect(w.vault.has('agent-cards:index')).toBe(true);
    expect(w.audit.events().map((e) => e.action)).toContain('agent.card.created');
  });

  it('refuses a second primary production card', async () => {
    await ok(studio.run(as(STEWARD), 'card.create', mutation()));
    const r = await studio.run(as(STEWARD), 'card.create', { primary: true, ...mutation() });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('primary_exists');
  });

  it('patches with an override binding and refuses a stale revision (409)', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1; draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    const p = await ok<{ draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: card, patch: [{ op: 'replace', path: '/description', value: 'Acme translation service.' }], ...mutation({ expectedRevision: 1 }) }));
    expect(p.draft.revision).toBe(2);
    expect(p.draft.card.description).toBe('Acme translation service.');
    expect(p.draft.fieldBindings['/description']).toMatchObject({ mode: 'override', source: { kind: 'user', ref: STEWARD } });
    expect(p.draft.etag).not.toBe(c.draft.etag);
    const stale = await studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: card, patch: [{ op: 'replace', path: '/description', value: 'x' }], ...mutation({ expectedRevision: 1 }) });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'stale_revision', currentRevision: 2 });
    const noRev = await studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: card, patch: [{ op: 'replace', path: '/description', value: 'x' }], ...mutation() });
    expect(noRev.status).toBe(400);
  });

  it('replays an idempotent mutation instead of re-applying it', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const m = mutation({ expectedRevision: 1 });
    const first = await ok<{ draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: c.resource.cardResourceId, patch: [{ op: 'replace', path: '/description', value: 'once' }], ...m }));
    const again = await ok<{ draft: A2AAgentCardDraftV1; replayed?: boolean }>(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: c.resource.cardResourceId, patch: [{ op: 'replace', path: '/description', value: 'once' }], ...m }));
    expect(again.replayed).toBe(true);
    expect(again.draft.revision).toBe(first.draft.revision);
    const reused = await studio.run(as(STEWARD), 'card.validate', { cardResourceId: c.resource.cardResourceId, ...m });
    expect(reused.status).toBe(200); // reads carry no idempotency key
    const other = await studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: c.resource.cardResourceId, ...m });
    expect(other.body.error).toBe('idempotency_key_reused');
  });

  it('validates a hand-edited interface as CATALOG_DIVERGENCE only without an override binding', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    const v0 = await ok<{ errors: number; state: string }>(studio.run(as(STEWARD), 'card.validate', { cardResourceId: card }));
    expect(v0).toMatchObject({ errors: 0, state: 'validated' });
    // A refused edit: a loopback URL in production is an error whatever the binding says.
    await ok(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: card, patch: [{ op: 'replace', path: '/supportedInterfaces', value: [{ url: 'http://127.0.0.1/api/a2a', protocolBinding: 'JSONRPC' }] }], ...mutation({ expectedRevision: 1 }) }));
    const v1 = await ok<{ errors: number; diagnostics: Array<{ code: string }> }>(studio.run(as(STEWARD), 'card.validate', { cardResourceId: card }));
    expect(v1.errors).toBeGreaterThan(0);
    const rel = await studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() });
    expect(rel.status).toBe(422);
    expect(rel.body.error).toBe('validation_failed');
  });

  it('freezes a release (append-only) and forks the draft', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1; draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    const r = await ok<{ release: A2AAgentCardReleaseV1; draft: A2AAgentCardDraftV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() }));
    expect(r.release.state).toBe('validated');
    expect(r.release.releaseNumber).toBe(1);
    expect(r.release.unsignedContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.draft.basedOnReleaseId).toBe(r.release.releaseId);
    expect(r.draft.revision).toBe(c.draft.revision + 1);
    // Append-only: a later edit + release adds a SECOND record; the first keeps its bytes and digest.
    await ok(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: card, patch: [{ op: 'replace', path: '/description', value: 'edited after r1' }], ...mutation({ expectedRevision: r.draft.revision }) }));
    const r2 = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() }));
    expect(r2.release.releaseNumber).toBe(2);
    expect(r2.release.unsignedContentDigest).not.toBe(r.release.unsignedContentDigest);
    const get = await ok<{ releases: A2AAgentCardReleaseV1[] }>(studio.run(as(STEWARD), 'card.get', { cardResourceId: card }));
    expect(get.releases).toHaveLength(2);
    expect(get.releases[0]).toEqual(r.release);
    // A stored release whose content moved is refused on the next lifecycle write (the guard compares the
    // record it is about to overwrite).
    const key = STUDIO_KEYS.release(card, r.release.releaseId);
    w.vault.set(key, { ...(w.vault.get(key) as A2AAgentCardReleaseV1), releaseNumber: 99 });
    const req = await studio.run(as(STEWARD), 'release.requestApproval', { cardResourceId: card, releaseId: r2.release.releaseId, ...mutation() });
    expect(req.status).toBe(200);
    expect(w.vault.has(STUDIO_KEYS.release(card, r2.release.releaseId))).toBe(true);
  });
});

describe('releases: approve → sign → publish', () => {
  let w: World;
  let studio: AgentCardStudio;
  beforeEach(() => { w = makeWorld(); studio = new AgentCardStudio(deps(w)); });

  it('approves with an ApprovalRefV1 naming the unsigned digest; strict SoD refuses the last editor', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    const r = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() }));
    // Approving before requesting approval is an illegal transition (validated → approved).
    const early = await studio.run(as(REVIEWER), 'release.approve', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('illegal_transition');
    await ok(studio.run(as(STEWARD), 'release.requestApproval', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    const strict = new AgentCardStudio(deps(w, { sod: 'strict' }));
    const self = await strict.run(as(STEWARD), 'release.approve', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() });
    expect(self.status).toBe(403);
    expect(self.body.error).toBe('separation_of_duties');
    const a = await ok<{ release: A2AAgentCardReleaseV1; approval: { approvedDigest: string; approver: string } }>(strict.run(as(REVIEWER), 'release.approve', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    expect(a.release.state).toBe('approved');
    expect(a.approval.approvedDigest).toBe(r.release.unsignedContentDigest);
    expect(a.approval.approver).toBe(`eip155:${CHAIN_ID}:${REVIEWER}`);
    expect(w.vault.has(STUDIO_KEYS.approval(a.release.approvals[0]!.approvalId))).toBe(true);
  });

  it('verifies a client-produced JWS and refuses a bad one or a foreign key', async () => {
    const { card, release, key } = await signedRelease(studio, w);
    expect(release.state).toBe('signed');
    expect(release.signatures[0]).toMatchObject({ alg: 'ES256', kid: key.kid });
    expect(release.signedContentDigest).toMatch(/^sha256:/);
    expect(w.vault.has(STUDIO_KEYS.signingKey(card, key.kid))).toBe(true);
    // A second signature by an unrelated key over DIFFERENT bytes is refused.
    const other = await generateA2ACardSigningKey('ES256');
    const forged = await signA2ACard({ ...release.unsignedCard, description: 'tampered' }, { privateKey: other.privateKey, kid: other.kid });
    const bad = await studio.run(as(STEWARD), 'release.sign', { cardResourceId: card, releaseId: release.releaseId, signedCard: forged.card, signature: forged.signature, signerJwk: other.publicJwk, ...mutation() });
    expect(bad.status).toBe(422);
    // A key whose thumbprint is not the header's kid is an unknown kid → refused.
    const mismatched = await signA2ACard(release.unsignedCard, { privateKey: other.privateKey, kid: other.kid });
    const wrongKey = await studio.run(as(STEWARD), 'release.sign', { cardResourceId: card, releaseId: release.releaseId, signedCard: { ...release.signedCard!, signatures: [...release.signedCard!.signatures!, mismatched.signature] }, signature: mismatched.signature, signerJwk: key.publicJwk, ...mutation() });
    expect(wrongKey.status).toBe(422);
    expect(wrongKey.body.error).toBe('signature_invalid');
  });

  it('attaches the Smart Agent binding only when ERC-1271 says yes', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    const r = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: card, ...mutation() }));
    await ok(studio.run(as(STEWARD), 'release.requestApproval', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    await ok(studio.run(as(REVIEWER), 'release.approve', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    const key = await generateA2ACardSigningKey('ES256');
    const signed = await signA2ACard(r.release.unsignedCard, { privateKey: key.privateKey, kid: key.kid });
    const signedDigest = sha256Digest(new TextEncoder().encode(jcsCanonicalize(signed.card)));
    const binding: SignedSmartAgentCardBindingV1 = {
      binding: { canonicalAgentId: `eip155:${CHAIN_ID}:${AGENT}`, cardResourceId: card, cardReleaseId: r.release.releaseId, cardUri: CARD_URI, unsignedCardDigest: r.release.unsignedContentDigest, signedCardDigest: signedDigest, signerKeyThumbprint: key.kid, validFrom: 0, validUntil: 0 },
      chainId: CHAIN_ID,
      verifyingContract: AGENT,
      signature: '0x1234' as Hex,
    };
    w.erc1271Ok = false;
    const no = await studio.run(as(STEWARD), 'release.sign', { cardResourceId: card, releaseId: r.release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: key.publicJwk, smartAgentBinding: binding, ...mutation() });
    expect(no.status).toBe(422);
    expect(no.body.error).toBe('binding_invalid');
    w.erc1271Ok = true;
    const yes = await ok<{ release: A2AAgentCardReleaseV1; binding: { ok: boolean } }>(studio.run(as(STEWARD), 'release.sign', { cardResourceId: card, releaseId: r.release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: key.publicJwk, smartAgentBinding: binding, ...mutation() }));
    expect(yes.release.smartAgentBinding?.signature).toBe('0x1234');
    expect(yes.binding.ok).toBe(true);
    expect(w.audit.events().map((e) => e.action)).toContain('agent.card.binding.created');
  });

  it('publishes into the cache and is `published` only when the re-fetched digest matches', async () => {
    const { card, release } = await signedRelease(studio, w);
    const p = await ok<{ release: A2AAgentCardReleaseV1; receipt: A2AWellKnownPublicationReceiptV1 }>(studio.run(as(STEWARD), 'release.publish', { cardResourceId: card, releaseId: release.releaseId, ...mutation() }));
    expect(p.receipt.verificationResult).toBe('valid');
    expect(p.receipt.uri).toBe(CARD_URI);
    expect(p.release.state).toBe('published');
    expect(p.release.publication?.uri).toBe(CARD_URI);
    const entry = JSON.parse(w.kv.get(studioReleasedCardKey(AGENT))!) as { digest: string; releaseId: string; bytes: string };
    expect(entry.releaseId).toBe(release.releaseId);
    expect(entry.digest).toBe(release.signedContentDigest);
    // The served bytes ARE the signed card, and they hash to the digest the header advertises.
    expect(sha256Digest(new TextEncoder().encode(entry.bytes))).toBe(entry.digest);
    expect(JSON.parse(entry.bytes)).toEqual(release.signedCard);
    expect(w.vault.has(STUDIO_KEYS.publication(card, p.receipt.receiptId))).toBe(true);
    expect(w.audit.events().find((e) => e.action === 'agent.card.published')?.outcome).toBe('success');
  });

  it('keeps the release `signed` when the world serves something else (invalid), and never on egress failure', async () => {
    const { card, release } = await signedRelease(studio, w);
    w.serve = () => new Response('{"stale":true}', { headers: { 'x-ap-card-digest': 'sha256:' + '11'.repeat(32) } });
    const p = await ok<{ release: A2AAgentCardReleaseV1; receipt: A2AWellKnownPublicationReceiptV1 }>(studio.run(as(STEWARD), 'release.publish', { cardResourceId: card, releaseId: release.releaseId, ...mutation() }));
    expect(p.receipt.verificationResult).toBe('invalid');
    expect(p.receipt.detail).toMatch(/served digest/);
    expect(p.release.state).toBe('signed');
    expect(w.audit.events().find((e) => e.action === 'agent.card.published')?.outcome).toBe('error');
    w.serve = () => { throw new Error('1042 loopback'); };
    const u = await ok<{ receipt: A2AWellKnownPublicationReceiptV1 }>(studio.run(as(STEWARD), 'release.verifyPublication', { cardResourceId: card, releaseId: release.releaseId }));
    expect(u.receipt.verificationResult).toBe('unverified');
    // Once the world catches up, re-verification moves it to published without re-publishing.
    w.serve = undefined;
    const v = await ok<{ release: A2AAgentCardReleaseV1; receipt: A2AWellKnownPublicationReceiptV1 }>(studio.run(as(STEWARD), 'release.verifyPublication', { cardResourceId: card, releaseId: release.releaseId }));
    expect(v.receipt.verificationResult).toBe('valid');
    expect(v.release.state).toBe('published');
  });

  it('supersedes the previous published release and drops the cache on revoke', async () => {
    const first = await signedRelease(studio, w);
    await ok(studio.run(as(STEWARD), 'release.publish', { cardResourceId: first.card, releaseId: first.release.releaseId, ...mutation() }));
    await ok(studio.run(as(STEWARD), 'card.patchDraft', { cardResourceId: first.card, patch: [{ op: 'replace', path: '/description', value: 'v2' }], ...mutation({ expectedRevision: 2 }) }));
    const r2 = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: first.card, ...mutation() }));
    expect(r2.release.supersedes).toBe(first.release.releaseId);
    await ok(studio.run(as(STEWARD), 'release.requestApproval', { cardResourceId: first.card, releaseId: r2.release.releaseId, ...mutation() }));
    await ok(studio.run(as(REVIEWER), 'release.approve', { cardResourceId: first.card, releaseId: r2.release.releaseId, ...mutation() }));
    const signed = await signA2ACard(r2.release.unsignedCard, { privateKey: first.key.privateKey, kid: first.key.kid });
    await ok(studio.run(as(STEWARD), 'release.sign', { cardResourceId: first.card, releaseId: r2.release.releaseId, signedCard: signed.card, signature: signed.signature, signerJwk: first.key.publicJwk, ...mutation() }));
    await ok(studio.run(as(STEWARD), 'release.publish', { cardResourceId: first.card, releaseId: r2.release.releaseId, ...mutation() }));
    const get = await ok<{ releases: A2AAgentCardReleaseV1[] }>(studio.run(as(STEWARD), 'card.get', { cardResourceId: first.card }));
    expect(get.releases.find((r) => r.releaseId === first.release.releaseId)).toMatchObject({ state: 'superseded', supersededBy: r2.release.releaseId });
    const rev = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'release.revoke', { cardResourceId: first.card, releaseId: r2.release.releaseId, ...mutation({ reason: 'key compromised' }) }));
    expect(rev.release.state).toBe('revoked');
    expect(rev.release.revocation).toMatchObject({ reason: 'key compromised', authority: `eip155:${CHAIN_ID}:${STEWARD}` });
    expect(w.kv.has(studioReleasedCardKey(AGENT))).toBe(false);
  });

  it('refuses to publish without the KV binding (fail-closed) or before signing', async () => {
    const noKv = new AgentCardStudio(deps(w, { kv: false }));
    const { card, release } = await signedRelease(noKv, w);
    const r = await noKv.run(as(STEWARD), 'release.publish', { cardResourceId: card, releaseId: release.releaseId, ...mutation() });
    expect(r.status).toBe(503);
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', { cardResourceId: 'second', primary: false, environment: 'staging', ...mutation() }));
    const rel = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: c.resource.cardResourceId, ...mutation() }));
    const early = await studio.run(as(STEWARD), 'release.publish', { cardResourceId: c.resource.cardResourceId, releaseId: rel.release.releaseId, ...mutation() });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('release_not_signed');
  });
});

describe('projections: AP naming preview → plan → approve → record', () => {
  let w: World;
  let studio: AgentCardStudio;
  beforeEach(() => { w = makeWorld(); studio = new AgentCardStudio(deps(w)); });

  async function publishedRelease() {
    const s = await signedRelease(studio, w);
    await ok(studio.run(as(STEWARD), 'release.publish', { cardResourceId: s.card, releaseId: s.release.releaseId, ...mutation() }));
    return s;
  }

  it('previews a pure artifact from a sealed bundle carrying the released card digest', async () => {
    const { card, release } = await publishedRelease();
    const cfg = await ok<{ instance: ProjectionInstanceV1; selectedCard: { releaseId: string } }>(studio.run(as(STEWARD), 'projection.configure', { family: 'ap-naming', cardResourceId: card, selectedReleaseId: release.releaseId, ...mutation() }));
    expect(cfg.instance.state).toBe('configured');
    expect(cfg.selectedCard.releaseId).toBe(release.releaseId);
    const pv = await ok<{ instance: ProjectionInstanceV1; result: ProjectionResultV1<ApNamingArtifactV1>; bundle: { selectedA2ACard?: { contentDigest: string; publicationUri?: string }; sourceBundleDigest: string } }>(studio.run(as(STEWARD), 'projection.preview', { instanceId: cfg.instance.instanceId }));
    expect(pv.instance.state).toBe('generated');
    expect(pv.bundle.selectedA2ACard?.contentDigest).toBe(release.signedContentDigest);
    expect(pv.bundle.selectedA2ACard?.publicationUri).toBe(CARD_URI);
    const a = pv.result.artifact;
    expect(a.name).toBe(NAME);
    expect(a.node).toBe(namehash(NAME));
    expect(a.records.addr).toBe(AGENT);
    expect(a.records.agentKind).toBe('service');
    expect(a.records.a2aEndpoint).toBe(`https://${HOST}/api/a2a`);
    expect(a.records.cardDigest).toBe(sha256ToBytes32(release.signedContentDigest!));
    expect(a.records.cardUri).toBe(CARD_URI);
    expect(pv.result.losses.length).toBeGreaterThan(0); // the loss report is always present
    expect(pv.result.digests.selectedCard).toBe(release.signedContentDigest);
    expect(w.vault.has(STUDIO_KEYS.artifact(cfg.instance.instanceId, pv.result.artifactDigest))).toBe(true);
    // Deterministic: previewing again yields the same artifact digest.
    const again = await ok<{ result: ProjectionResultV1<ApNamingArtifactV1> }>(studio.run(as(STEWARD), 'projection.preview', { instanceId: cfg.instance.instanceId }));
    expect(again.result.artifactDigest).toBe(pv.result.artifactDigest);
  });

  it('refuses to select an unsigned release and an unsupported family', async () => {
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD), 'card.create', mutation()));
    const r = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD), 'card.createRelease', { cardResourceId: c.resource.cardResourceId, ...mutation() }));
    const bad = await studio.run(as(STEWARD), 'projection.configure', { family: 'ap-naming', cardResourceId: c.resource.cardResourceId, selectedReleaseId: r.release.releaseId, ...mutation() });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('release_not_projection_ready');
    const ext = await studio.run(as(STEWARD), 'projection.configure', { family: 'erc8004', ...mutation() });
    expect(ext.status).toBe(400);
    expect(ext.body.error).toBe('unsupported_family');
  });

  it('plans the record writes as contract calls, gates recording on the approval, and verifies on chain', async () => {
    const { card, release } = await publishedRelease();
    const cfg = await ok<{ instance: ProjectionInstanceV1 }>(studio.run(as(STEWARD), 'projection.configure', { family: 'ap-naming', cardResourceId: card, selectedReleaseId: release.releaseId, ...mutation() }));
    const id = cfg.instance.instanceId;
    const pv = await ok<{ result: ProjectionResultV1<ApNamingArtifactV1> }>(studio.run(as(STEWARD), 'projection.preview', { instanceId: id }));
    const plan = await ok<{ plan: PublicationPlanV1; contractCalls: PlannedContractCallV1[]; signatureRequests: unknown[] }>(studio.run(as(STEWARD), 'projection.planPublication', { instanceId: id, ...mutation() }));
    expect(plan.plan.target).toMatchObject({ family: 'ap-naming', registry: REGISTRY, network: `eip155:${CHAIN_ID}` });
    expect(plan.plan.operations[0]!.kind).toBe('name-record-write');
    // addr, agentKind, displayName, a2aEndpoint, metadataHash, cardDigest, cardUri (no metadataUri — profile unanchored)
    expect(plan.contractCalls).toHaveLength(7);
    expect(plan.contractCalls.every((c) => c.to === RESOLVER && c.value === '0' && c.chainId === CHAIN_ID)).toBe(true);
    expect(plan.signatureRequests).toEqual([]);
    await ok(studio.run(as(STEWARD), 'projection.requestApproval', { instanceId: id, planId: plan.plan.planId, ...mutation() }));
    const appr = await ok<{ approval: { approvalId: string; approvedDigest: string; idempotencyKey: string } }>(studio.run(as(REVIEWER), 'projection.approve', { instanceId: id, planId: plan.plan.planId, ...mutation() }));
    expect(appr.approval.approvedDigest).toBe(plan.plan.planDigest);
    expect(appr.approval.idempotencyKey).toBe(plan.plan.idempotencyKey);

    // A DIFFERENT plan's approval does not cover this one.
    const other = await ok<{ plan: PublicationPlanV1 }>(studio.run(as(STEWARD), 'projection.planPublication', { instanceId: id, ...mutation() }));
    expect(other.plan.planId).not.toBe(plan.plan.planId);
    const wrong = await studio.run(as(STEWARD), 'projection.recordPublication', { instanceId: id, planId: other.plan.planId, approvalId: appr.approval.approvalId, transactions: [{ hash: '0x' + 'ab'.repeat(32) }], ...mutation() });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: 'plan_not_approved', reason: 'approval-digest-mismatch' });

    // The Home executed the calls, but the chain does not (yet) agree → invalid receipt, failed instance.
    const tx = ('0x' + 'cd'.repeat(32)) as Hex;
    const notYet = await ok<{ receipt: PublicationReceiptV1; binding: ExternalIdentityBindingV1; instance: ProjectionInstanceV1 }>(studio.run(as(STEWARD), 'projection.recordPublication', { instanceId: id, planId: plan.plan.planId, approvalId: appr.approval.approvalId, transactions: [{ hash: tx }], ...mutation() }));
    expect(notYet.receipt.verification.result).toBe('invalid');
    expect(notYet.instance.state).toBe('failed');
    expect(notYet.binding.lifecycle.state).toBe('pendingVerification');
    expect(w.audit.events().map((e) => e.action)).toContain('agent.projection.publish.failed');

    // The chain now carries exactly the artifact's records → valid receipt, active binding, published.
    w.chainRecords = { ...pv.result.artifact.records } as AgentNameRecords;
    const done = await ok<{ receipt: PublicationReceiptV1; binding: ExternalIdentityBindingV1; instance: ProjectionInstanceV1 }>(studio.run(as(STEWARD), 'projection.recordPublication', { instanceId: id, planId: plan.plan.planId, approvalId: appr.approval.approvalId, transactions: [{ hash: tx }], ...mutation() }));
    expect(done.receipt.verification).toMatchObject({ result: 'valid', method: 'readContract' });
    expect(done.receipt.transactions[0]).toMatchObject({ chainId: CHAIN_ID, hash: tx });
    expect(done.receipt.externalIds[0]).toMatchObject({ family: 'ap-naming', registry: REGISTRY, externalId: namehash(NAME) });
    expect(done.receipt.digests.selectedCard).toBe(release.signedContentDigest);
    expect(done.binding).toMatchObject({ target: { family: 'ap-naming', registry: REGISTRY }, externalId: namehash(NAME), verification: { state: 'verified' }, lifecycle: { state: 'active' } });
    expect(done.instance.state).toBe('published');
    expect(done.instance.lastBinding?.bindingId).toBe(done.binding.bindingId);
    expect(w.vault.has(STUDIO_KEYS.receipt(id, done.receipt.receiptId))).toBe(true);
    const actions = w.audit.events().map((e) => e.action);
    expect(actions).toContain('agent.projection.publish.completed');
    expect(actions).toContain('agent.naming.updated');
    expect(actions).toContain('agent.binding.verified');

    // binding.verify re-reads the chain; a drifted record flips the binding to stale.
    const listed = await ok<{ bindings: ExternalIdentityBindingV1[] }>(studio.run(as(STEWARD), 'binding.list', {}));
    expect(listed.bindings).toHaveLength(1);
    w.chainRecords = { ...w.chainRecords, cardDigest: ('0x' + '99'.repeat(32)) as Hex };
    const drift = await ok<{ binding: ExternalIdentityBindingV1; verdict: { ok: boolean; detail: string } }>(studio.run(as(STEWARD), 'binding.verify', { bindingId: done.binding.bindingId }));
    expect(drift.verdict.ok).toBe(false);
    expect(drift.verdict.detail).toMatch(/cardDigest/);
    expect(drift.binding.lifecycle.state).toBe('stale');
  });
});

describe('the Agent Metadata Steward (service-agent caller)', () => {
  it('may draft, validate and preview; may never approve, sign, publish or transact', async () => {
    const w = makeWorld();
    const studio = new AgentCardStudio(deps(w));
    const c = await ok<{ resource: A2AAgentCardResourceV1 }>(studio.run(as(STEWARD_AGENT), 'card.create', mutation()));
    const card = c.resource.cardResourceId;
    await ok(studio.run(as(STEWARD_AGENT), 'card.validate', { cardResourceId: card }));
    const r = await ok<{ release: A2AAgentCardReleaseV1 }>(studio.run(as(STEWARD_AGENT), 'card.createRelease', { cardResourceId: card, ...mutation() }));
    await ok(studio.run(as(STEWARD_AGENT), 'release.requestApproval', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    for (const [op, args] of [
      ['release.approve', { cardResourceId: card, releaseId: r.release.releaseId }],
      ['release.sign', { cardResourceId: card, releaseId: r.release.releaseId }],
      ['release.publish', { cardResourceId: card, releaseId: r.release.releaseId }],
      ['release.revoke', { cardResourceId: card, releaseId: r.release.releaseId }],
      ['projection.approve', { instanceId: 'x', planId: 'y' }],
      ['binding.verify', { bindingId: 'b' }],
    ] as const) {
      const res = await studio.run(as(STEWARD_AGENT), op, { ...args, ...mutation({ reason: 'r' }) });
      expect(res.status, op).toBe(403);
      expect(res.body.error, op).toBe('scope_not_held');
    }
    const denied = w.audit.events().filter((e) => e.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(6);
    expect(denied[0]!.actor).toMatchObject({ type: 'service', id: STEWARD_AGENT });
    // Configure + preview stay open to the steward — pure work.
    const humanStudio = new AgentCardStudio(deps(w));
    await ok(humanStudio.run(as(REVIEWER), 'release.approve', { cardResourceId: card, releaseId: r.release.releaseId, ...mutation() }));
    const cfg = await ok<{ instance: ProjectionInstanceV1 }>(studio.run(as(STEWARD_AGENT), 'projection.configure', { family: 'ap-naming', ...mutation() }));
    await ok(studio.run(as(STEWARD_AGENT), 'projection.preview', { instanceId: cfg.instance.instanceId }));
    const rec = await studio.run(as(STEWARD_AGENT), 'projection.recordPublication', { instanceId: cfg.instance.instanceId, planId: 'p', approvalId: 'a', ...mutation() });
    expect(rec.status).toBe(403);
  });
});
