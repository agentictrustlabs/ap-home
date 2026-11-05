// HER CHURCH, AS HER RECORD (ap-church-directory spec 203 §3) — which church (and which of its sites) the person
// calls home, kept by HER agent in HER vault as `church:ChurchHomePreference`, record type `faith.church-home`, key
// `faith.church-home:current`. Every app that lets her choose a church (church-web, the Seed reader) reads through
// `person.church.home.get` and writes through `person.church.home.save`; none keeps its own copy.
//
// A PREFERENCE, NEVER MEMBERSHIP. Choosing a church grants nothing and tells the church nothing. But the choice is
// CHECKED before it is kept: each church is resolved by its `.church` name (the name must point at the agent and
// the agent must declare itself a church) and asked for its own description (`church.describe/1`), so a site the
// church does not list, an answer from another agent, or a church that is not one is refused in words — the record
// only ever names what the church itself said.
//
// HER GROUPS (ap-church spec 204 §2) ride the same record: the home group, the men's group she is part of. A group one
// of her churches lists is kept by the id the church gave it, with the church's own name for it; a group no church
// lists (friends who meet on Thursdays) is kept under the name she gives it. Naming a group tells the church nothing
// and makes her nobody's member — a roster is the church's own record, kept by the church.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { requirePersonsTurn } from './persons-turn.js';
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import { askChurchDescribe, groupKindOf, CHURCH_NS, type ChurchGroupKind, type ChurchGroupV1, type ChurchNameRecordsV1 } from './church-describe.js';

export const CHURCH_HOME_GET = 'person.church.home.get' as const;
export const CHURCH_HOME_SAVE = 'person.church.home.save' as const;
export const CHURCH_HOME_RECORD = 'faith.church-home' as const;
export const CHURCH_HOME_KEY = `${CHURCH_HOME_RECORD}:current`;
export const CHURCH_HOME_CLASS = `${CHURCH_NS}ChurchHomePreference`;
/** The FaithNet naming service (spec 203 §1). A deployment may name another through the deps. */
export const DEFAULT_NAMES_ORIGIN = 'https://names.faithnet.io';

export const CHURCH_HOME_TOOLS: ToolSpec[] = [
  {
    id: CHURCH_HOME_GET,
    answers: ['my church', 'which church do I go to', 'my home church', 'which campus do I attend', 'my groups', 'which groups am I in'],
    description: 'ANSWERS which church (and which of its sites) the person chose as home: each church\'s agent, .church name and display name, the site chosen (or null for all sites), and the default church; and the groups they are part of (a home group, a men\'s group), each with the church that lists it or null for a group of their own. Only for the person asking.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
  },
  {
    id: CHURCH_HOME_SAVE,
    verbs: ['my church is', 'I go to', 'set my home church', 'choose my campus', 'I attend'],
    description: 'KEEPS the person\'s choice of church in their vault. churches: a JSON array [{"agent":"0x…","name":"<name>.church","site":"<site id>"|null}] — site is the id the church lists (from its church.describe answer), null for all sites; a church with more than one site needs a site or null. defaultChurch: the agent address of the main one (default: the first). Each church is checked against its .church name and its own description before anything is kept. groups (optional): a JSON array of the groups they are part of — {"church":"0x…","id":"<group id the church lists>"} for a church\'s group, or {"name":"…","kind":"home|men|women|couples|youth|young-adults|bible-study|prayer|serving|other"} for a group of their own; left out, the groups already kept stay; [] clears them. Their own record; tells the church nothing and authorizes nothing.',
    inputSchema: { type: 'object', properties: { churches: { type: 'string', description: 'JSON array of { agent, name, site? }' }, defaultChurch: { type: 'string' }, groups: { type: 'string', description: 'JSON array of { church, id } (a church\'s group) or { name, kind } (their own)' } }, required: ['churches'] },
    capability: { id: CHURCH_HOME_SAVE, action: 'save', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.churchHome,
    selfAuthorized: true,
  },
];
export const CHURCH_HOME_ACTS = new Set<string>([CHURCH_HOME_SAVE]);

export interface ChurchHomeDeps {
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown, operationId?: string) => Promise<{ ok: boolean; error?: string }>;
  /** THE NETWORK BOUNDARY: the naming service and each church's card and A2A endpoint. A fetch that reaches this
   *  Worker's own hosts in-process (a Worker cannot fetch its own hostname). */
  fetch?: typeof fetch;
  namesOrigin?: string;
  now?: () => Date;
}

