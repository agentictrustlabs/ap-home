import { describe, it, expect } from 'vitest';
import { churchHomeInvoker, CHURCH_HOME_GET, CHURCH_HOME_SAVE, CHURCH_HOME_KEY, CHURCH_HOME_CLASS } from '../src/church-home.js';
import { churchDescription, CHURCH_DESCRIBE_PROTOCOL, CHURCH_PROFILE_KEY } from '../src/church-describe.js';
import { publicLaneSkillOf } from '../src/standard-a2a.js';

const ALICE = '0x' + 'a'.repeat(40);
const CALVARY = '0x' + 'c'.repeat(40);
const HOUSE = '0x' + 'd'.repeat(40);
const IMPOSTOR = '0x' + 'e'.repeat(40);

function vault(opts: { denyWrites?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const k = (s: string, t: string) => `${s.toLowerCase()}|${t}`;
  return {
    rows,
    readSubjectRecord: async (s: string, t: string) => rows.get(k(s, t)) ?? null,
    writeSubjectRecord: async (s: string, t: string, r: unknown) => {
      if (opts.denyWrites) return { ok: false, error: 'record_scope_denied: vault:faith.church-home:current' };
      rows.set(k(s, t), r);
      return { ok: true };
    },
  };
}
const turn = (goal = 'x') => ({ intent: { goal, context: {} }, step: { id: 's0' }, index: 0, supplied: [] }) as never;

const CALVARY_SITES = [
  { id: 'campus_erie', name: 'Erie', address: { addressLocality: 'Erie', addressRegion: 'CO' }, services: [{ day: 'Sunday', time: '09:30' }] },
  { id: 'campus_boulder', name: 'Boulder' },
];

const CALVARY_GROUPS = [
  { id: 'group_mens', name: 'Men’s Group', kind: 'men', schedule: 'Thursdays 6:30 AM', site: 'campus_erie', leader: 'Tom', members: ['Bob'] },
  { id: 'group_erie_home', name: 'Erie Home Group', kind: 'Home' },
];

/** The network boundary: the naming service, each church's card, and its A2A endpoint. */
function network(over: { names?: Record<string, unknown>; describe?: Record<string, unknown>; down?: boolean; noCard?: boolean } = {}) {
  const calls: string[] = [];
  const names: Record<string, unknown> = {
    'calvary-bible-co.church': nameAnswer(CALVARY, 'https://calvary.example/api/a2a', 'https://calvary.example/.well-known/agent-card.json'),
    'fort-morgan-household.church': nameAnswer(HOUSE, 'https://fort-morgan-household-church.faithnet.ai/api/a2a', over.noCard ? undefined : 'https://fort-morgan-household-church.faithnet.ai/.well-known/agent-card.json'),
    ...over.names,
  };
  const describe: Record<string, unknown> = {
    'https://edge.example/api/a2a/calvary-bible-co.church': describeAnswer(CALVARY, 'Calvary Bible Church', CALVARY_SITES, CALVARY_GROUPS),
    'https://edge.example/api/a2a/fort-morgan-household.church': describeAnswer(HOUSE, 'Fort Morgan household church', []),
    'https://fort-morgan-household-church.faithnet.ai/api/a2a': describeAnswer(HOUSE, 'Fort Morgan household church', []),
    ...over.describe,
  };
  const fetcher = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (over.down) throw new TypeError('network down');
    const nm = /\/api\/name\/(.+)$/.exec(url);
    if (nm) {
      const hit = names[decodeURIComponent(nm[1]!)];
      return new Response(JSON.stringify(hit ?? { status: 'available', records: [] }), { status: 200 });
    }
    if (url.endsWith('/.well-known/agent-card.json')) {
      if (over.noCard) return new Response('not found', { status: 404 });
      const handle = url.includes('calvary') ? 'calvary-bible-co.church' : 'fort-morgan-household.church';
      return new Response(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `https://edge.example/api/a2a/${handle}` }] }), { status: 200 });
    }
    if (init?.method === 'POST' && describe[url]) {
      const sent = JSON.parse(String(init.body));
      expect(sent.params.message.parts[0].data.skill).toBe('church.describe');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: describe[url] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}
