// `church.describe/1` (ap-church-directory spec 203 §2) — A CHURCH'S OWN DESCRIPTION, PUBLIC.
//
// Every agent that holds a `.church` name answers it, to anyone, with no credential: its name, what it says of
// itself, and the sites (campuses) a person may choose among. Two halves live here:
//
//   - THE ANSWER this runtime gives AS a church agent (`churchDescription`), mounted on the public lane beside
//     `library.public.list`; and
//   - THE QUESTION a person's agent asks OF a church before it keeps that person's choice (`askChurchDescribe`),
//     with the endpoint discovery §2 prescribes and the checks a consumer must make of the answer.
//
// THE SOURCE OF THE ANSWER, and why it is this one. A church on this runtime has two public facts to speak from:
//   1. its NAME RECORDS (on chain, owner-written): displayName, description, siteUrl → `church.*`; and
//   2. an optional CHURCH PROFILE in its own vault, `faith.church-profile:current`, written by its steward under the
//      church's own grant (the `vault:faith.*` scope every agent's grant already carries): `website`, `timezone`,
//      `description`, `sites[]` in §2's shape.
// A church with no profile answers with its name alone and `sites: []` — the true answer ("this church lists no
// sites"), never an error. Nothing about people is read or returned: the profile's sites are sanitised to the §2
// keys, so a steward who wrote a roster into the record would not publish it here.
//
// GROUPS (ap-church spec 204 §1). The same answer may list the church's groups — a home group, a men's group — under
// `groups`, an optional addition to church.describe/1: what the group is and when and where it meets, never who is
// in it or who leads it. A person's agent reads them here before it keeps that person's own groups.
import type { Address } from 'viem';

export const CHURCH_DESCRIBE = 'church.describe' as const;
export const CHURCH_DESCRIBE_PROTOCOL = 'church.describe/1' as const;
export const CHURCH_NS = 'https://churchcore.ai/ontology/church#';
/** The church's own public profile, in its own vault. `faith.` so the church's existing grant covers it. */
export const CHURCH_PROFILE_KEY = 'faith.church-profile:current';

/** The card entry — advertised ONLY on a church agent's card (an over-claiming card is worse than a silent one). */
export const CHURCH_DESCRIBE_SKILL = {
  id: CHURCH_DESCRIBE,
  name: 'Describe this church',
  description: 'This church’s own public description: its name, what it says of itself, its website, the sites (campuses) a person may choose among, each with an address, time zone and service times when published, and the groups it lists (what each is, when and where it meets). No credential: SendMessage with a data part { "skill": "church.describe" }; the answer is a message whose data part carries `protocol: "church.describe/1"`, `church`, `sites` and `groups`. Nothing about people.',
  tags: ['church', 'public', 'a2a'],
};

export interface ChurchSiteV1 {
  id: string;
  '@type'?: string;
  name: string;
  address?: Record<string, string>;
  timezone?: string;
  website?: string;
  services?: Array<{ day: string; time: string; durationMinutes?: number }>;
}
/** Spec 204 §1 — the kinds a group may say it is; anything else is kept as `other`. */
export const CHURCH_GROUP_KINDS = ['home', 'men', 'women', 'couples', 'youth', 'young-adults', 'bible-study', 'prayer', 'serving', 'other'] as const;
export type ChurchGroupKind = (typeof CHURCH_GROUP_KINDS)[number];
export interface ChurchGroupV1 {
  id: string;
  '@type'?: string;
  name: string;
  kind: ChurchGroupKind;
  description?: string;
  /** When it meets, in the church's own words ("Thursdays 6:30 AM"). */
  schedule?: string;
  /** Where it meets, in the church's own words. Never a private home's address unless the church published it. */
  location?: string;
  /** The id of the site it belongs to, when it belongs to one. */
  site?: string;
}
export interface ChurchDescriptionV1 {
  skill: typeof CHURCH_DESCRIBE;
  protocol: typeof CHURCH_DESCRIBE_PROTOCOL;
  '@type': string;
  church: { agent: string; name?: string; displayName: string; description?: string; website?: string; timezone?: string };
  sites: ChurchSiteV1[];
  /** Spec 204 §1 — optional; absent means the same as empty. */
  groups?: ChurchGroupV1[];
  updatedAt: string;
}