export interface ChurchChoiceV1 { agent: string; name: string; displayName: string; site: { id: string; name: string } | null }
/** One group she is part of. `church` is the agent of the church that lists it, or null for a group of her own. */
export interface GroupChoiceV1 { id: string; name: string; kind: ChurchGroupKind; church: string | null }
export interface ChurchHomeRecordV1 {
  '@id': string; '@type': string; aboutSubject: string;
  churches: ChurchChoiceV1[]; defaultChurch: string | null; groups?: GroupChoiceV1[]; updatedAt: string;
}
export const MAX_GROUPS = 50;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CHURCH_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.church$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** `churches` as an array, or a JSON string of one (the Seed reader's server sends every argument as a string). */
function churchesArg(v: unknown): Array<Record<string, unknown>> | null {
  let raw: unknown = v;
  if (typeof v === 'string') { try { raw = JSON.parse(v); } catch { return null; } }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = [raw];
  return Array.isArray(raw) && raw.every((x) => !!x && typeof x === 'object') ? (raw as Array<Record<string, unknown>>) : null;
}

/** `groups` as an array or a JSON string of one; `undefined` when not said at all, `null` when unreadable. */
function groupsArg(v: unknown): Array<Record<string, unknown>> | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let raw: unknown = v;
  if (typeof v === 'string') { try { raw = JSON.parse(v); } catch { return null; } }
  return Array.isArray(raw) && raw.every((x) => !!x && typeof x === 'object') ? (raw as Array<Record<string, unknown>>) : null;
}
const keptGroups = (rec: ChurchHomeRecordV1 | null): GroupChoiceV1[] =>
  (rec && Array.isArray(rec.groups) ? rec.groups : [])
    .filter((g) => !!g && typeof g.id === 'string' && typeof g.name === 'string')
    .map((g) => ({ id: g.id, name: g.name, kind: groupKindOf(g.kind), church: typeof g.church === 'string' ? g.church.toLowerCase() : null }));
/** An id for a group of her own, from its name — the same name is the same group. */
const ownGroupId = (name: string) => `own-${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'group'}`;
const groupWords = (n: number) => `${n} group${n === 1 ? '' : 's'}`;

/** The site asked for: an id, `null` (all sites — said explicitly), or `undefined` (not said). */
function siteArg(o: Record<string, unknown>): string | null | undefined {
  if (!('site' in o) || o.site === undefined) return undefined;
  if (o.site === null) return null;
  const v = typeof o.site === 'object' ? str((o.site as { id?: unknown }).id) : str(o.site);
  if (!v) return undefined;
  return /^(null|all|all sites)$/i.test(v) ? null : v;
}