function nameAnswer(agent: string, a2aEndpoint: string, cardUri?: string, agentType = 'church') {
  return {
    status: 'registered', declared: { agentType }, typeCheck: { ok: agentType === 'church' },
    records: [{ key: 'addr', value: agent.toUpperCase().replace('0X', '0x') }, { key: 'a2aEndpoint', value: a2aEndpoint }, ...(cardUri ? [{ key: 'cardUri', value: cardUri }] : [])],
  };
}
function describeAnswer(agent: string, displayName: string, sites: unknown[], groups?: unknown[]) {
  return {
    messageId: 'm', role: 'ROLE_AGENT',
    parts: [{ text: `${displayName}.` }, { data: { skill: 'church.describe', protocol: CHURCH_DESCRIBE_PROTOCOL, church: { agent, displayName }, sites, ...(groups ? { groups } : {}), updatedAt: '2026-11-04T00:00:00.000Z' } }],
  };
}

describe('person.church.home — her choice of church, checked against the church', () => {
  it('keeps a church and the site it lists, with the names beside the ids; get reads it back', async () => {
    const v = vault();
    const net = network();
    const inv = churchHomeInvoker({ ...v, fetch: net.fetcher, namesOrigin: 'https://names.example', now: () => new Date('2026-11-04T12:00:00Z') }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [{ agent: CALVARY, name: 'calvary-bible-co.church', site: 'campus_erie' }] }, turn())) as { saved: unknown; answer: string };
    expect(out.answer).toMatch(/Calvary Bible Church \(Erie\)/);
    const stored = v.rows.get(`${ALICE}|${CHURCH_HOME_KEY}`) as Record<string, unknown>;
    expect(stored).toMatchObject({
      '@type': CHURCH_HOME_CLASS, aboutSubject: ALICE, defaultChurch: CALVARY, updatedAt: '2026-11-04T12:00:00.000Z',
      churches: [{ agent: CALVARY, name: 'calvary-bible-co.church', displayName: 'Calvary Bible Church', site: { id: 'campus_erie', name: 'Erie' } }],
    });
    // The church was asked at the endpoint its card names, not at a guess.
    expect(net.calls).toContain('POST https://edge.example/api/a2a/calvary-bible-co.church');
    const got = (await inv(CHURCH_HOME_GET, {}, turn())) as { churches: unknown[]; defaultChurch: string; answer: string };
    expect(got.churches).toEqual([{ agent: CALVARY, name: 'calvary-bible-co.church', displayName: 'Calvary Bible Church', site: { id: 'campus_erie', name: 'Erie' } }]);
    expect(got.defaultChurch).toBe(CALVARY);
    expect(got.answer).toMatch(/Your church is Calvary Bible Church \(Erie\)/);
  });

  it('accepts churches as a JSON string (every argument from the Seed reader is a string), and site null means all sites', async () => {
    const v = vault();
    const inv = churchHomeInvoker({ ...v, fetch: network().fetcher }, ALICE, ALICE);
    const churches = JSON.stringify([{ agent: CALVARY, name: 'calvary-bible-co.church', site: null }, { agent: HOUSE, name: 'fort-morgan-household.church' }]);
    await inv(CHURCH_HOME_SAVE, { churches, defaultChurch: HOUSE }, turn());
    const stored = v.rows.get(`${ALICE}|${CHURCH_HOME_KEY}`) as { churches: Array<{ site: unknown; displayName: string }>; defaultChurch: string };
    expect(stored.churches.map((c) => [c.displayName, c.site])).toEqual([['Calvary Bible Church', null], ['Fort Morgan household church', null]]);
    expect(stored.defaultChurch).toBe(HOUSE);
  });

  it('get answers an empty choice when nothing was kept', async () => {
    const inv = churchHomeInvoker({ ...vault(), fetch: network().fetcher }, ALICE, ALICE);
    const got = (await inv(CHURCH_HOME_GET, {}, turn())) as { churches: unknown[]; defaultChurch: unknown; answer: string };
    expect(got).toMatchObject({ churches: [], defaultChurch: null, answer: 'You have not chosen a church yet.' });
  });

  it('a church with more than one site and no site chosen is refused, naming its sites (campus_required)', async () => {
    const v = vault();
    const inv = churchHomeInvoker({ ...v, fetch: network().fetcher }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: JSON.stringify([{ agent: CALVARY, name: 'calvary-bible-co.church' }]) }, turn())) as { refused: string; code: string };
    expect(out.code).toBe('campus_required');
    expect(out.refused).toMatch(/2 sites.*Erie \(campus_erie\), Boulder \(campus_boulder\)/);
    expect(v.rows.size).toBe(0);
  });

  it('a site the church does not list is refused', async () => {
    const v = vault();
    const inv = churchHomeInvoker({ ...v, fetch: network().fetcher }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [{ agent: CALVARY, name: 'calvary-bible-co.church', site: 'campus_mars' }] }, turn())) as { refused: string };
    expect(out.refused).toMatch(/does not list a site "campus_mars"/);
    expect(v.rows.size).toBe(0);
  });

  it('an unknown church is refused: a name that does not exist, or one pointing at another agent', async () => {
    const v = vault();
    const inv = churchHomeInvoker({ ...v, fetch: network().fetcher }, ALICE, ALICE);
    expect(((await inv(CHURCH_HOME_SAVE, { churches: [{ agent: CALVARY, name: 'no-such.church' }] }, turn())) as { refused: string }).refused).toMatch(/not a church I know/);
    expect(((await inv(CHURCH_HOME_SAVE, { churches: [{ agent: IMPOSTOR, name: 'calvary-bible-co.church', site: null }] }, turn())) as { refused: string }).refused).toMatch(/not a church I know/);
    expect(v.rows.size).toBe(0);
  });

  it('a name whose agent does not declare itself a church is refused', async () => {
    const v = vault();
    const net = network({ names: { 'shop.church': nameAnswer(IMPOSTOR, 'https://shop.example/api/a2a', undefined, 'org') } });
    const inv = churchHomeInvoker({ ...v, fetch: net.fetcher }, ALICE, ALICE);
    expect(((await inv(CHURCH_HOME_SAVE, { churches: [{ agent: IMPOSTOR, name: 'shop.church' }] }, turn())) as { refused: string }).refused).toMatch(/does not say it is a church/);
    expect(v.rows.size).toBe(0);
  });

  it('a describe answer that names another agent is not trusted', async () => {
    const v = vault();
    const net = network({ describe: { 'https://edge.example/api/a2a/calvary-bible-co.church': describeAnswer(IMPOSTOR, 'Calvary Bible Church', CALVARY_SITES) } });
    const inv = churchHomeInvoker({ ...v, fetch: net.fetcher }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [{ agent: CALVARY, name: 'calvary-bible-co.church', site: 'campus_erie' }] }, turn())) as { refused: string };
    expect(out.refused).toMatch(/answered for a different agent/);
    expect(v.rows.size).toBe(0);
  });

  it('with no card, the church is asked at its a2aEndpoint itself', async () => {
    const v = vault();
    const net = network({ noCard: true });
    // No cardUri record: the card is looked for at the endpoint's origin; there is none there either.
    const inv = churchHomeInvoker({ ...v, fetch: net.fetcher }, ALICE, ALICE);
    await inv(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }] }, turn());
    expect(net.calls).toContain('GET https://fort-morgan-household-church.faithnet.ai/.well-known/agent-card.json');
    expect(net.calls).toContain('POST https://fort-morgan-household-church.faithnet.ai/api/a2a');
    expect((v.rows.get(`${ALICE}|${CHURCH_HOME_KEY}`) as { churches: unknown[] }).churches).toHaveLength(1);
  });

  it('the naming service unreachable: nothing saved, said plainly', async () => {
    const v = vault();
    const inv = churchHomeInvoker({ ...v, fetch: network({ down: true }).fetcher }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }] }, turn())) as { refused: string };
    expect(out.refused).toMatch(/could not be read just now.*nothing was saved/);
    expect(v.rows.size).toBe(0);
  });

  it('a default church outside the list is refused; a grant without the faith scope says to refresh it', async () => {
    const inv = churchHomeInvoker({ ...vault(), fetch: network().fetcher }, ALICE, ALICE);
    expect(((await inv(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }], defaultChurch: CALVARY }, turn())) as { refused: string }).refused).toMatch(/default church must be one of/);
    const denied = churchHomeInvoker({ ...vault({ denyWrites: true }), fetch: network().fetcher }, ALICE, ALICE);
    await expect(denied(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }] }, turn())).rejects.toThrow(/refresh the grant/);
  });

  it('is kept by her own agent only, and only on her turn', async () => {
    const inv = churchHomeInvoker({ ...vault(), fetch: network().fetcher }, ALICE, CALVARY);
    expect(((await inv(CHURCH_HOME_GET, {}, turn())) as { refused: string }).refused).toMatch(/your own agent only/);
    const unattended = churchHomeInvoker({ ...vault(), fetch: network().fetcher }, ALICE, ALICE);
    await expect(unattended(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }] }, { intent: { goal: 'x', context: { trigger: 'routine:daily' } }, step: { id: 's0' }, index: 0, supplied: [] } as never)).rejects.toThrow();
  });
});

