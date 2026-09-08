// White-label config schema (spec 234 §5/§11). The ONE place a deployment's
// identity, copy, and enabled surfaces live — consumed by the generic Experience
// Layer. Vertical/faith content belongs HERE (app level), never in packages
// (ADR-0021). Build-time only for now; a runtime/on-chain adapter is W4.
//
// All fields are plain data so a future runtime config can serialize them. Copy
// strings may contain {name} / {app} tokens, interpolated by `fmt` (config.ts).

/** A relying app registered with this trust site (the OIDC client registry, configured). */
export interface RelyingApp {
  client_id: string;
  /** Exact-match redirect URIs (no substring/prefix — CN-1). */
  redirect_uris: string[];
  allowed_scopes: string[];
  /** Delegation caveat templates this client may request (the template fixes the caveats). */
  allowed_delegation_templates: string[];
  /** OPTIONAL — the app's dedicated service SA for OPERATIONAL INTENT grants (org → agent). When set,
   *  org-create also mints that grant so the app can submit endeavor intents to the org's A2A endpoint
   *  directly instead of proxying through Home. MUST NOT be `delegate`: that address is shared by
   *  several registry entries, and operational authority granted to it is granted to all of them. */
  operational_delegate?: string;
  /** OPTIONAL — a scoped `org → app workspace agent` VAULT READ grant, minted at the org-connect
   *  ceremony (create AND select-existing) alongside the operational-intent grant. For apps whose
   *  workspace agent reads ONE record family from each member org's vault in place (a grant, never
   *  a copy — e.g. Gather27's `vault:gather27:listing`). Minted at the ceremony because that is the
   *  only moment every custody family (KMS / passkey / wallet / demo) can sign as the org — a
   *  relying app never holds the org's key, and persona-sign covers demo accounts only.
   *  `delegate` MUST be the app's dedicated workspace/service SA, never the shared registry
   *  `delegate` (same reasoning as `operational_delegate`). */
  org_read_grant?: {
    delegate: `0x${string}`;
    server: string;
    resources: string[];
  };
  /** OPTIONAL — spec 345. A `delegator = delegate = personSA` grant scoped to the person's OWN
   *  vault record family, minted in the SAME plain sign-in ceremony every relying app already
   *  runs (`givePermission` / template `site-login`) — no org, no team, no stewardship, no
   *  `impact-relationships` write. The resources/ops here are the ONLY scope a self-vault grant
   *  for this client can ever carry; a relying app names its `client_id`, never the scope itself. */
  self_vault_grant?: {
    server: string;
    resources: string[];
    ops: ('read' | 'write')[];
  };
  /** App logo for the consent screen — comes from THIS registered config, never a request
   *  param (anti-spoof). Optional; falls back to an initial badge. */
  logo?: string;
  /** Friendly app name shown at consent (e.g. "Impact"); falls back to the host. From this
   *  registered config only — never a request param (anti-spoof). */
  name?: string;
  /** The CANONICAL relying-site delegate SA address for this client (ADR-0019). This is the
   *  ONLY delegate the broker will mint a grant for; the URL-supplied `delegate` is
   *  treated as untrusted hint and MUST match this. Address format: 0x-prefixed 20-byte hex.
   *  (SEC-001 closure — the broker no longer accepts attacker-chosen delegates.) */
  delegate: `0x${string}`;
  /** spec 294 — when true, a social (OIDC) sign-in under THIS client_id yields a KMS-CUSTODIED
   *  Smart Agent directly (custody-grade), instead of the default login-grade relying-app path
   *  where members onboard via the Personal Home. A deliberate, registered exception for
   *  SELF-CONTAINED demos (e.g. demo-web) that bootstrap their own SA across SIWE/passkey/social —
   *  NOT for true relying apps (demo-org/jp/gs stay login-grade). Default false/undefined. */
  socialCustody?: boolean;
  /** When true, this relying app cannot authorize a nameless person Smart Agent. Empty `agent_name`
   *  requests must collect/claim a unique Impact name before granting. */
  requireNamedAgent?: boolean;
  /** x402 payment params for the `x402-pay` template (spec 272/243). Present only on clients that
   *  sell paid content. The home mints a `person-treasury → payee` PaymentEnforcer delegation with
   *  these caps; amounts are atomic-unit strings (plain data / JSON-serializable). `mode`: 'push'
   *  (x402 — OPEN delegate, the reader redeems at access) | 'pull' (delegate = payee, the provider
   *  redeems on its own schedule — subscriptions/metered post-pay). Defaults to 'push'. */
  paymentConfig?: {
    payee: `0x${string}`;
    asset: `0x${string}`;
    maxAmountPerCharge: string;
    maxAggregate: string;
    maxRedemptionsPerWindow?: number;
    windowSeconds?: number;
    mode?: 'push' | 'pull';
  };
  /** spec 272 recurring — for an OWNER app (e.g. demo-corpus) with the `subscription-collect` template:
   *  where the owner-online collection ceremony redeems DUE subscribers' pull mandates. `treasury` is the
   *  owner-custodied collection treasury (= the pull mandates' delegate/payee, e.g. lbsb-treasury.impact);
   *  `a2aBase` is the content service exposing the owner-gated /admin/subscriptions/{due,collected}. */
  collectionConfig?: {
    treasury: `0x${string}`;
    asset: `0x${string}`;
    edition: string;
    a2aBase: string;
  };
  /** Where the `service-agent-wire` ceremony reads the service's signing key and hands back the
   *  signed wire. Its own field rather than `collectionConfig` because nothing here is payment:
   *  this is the agent-signing rail (agent-rules/service-agent-signing.md). */
  serviceAgentConfig?: {
    a2aBase: string;
  };
  /** What a member of THIS app is set up with the first time they connect — see {@link NewMemberOnboarding}.
   *
   *  ABSENT MEANS TODAY'S BEHAVIOUR, EXACTLY. Every app that does not carry this field runs the same
   *  ceremony it ran before the field existed: nothing extra is deployed, nothing extra is asked. That
   *  is deliberate and it is the safety property of the whole feature — this is the Home's onboarding
   *  path, shared by every member of the platform, so a new provisioning step has to be something an
   *  app OPTS INTO rather than something every app suddenly inherits. */
  new_member?: NewMemberOnboarding;
}

