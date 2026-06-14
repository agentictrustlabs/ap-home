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
    credentialMethods: Array<'passkey' | 'wallet' | 'google' | 'youversion'>;
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