describe('person.church.home — her groups, kept beside her church (spec 204)', () => {
  const NOW = () => new Date('2026-11-04T12:00:00Z');
  const erie = { agent: CALVARY, name: 'calvary-bible-co.church', site: 'campus_erie' };
  const setup = () => {
    const v = vault();
    const net = network();
    return { v, inv: churchHomeInvoker({ ...v, fetch: net.fetcher, namesOrigin: 'https://names.example', now: NOW }, ALICE, ALICE) };
  };
  const stored = (v: ReturnType<typeof vault>) => v.rows.get(`${ALICE}|${CHURCH_HOME_KEY}`) as { groups: unknown[] };

  it('keeps a group her church lists under the church’s own name for it, and a group of her own under hers', async () => {
    const { v, inv } = setup();
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: JSON.stringify([{ church: CALVARY, id: 'group_mens', name: 'Wrong name', kind: 'women' }, { name: '  Thursday   friends ', kind: 'home' }]) }, turn())) as { answer: string };
    expect(stored(v).groups).toEqual([
      { id: 'group_mens', name: 'Men’s Group', kind: 'men', church: CALVARY },
      { id: 'own-thursday-friends', name: 'Thursday friends', kind: 'home', church: null },
    ]);
    expect(out.answer).toMatch(/2 groups: Men’s Group, Thursday friends/);
    const got = (await inv(CHURCH_HOME_GET, {}, turn())) as { groups: unknown[]; answer: string };
    expect(got.groups).toEqual(stored(v).groups);
    expect(got.answer).toMatch(/Your groups: Men’s Group, Thursday friends/);
  });

  it('a save that does not mention groups keeps them (an app that only knows churches cannot wipe them)', async () => {
    const { v, inv } = setup();
    await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_erie_home' }, { name: 'Lunch prayer', kind: 'prayer' }] }, turn());
    await inv(CHURCH_HOME_SAVE, { churches: [{ ...erie, site: 'campus_boulder' }] }, turn());
    expect(stored(v).groups).toEqual([
      { id: 'group_erie_home', name: 'Erie Home Group', kind: 'home', church: CALVARY },
      { id: 'own-lunch-prayer', name: 'Lunch prayer', kind: 'prayer', church: null },
    ]);
  });

  it('leaving a church leaves its groups; her own groups stay', async () => {
    const { v, inv } = setup();
    await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_mens' }, { name: 'Lunch prayer' }] }, turn());
    await inv(CHURCH_HOME_SAVE, { churches: [{ agent: HOUSE, name: 'fort-morgan-household.church' }] }, turn());
    expect(stored(v).groups).toEqual([{ id: 'own-lunch-prayer', name: 'Lunch prayer', kind: 'other', church: null }]);
  });

  it('an empty list clears her groups', async () => {
    const { v, inv } = setup();
    await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_mens' }] }, turn());
    await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: '[]' }, turn());
    expect(stored(v).groups).toEqual([]);
  });

  it('a group the church does not list is refused, naming the ones it does; nothing is saved', async () => {
    const { v, inv } = setup();
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_secret' }] }, turn())) as { refused: string };
    expect(out.refused).toMatch(/does not list a group "group_secret".*Men’s Group \(group_mens\).*Nothing was saved/);
    expect(v.rows.size).toBe(0);
  });

  it('a group she already keeps stays, as it was kept, when its church stops listing it — her next save still works', async () => {
    const v = vault();
    const NOW = () => new Date('2026-11-04T12:00:00Z');
    const first = churchHomeInvoker({ ...v, fetch: network().fetcher, namesOrigin: 'https://names.example', now: NOW }, ALICE, ALICE);
    await first(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_mens' }] }, turn());
    // The church takes the men's group off its list.
    const later = network({ describe: { 'https://edge.example/api/a2a/calvary-bible-co.church': describeAnswer(CALVARY, 'Calvary Bible Church', CALVARY_SITES, [CALVARY_GROUPS[1]]) } });
    const inv = churchHomeInvoker({ ...v, fetch: later.fetcher, namesOrigin: 'https://names.example', now: NOW }, ALICE, ALICE);
    const out = (await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_mens' }, { church: CALVARY, id: 'group_erie_home' }] }, turn())) as { refused?: string };
    expect(out.refused).toBeUndefined();
    expect(stored(v).groups).toEqual([
      { id: 'group_mens', name: 'Men’s Group', kind: 'men', church: CALVARY },
      { id: 'group_erie_home', name: 'Erie Home Group', kind: 'home', church: CALVARY },
    ]);
    // Once left, it cannot be joined again: the church no longer lists it.
    await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [] }, turn());
    expect(((await inv(CHURCH_HOME_SAVE, { churches: [erie], groups: [{ church: CALVARY, id: 'group_mens' }] }, turn())) as { refused: string }).refused).toMatch(/does not list a group "group_mens"/);
  });

  it('a group of a church she has not chosen, a church with no groups, a nameless group and an unreadable list are refused', async () => {
    const { v, inv } = setup();
    const save = async (churches: unknown, groups: unknown) => ((await inv(CHURCH_HOME_SAVE, { churches, groups } as never, turn())) as { refused: string }).refused;
    expect(await save([erie], [{ church: HOUSE, id: 'x' }])).toMatch(/choose that church first/);
    expect(await save([{ agent: HOUSE, name: 'fort-morgan-household.church' }], [{ church: HOUSE, id: 'x' }])).toMatch(/lists no groups yet.*a group of your own/);
    expect(await save([erie], [{ kind: 'home' }])).toMatch(/needs a name/);
    expect(await save([erie], 'not json')).toMatch(/say which groups/);
    expect(v.rows.size).toBe(0);
  });

  it('a record written before groups reads back with none', async () => {
    const { v, inv } = setup();
    v.rows.set(`${ALICE}|${CHURCH_HOME_KEY}`, { churches: [{ agent: CALVARY, name: 'calvary-bible-co.church', displayName: 'Calvary Bible Church', site: null }], defaultChurch: CALVARY });
    expect(((await inv(CHURCH_HOME_GET, {}, turn())) as { groups: unknown[] }).groups).toEqual([]);
  });
});

