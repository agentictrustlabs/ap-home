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
}

/** An agent kind the Portal lets the user manage. Person is live; others preview. */
export interface ManageableAgent {
  id: 'person' | 'organization' | 'treasury' | 'data-source';
  label: string;
  blurb: string;
  status: 'live' | 'soon';
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
  portalStepCta: string;
  portalStepBusy: string;
  portalStepReceipt: string;
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
    credentialMethods: Array<'passkey' | 'wallet' | 'google'>;
  };
  /** Which Portal surfaces are enabled for this deployment. */
  services: { devices: boolean; connectedApps: boolean };
  /** The "agents you manage" grid in the Portal. */
  manageableAgents: ManageableAgent[];
  /** Relying apps (the configured OIDC client registry). */
  relyingApps: RelyingApp[];
  copy: WhiteLabelCopy;
}
