// The active white-label config for this deployment: the FAITH vertical ("Impact"). This is
// the only place faith/vertical copy + the relying-app registry live for the central trust
// site (ADR-0021 — app level, never packages). The member-facing lexicon is documented in
// docs/portal-lexicon.md; this config is its single source of truth. Swapping verticals is a
// new config, not a code change.
import { A2A_DOMAIN, AGENT_NAME_PARENT, CONNECT_DOMAIN } from '../lib/domain';
import type { WhiteLabelConfig } from './schema';

const faithImpact: WhiteLabelConfig = {
  id: 'faith-impact',
  brand: {
    name: 'Impact',
    community: 'missional community',
    tagline: 'Your home in the missional community',
  },
  // Domains stay sourced from lib/domain.ts (the ADR-0021 single source of hostnames).
  domains: { connect: CONNECT_DOMAIN, a2a: A2A_DOMAIN, nameParent: AGENT_NAME_PARENT },
  onboarding: {
    credentialMethods: ['passkey', 'wallet', 'google'],
  },
  services: { devices: true, connectedApps: true },
  // The stewardship hub: what the member helps oversee / manage / protect from their home.
  manageableAgents: [
    { id: 'person', label: 'You', blurb: 'Your personal home — the you the community knows.', status: 'live' },
    { id: 'organization', label: 'Organizations', blurb: 'Ministries, churches, and teams you help oversee.', status: 'soon', verb: 'oversee' },
    { id: 'treasury', label: 'Treasuries', blurb: 'Funds and giving you help manage.', status: 'soon', verb: 'manage' },
    { id: 'data-source', label: 'Data sources', blurb: 'Records you help protect and share, with consent.', status: 'soon', verb: 'protect' },
  ],
  relyingApps: [
    {
      client_id: 'demo-org',
      name: 'Impact',
      redirect_uris: ['https://agenticprimitives-demo-org.pages.dev/', 'http://localhost:5473/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      // The canonical demo-org delegate SA (ADR-0019). Source of truth — the URL-supplied
      // `delegate` parameter is rejected if it doesn't equal this.
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // logo omitted → consent shows an initial badge (no spoofable logo).
    },
    // spec 236 — "JP Adopt" relying app (demo prototype): JP runs the adoption program;
    // Impact Community holds the data (PII, signed MOU/WEA) in the member's vault and
    // delegates scoped, revocable access. The consent screen reads "JP Adopt is asking
    // to connect" — JP is the program, not a sub-brand of Impact. The literal name of
    // the real underlying organization is NOT used on the live site (demo disclaimer).
    {
      client_id: 'demo-jp',
      name: 'JP Adopt',
      redirect_uris: ['https://agenticprimitives-demo-jp.pages.dev/', 'http://localhost:5573/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create', 'jp-data-access'],
      // TODO: deploy a JP-specific delegate SA + replace here (SEC-003 follow-up — user has
      // deferred per-app delegates for now; the broker still enforces "delegate matches
      // registered" so a future split is a config-only change).
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // spec 250/251 — "Global Switchboard" relying app (demo-gs): a skills/expertise broker.
    // A person signs in (KC individual) or creates a GCO organization (the org holds the GCO
    // role) — both through the shared Global.Church identity, exactly the Phase-2 "one-tap"
    // arrival the Switchboard pilot describes. demo-gs holds no PII; site-login + org-create only.
    {
      client_id: 'demo-gs',
      name: 'Global Switchboard',
      redirect_uris: ['https://agenticprimitives-demo-gs.pages.dev/', 'http://localhost:5673/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
  ],
  // Consent disclosure per template — the human-readable can/cannot shown at the permission
  // step. The caveats themselves are contract-enforced (spec 230); this is presentational.
  delegationTemplates: {
    'site-login': {
      canDo: ['Sign in as you in the missional community', 'Read your community profile'],
      cannotDo: ['Move your funds', 'Add new sign-in methods', 'Change your recovery'],
      expiryDays: 365,
    },
    'org-create': {
      canDo: ['Set up an organization under your name', 'View approved org records for this session'],
      cannotDo: ['Change organization access', 'Add members or move funds', 'Act outside this permission'],
      expiryDays: 365,
    },
    // spec 247 — JP's adoption program reads + writes the data it holds for you (your
    // profile + program records) in YOUR vault, through this scoped grant. The records
    // stay in your vault; JP holds the permission, not a copy of your data.
    'jp-data-access': {
      canDo: [
        'Sign in as you in the missional community',
        'Read your profile + adoption records from your vault',
        'Record your MOU, adoption, and program updates into your vault, on your behalf',
      ],
      cannotDo: [
        'Move your funds',
        'Add new sign-in methods or change your recovery',
        'Share your records with anyone else without a new permission',
      ],
      expiryDays: 365,
    },
  },
  // Member-facing copy — the lexicon (docs/portal-lexicon.md). {name} = the member's name;
  // {app} = the missional-community app asking for permission.
  copy: {
    // Arrival into your home.
    arrivalTitle: 'Welcome to your Impact Community Home',
    arrivalBody:
      "A place of your own in the missional community — where you oversee what you help lead, manage what you steward, and protect what's entrusted to you.",
    overviewTitle: "Here's how you'll get set up",
    // ① Secure your home (passkey + found it).
    portalStepTitle: 'Secure your home',
    portalStepValue: 'A home of your own that only you can open — using just this device, no password to lose.',
    portalStepCta: 'Secure my home',
    portalStepBusy: 'Securing your home…',
    portalStepReceipt: 'Your home is secured — only you can open it',
    // ② Register your name (rides with ①).
    communityStepTitle: 'Register your name',
    communityStepValue: 'Your name in the missional community — so the community and its apps can find you.',
    communityStepReceipt: "You're registered as {name} — the missional community can find you",
    // ③ Give an app permission to your resources.
    authorizeStepTitle: 'Give {app} permission',
    authorizeStepValue: 'A specific, revocable permission for {app} to act for you. You decide what it can touch — and can take it back anytime.',
    authorizeStepCta: 'Give {app} permission',
    authorizeStepBusy: 'Granting permission to {app}…',
    authorizeStepReceipt: 'Permission granted — {app} can do only what you allowed',
    // Your home (signed in).
    portalTitle: '{name} · your home',
    portalWelcome: 'Welcome to your home',
    portalYouLabel: 'This is you',
    portalManageHeading: 'What you steward',
  },
};

/** The active white-label for this deployment. */
export const whitelabel: WhiteLabelConfig = faithImpact;

/** Interpolate {name} / {app} (and any {token}) into a copy string. Missing tokens stay literal. */
export function fmt(template: string, vars: Record<string, string | undefined> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export type { WhiteLabelConfig, WhiteLabelCopy, RelyingApp, ManageableAgent, DelegationTemplate } from './schema';
