// Relying-site delegation issuance (ADR-0019). The central auth (this origin), with the
// person's ROOT passkey, issues a caveated, redeemer-bound ERC-7710 delegation from the
// person SA to the relying site's DELEGATE smart account. The site is a delegate, never a
// custodian of the person SA. Signed off-chain (EIP-712 `hashDelegation`) by the ROOT
// passkey via the same WebAuthn path that signs UserOps; the SA's ERC-1271 validates it at
// redemption. No new contracts — DelegationManager + enforcers are deployed.
import {
  type Delegation,
  type Caveat,
  buildCaveat,
  encodeTimestampTerms,
  encodeAllowedTargetsTerms,
  encodeValueTerms,
  buildPaymentMandateCaveats,
  buildVaultKeyUseCaveat,
  buildVaultRecordScopeCaveat,
  hashDelegation,
  buildSessionDelegation,
  ROOT_AUTHORITY,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';

type SignHash = (hash: Hex) => Promise<Hex>;

/** Wire form of a Delegation (bigint salt → string) for transport over postMessage / URL. */
export interface DelegationWire {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: string;
  signature: Hex;
}
export const toWire = (d: Delegation): DelegationWire => ({ ...d, salt: d.salt.toString() });

/** Least-privilege caveats for a relying site: time-boxed, value 0, scoped to the on-chain
 *  targets a relying site needs to act on the person's behalf (naming + relationship). */
function siteCaveats(validUntil: number): Caveat[] {
  return [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
    buildCaveat(
      CONTRACTS.allowedTargetsEnforcer,
      encodeAllowedTargetsTerms([
        CONTRACTS.agentRelationship,
        CONTRACTS.agentNameRegistry,
        CONTRACTS.permissionlessSubregistry,
      ]),
    ),
  ];
}

/** spec 253 — the approved-hash sentinel signature. A delegation carrying this 1-byte wire
 *  signature is NOT signed off-chain; instead its delegator SA pre-approved the EIP-712 digest
 *  in the ApprovedHashRegistry (inside the delegator's own userOp), and the SA's ERC-1271
 *  `isValidSignature` honors it via the `0x03` branch. Lets an org batch all of its outbound
 *  grants' approvals into one deploy userOp — one passkey instead of one-per-grant. */
export const APPROVED_HASH_SENTINEL: Hex = '0x03';

/** Build the unsigned delegation struct (shared by the signed + approved-hash variants). */
function buildSiteDelegation(delegator: Address, delegateSA: Address, validitySeconds: number): Delegation {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return {
    delegator,
    delegate: delegateSA,
    authority: ROOT_AUTHORITY,
    caveats: siteCaveats(validUntil),
    salt,
    signature: '0x',
  };
}

/** Issue `personAgent → delegateSA` with the default site caveats, signed by the ROOT
 *  credential (`signHash`). `delegate` is the relying site's delegate SA so redemption is
 *  bound to that account (DelegationManager requires `delegate == msg.sender`). */
export async function issueSiteDelegation(
  personAgent: Address,
  delegateSA: Address,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const d = buildSiteDelegation(personAgent, delegateSA, validitySeconds);
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // ROOT passkey signs the EIP-712 delegation digest
  return d;
}

/** Issue `delegator → delegateSA` with CALLER-SUPPLIED caveats, signed by `signHash` (spec 283/284
 *  connect-treasury AUTHORIZE step — a scoped, monotonic host grant). Unlike issueSiteDelegation the
 *  caveats are explicit (e.g. lowered from a TreasuryAuthorityScope via connect-treasury.scopeToHostCaveats). */
export async function issueScopedDelegation(
  delegator: Address,
  delegateSA: Address,
  caveats: Caveat[],
  signHash: SignHash,
): Promise<Delegation> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = { delegator, delegate: delegateSA, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest);
  return d;
}

/** spec 253 — build a `delegator → delegateSA` site delegation WITHOUT an off-chain signature.
 *  Returns the delegation (wire signature = the `0x03` sentinel) plus its EIP-712 `digest`, so
 *  the caller batches `approvedHashRegistry.approveHash(digest)` into the DELEGATOR's own userOp.
 *  The digest excludes the signature field, so it is identical to what the relayer + on-chain
 *  redeem recompute. The delegator MUST be the account whose userOp runs the `approveHash`
 *  (i.e. the org being deployed) — only the org can approve hashes under its own address. */
