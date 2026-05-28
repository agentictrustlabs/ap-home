// THE single source of demo-sso-next's deployment-domain config (ADR-0021).
// No other file in this app should hardcode a hostname or the name TLD — import
// from here. This module is deployment-specific BY DESIGN and must never be
// hoisted into packages/* (enforced by `pnpm check:no-domain-in-packages`).
//
// SSO/A2A split (spec 232): the human SSO home is `<handle>.impact-agent.me`
// (this app); the agent's A2A endpoint is a separate domain
// `<handle>.impact-agent.io` (the demo-a2a Worker). Names live under a
// permissionless subregistry `<label>.demo.agent`.

/** Registrable Connect SSO domain — each person's home is a single-label subdomain. */
export const CONNECT_DOMAIN = 'impact-agent.me';
/** Registrable A2A domain (served by demo-a2a, not this app) — for display/links. */
export const A2A_DOMAIN = 'impact-agent.io';
/** The permissionless `.agent` subregistry names are claimed under. */
export const AGENT_NAME_PARENT = 'demo.agent';

/** Alias kept for existing imports. */
export const CENTRAL_AUTH_DOMAIN = CONNECT_DOMAIN;
/** Platform (apex) Connect origin — landing + bootstrap default. */
export const PLATFORM_AUTH_ORIGIN = `https://${CONNECT_DOMAIN}`;

/** Single-label subdomain of `baseDomain` (alice.impact-agent.me → alice). The
 *  apex, nested labels, `www`, and non-matching hosts → null. */
export function parseAgentSubdomain(hostname: string, baseDomain: string = CONNECT_DOMAIN): string | null {
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base) return null;
  if (!host.endsWith('.' + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (!label || label.includes('.') || label === 'www') return null;
  return label;
}

/** The handle this page serves on a personal subdomain, else null (apex / pages.dev / localhost). */
export function subdomainHandle(): string | null {
  if (typeof window === 'undefined') return null;
  return parseAgentSubdomain(window.location.hostname);
}

/** Personal SSO origin for a label (alice → https://alice.impact-agent.me). */
export function personalAuthOrigin(label: string): string {
  return `https://${label}.${CONNECT_DOMAIN}`;
}

/** The `.agent` name for a label (alice → alice.demo.agent). */
export function agentNameForLabel(label: string): string {
  return `${label}.${AGENT_NAME_PARENT}`;
}

/** The label of a name (alice.demo.agent → alice; alice → alice). */
export function nameLabel(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(new RegExp(`\\.${AGENT_NAME_PARENT.replace(/\./g, '\\.')}$`), '')
      .replace(/\.+$/, '')
      .split('.')[0] ?? ''
  );
}

/** Normalize any name/label to its full `<label>.demo.agent` form. */
export function toAgentName(nameOrLabel: string): string {
  const n = nameOrLabel.trim().toLowerCase();
  return n.endsWith(`.${AGENT_NAME_PARENT}`) ? n : `${nameLabel(n)}.${AGENT_NAME_PARENT}`;
}
