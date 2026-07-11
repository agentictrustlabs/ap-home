// InteractionsDO — the per-principal SERIALIZED execution point for the interaction substrate
// (spec 322 W2; the embryo of spec 316's PrincipalGatewayDO). One instance per principal SA
// (idFromName = lowercase org/person SA): every board/directory mutation for that principal flows
// through THIS object, giving the single-writer ordering the vault's last-writer-wins storage
// cannot (spec 322 §5). Plane-B custody: the DO stores the principal's steward-signed interactions
// grant (the OPERATIONAL wire lives with its delegate service — spec 322 §2); callers never touch
// `/mcp/vault/*` for interaction records.
//
// Gates (spec 322 §4), all fail-closed:
//   caller    = a broker-verified Home session (any principal kind) → the session SA;
//   member    = a CURRENT directory listing whose ERC-1271 proof re-verifies AT GATE TIME against
//               the subject SA (index presence is never trust — the index is writable under the
//               execution grant);
//   steward   = a PRESENTED org→person stewardship DelegationWire, signature-verified against the
//               org (approved-hash 0x03 wires validate through the SA's ERC-1271 branch) and
//               checked unrevoked on-chain;
//   replay    = monotonic publishedAt per subject + tombstones honored by the gate.
// The VAULT enforces scopes only — never membership (stated so nobody optimizes this gate away).
// Audit: D1 (spec 322 §7), before commit.
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { hashDelegation, decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER, type Delegation } from '@agenticprimitives/delegation';
import {
  appendBoardPost,
  createBoardChannel,
  canonicalizeMessage,
  createVaultMessageBodyStore,
  isListingCurrent,
  sha256Hex32,
  validateDirectoryListing,
  type ChannelV1,
  type DirectoryListingV1,
  type MessageEnvelopeV1,
} from '@agenticprimitives/fabric/messaging';
import type { Vault } from '@agenticprimitives/vault';

import { verifyHomeSession } from './custody-oidc.js';
import { verifyBridgeCall, nonceStoreFromKv, type NonceStore } from './bridge-hmac';
// Hoisted-function import from index.js — the documented safe cycle (see a2a-task-do.ts:38).
import { buildAuditSink, callMcpToolViaDelegation, type Env, type IncomingDelegation } from './index.js';

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] }] as const;

// spec 322 W3 board split: descriptors in `board.index`; per-channel message projections in
// `board.channel:<id>` (multi-writer conflicts shrink to same-channel; reads stop paying for the
// whole board; per-channel scopes become possible). NO migration from the old single
// `channels.data` doc — disposable by product decision.
const BOARD_INDEX_RESOURCE = 'board.index';
const CHANNEL_RESOURCE = (channelId: string): string => `board.channel:${channelId}`;
const DIRECTORY_RESOURCE = 'directory.data';

/** The scope set the CURRENT wave requires — a stored grant missing any of these is STALE and the
 *  steward re-signs via the Enable ceremony (grant re-signs are ceremonies, not migration). */
const REQUIRED_SCOPES = ['vault:board.index', 'vault:board.channel:*', 'vault:message.body:channel:*', 'vault:inbox.data', 'vault:directory.data', 'vault:relationships.data', 'vault:member.profile:*', 'vault:message.body:dm:*', 'vault:impact-profile', 'vault:skills.data', 'vault:home.manifest'] as const;

// 1-1 inbox residency (spec 322 W3f): the DELIVERY grant is WRITE-ONLY — every inbox.data READ and
// dm-body READ rides the interactions grant THROUGH this DO (single writer, single reader path).
const INBOX_RESOURCE = 'inbox.data';
const DM_BODY_PREFIX = 'message.body:dm:';

// Person-plane records (spec 322 W3d): the person's authoritative org-relationship doc and their
// per-org shareable profile cards. Self-gated ops only — the session SA must BE the principal.
const RELATIONSHIPS_RESOURCE = 'relationships.data';
const MEMBER_PROFILE_RESOURCE = (org: string): string => `member.profile:${org.toLowerCase()}`;