export function buildApprovedSiteDelegation(
  delegator: Address,
  delegateSA: Address,
  validitySeconds = 60 * 60 * 24 * 365,
): { delegation: Delegation; digest: Hex } {
  const d = buildSiteDelegation(delegator, delegateSA, validitySeconds);
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = APPROVED_HASH_SENTINEL; // validated via the SA's approved-hash ERC-1271 branch
  return { delegation: d, digest };
}

// ─── spec 278 P5 — vault-key authorization (person SA → demo-mcp) ──────────────────────────────

export interface VaultKeyCeremonyParams {
  vaultId: string;
  /** The person's KEK resource name (provisioned by the operator via spec 276 ap-provision-gcp). */
  kmsKeyRef: string;
  /** demo-mcp's authorized delegate key (the binding's allowedServerId surface). */
  serverKey: Address;
  allowedResources: string[];
  classificationCeiling: string;
  ops: ('read' | 'write')[];
  validitySeconds?: number;
}

/** Build the unsigned `VaultKeyAuthorization` (person SA → demo-mcp, one non-subdelegable
 *  VAULT_KEY_USE caveat) + its EIP-712 digest + the binding `expiresAt`. The person's ROOT
 *  credential signs `digest`; the signed delegation is POSTed to /custody/vault-key/bind
 *  (spec 278 §3.3). Mirrors `issueSiteDelegation`'s build → hash → sign shape. */
export function buildVaultKeyAuthorization(
  owner: Address,
  p: VaultKeyCeremonyParams,
): { delegation: Delegation; digest: Hex; expiresAt: string } {
  const validUntil = Math.floor(Date.now() / 1000) + (p.validitySeconds ?? 60 * 60 * 24 * 90);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveat = buildVaultKeyUseCaveat({
    vaultId: p.vaultId,
    kmsKeyRef: p.kmsKeyRef,
    resources: p.allowedResources,
    classificationCeiling: p.classificationCeiling,
    ops: p.ops,
    noSubdelegation: true,
  });
  const d: Delegation = {
    delegator: owner,
    delegate: p.serverKey,
    authority: ROOT_AUTHORITY,
    caveats: [caveat],
    salt,
    signature: '0x',
  };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  return { delegation: d, digest, expiresAt: new Date(validUntil * 1000).toISOString() };
}

// ─── spec 317 W2a — the standing inbox-delivery delegation (record-scoped) ────────────────────

/** The vault resource scope an inbox-delivery delegate may write: message bodies ONLY. Mirrors
 *  demo-mcp's `resource = vault:<recordType>` (VAULT_RECORD_PREFIX) over fabric's `message.body:<id>`
 *  record type (`@agenticprimitives/fabric` `MESSAGE_BODY_RECORD_TYPE`) — kept as a local literal so
 *  this transport-agnostic module takes no fabric dependency. demo-mcp enforces the match (spec 317
 *  §3.2), intersected deny-by-default with the recipient's vault-key binding. */
export const INBOX_DELIVERY_RESOURCE_SCOPE = 'vault:message.body:*' as const;

/** The vault record that holds the owner's inbox document itself (`InboxDataV1` — envelopes + events +
 *  cases). spec 316 §11a cutover: the inbox is now vault-resident (not the Home's KV), so the standing
 *  inbox-delivery grant must also authorize read+write of THIS record — the a2a `messaging.deliver` skill
 *  appends to it (delivery) and the owner's Home reads/mutates it (render, archive, send). One record, one
 *  grant. demo-mcp record-scope-gates it exactly as it does the body records. */
export const INBOX_DATA_RESOURCE_SCOPE = 'vault:inbox.data' as const;


/** The vault record family that holds an ORG's invite tracking (`org.invite:<token>` — invitee email
 *  hash + status). Blast-zone (spec 315): invitee PII lives ENCRYPTED in the org vault, not KV; KV holds
 *  only a random-token→public-org pointer. Read+write over the org's steward-signed grant. */
export const ORG_INVITE_RESOURCE_SCOPE = 'vault:org.invite:*' as const;

