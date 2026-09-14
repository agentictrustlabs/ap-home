// THE MISSION REGISTRY ENROLMENT — an org-create that ends with the organization LISTED in a relying app's
// kit-built registry (spec 279 / spec 346 §7), run at the steward's Home because every act in it is custodial.
//
// A card room (Game Night, `docs/MISSION-REGISTRY.md` in its repo) keeps a registry of mission organizations
// that a game may invite as its guest: `urn:ap:registry:gamenight-missions` on this chain's AgentRegistryBase,
// controlled by the card room's registry operator agent, OPEN — the subject registers itself (RB-01) and the
// operator admits off-chain from what the chain and the vault say. The app sends the person here with
// `delegation_template=org-create&org_purpose=mission&registry_entry=<base64url JSON>`; after the org is chosen
// or created, this module:
//
//   1. composes the PRESENCE (name, blurb, website, languages, place) as the org's own record;
//   2. has the steward SIGN THE COVENANT — three clauses, bound to the org and the registry — with the same
//      credential that custodies their Home (an EIP-191 message their Smart Agent's ERC-1271 answers for);
//   3. writes presence, covenant and the confidential contact into the ORG'S vault under the stewardship wire;
//   4. registers the entry ON CHAIN as the org (the org's account executes `registerEntry`, so msg.sender is
//      the subject), carrying the card hash, the binding-proof hash and the two claim hashes; an org already
//      listed is RENEWED and its card re-pointed instead;
//   5. hands the whole thing back on the `org` payload the relying app receives at `/token`, so the operator
//      can verify every hash against the chain and receipt the admission.
//
// Hashes are sha256 over sorted-key canonical JSON (`canonicalizeJson` — the kit's), which is what lets the card
// room, holding only the kit, recompute them; nothing here is app-specific beyond the registry id the client's
// curated entry names.
import { buildRegisterEntryCall, buildRenewEntryCall, buildUpdateEntryCall, hashBindingProofBody, urnToBytes32, type RegistryEntryId, type RegistryId, type Sha256 } from '@agenticprimitives/registry-kit';
import { canonicalizeJson, type Address, type Hex } from '@agenticprimitives/types';
import { createPublicClient, hashMessage, http } from 'viem';
import { executeCalls, type SignHash } from '../connect-client';
import { CHAIN, CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from './chain';
import { vaultWriteWithDelegation } from './vault-client';
import type { DelegationWire } from './delegation';

export interface MissionRegistryConfig {
  /** `urn:ap:registry:<name>` — the registry this client's missions list into. */
  registryId: string;
}

/** What the app sends: the presence WITHOUT the org (chosen here) and the affirmed clauses. Confidential
 *  `contact` never leaves the org's vault. */
export interface MissionEntryRequest {
  presence: { name: string; blurb: string; website: string; languages: string[]; place: { label: string; country: string; lat: number; lng: number; precise: boolean } };
  clauseIds: string[];
  contact: string;
}

/** The three clauses, verbatim — the message the steward signs is composed from these, so both ends must agree. */
export const MISSION_COVENANT_VERSION = 'gamenight-missions-v1';
export const MISSION_COVENANT_CLAUSES: readonly { id: string; text: string }[] = [
  { id: 'genuine', text: 'This is a genuine mission organization and I am authorised to act for it.' },
  { id: 'use-limitation', text: 'People who reach us through a game night are contacted only about that night and about what we told them we do — no list-building, no onward sharing, no marketing.' },
  { id: 'safety', text: 'Publishing where we are does not endanger anyone who works with us or comes to us.' },
];

/** `registry_entry` is base64url JSON, capped — a presence is under two kilobytes. */
export function parseRegistryEntry(param: string | undefined | null): MissionEntryRequest | null {
  if (!param || param.length > 12_000) return null;
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(param.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const r = JSON.parse(json) as MissionEntryRequest;
    const p = r?.presence;
    if (!p || typeof p.name !== 'string' || typeof p.blurb !== 'string' || typeof p.website !== 'string' || !Array.isArray(p.languages) || !p.place) return null;
    if (typeof p.place.label !== 'string' || typeof p.place.country !== 'string' || typeof p.place.lat !== 'number' || typeof p.place.lng !== 'number' || typeof p.place.precise !== 'boolean') return null;
    if (!Array.isArray(r.clauseIds) || !MISSION_COVENANT_CLAUSES.every((c) => r.clauseIds.includes(c.id))) return null;
    if (typeof r.contact !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.contact)) return null;
    return { presence: { name: p.name, blurb: p.blurb, website: p.website, languages: p.languages.filter((l) => typeof l === 'string'), place: { label: p.place.label, country: p.place.country, lat: p.place.lat, lng: p.place.lng, precise: p.place.precise } }, clauseIds: r.clauseIds, contact: r.contact };
  } catch {
    return null;
  }
}