const s = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ADDRESS_KEYS = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'] as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** §2's site shape and nothing else: unknown keys are dropped, a site without an id and a name is not a site. */
export function sanitizeSites(raw: unknown): ChurchSiteV1[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChurchSiteV1[] = [];
  for (const r of raw.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = s(o.id, 120);
    const name = s(o.name, 200);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const address = o.address && typeof o.address === 'object'
      ? Object.fromEntries(ADDRESS_KEYS.map((k) => [k, s((o.address as Record<string, unknown>)[k], 200)] as const).filter(([, v]) => v))
      : {};
    const services = Array.isArray(o.services)
      ? o.services.flatMap((x) => {
        const sv = (x ?? {}) as Record<string, unknown>;
        const day = DAYS.find((d) => d.toLowerCase() === s(sv.day).toLowerCase());
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s(sv.time)) ? s(sv.time) : '';
        if (!day || !time) return [];
        const mins = Number(sv.durationMinutes);
        return [{ day, time, ...(Number.isFinite(mins) && mins > 0 && mins < 24 * 60 ? { durationMinutes: Math.round(mins) } : {}) }];
      })
      : [];
    out.push({
      id, '@type': `${CHURCH_NS}Campus`, name,
      ...(Object.keys(address).length ? { address } : {}),
      ...(s(o.timezone, 64) ? { timezone: s(o.timezone, 64) } : {}),
      ...(URL_RE.test(s(o.website)) ? { website: s(o.website) } : {}),
      ...(services.length ? { services } : {}),
    });
  }
  return out;
}

export const groupKindOf = (v: unknown): ChurchGroupKind => {
  const k = s(v, 40).toLowerCase().replace(/[\s_]+/g, '-');
  return (CHURCH_GROUP_KINDS as readonly string[]).includes(k) ? (k as ChurchGroupKind) : 'other';
};

/** Spec 204 §1's group shape and nothing else: unknown keys (a roster, a leader, a phone number) are dropped; a group
 *  without an id and a name is not a group; a `site` the church does not list is left off. */
export function sanitizeGroups(raw: unknown, sites: ReadonlyArray<{ id: string }> = []): ChurchGroupV1[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChurchGroupV1[] = [];
  for (const r of raw.slice(0, 500)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = s(o.id, 180);
    const name = s(o.name, 200);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const site = s(o.site, 180);
    out.push({
      id, '@type': `${CHURCH_NS}ChurchGroup`, name, kind: groupKindOf(o.kind),
      ...(s(o.description, 1000) ? { description: s(o.description, 1000) } : {}),
      ...(s(o.schedule, 200) ? { schedule: s(o.schedule, 200) } : {}),
      ...(s(o.location, 200) ? { location: s(o.location, 200) } : {}),
      ...(site && sites.some((x) => x.id === site) ? { site } : {}),
    });
  }
  return out;
}

export interface ChurchDescribeDeps {
  /** The agent's declared type (`atl:agentType`), on chain. */
  agentTypeOf: (agent: string) => Promise<string | null>;
  /** The agent's primary name (reverse resolution, round-trip checked). */
  nameOf: (agent: string) => Promise<string | null>;
  /** The name's public text records. */
  nameRecords: (name: string) => Promise<{ displayName?: string; description?: string; siteUrl?: string } | null>;
  /** One record from the agent's OWN vault (the public lane's reader). */
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  now?: () => Date;
}

/**
 * The answer to `church.describe`, AS `agent`. A non-church agent is answered that it is not one (a message, not a
 * description); a church with nothing published answers its name and `sites: []`. Returned with `answer` (the text
 * part) beside the description — the lane puts `answer` in the text part and the rest in the data part.
 */
export async function churchDescription(deps: ChurchDescribeDeps, agent: Address | string): Promise<Record<string, unknown>> {
  const who = agent.toLowerCase();
  const type = (await deps.agentTypeOf(who).catch(() => null))?.toLowerCase() ?? null;
  if (type !== 'church') {
    return { refused: 'not_a_church', agent: who, answer: 'This agent is not a church, so it has no church description.' };
  }
  const name = (await deps.nameOf(who).catch(() => null)) ?? null;
  const records = name ? await deps.nameRecords(name).catch(() => null) : null;
  const profile = (await deps.readSubjectRecord?.(who, CHURCH_PROFILE_KEY).catch(() => null)) as Record<string, unknown> | null | undefined;
  const p = profile && typeof profile === 'object' ? profile : {};
  const displayName = s(records?.displayName, 200) || s(p.displayName, 200) || name || who;
  const description = s(p.description, 2000) || s(records?.description, 2000);
  const website = [s(p.website), s(records?.siteUrl)].find((u) => URL_RE.test(u));
  const timezone = s(p.timezone, 64);
  const sites = sanitizeSites(p.sites);
  const groups = sanitizeGroups(p.groups, sites);
  const updatedAt = s(p.updatedAt, 40) || (deps.now ? deps.now() : new Date()).toISOString();
  const out: ChurchDescriptionV1 = {
    skill: CHURCH_DESCRIBE,
    protocol: CHURCH_DESCRIBE_PROTOCOL,
    '@type': `${CHURCH_NS}ChurchDescription`,
    church: { agent: who, ...(name ? { name } : {}), displayName, ...(description ? { description } : {}), ...(website ? { website } : {}), ...(timezone ? { timezone } : {}) },
    sites,
    groups,
    updatedAt,
  };
  const said = (sites.length
    ? `${displayName} meets at ${sites.length} site${sites.length === 1 ? '' : 's'}: ${sites.map((x) => x.name).join(', ')}.`
    : `${displayName} lists no separate sites.`)
    + (groups.length ? ` It lists ${groups.length} group${groups.length === 1 ? '' : 's'}.` : '');
  return { ...out, answer: said };
}