/**
 * spec 317 §3.2 — issue the standing inbox-delivery delegation `recipient → deliveryServiceSA`,
 * signed once at onboarding by the recipient's ROOT credential (`signHash`). A `VAULT_RECORD_SCOPE`
 * caveat scopes the delegate to `INBOX_DELIVERY_RESOURCE_SCOPE` with op `write` ONLY — NO read, NO
 * list, NO delete (tombstone), per the security audit (F1): the delivery service can create/update
 * inbound message bodies and NOTHING else. demo-mcp decodes + enforces it (deny-by-default) AND-ed with
 * the recipient's vault-key binding, so it can act as the recipient for message bodies and nothing else
 * (least-privilege, ADR-0025). The delegate is a
 * DISTINCT delivery-service SA (never the vault-key `serverKey`), so its authority IS exactly this
 * grant. Stored server-side; the delivery service presents it at delivery to mint a `sub = recipient`
 * token (client-mint, delegate-signed — never `DEMO_ALLOW_SERVER_MINT`). Web3 is the authority
 * (ADR-0041); revoking this delegation stops inbound body writes at the substrate, fail-closed.
 *
 * `mcpServerId` is the demo-mcp server identifier the `DataScopeGrant.server` field binds (the scope
 * applies at that resource server); demo-mcp matches its own id before honoring the grant.
 */
