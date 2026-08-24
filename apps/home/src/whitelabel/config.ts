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
    credentialMethods: ['passkey', 'wallet', 'google', 'youversion', 'email', 'phone'],
  },
  services: { devices: true, connectedApps: true },
  // The stewardship hub: what the member helps oversee / manage / protect from their home.
  manageableAgents: [
    { id: 'person', label: 'You', blurb: 'Your personal home — the you the community knows.', status: 'live' },
    { id: 'organization', label: 'Organizations', blurb: 'Ministries, churches, and teams you help oversee.', status: 'live', verb: 'oversee' },
    { id: 'treasury', label: 'Treasuries', blurb: 'Funds and giving you help manage.', status: 'live', verb: 'manage' },
    { id: 'data-source', label: 'Data sources', blurb: 'Records you help protect and share, with consent.', status: 'soon', verb: 'protect' },
  ],
  relyingApps: [
    // skills-app — the SKILL.md management app (agentictrustlabs/skills). Login-grade connect via the
    // Personal Home; no PII held by the broker. aud = client_id; the allowed origin is derived from
    // the exact-match redirect_uri (CN-1) by `src/lib/oidc-clients.ts`.
    //
    // `org-create` because a DOMAIN in that app is an ORGANIZATION in the member's own Home: it holds
    // the domain's skill folders (its library), its knowledge base (its vault) and the agent that runs
    // them. One org per domain, deployed by the member's own credential in a single consent — the app
    // cannot mint it, which is the point. Requests arrive name-deferred (empty `agent_name`) with
    // `org_base=<domain label>`, so they route through RecognizedEnroll's org-create leg.
    {
      client_id: 'skills-app',
      name: 'Skills',
      redirect_uris: ['https://skills-web-7ar.pages.dev/', 'http://localhost:5190/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create', 'service-agent-wire'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // `skills-agent.impact` — the service agent orgs grant to and skills-a2a signs AS. It is
      // custodied by a SIWE credential in its owner's Home, NOT by skills-a2a: the worker signs with
      // a KMS key that the `service-agent-wire` ceremony authorizes as a DELEGATE, so a compromise of
      // the worker yields something the custodian revokes rather than the identity itself
      // (ADR-0019 + docs/architecture/agent-rules/service-agent-signing.md).
      //
      // It replaces 0x2aF8853D…, which was deployed custodied by the KMS key DIRECTLY — "no held
      // key" but the service was still the custodian, which is the shape the rule forbids. Grants
      // minted to that address name a delegate this worker can no longer present a wire for and must
      // be re-minted. NOT the shared `delegate` above, which a dozen entries name.
      operational_delegate: '0x9c9b7aDd48B001CC3b4672911972b2e6feDCC95F',
      // Where the service-agent-wire ceremony talks to skills-a2a.
      serviceAgentConfig: { a2aBase: 'https://skills-a2a-production.richardpedersen3.workers.dev' },
    },
    // commons-app — the reference third-party app from the PUBLIC starter repo
    // (agentic-primitives-starter, apps/commons). It is the one entry here that exists to be COPIED:
    // a plain relying app with no privileged template, no social custody, and no payment config —
    // exactly what a member gets from the self-service registry at /developer.
    //
    // It is curated rather than self-registered only so the starter runs against a fresh deployment
    // before anyone has opened the portal. A developer deploying their own copy registers THEIR
    // origin at /developer instead of editing this file.
    {
      client_id: 'commons-app',
      name: 'Commons',
      // The deployed starter, plus `wrangler dev` on 8799. Exact match (CN-1), so the trailing
      // slash is load-bearing — and note the `-production` suffix: `wrangler deploy --env
      // production` names the Worker `<name>-<env>`, so the origin is NOT `commons.workers.dev`.
      // A developer deploying their own copy adds THEIR origin through /developer, not here.
      redirect_uris: [
        'https://commons-production.richardpedersen3.workers.dev/',
        'http://localhost:8799/',
        'http://127.0.0.1:8799/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // engage-app — the engagement layer for faith and impact work (agentictrustlabs/engage). Turns a
    // stated need into a mandate-authorized, receipted fulfilment. Login-grade connect via the
    // Personal Home; no PII held by the broker.
    //
    // `org-create` for the same reason skills has it: a DOMAIN in that app is an ORGANIZATION in the
    // member's own Home, holding the domain's published needs/offerings and the agent that runs
    // them. One org per domain, deployed by the member's own credential in a single consent — the
    // app cannot mint it, which is the point.
    {
      client_id: 'engage-app',
      name: 'Engage',
      // A redirect_uri is exact-match (CN-1) and is where this broker HANDS OVER an authorization
      // code, so it must name a domain we CONTROL — never a guessed one. An earlier revision of this
      // entry read `https://engage.pages.dev/`, inferred from the project name; that domain belongs
      // to someone else. Cloudflare appends a suffix when a project name is taken, and it did here:
      // the project is `engage-web`, the domain is `engage-web-7um.pages.dev`. Read from
      // `wrangler pages project list`, never derived.
      redirect_uris: [
        'https://engage-web-7um.pages.dev/',
        'http://localhost:5173/',
        // Field Workspace still sends `engage-app` today (field-a2a accepts that audience until
        // field-app tokens exist). Without this exact URI, Home fail-closes the enroll as
        // "Request blocked / Only start setup from a site you trust." Comes off this list once
        // field-web's CLIENT_ID is `field-app`.
        'https://field-web.richardpedersen3.workers.dev/',
        'http://localhost:5174/',
        'http://127.0.0.1:5174/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create', 'service-agent-wire'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // `engage-service.impact` — the service agent orgs grant to and engage-a2a signs AS. Custodied
      // OUTSIDE engage-a2a (1 custodian, 0 passkeys on chain today); the worker signs with a KMS key
      // the `service-agent-wire` ceremony authorizes as a DELEGATE, so compromising the worker
      // yields something the custodian revokes rather than the identity itself (ADR-0019 +
      // docs/architecture/agent-rules/service-agent-signing.md).
      //
      // engage-a2a asserts that separation at RUNTIME rather than trusting this comment: it reads
      // `isCustodian(kmsKey)` on this SA before its first signature and refuses to start if the key
      // it signs with is also a custodian of the identity it signs as. See engage's
      // `apps/engage-a2a/src/custody.ts`.
      //
      // NOT the shared `delegate` above, which a dozen entries name — operational authority granted
      // to that address is granted to all of them.
      operational_delegate: '0x0d9be26B9F52AF06354c3eFA19173BcBA60176d3',
      // Where the service-agent-wire ceremony talks to engage-a2a.
      serviceAgentConfig: { a2aBase: 'https://engage-a2a-production.richardpedersen3.workers.dev' },
    },
    // field-app — Field Circles / Field Workspace (agentictrustlabs/engage apps/field-*).
    // A SEPARATE product (ADR-0007), not a mode of Engage. Login-grade connect via the Personal
    // Home; no PII held by the broker. No service-agent-wire yet — field-a2a signs nothing as
    // itself until F2 (outbound send). operational_delegate is field-service.impact, not the
    // shared `delegate` below.
    {
      client_id: 'field-app',
      name: 'Field',
      redirect_uris: [
        'https://field-web.richardpedersen3.workers.dev/',
        'http://localhost:5174/',
        'http://127.0.0.1:5174/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: [
        'site-login',
        'org-create',
        'workspace-create',
        // P4 — workspace membership, two ceremonies around one stash (/connect/workspace-invite):
        // the custodian signs the member's access in; the member claims it into their own tree.
        'workspace-member-invite',
        'workspace-join',
        'service-agent-wire',
      ],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      operational_delegate: '0xD1F7Ef18537eFDBfE0cA265F60f7A59333066f20',
      serviceAgentConfig: { a2aBase: 'https://field-a2a-production.richardpedersen3.workers.dev' },
    },
    // gather-app — Gather27 (agentictrustlabs/engage apps/gather27-*). Find a group near you;
    // invite-driven host onboarding; events live in the host org vault. Login-grade connect via
    // the Personal Home.
    //
    // `service-agent-wire` — the Gather27 WORKSPACE is a service-class agent (kind 'workspace',
    // ADR-0046: a service ROLE that mirrors treasury, never extends it). Its vault holds the roster
    // of member organizations; the ceremony authorizes gather27-a2a's KMS key as the workspace's
    // DELEGATE, and that wire is the ONLY delegation the roster read path presents. The workspace is
    // custodied by the Gather org's custodian, who runs the ceremony from Home against a2aBase.
    {
      client_id: 'gather-app',
      name: 'Gather27',
      redirect_uris: [
        'https://gather27-web.richardpedersen3.workers.dev/',
        'http://localhost:5175/',
        'http://127.0.0.1:5175/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create', 'service-agent-wire'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // Where the service-agent-wire ceremony talks to gather27-a2a.
      serviceAgentConfig: { a2aBase: 'https://gather27-a2a-production.richardpedersen3.workers.dev' },
      // Each host org grants the WORKSPACE a read of its own listing record at connect time: the
      // workspace roster reads listings in place, never copies them (org_read_grant — see schema).
      org_read_grant: {
        delegate: '0xcE7bb378e132Cd373B366746B5F43533f9777Da7', // gather27-workspace.impact
        server: 'demo-mcp',
        resources: ['vault:gather27:listing'],
      },
    },
    // skills-corpus — the SKILL.md ceremony/admin surface (owner claims a skillset).
    {
      client_id: 'skills-corpus',
      name: 'Skills Corpus (admin)',
      redirect_uris: ['https://skills-corpus.richardpedersen3.workers.dev/', 'http://localhost:8996/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // spec 294 — the SIMPLE demo (apps/demo-web). Unlike the relying apps below, demo-web is a
    // self-contained demo that bootstraps its OWN Smart Agent across SIWE / passkey / social. So its
    // social (OIDC) sign-in is custody-grade (`socialCustody: true`) — the OIDC custodian deploys + signs
    // for the SA directly, giving tri-custody parity with the SIWE/passkey paths. NOT a pattern for true
    // relying apps (which stay login-grade + onboard via the Personal Home).
    {
      client_id: 'demo-web',
      name: 'agenticprimitives demo',
      redirect_uris: ['https://agenticprimitives-demo.pages.dev/', 'http://localhost:5173/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      socialCustody: true,
    },
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
    // spec 250/251 — "Global Switchboard" relying app (demo-gs): a capability/expertise broker.
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
      requireNamedAgent: true,
    },
    // specs 266/267 — "Bible Explorer" relying app: the Verifiable Content Substrate +
    // scripture vertical demo (demo-bible-ontology Worker). Connects via Global.Church
    // identity; site-login + org-create only (no PII held by the broker).
    {
      client_id: 'bible-explorer',
      name: 'Bible Explorer',
      redirect_uris: ['https://demo-bible-ontology-production.richardpedersen3.workers.dev/', 'http://localhost:5673/'],
      allowed_scopes: ['openid', 'agent'],
      // spec 272/243 — `x402-pay`: the member authorizes (once) a capped payment delegation from
      // their person-treasury to the lbsb licensed-scripture treasury, redeemed per paid read (x402).
      allowed_delegation_templates: ['site-login', 'org-create', 'x402-pay'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // x402 push: USDC lands at the lbsb-treasury SA; the reader redeems at access time (OPEN delegate).
      // 0.001 USDC/read (1000 atomic, 6-dp mock USDC), 1.0 USDC aggregate cap per delegation.
      paymentConfig: {
        payee: '0x17320bF2DAe8820157530c634B9bB76f6Eb72004',
        asset: '0x6cfF706bA1461a9ef9F5aaf8f1581301805FbF92',
        maxAmountPerCharge: '60000', // 0.06 USDC — covers the largest tier (Plus); the UI picks the amount
        maxAggregate: '6000000',     // 6 USDC across the delegation's life
        maxRedemptionsPerWindow: 1000,
        windowSeconds: 3600,
        mode: 'push',
      },
    },
    // demo-corpus relying app — connects via Global.Church identity; site-login + org-create
    // (no PII held by the broker). aud = client_id; the allowed origin is derived from the
    // exact-match redirect_uri (CN-1) by `src/lib/oidc-clients.ts`.
    {
      client_id: 'demo-corpus',
      name: 'Demo Corpus',
      redirect_uris: ['https://demo-corpus-production.richardpedersen3.workers.dev/'],
      allowed_scopes: ['openid', 'agent'],
      // spec 272 recurring — `subscription-collect`: the corpus OWNER redeems DUE subscribers' standing
      // pull mandates (owner-online, no held key), signed as the collection treasury they custody.
      // spec 266 — `content-signer`: the owner authorizes each content issuer's Cloud-KMS signing key.
      allowed_delegation_templates: ['site-login', 'org-create', 'subscription-collect', 'content-signer'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
      // The owner-custodied lbsb collection treasury (= lbsb-treasury.impact, the pull mandates' delegate)
      // and the content service exposing the owner-gated due/collected endpoints.
      collectionConfig: {
        treasury: '0x17320bF2DAe8820157530c634B9bB76f6Eb72004',
        asset: '0x6cfF706bA1461a9ef9F5aaf8f1581301805FbF92',
        edition: 'lbsb',
        a2aBase: 'https://demo-bible-a2a-production.richardpedersen3.workers.dev',
      },
    },
    // UUPG+ Alliance Engagement Tracker (agentictrustlabs/uupg — the ported demo-uupg) — connects via
    // Global.Church identity; site-login + org-create (the tracker's alliance/org ceremonies hand off
    // to the Home). No PII held by the broker; aud = client_id; allowed origin derived from the
    // exact-match redirect_uri (CN-1) by `src/lib/oidc-clients.ts`.
    {
      client_id: 'uupg-tracker',
      name: 'UUPG+ Tracker',
      redirect_uris: [
        'https://uupg.richardpedersen3.workers.dev/',
        // verifiable-content-demo apps/demo-uupg (the original) — repointed onto this broker.
        'https://demo-uupg-production.richardpedersen3.workers.dev/',
        'https://demo-uupg.richardpedersen3.workers.dev/',
        'https://demo-uupg-production.global-church.workers.dev/',
        // uupg apps/tracker — the hotspot workspace (same product, its own Worker; dev on :8799).
        'https://hotspot-tracker.richardpedersen3.workers.dev/',
        'http://127.0.0.1:8797/',
        'http://localhost:8797/',
        'http://127.0.0.1:8799/',
        'http://localhost:8799/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // Engagement Campaign Studio (uupg apps/campaign) — org-scoped ask over demo-a2a needs a
    // session whose `aud` is THIS client_id. Borrowing `uupg-tracker` mints a valid token that
    // demo-a2a then refuses as aud mismatch. Same demo delegate as the other uupg apps.
    {
      client_id: 'campaign-studio',
      name: 'Engagement Campaign Studio',
      redirect_uris: [
        'https://campaign-studio.richardpedersen3.workers.dev/',
        'http://127.0.0.1:8801/',
        'http://localhost:8801/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // Single-organization site (agentictrustlabs/uupg apps/org) — ONE Worker serving a dedicated
    // per-org website; the org is resolved from the hostname (or `?org=<label>` on the workers.dev
    // and local-dev origins, which is why those redirect_uris are enough for now). site-login only.
    // NOTE: redirect_uris are EXACT-match (CN-1) — production per-org subdomains
    // (`https://<label>.<zone>/`) must each be registered here explicitly, or clientAllowsRedirect
    // needs a deliberate wildcard-host extension for this client before subdomain routing goes live.
    {
      client_id: 'org-site',
      name: 'Organization Site',
      redirect_uris: ['https://uupg-org.richardpedersen3.workers.dev/', 'https://org.richardpedersen3.workers.dev/', 'http://127.0.0.1:8798/', 'http://localhost:8798/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // New City AI family/advisor portal (newcitycase repo, apps/portal) — wealth reporting on the
    // substrate; site-login + org-create (FR-48: the connecting user creates/selects a user-custodied
    // family org at onboarding). Local dev/e2e shares port 8798 with org-site (distinct client_id, so
    // no ambiguity — the RP always sends its own client_id). Delegate is the shared demo delegate SA
    // for now; replace when the portal mints its own service SA.
    {
      client_id: 'newcity-portal',
      name: 'New City AI Portal',
      redirect_uris: [
        'https://newcity-portal.richardpedersen3.workers.dev/',
        'http://127.0.0.1:8798/',
        'http://localhost:8798/',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
      delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    },
    // OpenBook × Tyndale (openbook-tyndale.vercel.app) — Tyndale Open Bible Dictionary demo with a
    // server-side "Sign in with Home" flow (its /api/home/start 307s here with PKCE + template=site-login;
    // the code lands at /api/home/callback, exchanged server-side). site-login only; no PII at the broker.
    {
      client_id: 'openbook-tyndale',
      name: 'OpenBook × Tyndale',
      redirect_uris: [
        'https://openbook-tyndale.vercel.app/api/home/callback',
        'http://localhost:3000/api/home/callback',
      ],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login'],
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
    'workspace-create': {
      canDo: [
        'Create a Field Workspace under your name',
        'Hold its shared roster and associations in its own vault',
        'Authorize Field to act as that workspace, revocably',
      ],
      cannotDo: [
        'Take custody of the workspace agent away from you',
        'Move funds, or touch your sign-in methods or recovery',
        'Copy field records out of steward vaults',
      ],
      expiryDays: 365,
    },
    'workspace-member-invite': {
      canDo: [
        'Let the person you named read this workspace, revocably',
        'Hold that access for them until they join',
      ],
      cannotDo: [
        'Make them a steward, or change who governs the workspace',
        'Touch their home, their vault, or their sign-in',
        'Move funds',
      ],
      expiryDays: 365,
    },
    'workspace-join': {
      canDo: [
        'Add this workspace to the places you can work',
        'Accept the access its steward set aside for you',
      ],
      cannotDo: [
        'Give the workspace anything from your own vault',
        'Make you a steward of it',
        'Move funds, or touch your sign-in methods or recovery',
      ],
      expiryDays: 365,
    },
    // spec 272/243 — pay-per-access for licensed content. Your personal treasury authorizes capped,
    // per-read charges to the content's treasury; you can revoke anytime. The cap + payee are
    // contract-enforced (PaymentEnforcer), not just disclosure.
    'x402-pay': {
      canDo: [
        'Pay a small, capped fee from your personal treasury for each licensed read',
        'Send those payments only to this content provider’s treasury',
      ],
      cannotDo: [
        'Charge more than the per-read cap or the total you approved',
        'Move funds to anyone other than this provider',
        'Touch your sign-in methods or recovery',
      ],
      expiryDays: 365,
    },
    // spec 272 recurring — the corpus OWNER collects due subscriptions: signs, with their own credential,
    // the redemption of each due subscriber's standing pull mandate as the collection treasury they custody.
    'subscription-collect': {
      canDo: [
        'Charge subscribers whose period is due, using the standing mandate each one already authorized',
        'Send each charge only to your content treasury, capped by that mandate',
      ],
      cannotDo: [
        'Charge more than a subscriber authorized, or charge a non-subscriber',
        'Move funds anywhere other than your content treasury',
        'Touch sign-in methods or recovery',
      ],
      expiryDays: 1,
    },
    // spec 266 — the corpus OWNER authorizes each content issuer's Cloud-KMS signing key: signs, with their
    // own credential, a delegation binding each issuer SA (e.g. lbsb.impact) → its KMS content-signing key.
    'content-signer': {
      canDo: [
        'Authorize an HSM-backed Cloud KMS key to sign content on behalf of issuers you control (e.g. lbsb.impact)',
        'Bind each authorization to a specific issuer + key, revocable later',
      ],
      cannotDo: [
        'Expose or move any signing key (the key never leaves the HSM-backed Cloud KMS)',
        'Authorize signing for an issuer you do not custody',
        'Touch sign-in methods, funds, or recovery',
      ],
      expiryDays: 1,
    },
    // agent-rule `service-agent-signing.md` — you authorize a service's HSM-backed KMS key to act AS
    // an agent you custody (e.g. skills-agent.impact), for ONE kind of message, revocably. The
    // service never holds anything that controls the agent.
    'service-agent-wire': {
      canDo: [
        'Let this service act as an agent you custody, for one specific kind of request',
        'Bind that permission to the service\u2019s HSM-backed key, revocable by you at any time',
      ],
      cannotDo: [
        'Take custody of the agent, or act as it for anything else',
        'Expose or move any signing key (it never leaves the HSM-backed Cloud KMS)',
        'Move funds, or touch your sign-in methods or recovery',
      ],
      expiryDays: 90,
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
    // ① Secure your home (passkey + found it). The passkey path has two device gestures: create the
    // key (portalStepCreateCta) then approve the setup with it (portalStepCta). Spec 255 — distinct
    // labels so the second OS prompt is clearly NOT a repeat of the first.
    portalStepTitle: 'Secure your home',
    portalStepValue: 'A home of your own that only you can open — using just this device, no password to lose.',
    portalStepCreateCta: 'Create your passkey',
    portalStepCta: 'Approve my setup',
    portalStepBusy: 'Securing your home…',
    portalStepReceipt: 'Your home is secured — only you can open it',
    // Receipt after gesture 1 (passkey created) — spec 255.
    portalKeyCreatedReceiptTitle: 'Passkey created — your key is ready',
    portalKeyCreatedReceiptBody: "This device now holds a key that proves it's you. Nothing left this device.",
    // ② Register your name (rides with ①).
    communityStepTitle: 'Register your name',
    communityStepValue: 'Your name in the missional community — so the community and its apps can find you.',
    communityStepReceipt: "You're registered as {name} — the missional community can find you",
    // ③ Give an app permission to your resources.
    authorizeStepTitle: 'Allow {app}?',
    authorizeStepValue: 'A specific, revocable permission for {app} to act for you. You decide what it can touch — and can take it back anytime.',
    authorizeStepCta: 'Allow {app}',
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
