// WHERE A SUBJECT IS ASKED — spec 366 R4, the second deployment.
//
// A routed step goes to the subject's OWN agent. Where that agent is asked is what the subject's NAME
// publishes — its on-chain `atl:a2aEndpoint` / `atl:cardUri` records, the same records an outside agent
// resolves through (spec 379 W2) — never a host derived from the name's spelling. Two agents on two
// subdomains are not two deployments, and a subdomain convention is not a resolution: the record is.
//
// From the records, one of three answers:
//   here     — the records name THIS deployment: the ingress it advertises on every card it serves, or
//              exactly the host it would serve that name at (`hostForName` on one of its own zones — an
//              equality against the one host, never a suffix match: a second deployment may well live on
//              a subdomain of the first's zone), so the ask is made in-process (a Worker cannot fetch its
//              own hostnames);
//   wire     — the records name somewhere else: the ask rides the one wire (spec 372 S4) to the endpoint
//              the subject's CARD publishes, the card pinned by `atl:cardDigest` when the name pins one;
//   nowhere  — the registry knows no such name, or the name publishes no endpoint and this deployment
//              does not serve the unpublished (the estate's default deployment does — a statement in its
//              configuration, `A2A_SERVES_UNPUBLISHED_NAMES`, never an inference).
//
// Pure: the caller supplies the records; nothing here reads a chain.
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { hostForName } from './host-context.js';
import type { Address } from 'viem';

export interface NameRecordsLite { a2aEndpoint?: string; cardUri?: string; cardDigest?: string }

export interface SubjectAddressEnv {
  /** The ingress this deployment advertises on the cards it serves (`DEMO_EDGE_URL`); absent ⇒ none. */
  ownIngress?: string | undefined;
  /** The zones this deployment serves agents on (`A2A_PUBLIC_BASE_DOMAIN`) and the person roots it names them under. */
  ownDomains: readonly string[];
  parents: readonly string[];
  /** Does this deployment serve names that publish no endpoint? The estate's default deployment does. */
  servesUnpublished: boolean;
}

export type SubjectAddress =
  | { where: 'here'; because: string }
  | { where: 'wire'; cardUrl: string; pinnedDigest?: string }
  | { where: 'nowhere'; refused: string };

const originOf = (url: string): string | null => { try { return new URL(url).origin.toLowerCase(); } catch { return null; } };
const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
/** The hosts THIS deployment would serve the name at — one per zone it serves; equality, never a suffix. */
const ownHostsFor = (name: string, env: SubjectAddressEnv): string[] => env.ownDomains.map((d) => hostForName(name, d, env.parents)).filter((h): h is string => !!h);

export function subjectAddress(name: string | null, records: NameRecordsLite | null, env: SubjectAddressEnv): SubjectAddress {
  if (!name) return { where: 'nowhere', refused: 'it has no name in the registry, so nothing says where it is asked' };
  if (!records) return { where: 'nowhere', refused: `the registry names no agent called “${name}”` };
  const endpoint = (records.a2aEndpoint ?? '').trim();
  const cardUri = (records.cardUri ?? '').trim();
  const cardUrl = cardUri || (endpoint && originOf(endpoint) ? `${originOf(endpoint)}/.well-known/agent-card.json` : '');
  if (!cardUrl) {
    return env.servesUnpublished
      ? { where: 'here', because: `${name} publishes no endpoint; this deployment serves the estate's unpublished names` }
      : { where: 'nowhere', refused: `${name} publishes no A2A endpoint or card in its records, and this deployment serves only names that publish one` };
  }
  const own = env.ownIngress ? originOf(env.ownIngress) : null;
  if (endpoint && own && originOf(endpoint) === own) return { where: 'here', because: `${name}'s records name this deployment's ingress ${own}` };
  const mine = ownHostsFor(name, env);
  if ([hostOf(endpoint), hostOf(cardUrl)].some((h) => !!h && mine.includes(h))) return { where: 'here', because: `${name}'s records name the host this deployment serves it at` };
  const pin = (records.cardDigest ?? '').trim();
  return { where: 'wire', cardUrl, ...(/^0x[0-9a-f]{64}$/i.test(pin) ? { pinnedDigest: pin.toLowerCase() } : {}) };
}

/** `A2A_SERVES_UNPUBLISHED_NAMES` — "false" says no; unset or anything else says yes (every deployment did, until a second one existed). */
export function servesUnpublishedNames(env: { A2A_SERVES_UNPUBLISHED_NAMES?: string }): boolean {
  return (env.A2A_SERVES_UNPUBLISHED_NAMES ?? '').trim().toLowerCase() !== 'false';
}

export interface NameRecordsEnv {
  RPC_URL?: string; CHAIN_ID?: string; AGENT_NAME_REGISTRY?: string; AGENT_NAME_UNIVERSAL_RESOLVER?: string; PROFILE_RESOLVER?: string;
}

// A short per-isolate memory of what a name publishes — the canonical answer, held briefly (ADR-0013 allows
// a cache-first read); a routed run with several steps at one subject reads the chain once, not per step.
const RECORDS_TTL_MS = 60_000;
const recent = new Map<string, { at: number; records: NameRecordsLite | null }>();

/** The records a name publishes (`a2aEndpoint`, `cardUri`, `cardDigest`), or null when the registry knows no such name. */
export function nameRecordsReader(env: NameRecordsEnv): ((name: string) => Promise<NameRecordsLite | null>) | null {
  if (!env.RPC_URL || !env.AGENT_NAME_REGISTRY || !env.AGENT_NAME_UNIVERSAL_RESOLVER) return null;
  const client = new AgentNamingClient({
    rpcUrl: env.RPC_URL, chainId: Number(env.CHAIN_ID), registry: env.AGENT_NAME_REGISTRY as Address,
    universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as Address, ...(env.PROFILE_RESOLVER ? { profileResolver: env.PROFILE_RESOLVER as Address } : {}),
  });
  return async (name) => {
    const key = name.trim().toLowerCase();
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < RECORDS_TTL_MS) return hit.records;
    const r = await client.getRecords(key).catch(() => null);
    const records: NameRecordsLite | null = r
      ? { ...(r.a2aEndpoint ? { a2aEndpoint: r.a2aEndpoint } : {}), ...(r.cardUri ? { cardUri: r.cardUri } : {}), ...(r.cardDigest ? { cardDigest: r.cardDigest } : {}) }
      : null;
    recent.set(key, { at: Date.now(), records });
    return records;
  };
}