export function covenantMessage(a: { version: string; registryId: string; org: string; steward: string; clauseIds: string[]; signedAt: string }): string {
  const clauses = MISSION_COVENANT_CLAUSES.filter((c) => a.clauseIds.includes(c.id)).map((c, i) => `${i + 1}. ${c.text}`);
  return ['Game Night mission covenant', ...clauses, '', `covenant: ${a.version}`, `registry: ${a.registryId}`, `organization: ${a.org}`, `affirmed by: ${a.steward}`, `at: ${a.signedAt}`].join('\n');
}

async function sha256Of(text: string): Promise<Sha256> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const ENTRY_TTL_SECONDS = 365 * 86_400;
const REGISTRY_VIEW_ABI = [
  { type: 'function', name: 'getEntry', stateMutability: 'view', inputs: [{ name: 'registryId', type: 'bytes32' }, { name: 'entryId', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'subjectAgent', type: 'address' }, { name: 'cardHash', type: 'bytes32' }, { name: 'bindingProofHash', type: 'bytes32' }, { name: 'claimsRoot', type: 'bytes32' }, { name: 'status', type: 'uint8' }, { name: 'registeredAtBucket', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' }] }] },
] as const;

/** What goes back to the app on `org.registry`, and what the operator verifies against the chain. */
export interface MissionRegistryOutcome {
  registryId: string;
  entryId: string;
  org: Address;
  steward: Address;
  presence: Record<string, unknown>;
  covenant: Record<string, unknown>;
  cardHash: Sha256;
  bindingProofHash: Sha256;
  claimHashes: Sha256[];
  issuedAt: string;
  expiresAt: number;
  txHash?: Hex;
  /** `registered` — a new entry; `renewed` — an existing one re-pointed at the new card and extended. */
  act: 'registered' | 'renewed';
  /** CONFIDENTIAL — the operators' contact, handed to the relying app's server on `/token` (never a public
   *  read) beside its copy in the org's vault. */
  contact: string;
}

export async function enrolMission(input: {
  config: MissionRegistryConfig;
  request: MissionEntryRequest;
  org: Address;
  steward: Address;
  /** Signs as the STEWARD (the covenant) — their own custody. */
  signAsSteward: SignHash;
  /** Signs as the ORG (the chain entry) — the org's custody, which the person holds for an org they created here. */
  signAsOrg: SignHash;
  /** The org→person stewardship wire the org-create produced: how the org's vault is written. */
  stewardship?: DelegationWire;
  onStep?: (label: string) => void;
}): Promise<{ ok: true; registry: MissionRegistryOutcome } | { ok: false; error: string }> {
  const { config, request } = input;
  const registryId = config.registryId as RegistryId;
  if (!/^urn:ap:registry:[a-z0-9-]+$/.test(registryId)) return { ok: false, error: 'this app names no registry to list into' };
  const registryAddress = CONTRACTS.agentRegistryBase as Address | undefined;
  if (!registryAddress) return { ok: false, error: 'this chain has no AgentRegistryBase deployed' };
  const org = input.org.toLowerCase() as Address;
  const steward = input.steward.toLowerCase() as Address;
  const now = new Date();
  const issuedAt = now.toISOString();
  const entryId = `urn:ap:registry-entry:${registryId.slice('urn:ap:registry:'.length)}/${org}` as RegistryEntryId;

  // 1. The presence — the org's own record, stamped now.
  const presence = { type: 'MissionPresenceV1', org, ...request.presence, updatedAt: issuedAt };
  const card = { type: 'organization', displayName: presence.name, description: presence.blurb, url: presence.website };
  const cardHash = await sha256Of(canonicalizeJson(card));
  const presenceHash = await sha256Of(canonicalizeJson(presence));

  // 2. The covenant, signed by the steward. EIP-191 over the readable message; the org's registry operator
  //    verifies it against the steward's Smart Agent (ERC-1271), never against a bare key.
  input.onStep?.('Affirming the mission covenant — you sign it…');
  const unsigned = { version: MISSION_COVENANT_VERSION, registryId, org, steward, clauseIds: [...request.clauseIds], signedAt: issuedAt };
  const signature = await input.signAsSteward(hashMessage(covenantMessage(unsigned)));
  if (!signature || signature === '0x') return { ok: false, error: 'the covenant was not signed' };
  const covenant = { type: 'MissionCovenantAttestationV1', ...unsigned, signature };
  const covenantHash = await sha256Of(canonicalizeJson(covenant));
  const claimHashes: Sha256[] = [covenantHash, presenceHash];

  // 3. The org's own records. The contact is confidential and lives ONLY here (and at the operator's desk).
  if (input.stewardship) {
    input.onStep?.('Keeping the mission’s records at its own vault…');
    try {
      await vaultWriteWithDelegation(input.stewardship, 'cardroom.mission.presence', presence);
      await vaultWriteWithDelegation(input.stewardship, 'cardroom.mission.covenant', covenant);
      await vaultWriteWithDelegation(input.stewardship, 'cardroom.mission.contact', { type: 'MissionContactV1', org, email: request.contact, updatedAt: issuedAt });
    } catch (e) {
      console.warn('[mission-registry] the org’s vault did not keep the records:', e);
    }
  }

  // 4. The chain. Register, or renew + re-point when the org is already listed.
  input.onStep?.('Listing the mission in the registry — the organization signs…');
  const bindingProofHash = await hashBindingProofBody({ registryId, entryId, subjectAgent: org, cardHash, claimHashes, issuedAt, chainId: CHAIN_ID, registryAddress });
  const expiresAt = Math.floor(now.getTime() / 1000) + ENTRY_TTL_SECONDS;
  let listed = false;
  try {
    const pc = createPublicClient({ chain: CHAIN, transport: http(DEFAULT_RPC_URL) });
    const e = await pc.readContract({ address: registryAddress, abi: REGISTRY_VIEW_ABI, functionName: 'getEntry', args: [urnToBytes32(registryId), urnToBytes32(entryId)] });
    listed = Number(e.status) === 1; // Active — anything else registers afresh or fails on chain, which is the honest answer
  } catch { /* not listed */ }
  const calls = listed
    ? [
        buildUpdateEntryCall({ registry: registryAddress, registryId, entryId, cardHash, bindingProofHash, claimHashes }),
        buildRenewEntryCall({ registry: registryAddress, registryId, entryId, expiresAt }),
      ]
    : [buildRegisterEntryCall({ registry: registryAddress, registryId, entryId, subjectAgent: org, cardHash, bindingProofHash, claimHashes, expiresAt })];
  const res = await executeCalls(org, input.signAsOrg, calls);
  if (!res.ok) return { ok: false, error: `the registry entry was not recorded on chain — ${res.error}` };

  return {
    ok: true,
    registry: { registryId, entryId, org, steward, presence, covenant, cardHash, bindingProofHash, claimHashes, issuedAt, expiresAt, ...(res.txHash ? { txHash: res.txHash } : {}), act: listed ? 'renewed' : 'registered', contact: request.contact },
  };
}