/**
 * First-connect provisioning a relying app declares for its members (the "what does a person need
 * before this app is usable" contract, stated by the app and honoured by the Home).
 *
 * The Home owns the ceremony; the app owns the requirement. A card room needs a player with a money
 * account and a name to show at the table, so it asks for both; a read-only directory app asks for
 * neither and is not touched. The app never gets to run the ceremony itself — declaring it here is
 * the only way to ask, which is what keeps "the app made me an account" impossible.
 *
 * EVERY field is optional and every omission means "don't". A `{}` here is the same as no field.
 */
export interface NewMemberOnboarding {
  /** Deploy the member's OWN personal treasury (`kind: 'person-treasury'`, custodied by their own
   *  credential, parented to their person SA) as part of first account creation, and record it so
   *  `/connect/related-orgs` discovery finds it.
   *
   *  NAMELESS BY DEFAULT, always — no label is claimed. A treasury's address is its canonical id
   *  (MAM-D4 name deferral), a label is globally unique per subregistry, and this runs for every new
   *  member of an app that asks for it: claiming here would mean racing thousands of people for the
   *  same obvious labels, and a failed claim must never cost someone the account itself. They can
   *  name it later from /treasuries.
   *
   *  The Home CREATES and CUSTODIES the account. It does NOT fund it — putting money in is the
   *  relying app's business (the card room tops any treasury it sees up to its floor), and a Home
   *  that mints play money is the wrong shape. */
  personal_treasury?: boolean;
  /** Ask the member for their human name (what a person is CALLED — "Rich Pedersen"), stored as the
   *  first/last name on their private profile. Omit and they are never asked, which is today's
   *  behaviour: a phone or Google sign-up ends up with no name at all and renders as a truncated
   *  address everywhere, which is exactly the complaint this exists to fix.
   *
   *  This is NOT the `<label>.me` handle. The handle is a globally-unique on-chain name in the agent
   *  naming service and claiming one is a separate, deliberate act the member takes in their own
   *  home (see `requireNamedAgent` for the app-level version of THAT). Accounts made through this
   *  path stay nameless in the naming service on purpose.
   *
   *  'required' — the member must give a name before the connect continues.
   *  'optional' — the field is offered with a way past it. */
  collect_name?: 'required' | 'optional';
}