// spec 323 W2 — owner-own capability DOCUMENTS (last-writer-wins whole-doc records), reachable ONLY
// self (session SA === principal) over the interactions grant. This is the delegation-authorized,
// KEK-encrypted replacement for the bearer/service-MAC `impact-profile` path (V-1 remediation) and
// the app-local `skills`/`home-manifest` KV. NOT append logs (control-events needs its own op).
const CAPABILITY_RECORDS = new Set(['impact-profile', 'skills.data', 'home.manifest']);

// spec 323 §3: wires whose DELEGATE is this person (stewardship, member-access) are the person's
// own private credentials — they ride the entry so any Home can act from the vault (ADR-0025).
interface RelationshipEntryV1 { org: string; relationship: 'member' | 'steward'; orgName?: string; delegationHash?: string; delegations?: IncomingDelegation[]; updatedAt: string }
interface RelationshipsDocV1 { orgs: Record<string, RelationshipEntryV1> }
/** Grants LEDGER row (spec 322 W3e §2): hash + metadata ONLY — the wire itself is a bearer secret. */
interface GrantLedgerRowV1 { hash: string; delegate: string; resources: string[]; storedAt: string }

interface IndexedListing { listing: DirectoryListingV1; label: string }
interface StoredState {
  grant?: IncomingDelegation;
  /** Issuance ledger (spec 322 W3e): every grant ever custodied here, hash/metadata only. */
  ledger?: GrantLedgerRowV1[];
  /** subject(lowercase caip10) → highest publishedAt accepted (replay guard) + tombstone flag. */
  subjects?: Record<string, { publishedAt: string; tombstoned?: boolean }>;
}

const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

export class InteractionsDO {
  constructor(private state: DurableObjectState, private env: Env) {}


  private pub() {
    return createPublicClient({ chain: baseSepolia, transport: http(this.env.RPC_URL) });
  }

