// Org-membership link projection (spec 318). The SOURCE OF TRUTH for membership is the person's own
// CURRENT self-signed directory listing in the org's community (ADR-0025 — their consent artifact,
// revocable). The `related:<person>:<org>` link with relationship:'member' is a PROJECTION of that
// listing — the index the workspace switcher + related-orgs read. This helper reconciles the
// projection from the truth (idempotent, absent-only, never downgrades a steward link), so a member
// whose link is missing (e.g. joined before the projection existed) self-heals on the next
// channels read. Reconciling a projection from its source is not a fallback mechanism (ADR-0013).
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

interface KvLike {
  get(k: string): Promise<string | null>;
  put(k: string, v: string): Promise<void>;
  delete(k: string): Promise<void>;
}

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Upsert the authority-only member link for `person` in org `communityId` (absent-only — an existing
 *  link of ANY relationship is left untouched). No-op for non-address communities or self. */
export async function ensureOrgMemberLink(
  env: { AUTH_CODES: KvLike; RPC_URL?: string },
  person: string,
  communityId: string,
): Promise<void> {
  const p = person.toLowerCase();
  const org = communityId.toLowerCase();
  if (!isAddress(org) || org === p) return;
  const linkKey = `related:${p}:${org}`;
  if (await env.AUTH_CODES.get(linkKey)) return; // steward or member link already present — never touch
  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const orgName = await naming.reverseResolve(org as Address).catch(() => null);
  await env.AUTH_CODES.put(linkKey, JSON.stringify({
    orgAgent: org,
    orgName: orgName ?? org,
    purpose: 'channel membership',
    requestedBy: 'home-channels',
    siteDelegation: null,
    proofHash: null,
    createdAt: Date.now(),
    kind: 'org',
    parent: p,
    relationship: 'member',
  }));
  const idxKey = `related-idx:${p}`;
  const idx = JSON.parse((await env.AUTH_CODES.get(idxKey)) ?? '[]') as string[];
  if (!idx.some((a) => a.toLowerCase() === org)) {
    await env.AUTH_CODES.put(idxKey, JSON.stringify([...idx, org]));
  }
}

/** Remove the member link when the person leaves (listing revoked). NEVER deletes a steward link —
 *  custody is not granted or revoked here. */
export async function removeOrgMemberLink(
  env: { AUTH_CODES: KvLike },
  person: string,
  communityId: string,
): Promise<void> {
  const p = person.toLowerCase();
  const org = communityId.toLowerCase();
  if (!isAddress(org)) return;
  const linkKey = `related:${p}:${org}`;
  const raw = await env.AUTH_CODES.get(linkKey);
  const link = raw ? (JSON.parse(raw) as { relationship?: string }) : null;
  if (link?.relationship !== 'member') return;
  await env.AUTH_CODES.delete(linkKey);
  const idxKey = `related-idx:${p}`;
  const idx = JSON.parse((await env.AUTH_CODES.get(idxKey)) ?? '[]') as string[];
  await env.AUTH_CODES.put(idxKey, JSON.stringify(idx.filter((a) => a.toLowerCase() !== org)));
}