export function churchHomeInvoker(deps: ChurchHomeDeps, person: string | undefined, addressee: string | undefined): ToolInvoker {
  const now = () => (deps.now ? deps.now() : new Date());
  return async (toolId, args, ctx) => {
    if (!person) throw new Error('your church is kept as you, and there is no signed-in person on this run');
    const me = person.toLowerCase();
    if (addressee && addressee.toLowerCase() !== me) return { refused: 'your church is kept by your own agent only — ask at your home, not in this room' };
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('your church cannot be kept here (the private tier is not configured)');

    if (toolId === CHURCH_HOME_GET) {
      const rec = (await deps.readSubjectRecord(me, CHURCH_HOME_KEY).catch(() => null)) as ChurchHomeRecordV1 | null;
      const churches = rec && Array.isArray(rec.churches) ? rec.churches : [];
      const groups = keptGroups(rec);
      const def = churches.find((c) => c.agent === rec?.defaultChurch) ?? churches[0];
      return {
        tier: 'private',
        '@type': CHURCH_HOME_CLASS,
        churches: churches.map((c) => ({ agent: c.agent, name: c.name, displayName: c.displayName, site: c.site ? { id: c.site.id, name: c.site.name } : null })),
        defaultChurch: rec?.defaultChurch ?? null,
        groups,
        ...(rec?.updatedAt ? { updatedAt: rec.updatedAt } : {}),
        answer: (def ? `Your church is ${def.displayName}${def.site ? ` (${def.site.name})` : ''}${churches.length > 1 ? `, and ${churches.length - 1} other${churches.length === 2 ? '' : 's'}` : ''}.` : 'You have not chosen a church yet.')
          + (groups.length ? ` Your groups: ${groups.map((g) => g.name).join(', ')}.` : ''),
      };
    }

    if (toolId !== CHURCH_HOME_SAVE) throw new Error(`${toolId} is not a church-home capability`);
    requirePersonsTurn({ ctx, toolId, what: 'keep your choice of church' });
    const asked = churchesArg(args.churches);
    if (!asked) return { refused: 'say which church — churches is a list of { agent, name, site }' };
    const askedGroups = groupsArg(args.groups);
    if (askedGroups === null) return { refused: 'say which groups — groups is a list of { church, id } for a church\'s group or { name, kind } for one of your own. Nothing was saved.' };
    if (askedGroups && askedGroups.length > MAX_GROUPS) return { refused: `that is more than ${MAX_GROUPS} groups — keep the ones you are part of now. Nothing was saved.` };
    if (!deps.fetch) throw new Error('your church cannot be checked from here (no way to reach the naming service)');
    const namesOrigin = (deps.namesOrigin ?? DEFAULT_NAMES_ORIGIN).replace(/\/$/, '');

    const kept: ChurchChoiceV1[] = [];
    const listed = new Map<string, ChurchGroupV1[]>();
    for (const c of asked) {
      const agent = str(c.agent).toLowerCase();
      const name = str(c.name).toLowerCase();
      if (!ADDR.test(agent)) return { refused: `${name || 'one church'} has no agent address — choose it from the church list` };
      if (!CHURCH_NAME.test(name)) return { refused: `say the church's .church name for ${agent} — "${name || 'none'}" is not one` };
      if (kept.some((k) => k.agent === agent)) continue;

      // The name must point at this agent, and the agent must declare itself a church (spec 203 §1).
      const n = await deps.fetch(`${namesOrigin}/api/name/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
        .then(async (r) => (r.ok ? ((await r.json()) as { status?: string; records?: Array<{ key?: string; value?: string }>; declared?: { agentType?: string }; typeCheck?: { ok?: boolean } }) : null))
        .catch(() => undefined);
      if (n === undefined) return { refused: `the church list could not be read just now, so ${name} was not checked — nothing was saved; try again` };
      const rec = (k: string) => str(n?.records?.find((r) => r?.key === k)?.value);
      if (!n || n.status !== 'registered' || rec('addr').toLowerCase() !== agent) return { refused: `${name} is not a church I know — no such name points at that agent. Nothing was saved.` };
      if (n.declared?.agentType !== 'church' || n.typeCheck?.ok !== true) return { refused: `${name} does not say it is a church, so it cannot be your church. Nothing was saved.` };

      const records: ChurchNameRecordsV1 = { addr: rec('addr'), ...(rec('a2aEndpoint') ? { a2aEndpoint: rec('a2aEndpoint') } : {}), ...(rec('cardUri') ? { cardUri: rec('cardUri') } : {}) };
      const asked2 = await askChurchDescribe(deps.fetch, records);
      if (!asked2.ok) return { refused: `I asked ${name} for its sites and ${asked2.reason}, so your choice was not saved.` };
      const d = asked2.description;
      if (d.church.agent !== agent) return { refused: `${name} answered for a different agent than the one its name points at, so I did not trust it. Nothing was saved.` };

      const want = siteArg(c);
      let site: ChurchChoiceV1['site'] = null;
      if (typeof want === 'string') {
        const hit = d.sites.find((x) => x.id === want);
        if (!hit) return { refused: d.sites.length ? `${d.church.displayName} does not list a site "${want}" — its sites are ${d.sites.map((x) => `${x.name} (${x.id})`).join(', ')}. Nothing was saved.` : `${d.church.displayName} lists no sites, so "${want}" cannot be chosen — choose the church alone. Nothing was saved.` };
        site = { id: hit.id, name: hit.name };
      } else if (want === undefined) {
        // The campus_required rule: more than one site needs a choice — a site, or null for all of them.
        if (d.sites.length > 1) return { refused: `${d.church.displayName} meets at ${d.sites.length} sites — say which: ${d.sites.map((x) => `${x.name} (${x.id})`).join(', ')}, or all sites. Nothing was saved.`, code: 'campus_required', church: agent, sites: d.sites.map((x) => ({ id: x.id, name: x.name })) };
        if (d.sites.length === 1) site = { id: d.sites[0]!.id, name: d.sites[0]!.name };
      }
      kept.push({ agent, name, displayName: d.church.displayName, site });
      listed.set(agent, d.groups ?? []);
    }

    // Her groups. Not said: the ones already kept stay, except those of a church she no longer names. Said: each
    // church's group must be one that church lists today, and takes the church's own name for it.
    let groups: GroupChoiceV1[];
    if (askedGroups === undefined) {
      const before = (await deps.readSubjectRecord(me, CHURCH_HOME_KEY).catch(() => null)) as ChurchHomeRecordV1 | null;
      groups = keptGroups(before).filter((g) => g.church === null || kept.some((k) => k.agent === g.church));
    } else {
      groups = [];
      for (const g of askedGroups) {
        const church = str(g.church).toLowerCase();
        if (church) {
          const of = kept.find((k) => k.agent === church);
          if (!of) return { refused: 'a group belongs to one of your churches — choose that church first, then its group. Nothing was saved.' };
          const id = str(g.id);
          const hit = (listed.get(church) ?? []).find((x) => x.id === id);
          if (!hit) {
            const names = (listed.get(church) ?? []).map((x) => `${x.name} (${x.id})`);
            return { refused: names.length ? `${of.displayName} does not list a group "${id}" — its groups are ${names.join(', ')}. Nothing was saved.` : `${of.displayName} lists no groups yet, so "${id}" cannot be chosen — add it as a group of your own. Nothing was saved.` };
          }
          if (!groups.some((x) => x.church === church && x.id === hit.id)) groups.push({ id: hit.id, name: hit.name, kind: hit.kind, church });
        } else {
          const name = str(g.name).replace(/\s+/g, ' ').slice(0, 120);
          if (!name) return { refused: 'a group of your own needs a name. Nothing was saved.' };
          const id = /^own-[a-z0-9-]{1,80}$/.test(str(g.id)) ? str(g.id) : ownGroupId(name);
          if (!groups.some((x) => x.church === null && x.id === id)) groups.push({ id, name, kind: groupKindOf(g.kind), church: null });
        }
      }
    }

    const wantDefault = str(args.defaultChurch).toLowerCase();
    if (wantDefault && !kept.some((k) => k.agent === wantDefault)) return { refused: 'the default church must be one of the churches you chose. Nothing was saved.' };
    const defaultChurch = wantDefault || kept[0]?.agent || null;
    const record: ChurchHomeRecordV1 = { '@id': `urn:faith:${me}:church-home:current`, '@type': CHURCH_HOME_CLASS, aboutSubject: me, churches: kept, defaultChurch, groups, updatedAt: now().toISOString() };
    const wrote = await deps.writeSubjectRecord(me, CHURCH_HOME_KEY, record, ctx.operationId);
    if (!wrote.ok) throw new Error(/record_scope_denied|scope/i.test(wrote.error ?? '') ? 'your storage grant predates faith records — refresh the grant at your Home, then say it again' : (wrote.error ?? 'your choice of church could not be kept'));
    const def = kept.find((k) => k.agent === defaultChurch);
    return {
      saved: { recordType: CHURCH_HOME_RECORD, class: CHURCH_HOME_CLASS, churches: kept, defaultChurch, groups },
      answer: (def ? `Kept — your church is ${def.displayName}${def.site ? ` (${def.site.name})` : ''}${kept.length > 1 ? `, with ${kept.length - 1} more` : ''}` : 'Kept — you have no church chosen now')
        + (groups.length ? `, and ${groupWords(groups.length)}: ${groups.map((g) => g.name).join(', ')}` : '')
        + (def || groups.length ? '. It tells the church nothing.' : '.'),
    };
  };
}
