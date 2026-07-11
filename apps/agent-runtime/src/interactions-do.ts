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
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import {
  appendBoardPost,
  createBoardChannel,
  canonicalizeMessage,
  createVaultMessageBodyStore,
  isListingCurrent,
  messageBodyResource,
  sha256Hex32,
  validateDirectoryListing,
  type ChannelV1,
  type DirectoryListingV1,
  type MessageEnvelopeV1,
} from '@agenticprimitives/fabric/messaging';
import type { Vault } from '@agenticprimitives/vault';

import { verifyHomeSession } from './custody-oidc.js';
// Hoisted-function import from index.js — the documented safe cycle (see a2a-task-do.ts:38).
import { buildAuditSink, callMcpToolViaDelegation, type Env, type IncomingDelegation } from './index.js';

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] }] as const;

// The vault RECORD is 'channels.data' (spec 316 §11a / 322 §1) — `channels:<sa>` is only the Home's
// KV routing key (makeVaultDocKv), never the record name.
const CHANNELS_RESOURCE = (_principal: string): string => 'channels.data';
const DIRECTORY_RESOURCE = 'directory.data';

interface IndexedListing { listing: DirectoryListingV1; label: string }
interface StoredState {
  grant?: IncomingDelegation;
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // interactions/<principal>/<op>
    const principal = (parts[1] ?? '').toLowerCase();
    const op = parts[2] ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal)) return json({ error: 'bad principal' }, 400);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

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
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    if (op === 'status') {
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      return json({ ok: true, granted: !!st.grant });
    }

    // ── Skills — caller = broker-verified Home session (any principal kind). ──
    const gate = await verifyHomeSession(String(body.session ?? ''), this.env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const sessionSa = gate.sa;
    const sessionCaip = gate.caip;

    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    const grant = st.grant;
    if (!grant) return json({ error: 'no interactions grant — a steward must enable storage for this agent' }, 409);
    const audit = buildAuditSink(this.env);

    try {
      if (op === 'directory.publish') {
        const listing = body.listing as DirectoryListingV1 | undefined;
        if (!listing) return json({ error: 'listing required' }, 400);
        const errors = validateDirectoryListing(listing);
        if (errors.length > 0) return json({ error: `invalid listing: ${errors.join(', ')}` }, 400);
        if (listing.subject.toLowerCase() !== sessionCaip.toLowerCase()) return json({ error: 'listing subject must be the session principal' }, 403);
        const { proof, ...draft } = listing;
        const digest = await sha256Hex32(canonicalizeMessage(draft));
        if (!(await this.erc1271(sessionSa, digest as Hex, proof.signature as Hex))) return json({ error: 'listing signature failed ERC-1271 verification' }, 403);
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
        const board = await this.readDoc<ChannelV1[]>(grant, CHANNELS_RESOURCE(principal), []);
        const wire = board.map((c) => ({ ...c, messages: c.messages.map(({ envelope, authorName }) => ({ envelope, authorName })) }));
        const bodies: Record<string, string> = {};
        if (op === 'channels.read' && typeof body.channelId === 'string') {
          const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
          const channel = board.find((c) => c.descriptor.id === body.channelId);
          await Promise.all((channel?.messages ?? []).map(async (m) => {
            const normalized: MessageEnvelopeV1 = { ...m.envelope, body: { ...m.envelope.body, resource: messageBodyResource(m.envelope.id) } };
            try { bodies[m.envelope.id] = new TextDecoder().decode(await store.loadBody(normalized)); } catch { /* fail-closed omit */ }
          }));
        }
        return json({ ok: true, channels: wire, bodies, you: name ?? 'Steward', steward });
      }

      if (op === 'channels.create') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        const board = await this.readDoc<ChannelV1[]>(grant, CHANNELS_RESOURCE(principal), []);
        const r = createBoardChannel(board, { contextId: principal, owner: sessionCaip as ChannelV1['descriptor']['owner'], title: String(body.title ?? ''), createdBy: name ?? 'Steward' });
        if (!r.ok) return json({ error: r.error }, r.error.includes('already exists') ? 409 : 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.create', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: r.channel.descriptor.id } });
        await this.writeDoc(grant, CHANNELS_RESOURCE(principal), board);
        return json({ ok: true, channelId: r.channel.descriptor.id });
      }

      if (op === 'channels.post') {
        const name = await this.memberName(grant, principal, sessionCaip);
        if (!name) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403); // posting = listing members ONLY
        const board = await this.readDoc<ChannelV1[]>(grant, CHANNELS_RESOURCE(principal), []);
        const r = await appendBoardPost(board, { channelId: String(body.channelId ?? ''), from: sessionCaip as MessageEnvelopeV1['from'], authorName: name, bodyText: String(body.bodyText ?? '') });
        if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: r.envelope.createdAt, action: 'interactions.channels.post', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel-post', id: r.envelope.id } });
        const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
        await store.putBody({ messageId: r.envelope.id, bytes: new TextEncoder().encode(String(body.bodyText ?? '').trim()), contentType: 'text/plain', classification: 'internal' });
        await this.writeDoc(grant, CHANNELS_RESOURCE(principal), board);
        return json({ ok: true, messageId: r.envelope.id });
      }

      return json({ error: `unknown op: ${op}` }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }
}