describe('church.describe/1 — the answer a church agent gives', () => {
  const deps = (type: string | null, profile: unknown = null) => ({
    agentTypeOf: async () => type,
    nameOf: async () => 'fort-morgan-household.church',
    nameRecords: async () => ({ displayName: 'Fort Morgan household church', siteUrl: 'https://fortmorgan.example/' }),
    readSubjectRecord: async (_s: string, key: string) => (key === CHURCH_PROFILE_KEY ? profile : null),
    now: () => new Date('2026-11-04T00:00:00Z'),
  });

  it('is on the public lane', () => {
    expect(publicLaneSkillOf({ parts: [{ data: { skill: 'church.describe' } }] } as never)).toEqual({ skill: 'church.describe', args: {} });
  });

  it('a church with nothing published answers its name and sites: []', async () => {
    const out = await churchDescription(deps('church'), HOUSE);
    expect(out).toMatchObject({
      skill: 'church.describe', protocol: 'church.describe/1', '@type': 'https://churchcore.ai/ontology/church#ChurchDescription',
      church: { agent: HOUSE, name: 'fort-morgan-household.church', displayName: 'Fort Morgan household church', website: 'https://fortmorgan.example/' },
      sites: [], updatedAt: '2026-11-04T00:00:00.000Z',
    });
    expect(out.answer).toMatch(/lists no separate sites/);
  });

  it('a church profile adds its sites, sanitised to the standard keys (nothing about people leaves)', async () => {
    const out = (await churchDescription(deps('church', { timezone: 'America/Denver', sites: [{ id: 'main', name: 'Main', members: ['Bob'], services: [{ day: 'sunday', time: '10:00', leader: 'Pastor X' }, { day: 'Funday', time: '10:00' }] }, { name: 'no id' }] }), HOUSE)) as { church: Record<string, unknown>; sites: Array<Record<string, unknown>> };
    expect(out.church.timezone).toBe('America/Denver');
    expect(out.sites).toEqual([{ id: 'main', '@type': 'https://churchcore.ai/ontology/church#Campus', name: 'Main', services: [{ day: 'Sunday', time: '10:00' }] }]);
  });

  it('a church profile lists its groups — what each is and when it meets, never who is in it (spec 204)', async () => {
    const out = (await churchDescription(deps('church', { sites: [{ id: 'main', name: 'Main' }], groups: [
      { id: 'mens', name: 'Men’s Group', kind: 'men', schedule: 'Thursdays 6:30 AM', location: 'Room 2', site: 'main', leader: 'Tom', members: ['Bob'], phone: '555' },
      { id: 'quilters', name: 'Quilters', kind: 'craft', site: 'gone' },
      { name: 'no id' }, { id: 'mens', name: 'Twice' },
    ] }), HOUSE)) as { groups: unknown[]; answer: string };
    expect(out.groups).toEqual([
      { id: 'mens', '@type': 'https://churchcore.ai/ontology/church#ChurchGroup', name: 'Men’s Group', kind: 'men', schedule: 'Thursdays 6:30 AM', location: 'Room 2', site: 'main' },
      { id: 'quilters', '@type': 'https://churchcore.ai/ontology/church#ChurchGroup', name: 'Quilters', kind: 'other' },
    ]);
    expect(out.answer).toMatch(/It lists 2 groups/);
    expect(((await churchDescription(deps('church'), HOUSE)) as { groups: unknown[] }).groups).toEqual([]);
  });

  it('an agent that is not a church does not describe itself as one', async () => {
    const out = await churchDescription(deps('person'), HOUSE);
    expect(out.protocol).toBeUndefined();
    expect(out.refused).toBe('not_a_church');
  });
});