  private async erc1271(account: Address, digest: Hex, signature: Hex): Promise<boolean> {
    try {
      const magic = (await this.pub().readContract({ address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
      return magic.toLowerCase() === ERC1271_MAGIC;
    } catch { return false; }
  }

  /** The fabric Vault port over the delegation-authorized demo-mcp transport (plane B). */
  private vaultFor(grant: IncomingDelegation): Vault {
    const env = this.env;
    return {
      async write({ resource, data }: { owner: string; resource: string; data: unknown; classification?: string }): Promise<void> {
        const resp = await callMcpToolViaDelegation({ env, toolName: 'set_vault_record', delegation: grant, requester: grant.delegate as Address, toolArgs: { recordType: resource, data } });
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `vault write failed (${resp.status})`);
      },
      async read<T>({ resource }: { owner: string; resource: string }): Promise<{ data: T } | null> {
        const resp = await callMcpToolViaDelegation({ env, toolName: 'get_vault_record', delegation: grant, requester: grant.delegate as Address, toolArgs: { recordType: resource } });
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; record?: T | null; error?: string };
        if (!resp.ok) throw new Error(out.error ?? `vault read failed (${resp.status})`);
        return out.record === null || out.record === undefined ? null : { data: out.record };
      },
      async list(): Promise<never[]> { return []; },
    } as unknown as Vault;
  }

  private async readDoc<T>(grant: IncomingDelegation, resource: string, empty: T): Promise<T> {
    const r = await this.vaultFor(grant).read<T>({ owner: '', resource });
    return (r?.data as T) ?? empty;
  }

  private async writeDoc(grant: IncomingDelegation, resource: string, data: unknown): Promise<void> {
    await this.vaultFor(grant).write({ owner: '', resource, data, classification: 'internal' } as never);
  }

  /** GATE-TIME listing verification (spec 322 §4): current + ERC-1271-proven + not tombstoned. */
  private async memberName(grant: IncomingDelegation, principal: string, sessionSaCaip: string): Promise<string | null> {
    const rows = await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, []);
    const me = sessionSaCaip.toLowerCase();
    const now = new Date().toISOString();
    const mine = rows.find((l) => l.listing.subject.toLowerCase() === me && isListingCurrent(l.listing, now));
    if (!mine) return null;
    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    if (st.subjects?.[me]?.tombstoned) return null;
    const { proof, ...draft } = mine.listing;
    const digest = await sha256Hex32(canonicalizeMessage(draft));
    const subjectAddr = mine.listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] as Address | undefined;
    if (!subjectAddr || !(await this.erc1271(subjectAddr, digest as Hex, proof.signature as Hex))) return null;
    void principal;
    return mine.listing.displayName;
  }

  /** Steward proof: a presented org→person stewardship wire, org-verified + unrevoked on-chain. */
  private async isSteward(principal: string, sessionSa: Address, wire: IncomingDelegation | undefined): Promise<boolean> {
    if (!wire) return false;
    if (wire.delegator.toLowerCase() !== principal.toLowerCase()) return false;
    if (wire.delegate.toLowerCase() !== sessionSa.toLowerCase()) return false;
    const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
    const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
    if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return false;
    try {
      const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
      return !revoked;
    } catch { return false; } // fail-closed on chain-read failure
  }


  /** Does the stored grant cover the CURRENT wave's scope set? Stale ⇒ steward re-enables. */
  private grantIsCurrent(grant: IncomingDelegation): boolean {
    const cav = (grant.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
    if (!cav?.terms) return false;
    try {
      const resources = new Set(decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources));
      return REQUIRED_SCOPES.every((r) => resources.has(r));
    } catch { return false; }
  }

  /** Bridge-HMAC gate for the Home-server channel (SEC-010 envelope; audience pins the op). */
  private async bridgeGate(request: Request, rawBody: string, op: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    const kv = this.env.BRIDGE_NONCES;
    if (!secret || !kv) return { ok: false, reason: 'bridge not configured' };
    const nonces: NonceStore = nonceStoreFromKv(kv);
    return verifyBridgeCall({ request, rawBody, secret, expectedAudience: `interactions.${op}`, nonces });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // interactions/<principal>/<op>
    const principal = (parts[1] ?? '').toLowerCase();
    const op = parts[2] ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal)) return json({ error: 'bad principal' }, 400);
    const rawBody = await request.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* empty body ok */ }

    // ── Grant custody (plane B): the Worker pre-verifies the steward session + delegator match. ──
    if (op === 'grant' && request.method === 'POST') {
      const wire = body.delegation as IncomingDelegation | undefined;
      if (!wire?.signature || wire.delegator.toLowerCase() !== principal) return json({ error: 'delegation with delegator = principal required' }, 400);
      // Verify the wire IS the principal's before storing (junk-overwrite DoS guard): ERC-1271 over
      // the delegation digest against the delegator (approved-hash 0x03 wires validate through the
      // SA's approved-hash branch). Fail-closed: an unverifiable grant is never stored.
      const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
      const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
      if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) {
        return json({ error: 'grant signature failed verification against the delegator' }, 403);
      }
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      st.grant = wire;
      // Ledger row (W3e): hash + delegate + decoded resources — never the wire (bearer secret).
      let resources: string[] = [];
      try {
        const cav = wire.caveats.find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
        if (cav?.terms) resources = decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources);
      } catch { /* undecodable scopes → empty resources row; the currency gate handles enforcement */ }
      st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: wire.delegate.toLowerCase(), resources, storedAt: new Date().toISOString() }].slice(-50);
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    if (op === 'status') {
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      return json({ ok: true, granted: !!st.grant, current: !!st.grant && this.grantIsCurrent(st.grant) });
    }

    // ── 1-1 inbox residency (spec 322 W3f) — the Home-server channel + in-Worker delivery. ──
    // The Home reaches this principal's mail ONLY here (bridge-HMAC-authenticated, the same SEC-010
    // envelope as the custody bridge); the a2a messaging skills merge deliveries here in-Worker
    // (`internal.deliver` — the public route refuses `internal.*`, so only Worker code reaches it).
    // The standing DELIVERY grant is write-only: it can no longer read anyone's mail.
    if (op === 'inbox.get' || op === 'inbox.put' || op === 'inbox.body.get' || op === 'internal.deliver') {
      if (op !== 'internal.deliver') {
        const bg = await this.bridgeGate(request, rawBody, op);
        if (!bg.ok) return json({ error: `unauthorized: ${bg.reason}` }, 401);
      }
      const st0 = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      const g = st0.grant;
      if (!g) return json({ error: 'no interactions grant — enable interactions for this agent first' }, 409);
      if (!this.grantIsCurrent(g)) return json({ error: 'interactions grant is stale — re-enable (scope widened this wave)' }, 409);
      try {
        if (op === 'inbox.get') {
          const doc = await this.readDoc<unknown>(g, INBOX_RESOURCE, null);
          return json({ ok: true, doc });
        }
        if (op === 'inbox.put') {
          if (body.doc === undefined) return json({ error: 'doc required' }, 400);
          await this.writeDoc(g, INBOX_RESOURCE, body.doc);
          return json({ ok: true });
        }
        if (op === 'inbox.body.get') {
          // dm-namespace ONLY — the bridge cannot be aimed at arbitrary vault records (the grant's
          // record scope enforces the same bound at the vault; this is the belt to that suspender).
          const resource = String(body.resource ?? '');
          if (!resource.startsWith(DM_BODY_PREFIX)) return json({ error: 'dm body resources only' }, 400);
          const r = await this.vaultFor(g).read<unknown>({ owner: '', resource });
          return json({ ok: true, record: r?.data ?? null });
        }
        // internal.deliver — append-only merge of a validated envelope (the skill already verified
        // addressing + bodyHash and persisted the body under the delivery grant).
        const envelope = body.envelope as MessageEnvelopeV1 | undefined;
        if (!envelope?.id) return json({ error: 'envelope required' }, 400);
        const doc = (await this.readDoc<Record<string, unknown>>(g, INBOX_RESOURCE, null as never)) ?? { version: 1, envelopes: [], events: [], draftCases: [], caseEvents: [], cards: {} };
        const envs = (doc.envelopes as MessageEnvelopeV1[] | undefined) ?? [];
        if (!envs.some((e) => e.id === envelope.id)) {
          doc.envelopes = [...envs, envelope];
          doc.events = [
            ...((doc.events as unknown[] | undefined) ?? []),
            { version: 'ap.message.event.v1', messageId: envelope.id, actor: envelope.from, eventType: 'delivered', at: new Date().toISOString() },
          ];
          await this.writeDoc(g, INBOX_RESOURCE, doc);
        }
        return json({ ok: true, messageId: envelope.id });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 409);
      }
    }

    // ── Skills — caller = broker-verified Home session (any principal kind). ──
    const gate = await verifyHomeSession(String(body.session ?? ''), this.env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const sessionSa = gate.sa;
    const sessionCaip = gate.caip;

    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    const grant = st.grant;
    if (!grant) return json({ error: 'no interactions grant — a steward must enable storage for this agent' }, 409);
    if (!this.grantIsCurrent(grant)) return json({ error: 'interactions grant is stale — a steward must re-enable storage (scope widened this wave)' }, 409);
    const audit = buildAuditSink(this.env);

    try {
      if (op === 'directory.publish') {
        const listing = body.listing as DirectoryListingV1 | undefined;
        if (!listing) return json({ error: 'listing required' }, 400);
        const errors = validateDirectoryListing(listing);
        if (errors.length > 0) return json({ error: `invalid listing: ${errors.join(', ')}` }, 400);
        // Self-publish, OR a steward publishing an ORG's listing (spec 313 §4 Networks): the
        // presented stewardship wire must be delegated BY the listing subject to the session SA.
        if (listing.subject.toLowerCase() !== sessionCaip.toLowerCase()) {
          const subjAddr = listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0];
          const w = body.subjectStewardship as IncomingDelegation | undefined;
          const ok = !!subjAddr && (await this.isSteward(subjAddr, sessionSa, w));
          if (!ok) return json({ error: 'listing subject must be the session principal (or present its stewardship wire)' }, 403);
        }
        const { proof, ...draft } = listing;
        const digest = await sha256Hex32(canonicalizeMessage(draft));
        const proofSubject = (listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? sessionSa) as Address;
        if (!(await this.erc1271(proofSubject, digest as Hex, proof.signature as Hex))) return json({ error: 'listing signature failed ERC-1271 verification' }, 403);
        // Replay guard: monotonic publishedAt per subject; publishing clears any tombstone (rejoin).
        const me = sessionCaip.toLowerCase();
        const prev = st.subjects?.[me]?.publishedAt;
        if (prev && Date.parse(listing.publishedAt) <= Date.parse(prev)) return json({ error: 'stale listing (publishedAt must be monotonic)' }, 409);
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
        rows.push({ listing, label: String(body.label ?? '') });
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.publish', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        st.subjects = { ...(st.subjects ?? {}), [me]: { publishedAt: listing.publishedAt } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.revoke') {
        const me = sessionCaip.toLowerCase();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.revoke', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        st.subjects = { ...(st.subjects ?? {}), [me]: { publishedAt: st.subjects?.[me]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.remove') {
        // STEWARD removal of another member's listing (spec 321 W3 continuity under the DO): the
        // caller presents the stewardship wire; the subject's listing is dropped + tombstoned so a
        // replayed old listing cannot re-enter (spec 322 §4).
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'stewardship proof required' }, 403);
        const subject = String(body.subject ?? '').toLowerCase();
        if (!subject) return json({ error: 'subject required' }, 400);
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => !l.listing.subject.toLowerCase().endsWith(subject));
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.remove', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: subject } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        const key = Object.keys(st.subjects ?? {}).find((k) => k.endsWith(subject)) ?? subject;
        st.subjects = { ...(st.subjects ?? {}), [key]: { publishedAt: st.subjects?.[key]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.list') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter' }, 403);
        const now = new Date().toISOString();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => isListingCurrent(l.listing, now));
        return json({ ok: true, listings: rows });
      }

      if (op === 'channels.list' || op === 'channels.read') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        // Board split (W3): descriptors from board.index; ONE channel's messages from its own doc.
        const index = await this.readDoc<ChannelV1[]>(grant, BOARD_INDEX_RESOURCE, []);
        const bodies: Record<string, string> = {};
        let wire = index.map((c) => ({ ...c, messages: [] as { envelope: MessageEnvelopeV1; authorName: string }[] }));
        if (op === 'channels.read' && typeof body.channelId === 'string') {
          const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, CHANNEL_RESOURCE(body.channelId), []);
          wire = wire.map((c) => (c.descriptor.id === body.channelId ? { ...c, messages } : c));
          const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
          await Promise.all(messages.map(async (m) => {
            // Bodies load at the envelope's OWN resource (channel namespace) — never re-normalized.
            try { bodies[m.envelope.id] = new TextDecoder().decode(await store.loadBody(m.envelope)); } catch { /* fail-closed omit */ }
          }));
        }
        return json({ ok: true, channels: wire, bodies, you: name ?? 'Steward', steward });
      }

      if (op === 'channels.create') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        const index = await this.readDoc<ChannelV1[]>(grant, BOARD_INDEX_RESOURCE, []);
        const r = createBoardChannel(index, { contextId: principal, owner: sessionCaip as ChannelV1['descriptor']['owner'], title: String(body.title ?? ''), createdBy: name ?? 'Steward' });
        if (!r.ok) return json({ error: r.error }, r.error.includes('already exists') ? 409 : 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.create', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: r.channel.descriptor.id } });
        await this.writeDoc(grant, BOARD_INDEX_RESOURCE, index); // index holds descriptors only (messages stay [])
        return json({ ok: true, channelId: r.channel.descriptor.id });
      }

      if (op === 'channels.post') {
        const name = await this.memberName(grant, principal, sessionCaip);
        if (!name) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403); // posting = listing members ONLY
        // Board split (W3): only the ONE channel doc is read + rewritten — same-channel conflicts only.
        const channelId = String(body.channelId ?? '');
        const index = await this.readDoc<ChannelV1[]>(grant, BOARD_INDEX_RESOURCE, []);
        const entry = index.find((c) => c.descriptor.id === channelId);
        if (!entry) return json({ error: 'unknown channel' }, 404);
        const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, CHANNEL_RESOURCE(channelId), []);
        const composed: ChannelV1[] = [{ ...entry, messages }];
        const r = await appendBoardPost(composed, { channelId, from: sessionCaip as MessageEnvelopeV1['from'], authorName: name, bodyText: String(body.bodyText ?? '') });
        if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: r.envelope.createdAt, action: 'interactions.channels.post', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel-post', id: r.envelope.id } });
        const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
        // Channel bodies live in the CHANNEL namespace (the envelope's own resource — closes FAB-SSO-2).
        await store.putBody({ messageId: r.envelope.id, bytes: new TextEncoder().encode(String(body.bodyText ?? '').trim()), contentType: 'text/plain', classification: 'internal', resource: r.envelope.body.resource });
        await this.writeDoc(grant, CHANNEL_RESOURCE(channelId), composed[0]!.messages);
        return json({ ok: true, messageId: r.envelope.id });
      }

      if (op === 'grants.list') {
        // Steward-or-self visibility into the issuance ledger (spec 322 W3e).
        const self = sessionSa.toLowerCase() === principal;
        const steward = self ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!self && !steward) return json({ error: 'stewardship proof required' }, 403);
        return json({ ok: true, grants: st.ledger ?? [] });
      }

      // ── Person-plane ops (spec 322 W3d) — STRICTLY self: the session SA must BE the principal. ──
      if (op === 'relationships.get' || op === 'relationships.merge' || op === 'member.profile.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        if (op === 'relationships.get') {
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          return json({ ok: true, relationships: doc });
        }
        if (op === 'relationships.merge') {
          const entry = body.entry as Partial<RelationshipEntryV1> | undefined;
          const org = String(entry?.org ?? '').toLowerCase();
          if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'entry.org (address) required' }, 400);
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          if (body.remove === true) delete doc.orgs[org];
          else {
            const prev = doc.orgs[org];
            doc.orgs[org] = {
              org,
              relationship: entry?.relationship === 'steward' ? 'steward' : 'member',
              ...(entry?.orgName ? { orgName: String(entry.orgName) } : {}),
              ...(entry?.delegationHash ? { delegationHash: String(entry.delegationHash) } : {}),
              // Wires accumulate (a member-access grant may arrive after the membership entry);
              // self-gated op — only the person can place credentials in their own doc.
              ...(Array.isArray(entry?.delegations) || prev?.delegations
                ? { delegations: [...(prev?.delegations ?? []), ...((entry?.delegations as IncomingDelegation[] | undefined) ?? [])].slice(-8) }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.relationships.merge', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'org-link', id: org } });
          await this.writeDoc(grant, RELATIONSHIPS_RESOURCE, doc);
          return json({ ok: true });
        }
        const org = String(body.org ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'org (address) required' }, 400);
        const profile = (body.profile ?? {}) as Record<string, unknown>;
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.member-profile.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'member-profile', id: org } });
        await this.writeDoc(grant, MEMBER_PROFILE_RESOURCE(org), profile);
        return json({ ok: true });
      }

      // ── Owner-own capability records (spec 323 W2) — STRICTLY self; whitelisted recordType. ──
      // `record.get`/`record.put { record }`: the delegation-authorized, KEK-encrypted home for the
      // person's own profile/skills/manifest, replacing the V-1 bearer path + app-local KV. The
      // interactions grant's record scope + the vault's KEK gate BOTH bound this at demo-mcp; the
      // self-check + whitelist here are the belt to those suspenders.
      if (op === 'record.get' || op === 'record.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        const recordType = String(body.recordType ?? '');
        if (!CAPABILITY_RECORDS.has(recordType)) return json({ error: `recordType must be one of: ${[...CAPABILITY_RECORDS].join(', ')}` }, 400);
        if (op === 'record.get') {
          const r = await this.vaultFor(grant).read<unknown>({ owner: '', resource: recordType });
          return json({ ok: true, record: r?.data ?? null });
        }
        if (body.record === undefined) return json({ error: 'record required' }, 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.record.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'record', id: recordType } });
        await this.writeDoc(grant, recordType, body.record);
        return json({ ok: true });
      }

      return json({ error: `unknown op: ${op}` }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }
}
