// The active white-label config for this deployment: the FAITH vertical ("Impact").
// This is the only place faith/vertical copy + the relying-app registry live for
// the central trust site (ADR-0021 — app level, never packages). The generic
// Experience Layer (App.tsx) + the OIDC client registry (lib/oidc-clients.ts) read
// from `whitelabel`; swapping verticals is a new config, not a code change.

import { A2A_DOMAIN, AGENT_NAME_PARENT, CONNECT_DOMAIN } from '../lib/domain';
import type { WhiteLabelConfig } from './schema';

const faithImpact: WhiteLabelConfig = {
  id: 'faith-impact',
  brand: {
    name: 'Impact',
    community: 'Impact community',
    tagline: 'Your trusted home in the Impact community',
  },
  // Domains stay sourced from lib/domain.ts (the ADR-0021 single source of hostnames).
  domains: { connect: CONNECT_DOMAIN, a2a: A2A_DOMAIN, nameParent: AGENT_NAME_PARENT },
  onboarding: {
    credentialMethods: ['passkey', 'wallet'],
  },
  services: { devices: true, connectedApps: true },
  manageableAgents: [
    { id: 'person', label: 'You', blurb: 'Your personal agent — the home you sign in as.', status: 'live' },
    {
      id: 'organization',
      label: 'Organizations',
      blurb: 'Ministries, churches, and teams you govern.',
      status: 'soon',
    },
    { id: 'treasury', label: 'Treasuries', blurb: 'Funds and giving your agents steward.', status: 'soon' },
    {
      id: 'data-source',
      label: 'Data sources',
      blurb: 'Records and feeds your agents can share, with your consent.',
      status: 'soon',
    },
  ],
  relyingApps: [
    {
      client_id: 'demo-org',
      redirect_uris: ['https://agenticprimitives-demo-org.pages.dev/', 'http://localhost:5473/'],
      allowed_scopes: ['openid', 'agent'],
      allowed_delegation_templates: ['site-login', 'org-create'],
    },
  ],
  copy: {
    arrivalTitle: 'Welcome to your Impact community portal',
    arrivalBody: 'This is your own secure home in the Impact community — you own it, you control it.',
    overviewTitle: "Here's what you're setting up",
    portalStepTitle: 'Your own Portal',
    portalStepValue: 'A Smart Agent that is yours — your private command center. No password to lose.',
    portalStepCta: 'Set up my Portal',
    portalStepBusy: 'Creating your Portal on Base Sepolia…',
    portalStepReceipt: 'Your Portal is live',
    communityStepTitle: 'Your place in the Impact community',
    communityStepValue: 'A name others can find and trust — your identity in the community.',
    communityStepReceipt: "You're {name} in the Impact community",
    authorizeStepTitle: 'Give {app} access',
    authorizeStepValue: 'A scoped, revocable permission for {app}. You stay in control and can revoke anytime.',
    authorizeStepCta: 'Authorize {app}',
    authorizeStepBusy: 'Connecting {app}…',
    authorizeStepReceipt: 'Connected — returning you to {app}',
    portalTitle: '{name} · Impact portal',
    portalWelcome: 'Welcome to your Impact community portal',
    portalYouLabel: 'This is you',
    portalManageHeading: 'Agents you manage',
  },
};

/** The active white-label for this deployment. */
export const whitelabel: WhiteLabelConfig = faithImpact;

/** Interpolate {name} / {app} (and any {token}) into a copy string. Missing tokens stay literal. */
export function fmt(template: string, vars: Record<string, string | undefined> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export type { WhiteLabelConfig, WhiteLabelCopy, RelyingApp, ManageableAgent } from './schema';