export async function issueInboxDeliveryDelegation(
  recipient: Address,
  deliveryServiceSA: Address,
  mcpServerId: string,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveats: Caveat[] = [
    // TESTNET POSTURE (spec 317 §5.1): read+write. The audit's write-only ideal (F1) requires a SEPARATE
    // owner read-delegation for `readInboxView` (the owner reading their OWN bodies); until that is provisioned,
    // spec 322 W3f — the delivery plane is WRITE-ONLY on the mail records: it can append a body and
    // the a2a skill can hand the envelope to the recipient's InteractionsDO, but it can NO LONGER
    // read anyone's inbox or dm bodies (closes the "delivery service reads your mail" testnet hole).
    // Reads ride the interactions grant through the DO. Invite tracking keeps read+write (the org's
    // steward surfaces look invites up by record).
    buildVaultRecordScopeCaveat([
      { server: mcpServerId, resources: [DM_BODIES_RESOURCE_SCOPE, INBOX_DATA_RESOURCE_SCOPE], ops: ['write'] },
      { server: mcpServerId, resources: [ORG_INVITE_RESOURCE_SCOPE], ops: ['read', 'write'] },
    ]),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: recipient, delegate: deliveryServiceSA, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // recipient's ROOT credential authorizes the delivery service
  return d;
}

/** The vault record holding a member's SHAREABLE profile card — what an org they joined may read
 *  (spec 321): display info the member chose to share, never the whole vault. */
export const MEMBER_PROFILE_RESOURCE_SCOPE = 'vault:member.profile' as const;

/** The membership directory record (spec 322 W2/W3 — the DO-managed vault residency). */
export const DIRECTORY_DATA_RESOURCE_SCOPE = 'vault:directory.data' as const;
/** Conversation/topic split (spec 324 §10 — renamed from board.* in the W6 key migration): the org's
 *  conversation descriptor index + per-topic docs + topic-namespace bodies. */
export const CONVERSATION_INDEX_RESOURCE_SCOPE = 'vault:conversation.index' as const;
export const CONVERSATION_TOPIC_RESOURCE_SCOPE = 'vault:conversation.topic:*' as const;
export const TOPIC_BODIES_RESOURCE_SCOPE = 'vault:message.body:topic:*' as const;
/** 1-1 (DM) bodies — the DELIVERY plane's namespace; disjoint from channel bodies (FAB-SSO-2). */
export const DM_BODIES_RESOURCE_SCOPE = 'vault:message.body:dm:*' as const;
/** The person's AUTHORITATIVE org-relationship doc (spec 322 W3d) — Home `related:*` KV is a cache. */
export const RELATIONSHIPS_DATA_RESOURCE_SCOPE = 'vault:relationships.data' as const;
/** All per-org member profiles (`member.profile:<orgSA>`) — the person DO writes them per org. */
export const MEMBER_PROFILE_WILDCARD_SCOPE = 'vault:member.profile:*' as const;
/** spec 323 W2 — owner-own capability records reached self-only over the interactions grant: the
 *  person's community profile (V-1 remediation — delegation-authorized, replaces the bearer path),
 *  their private skills tier, and their home manifest master. */
export const IMPACT_PROFILE_RESOURCE_SCOPE = 'vault:impact-profile' as const;
export const SKILLS_DATA_RESOURCE_SCOPE = 'vault:skills.data' as const;
export const HOME_MANIFEST_RESOURCE_SCOPE = 'vault:home.manifest' as const;
/** The person's portable control-plane timeline (spec 323 W2.3) — append via bridge, read self. */
export const CONTROL_EVENTS_RESOURCE_SCOPE = 'vault:control-events.data' as const;
/** spec 324 W3 — the authoritative OrganizationMembership records (`org.membership:<orgSA>`): the party's
 *  own membership Situation + credential per org, written self-only through the InteractionsDO. Membership is
 *  the source of truth (ADR-0048 #3) — distinct from the delegations/listings that project it. */
export const ORG_MEMBERSHIP_WILDCARD_SCOPE = 'vault:org.membership:*' as const;

/** spec 324 §7 Tier-2 — the org's pending MembershipApplications doc (`org.applications`), read by the steward
 *  + appended by applicants, both via the Home over the interactions grant. A plain org-vault doc (not inbox). */
export const ORG_APPLICATIONS_RESOURCE_SCOPE = 'vault:org.applications' as const;

/**
 * spec 322 §2 plane B — the INTERACTIONS grant `principal → INTERACTIONS_SERVICE_SA`, signed once
 * by the steward's credential AS the principal at the enable ceremony. Exercised only by the
 * principal's InteractionsDO (the serialized execution point); scoped to the interaction records
 * (board + bodies + inbox + directory), read+write. The wire lives WITH its delegate service (the
 * DO's storage) — never in app KV, never readable by member/app scopes (a stored wire is a bearer
 * secret under server-mint; spec 322 §2).
 */
export async function issueInteractionsDelegation(
  principal: Address,
  interactionsServiceSA: Address,
  mcpServerId: string,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([
      { server: mcpServerId, resources: [CONVERSATION_INDEX_RESOURCE_SCOPE, CONVERSATION_TOPIC_RESOURCE_SCOPE, TOPIC_BODIES_RESOURCE_SCOPE, INBOX_DATA_RESOURCE_SCOPE, DIRECTORY_DATA_RESOURCE_SCOPE, RELATIONSHIPS_DATA_RESOURCE_SCOPE, MEMBER_PROFILE_WILDCARD_SCOPE, ORG_MEMBERSHIP_WILDCARD_SCOPE, ORG_APPLICATIONS_RESOURCE_SCOPE, IMPACT_PROFILE_RESOURCE_SCOPE, SKILLS_DATA_RESOURCE_SCOPE, HOME_MANIFEST_RESOURCE_SCOPE, CONTROL_EVENTS_RESOURCE_SCOPE], ops: ['read', 'write'] },
      // spec 322 W3f — dm bodies are READ-only here: the DO serves the owner's mail reads, while
      // only the (write-only) delivery plane may create them. Planes stay disjoint on writes.
      { server: mcpServerId, resources: [DM_BODIES_RESOURCE_SCOPE], ops: ['read'] },
    ]),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: principal, delegate: interactionsServiceSA, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // the steward's credential authorizes the execution point
  return d;
}

/** The org's managed profile record (`org:profile` — what OrgDetail's steward edits): the org
 *  information a MEMBER may read over their member-access grant (spec 321 W2). */
export const ORG_PROFILE_RESOURCE_SCOPE = 'vault:org.profile' as const; // spec 322 W3 rename

/**
 * spec 321 W2 — the member-access delegation `org → member`, signed by the ORG's custody (the
 * steward's credential) at INVITE time. The delegate is the invitee's person SA — their actual SA
 * for an in-network invite, or the COUNTERFACTUAL email-bootstrap home address for an email invite
 * (the same derivation redeem performs, so the grant activates only if that exact home deploys;
 * against any other account it is inert — fail-closed, no re-targeting). Read-only over the org's
 * shareable profile record; time-boxed; on-chain revocable.
 */
export async function issueOrganizationResourceAccessDelegation(
  orgSA: Address,
  member: Address,
  mcpServerId: string,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: mcpServerId, resources: [ORG_PROFILE_RESOURCE_SCOPE], ops: ['read'] }]),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: orgSA, delegate: member, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // the org's custody (the steward's credential) grants member access
  return d;
}

/**
 * spec 321 W1 — the membership delegation `member → org`, signed by the member's connection
 * custodian at invite ACCEPT (spec 246's deferred person→org leg). Read-only over the member's
 * shareable profile record (`vault:member.profile`) — the org can render its member roster from
 * each member's own vault (spec 247: it holds a delegation, never a copy) and NOTHING else.
 * Time-boxed, value 0, on-chain revocable.
 */