// ── The consumer's half: ask a church for its description, as §2 says to ────────────────────────────────────────────

export interface ChurchNameRecordsV1 { addr?: string; a2aEndpoint?: string; cardUri?: string }
export type DescribeOutcome = { ok: true; description: ChurchDescriptionV1; endpoint: string } | { ok: false; reason: string };

const originOf = (u: string): string | null => { try { return new URL(u).origin; } catch { return null; } };

/**
 * §2's endpoint discovery: the `cardUri` record, else `<origin of a2aEndpoint>/.well-known/agent-card.json`; the card's
 * JSONRPC interface url; with no card, the `a2aEndpoint` itself. Then one `SendMessage` with the data part
 * `{ skill: "church.describe" }`, and the answer's data part carrying `protocol: "church.describe/1"`.
 * The caller checks `church.agent` against the name's `addr` — this only reads.
 */
export async function askChurchDescribe(fetcher: typeof fetch, records: ChurchNameRecordsV1, opts: { timeoutMs?: number } = {}): Promise<DescribeOutcome> {
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? 8_000);
  const cardUrl = s(records.cardUri) || (records.a2aEndpoint && originOf(records.a2aEndpoint) ? `${originOf(records.a2aEndpoint)}/.well-known/agent-card.json` : '');
  let endpoint = '';
  if (cardUrl && URL_RE.test(cardUrl)) {
    const card = await fetcher(cardUrl, { headers: { accept: 'application/json' }, signal: timeout() })
      .then(async (r) => (r.ok ? ((await r.json()) as { supportedInterfaces?: Array<{ protocolBinding?: string; url?: string }> }) : null))
      .catch(() => null);
    endpoint = s(card?.supportedInterfaces?.find((i) => String(i?.protocolBinding ?? '').toUpperCase() === 'JSONRPC')?.url);
  }
  if (!URL_RE.test(endpoint)) endpoint = s(records.a2aEndpoint);
  if (!URL_RE.test(endpoint)) return { ok: false, reason: 'it publishes no address to ask it at' };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data: { skill: CHURCH_DESCRIBE } }] } } };
  type RpcReply = { result?: Record<string, unknown>; error?: { message?: string } };
  let body = null as RpcReply | null;
  try {
    const r = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify(rpc), signal: timeout() });
    body = (await r.json().catch(() => null)) as RpcReply | null;
    if (!r.ok && !body?.result) return { ok: false, reason: `it answered ${r.status}${body?.error?.message ? ` (${body.error.message})` : ''}` };
  } catch (e) {
    return { ok: false, reason: `it could not be reached (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!body?.result) return { ok: false, reason: body?.error?.message ? `it refused: ${body.error.message}` : 'it sent no answer' };
  // A message is the result itself (A2A 1.0) or wrapped as `{ message }`.
  const msg = ((body.result as { message?: unknown }).message ?? body.result) as { parts?: Array<{ data?: unknown }> };
  const data = (msg.parts ?? []).map((p) => p?.data).find((d): d is Record<string, unknown> => !!d && typeof d === 'object' && (d as { protocol?: unknown }).protocol === CHURCH_DESCRIBE_PROTOCOL);
  if (!data) return { ok: false, reason: 'it does not answer church.describe' };
  const church = (data.church ?? {}) as Record<string, unknown>;
  const agent = s(church.agent, 42).toLowerCase();
  const displayName = s(church.displayName, 200);
  if (!/^0x[0-9a-f]{40}$/.test(agent) || !displayName) return { ok: false, reason: 'its description does not say which agent it is, or its name' };
  const sites = sanitizeSites(data.sites);
  return {
    ok: true, endpoint,
    description: {
      skill: CHURCH_DESCRIBE, protocol: CHURCH_DESCRIBE_PROTOCOL, '@type': s(data['@type']) || `${CHURCH_NS}ChurchDescription`,
      church: { agent, displayName, ...(s(church.name) ? { name: s(church.name) } : {}) },
      sites,
      groups: sanitizeGroups(data.groups, sites),
      updatedAt: s(data.updatedAt, 40),
    },
  };
}