/** Human-readable consent disclosure for a delegation template. The caveats themselves are
 *  contract-enforced (spec 230); this is the presentational can/cannot shown at consent. */
export interface DelegationTemplate {
  canDo: string[];
  /** Required, ≥1 — honest disclosure. <ConsentSheet> throws in dev if empty. */
  cannotDo: string[];
  /** Drives "Permission expires in N days" (omit → "ongoing until you revoke"). */
  expiryDays?: number;
}

/** An agent kind the Portal lets the user manage. Person is live; others preview. */
export interface ManageableAgent {
  id: 'person' | 'organization' | 'treasury' | 'data-source';
  label: string;
  blurb: string;
  status: 'live' | 'soon';
  /** The stewardship verb for this kind ("oversee" | "manage" | "protect"). */
  verb?: string;
}

/** Tokenized copy for the Experience Layer. {name} = the user's name; {app} = relying app. */
export interface WhiteLabelCopy {
  // Arrival into the Home — belonging + ownership, not a login page.
  arrivalTitle: string;
  arrivalBody: string;
  // Onboarding overview (lists the value steps up front).
  overviewTitle: string;
  // Value step ① — your own Portal (deploy the person SA).
  portalStepTitle: string;
  portalStepValue: string;
  // The CREATE-passkey CTA (gesture 1 — mint the key; passkey path only).
  portalStepCreateCta: string;
  // The APPROVE-setup CTA (gesture 2 — use the key just made to deploy + claim; passkey path only).
  portalStepCta: string;
  portalStepBusy: string;
  portalStepReceipt: string;
  // Receipt shown right after the passkey is CREATED, before the approve step (passkey path only).
  portalKeyCreatedReceiptTitle: string;
  portalKeyCreatedReceiptBody: string;
  // Value step ② — your place in the community (claim the name; batched with ①).
  communityStepTitle: string;
  communityStepValue: string;
  communityStepReceipt: string;
  // Value step ③ — access for the relying app (scoped delegation).
  authorizeStepTitle: string;
  authorizeStepValue: string;
  authorizeStepCta: string;
  authorizeStepBusy: string;
  authorizeStepReceipt: string;
  // Portal (signed-in).
  portalTitle: string;
  portalWelcome: string;
  portalYouLabel: string;
  portalManageHeading: string;
}

export interface WhiteLabelConfig {
  /** Stable id of this white-label (e.g. 'faith-impact'). */
  id: string;
  brand: {
    /** Short platform/community brand, e.g. "Impact". */
    name: string;
    /** Community noun, e.g. "Impact community". */
    community: string;
    tagline: string;
  };
  /** Deployment domains — sourced from lib/domain.ts (the ADR-0021 single source). */
  domains: { connect: string; a2a: string; nameParent: string };
  onboarding: {
    credentialMethods: Array<'passkey' | 'wallet' | 'google' | 'youversion' | 'email' | 'phone'>;
  };
  /** Which Portal surfaces are enabled for this deployment. */
  services: { devices: boolean; connectedApps: boolean };
  /** The "agents you manage" grid in the Portal. */
  manageableAgents: ManageableAgent[];
  /** Relying apps (the configured OIDC client registry). */
  relyingApps: RelyingApp[];
  /** Consent disclosure per delegation template (the human-readable can/cannot at consent). */
  delegationTemplates: Record<string, DelegationTemplate>;
  copy: WhiteLabelCopy;
}