export async function issueMemberProfileAccessDelegation(
  member: Address,
  orgSA: Address,
  mcpServerId: string,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveats: Caveat[] = [
    // Per-org record (spec 322 W3d): the org reads ONLY the profile card the member keyed to IT.
    buildVaultRecordScopeCaveat([{ server: mcpServerId, resources: [`${MEMBER_PROFILE_RESOURCE_SCOPE}:${orgSA.toLowerCase()}`], ops: ['read'] }]),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: member, delegate: orgSA, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // the member's connection custodian consents to org membership
  return d;
}

// ─── spec 272/243 — x402 payment delegation (treasury → treasury) ─────────────────────────────

/** DelegationManager sentinel: delegate = 0xa11 ⇒ ANY redeemer may redeem (the PaymentEnforcer still
 *  fully gates every charge — payee-bound, capped, transfer-only). Use this for x402 PUSH payments
 *  where the PAYER (reader) drives the redemption at access time; the funds still move treasury →
 *  treasury (payer-treasury → the caveat's payee). For PULL payments (subscriptions, metered post-pay)
 *  pass `delegate = the payee treasury` instead, so the provider redeems on its own schedule. */
export const OPEN_DELEGATION = '0x0000000000000000000000000000000000000a11' as Address;

/** Issue an x402 payment delegation from the person's TREASURY SA. The custodian never appears: the
 *  person's treasury is custodied by the SAME ROOT credential as the person SA (MAM-D2), so `signHash`
 *  — the same passkey/wallet/social signer used for the site delegation — authorizes it; the treasury's
 *  ERC-1271 validates it at redemption. Signed ONCE at connect, stored in a vault, redeemed many times
 *  within the caveats (no held key, no per-charge signature). USDC always lands at `payee`.
 *
 *  `delegate`: OPEN_DELEGATION for x402 push (the reader redeems) | a payee treasury for pull/subscription. */
export async function issuePaymentDelegation(
  payerTreasury: Address,
  delegate: Address,
  payee: Address,
  signHash: SignHash,
  opts: {
    asset: Address;
    maxAmountPerCharge: bigint;
    maxAggregate: bigint;
    maxRedemptionsPerWindow?: number;
    windowSeconds?: number;
    validitySeconds?: number;
  },
): Promise<Delegation> {
  const validUntil = Math.floor(Date.now() / 1000) + (opts.validitySeconds ?? 60 * 60 * 24 * 365);
  const caveats = buildPaymentMandateCaveats({
    enforcers: {
      payment: CONTRACTS.paymentEnforcer,
      timestamp: CONTRACTS.timestampEnforcer,
      allowedTargets: CONTRACTS.allowedTargetsEnforcer,
      allowedMethods: CONTRACTS.allowedMethodsEnforcer,
    },
    payee,
    asset: opts.asset,
    maxAmountPerCharge: opts.maxAmountPerCharge,
    maxAggregate: opts.maxAggregate,
    maxRedemptionsPerWindow: opts.maxRedemptionsPerWindow ?? 1000,
    windowSeconds: opts.windowSeconds ?? 3600,
    validUntil,
  });
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = {
    delegator: payerTreasury,
    delegate,
    authority: ROOT_AUTHORITY,
    caveats,
    salt,
    signature: '0x',
  };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // SAME root credential that signs the site delegation
  return d;
}

// ─── spec 270 v4 W2 — the DEL-001 session-delegation leaf (the connect-ceremony emission) ─────

// The session keypair is generated by the RELYING APP (it holds the private key on its own origin);
// the home only receives the public `sessionKeyAddress` and signs the leaf below. The home therefore
// never mints or holds a session private key (no cross-origin key transport — spec 270 v4 secure design).

/** Issue the DEL-001 session-delegation leaf `personAgent → sessionKey`, signed by the SAME ROOT
 *  credential (`signHash`) that signs the site delegation at connect. Bound to the person SA (the
 *  canonical identity), so it works for whatever credential the member connected with (passkey / wallet /
 *  Google-KMS); the verifier validates it via the UniversalSignatureValidator (spec 270 W1). The relying
 *  app holds the session key + this leaf, signs tokens with the key, and presents the chain. */
export async function issueSessionDelegation(
  personAgent: Address,
  sessionKeyAddress: Address,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 12, // 12h session
): Promise<Delegation> {
  const { leaf, digest } = buildSessionDelegation({
    delegator: personAgent,
    sessionKeyAddress,
    validUntil: Math.floor(Date.now() / 1000) + validitySeconds,
    enforcers: { timestamp: CONTRACTS.timestampEnforcer, value: CONTRACTS.valueEnforcer },
    chainId: CHAIN_ID,
    delegationManager: CONTRACTS.delegationManager,
  });
  leaf.signature = await signHash(digest); // the ROOT credential authorizes the session key
  return leaf;
}
