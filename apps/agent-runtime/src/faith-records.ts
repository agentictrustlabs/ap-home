// HER FAITH LIFE AS HER RECORDS — the person's own faith journey, prayers and care requests, kept by HER agent in HER
// vault as typed records of the faith ontology (~/skills ontology/faith.ttl §"The person's own faith records"). Any app
// — the Seed reader, the Church app — writes through these acts and reads through these reads; none keeps its own copy
// and none holds a write grant on her vault. The record type of each class is the faith domain's `skills:mapsRecordType`
// (faith.data.ttl); the fields are the class shape's `sh:name`s, so a record is readable BY the ontology.
//
// Disclosure lives on the record (`visibility` + `sharedWith`) and is applied HERE, in code, before anything reaches a
// planner or another agent: `person.faith.shared.view` returns only what a named audience may see. The person's own
// reads return everything — they are hers.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { requirePersonsTurn } from './persons-turn.js';
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import { validateRecord, type DomainShapeV1 } from './state-check.js';

export const FCI = 'https://ontology.faithchain.org/incubator#';
const AT = 'https://agentictrustlabs.dev/ns/agentic-trust#';

export const FAITH_CLASS = {
  stage: `${FCI}JourneyStageAssertion`,
  milestone: `${FCI}FaithMilestone`,
  prayer: `${FCI}PrayerRequest`,
  answered: `${FCI}AnsweredPrayerReport`,
  care: `${FCI}CareRequest`,
} as const;
type Kind = keyof typeof FAITH_CLASS;
/** faith.data.ttl `skills:mapsRecordType` — `<record type>:<id>` is the vault key. */
export const FAITH_RECORD = {
  stage: 'faith.journey-stage',
  milestone: 'faith.milestone',
  prayer: 'faith.prayer-request',
  answered: 'faith.answered-prayer',
  care: 'faith.care-request',
} as const satisfies Record<Kind, string>;

/** The JSON-LD context every faith record carries: its keys are the shapes' names, mapped to the ontology's terms. */
export const FAITH_CONTEXT = {
  fci: FCI, at: AT, prov: 'http://www.w3.org/ns/prov#', dcterms: 'http://purl.org/dc/terms/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  aboutSubject: { '@id': 'at:aboutSubject', '@type': '@id' }, attestedBy: { '@id': 'at:attestedBy', '@type': '@id' }, sharedWith: { '@id': 'fci:sharedWith', '@type': '@id' },
  stage: 'fci:assertsJourneyStage', milestone: 'fci:faithMilestone', assertedAt: 'prov:generatedAtTime', recordedAt: 'prov:generatedAtTime', answeredAt: 'prov:generatedAtTime',
  occurredOn: 'fci:occurredOn', place: 'fci:milestonePlace', note: 'fci:faithNote', visibility: 'fci:faithVisibility',
  label: 'rdfs:label', description: 'dcterms:description', kind: 'fci:prayerKind', status: 'at:intentStatus', prayingFor: 'fci:prayingFor', passage: 'fci:prayedFromPassage',
  prayedCount: 'fci:prayedCount', lastPrayedAt: 'fci:lastPrayedAt', answers: { '@id': 'fci:answersPrayerRequest', '@type': '@id' },
  urgency: 'fci:careUrgency', safeToText: 'fci:safeToText', createdAt: 'dcterms:created', updatedAt: 'dcterms:modified', removedAt: 'fci:removedAt',
} as const;

// ── The vocabularies (skos:notation of faith.data.ttl's concepts) ───────────────────────────────────────────────────
export const STAGES = ['Seeker', 'GospelClarity', 'Conversion', 'NewBeliever', 'Connected', 'Growing', 'Serving', 'Multiplying', 'Leader'] as const;
export const STAGE_LABEL: Record<(typeof STAGES)[number], string> = { Seeker: 'Seeker', GospelClarity: 'Understanding the gospel', Conversion: 'Deciding to follow Jesus', NewBeliever: 'New believer', Connected: 'Connected', Growing: 'Growing disciple', Serving: 'Serving', Multiplying: 'Multiplying', Leader: 'Leader' };
export const MILESTONES = ['UnderstoodGospel', 'ProfessionOfFaith', 'Baptized', 'JoinedGroup', 'FoundationsClass', 'StartedServing', 'SharedTestimony'] as const;
export const MILESTONE_LABEL: Record<(typeof MILESTONES)[number], string> = { UnderstoodGospel: 'Understood the gospel', ProfessionOfFaith: 'Professed faith in Jesus', Baptized: 'Baptized', JoinedGroup: 'Joined a group', FoundationsClass: 'Took a foundations class', StartedServing: 'Started serving', SharedTestimony: 'Shared their story' };
export const PRACTICE_LABEL: Record<string, string> = { Bible: 'Reading the Bible', Prayer: 'Prayer', WorshipGathering: 'Gathering for worship', Community: 'Life in community', Generosity: 'Generosity', Serving: 'Serving', Evangelism: 'Sharing faith', Sabbath: 'Sabbath rest', ScriptureMemory: 'Memorizing Scripture', Confession: 'Confession' };
export const VISIBILITIES = ['Confidential', 'Friends', 'LeadersOnly', 'BodyOnly', 'Open'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const PRAYER_KINDS = ['Request', 'Thanksgiving'] as const;
export const URGENCIES = ['Low', 'Normal', 'High'] as const;
export const STATUSES = ['expressed', 'fulfilled', 'withdrawn'] as const;

/** faith.data.ttl's next-step graph (fci:nextStage / fci:stageRequires / fci:stageRecommends), from ChurchCore's seed. */
export const NEXT_STEPS: Record<(typeof STAGES)[number], { next?: (typeof STAGES)[number]; requires: string[]; recommends: string[] }> = {
  Seeker: { next: 'GospelClarity', requires: [], recommends: ['practice:Prayer'] },
  GospelClarity: { next: 'Conversion', requires: ['milestone:UnderstoodGospel'], recommends: [] },
  Conversion: { next: 'NewBeliever', requires: ['milestone:ProfessionOfFaith'], recommends: [] },
  NewBeliever: { next: 'Connected', requires: ['practice:Bible', 'practice:Prayer'], recommends: [] },
  Connected: { next: 'Growing', requires: ['milestone:JoinedGroup'], recommends: [] },
  Growing: { next: 'Serving', requires: ['milestone:FoundationsClass'], recommends: [] },
  Serving: { next: 'Multiplying', requires: ['milestone:StartedServing'], recommends: [] },
  Multiplying: { next: 'Leader', requires: [], recommends: [] },
  Leader: { requires: [], recommends: [] },
};

// ── The shapes (faith.ttl's SHACL, flat). A playbook that carries the ontology's own `domainShapes` wins. ───────────
const f = (name: string, path: string, more: Partial<DomainShapeV1['fields'][number]> = {}) => ({ name, path, ...more });
const vis = f('visibility', `${FCI}faithVisibility`, { allowed: [...VISIBILITIES] });
export const FAITH_SHAPES: DomainShapeV1[] = [
  { class: FAITH_CLASS.stage, label: 'Journey Stage Assertion', fields: [f('aboutSubject', `${AT}aboutSubject`, { minCount: 1, maxCount: 1 }), f('stage', `${FCI}assertsJourneyStage`, { minCount: 1, maxCount: 1, allowed: [...STAGES] }), f('assertedAt', 'prov:generatedAtTime', { minCount: 1 }), vis] },
  { class: FAITH_CLASS.milestone, label: 'Faith Milestone', fields: [f('aboutSubject', `${AT}aboutSubject`, { minCount: 1, maxCount: 1 }), f('milestone', `${FCI}faithMilestone`, { minCount: 1, maxCount: 1, allowed: [...MILESTONES] }), f('recordedAt', 'prov:generatedAtTime', { minCount: 1 }), f('occurredOn', `${FCI}occurredOn`, { pattern: '^\\d{4}(-\\d{2}(-\\d{2})?)?$' }), vis] },
  { class: FAITH_CLASS.prayer, label: 'Prayer Request', fields: [f('aboutSubject', `${AT}aboutSubject`, { minCount: 1, maxCount: 1 }), f('label', 'rdfs:label', { minCount: 1, minLength: 1 }), f('kind', `${FCI}prayerKind`, { minCount: 1, allowed: [...PRAYER_KINDS] }), f('visibility', `${FCI}prayerVisibility`, { minCount: 1, allowed: [...VISIBILITIES] }), f('status', `${AT}intentStatus`, { minCount: 1, allowed: [...STATUSES] }), f('createdAt', 'dcterms:created', { minCount: 1 })] },
  { class: FAITH_CLASS.answered, label: 'Answered Prayer Report', fields: [f('answers', `${FCI}answersPrayerRequest`, { minCount: 1, maxCount: 1 }), f('aboutSubject', `${AT}aboutSubject`, { minCount: 1, maxCount: 1 }), f('answeredAt', 'prov:generatedAtTime', { minCount: 1 })] },
  { class: FAITH_CLASS.care, label: 'Care Request', fields: [f('aboutSubject', `${AT}aboutSubject`, { minCount: 1, maxCount: 1 }), f('label', 'rdfs:label', { minCount: 1, minLength: 1 }), f('urgency', `${FCI}careUrgency`, { minCount: 1, allowed: [...URGENCIES] }), f('status', `${AT}intentStatus`, { minCount: 1, allowed: [...STATUSES] }), f('createdAt', 'dcterms:created', { minCount: 1 })] },
];

export const FAITH_JOURNEY_GET = 'person.faith.journey.get' as const;
export const FAITH_JOURNEY_RECORD = 'person.faith.journey.record' as const;
export const FAITH_PRAYERS_LIST = 'person.faith.prayers.list' as const;
export const FAITH_PRAYER_SAVE = 'person.faith.prayer.save' as const;
export const FAITH_CARE_REQUEST = 'person.faith.care.request' as const;
export const FAITH_SHARED_VIEW = 'person.faith.shared.view' as const;

const text = { type: 'string' } as const;
export const FAITH_TOOLS: ToolSpec[] = [
  {
    id: FAITH_JOURNEY_GET,
    answers: ['my faith journey', 'where am I on my journey', 'my milestones', 'when was I baptized', 'my next step'],
    description: 'ANSWERS the person\'s own faith journey: the stage they last said (and its history), the milestones they recorded, and the next steps the faith ontology names for that stage. Only for the person asking.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
  },
  {
    id: FAITH_JOURNEY_RECORD,
    verbs: ['I was baptized', 'I decided to follow Jesus', 'I joined a group', 'I started serving', 'record my milestone', 'I am a new believer'],
    description: `RECORDS a step of the person's own faith journey in their vault: a stage they now say (stage: ${STAGES.join(' | ')}) or a milestone they reached (milestone: ${MILESTONES.join(' | ')}, occurredOn YYYY[-MM[-DD]], place, note), with who may see it (visibility: ${VISIBILITIES.join(' | ')}, default Confidential; sharedWith: comma-separated agent addresses). remove: the id of one they recorded. Their own record; authorizes nothing.`,
    inputSchema: { type: 'object', properties: { id: text, stage: { type: 'string', enum: [...STAGES] }, milestone: { type: 'string', enum: [...MILESTONES] }, occurredOn: text, place: text, note: text, visibility: { type: 'string', enum: [...VISIBILITIES] }, sharedWith: text, remove: text } },
    capability: { id: FAITH_JOURNEY_RECORD, action: 'record', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.faithJourney,
    selfAuthorized: true,
  },
  {
    id: FAITH_PRAYERS_LIST,
    answers: ['my prayers', 'my prayer list', 'what am I praying for', 'answered prayers', 'my care requests'],
    description: 'ANSWERS the person\'s own Care & Prayer list — prayers (requests and thanksgivings) with their status, answers, visibility and how often they prayed, and the care requests they sent. status (optional): expressed | fulfilled | withdrawn. Only for the person asking.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: [...STATUSES] } } },
    establishes: 'lookup',
  },
  {
    id: FAITH_PRAYER_SAVE,
    verbs: ['add a prayer', 'pray for', 'I prayed for', 'my prayer was answered', 'stop praying for', 'thank God for'],
    description: `KEEPS one of the person's prayers in their vault: add or edit (id, label, description, kind: ${PRAYER_KINDS.join(' | ')}, prayingFor, passage OSIS, visibility: ${VISIBILITIES.join(' | ')} — default Confidential, sharedWith), mark prayed (prayed: yes), mark answered (answered: their words), set status (${STATUSES.join(' | ')}), or remove (remove: yes). Notifies no one; authorizes nothing.`,
    inputSchema: { type: 'object', properties: { id: text, label: text, description: text, kind: { type: 'string', enum: [...PRAYER_KINDS] }, prayingFor: text, passage: text, visibility: { type: 'string', enum: [...VISIBILITIES] }, sharedWith: text, prayed: text, answered: text, status: { type: 'string', enum: [...STATUSES] }, remove: text } },
    capability: { id: FAITH_PRAYER_SAVE, action: 'save', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.prayer,
    selfAuthorized: true,
  },
  {
    id: FAITH_CARE_REQUEST,
    verbs: ['ask my church to call me', 'request a visit', 'I need someone to talk to', 'request pastoral care'],
    description: `KEEPS the person's request for pastoral care in their vault, for the leaders of the church they name (church: its agent address) to see: label, description, urgency (${URGENCIES.join(' | ')}), safeToText (yes | no). withdraw: yes withdraws it. Not an emergency service. Their own record; authorizes nothing.`,
    inputSchema: { type: 'object', properties: { id: text, label: text, description: text, urgency: { type: 'string', enum: [...URGENCIES] }, safeToText: text, church: text, withdraw: text } },
    capability: { id: FAITH_CARE_REQUEST, action: 'request', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.care,
    selfAuthorized: true,
  },
  {
    id: FAITH_SHARED_VIEW,
    answers: ['what can my church see', 'what do my friends see', 'my shared prayers'],
    description: 'ANSWERS what of the person\'s faith life a named audience may see — audience: friends | church | leaders (church: the church\'s agent address; friend: one friend\'s address), purpose: why. Each record\'s own visibility decides, in code; only what passed is returned, with a count of what was withheld.',
    inputSchema: { type: 'object', properties: { audience: { type: 'string', enum: ['friends', 'church', 'leaders'] }, church: text, friend: text, purpose: text }, required: ['audience', 'purpose'] },
    establishes: 'lookup',
  },
];
export const FAITH_ACTS = new Set<string>([FAITH_JOURNEY_RECORD, FAITH_PRAYER_SAVE, FAITH_CARE_REQUEST]);
export const FAITH_READS = new Set<string>([FAITH_JOURNEY_GET, FAITH_PRAYERS_LIST, FAITH_SHARED_VIEW]);

export interface FaithDeps {
  survey?: (subject: string) => Promise<Array<{ recordType: string; updatedAt?: string }>>;
  readRecords?: (subject: string, keys: string[]) => Promise<Record<string, unknown>>;
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown, operationId?: string) => Promise<{ ok: boolean; error?: string }>;
  /** The ontology's own shapes, when the playbook carries them (the definition's `domainShapes`). */
  shapes?: DomainShapeV1[];
  now?: () => Date;
}

type Rec = Record<string, unknown> & { '@id': string; '@type': string; aboutSubject: string; removedAt?: string; visibility?: string; sharedWith?: string[] };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const yes = (v: unknown) => v === true || /^(yes|true|on|1)$/i.test(str(v));
const pick = <T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined => {
  const s = str(v).toLowerCase();
  return allowed.find((a) => a.toLowerCase() === s || a.toLowerCase().replace(/[^a-z]/g, '') === s.replace(/[^a-z]/g, ''));
};
const agents = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : str(v).split(',')).map((x) => str(x).toLowerCase()).filter((x) => ADDR.test(x)))];
const keyOf = (kind: Kind, id: string) => `${FAITH_RECORD[kind]}:${id}`;
const iriOf = (person: string, kind: Kind, id: string) => `urn:faith:${person}:${FAITH_RECORD[kind].slice('faith.'.length)}:${id}`;
const idOfKey = (key: string) => key.slice(key.indexOf(':') + 1);
const withId = (r: { key: string; rec: Rec }) => Object.assign({}, r.rec, { id: idOfKey(r.key) }) as Rec & { id: string };
const visibilityOf = (r: { visibility?: unknown }): Visibility => pick(r.visibility, VISIBILITIES) ?? 'Confidential';

export function faithInvoker(deps: FaithDeps, person: string | undefined, addressee: string | undefined): ToolInvoker {
  const now = () => (deps.now ? deps.now() : new Date());
  const shapes = deps.shapes?.length ? deps.shapes : FAITH_SHAPES;
  return async (toolId, args, ctx) => {
    if (!person) throw new Error('faith records are kept as you, and there is no signed-in person on this run');
    const me = person.toLowerCase();
    if (addressee && addressee.toLowerCase() !== me) return { refused: 'your faith records are kept by your own agent only — ask at your home, not in this room' };
    if (!deps.survey || !deps.readRecords || !deps.writeSubjectRecord) throw new Error('faith records cannot be kept here (the private tier is not configured)');

    const all = async (kinds: Kind[]): Promise<Array<{ kind: Kind; key: string; rec: Rec }>> => {
      const prefixes = kinds.map((k) => [k, `${FAITH_RECORD[k]}:`] as const);
      const keys = (await deps.survey!(me)).map((r) => r.recordType).filter((t) => prefixes.some(([, p]) => t.startsWith(p)));
      if (!keys.length) return [];
      const recs = await deps.readRecords!(me, keys);
      return keys.flatMap((key) => {
        const rec = recs[key] as Rec | undefined;
        const kind = prefixes.find(([, p]) => key.startsWith(p))![0];
        return rec && typeof rec === 'object' && !rec.removedAt ? [{ kind, key, rec }] : [];
      });
    };
    const write = async (kind: Kind, id: string, rec: Rec) => {
      const shape = shapes.find((s) => s.class === FAITH_CLASS[kind]);
      if (shape) {
        const v = validateRecord(rec, shape);
        if (!v.valid) return { refused: `that ${shape.label.toLowerCase()} is not complete: ${v.errors.join('; ')}` };
      }
      const wrote = await deps.writeSubjectRecord!(me, keyOf(kind, id), rec, ctx.operationId);
      if (!wrote.ok) throw new Error(/record_scope_denied|scope/i.test(wrote.error ?? '') ? 'your storage grant predates faith records — refresh the grant at your Home, then say it again' : (wrote.error ?? 'the record could not be kept'));
      return null;
    };
    const base = (kind: Kind, id: string): Rec => ({ '@context': FAITH_CONTEXT, '@id': iriOf(me, kind, id), '@type': FAITH_CLASS[kind], aboutSubject: me } as Rec);
    const newId = (v: unknown) => (ID.test(str(v)) ? str(v) : crypto.randomUUID());
    const whoSees = (v: Visibility, shared: string[]) => (v === 'Confidential' ? 'only you can see it' : v === 'Friends' ? 'your friends can see it' : v === 'Open' ? 'anyone you share with can see it' : `${v === 'LeadersOnly' ? 'the leaders of' : 'the people of'} ${shared.length ? 'the church you named' : 'no church yet — name one to share it'} can see it`);

    if (toolId === FAITH_JOURNEY_GET) {
      const rows = await all(['stage', 'milestone']);
      const stages = rows.filter((r) => r.kind === 'stage').map((r) => r.rec).sort((a, b) => str(b.assertedAt).localeCompare(str(a.assertedAt)));
      const milestones = rows.filter((r) => r.kind === 'milestone').map(withId).sort((a, b) => str(b.occurredOn || b.recordedAt).localeCompare(str(a.occurredOn || a.recordedAt)));
      const current = stages[0];
      const stage = current ? pick(current.stage, STAGES) : undefined;
      return {
        tier: 'private',
        stage: current && stage ? { stage, label: STAGE_LABEL[stage], assertedAt: current.assertedAt, ...(current.note ? { note: current.note } : {}), visibility: visibilityOf(current) } : null,
        history: stages.map((s) => ({ stage: s.stage, assertedAt: s.assertedAt })),
        milestones: milestones.map((m) => ({ id: m.id, milestone: m.milestone, label: MILESTONE_LABEL[m.milestone as (typeof MILESTONES)[number]] ?? m.milestone, ...(m.occurredOn ? { occurredOn: m.occurredOn } : {}), ...(m.place ? { place: m.place } : {}), ...(m.note ? { note: m.note } : {}), visibility: visibilityOf(m) })),
        nextSteps: nextStepsOf(stage, milestones.map((m) => String(m.milestone))),
        answer: stage ? `You last said you are ${STAGE_LABEL[stage].toLowerCase()}${milestones.length ? `, with ${milestones.length} milestone${milestones.length === 1 ? '' : 's'} recorded` : ''}.` : milestones.length ? `You have ${milestones.length} milestone${milestones.length === 1 ? '' : 's'} recorded and have not said where you are on your journey.` : 'You have not recorded anything about your faith journey yet.',
      };
    }

    if (toolId === FAITH_PRAYERS_LIST) {
      const rows = await all(['prayer', 'answered', 'care']);
      const answers = new Map(rows.filter((r) => r.kind === 'answered').map((r) => [idOfKey(r.key), r.rec] as const));
      const status = pick(args.status, STATUSES);
      const prayers = rows.filter((r) => r.kind === 'prayer').map(withId).filter((p) => !status || p.status === status).sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
      const care = rows.filter((r) => r.kind === 'care').map(withId).sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
      return {
        tier: 'private',
        prayers: prayers.map((p) => ({ id: p.id, label: p.label, ...(p.description ? { description: p.description } : {}), kind: p.kind, status: p.status, visibility: visibilityOf(p), ...(p.sharedWith?.length ? { sharedWith: p.sharedWith } : {}), ...(p.prayingFor ? { prayingFor: p.prayingFor } : {}), ...(p.passage ? { passage: p.passage } : {}), prayedCount: Number(p.prayedCount ?? 0), ...(p.lastPrayedAt ? { lastPrayedAt: p.lastPrayedAt } : {}), ...(answers.get(p.id) ? { answered: { ...(answers.get(p.id)!.description ? { description: answers.get(p.id)!.description } : {}), answeredAt: answers.get(p.id)!.answeredAt } } : {}), createdAt: p.createdAt, ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) })),
        care: care.map((c) => ({ id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}), urgency: c.urgency, status: c.status, ...(c.sharedWith?.length ? { sharedWith: c.sharedWith } : {}), ...(c.safeToText !== undefined ? { safeToText: c.safeToText } : {}), createdAt: c.createdAt })),
        answer: `${prayers.length} prayer${prayers.length === 1 ? '' : 's'}${care.length ? ` and ${care.length} care request${care.length === 1 ? '' : 's'}` : ''}.`,
      };
    }

    if (toolId === FAITH_SHARED_VIEW) return sharedView(await all(['stage', 'milestone', 'prayer', 'answered', 'care']), args);

    if (!FAITH_ACTS.has(toolId)) throw new Error(`${toolId} is not a faith capability`);
    requirePersonsTurn({ ctx, toolId, what: toolId === FAITH_JOURNEY_RECORD ? 'record a step of your faith journey' : toolId === FAITH_PRAYER_SAVE ? 'keep your prayer' : 'keep your care request' });
    const at = now().toISOString();

    if (toolId === FAITH_JOURNEY_RECORD) {
      if (str(args.remove)) {
        const id = str(args.remove);
        for (const k of ['milestone', 'stage'] as const) {
          const cur = (await deps.readSubjectRecord?.(me, keyOf(k, id)).catch(() => null)) as Rec | null;
          if (cur && typeof cur === 'object' && !cur.removedAt) {
            const refused = await write(k, id, { ...cur, removedAt: at });
            return refused ?? { removed: id, recordType: FAITH_RECORD[k], answer: 'Removed.' };
          }
        }
        return { refused: `there is no journey record "${id}" to remove` };
      }
      const visibility = pick(args.visibility, VISIBILITIES) ?? 'Confidential';
      const sharedWith = agents(args.sharedWith);
      const common = { visibility, ...(sharedWith.length ? { sharedWith } : {}), ...(str(args.note) ? { note: str(args.note) } : {}) };
      const stage = pick(args.stage, STAGES);
      const milestone = pick(args.milestone, MILESTONES);
      if (!stage && !milestone) return { refused: `say a stage (${STAGES.join(', ')}) or a milestone (${MILESTONES.join(', ')})` };
      const out: Record<string, unknown> = {};
      if (stage) {
        const id = newId(milestone ? undefined : args.id);
        const refused = await write('stage', id, { ...base('stage', id), stage, assertedAt: at, ...common });
        if (refused) return refused;
        out.stage = { id, recordType: FAITH_RECORD.stage, class: FAITH_CLASS.stage, stage };
      }
      if (milestone) {
        const id = newId(args.id);
        const prev = (await deps.readSubjectRecord?.(me, keyOf('milestone', id)).catch(() => null)) as Rec | null;
        const occurredOn = str(args.occurredOn);
        const place = str(args.place);
        const rec = { ...base('milestone', id), milestone, recordedAt: str(prev?.recordedAt) || at, ...(occurredOn ? { occurredOn } : {}), ...(place ? { place } : {}), ...common };
        const refused = await write('milestone', id, rec);
        if (refused) return refused;
        out.milestone = { id, recordType: FAITH_RECORD.milestone, class: FAITH_CLASS.milestone, milestone };
      }
      return { recorded: out, answer: `Kept${stage ? ` — you are ${STAGE_LABEL[stage].toLowerCase()}` : ''}${milestone ? `${stage ? ', and' : ' —'} ${MILESTONE_LABEL[milestone].toLowerCase()}` : ''}; ${whoSees(visibility, sharedWith)}.` };
    }

    if (toolId === FAITH_PRAYER_SAVE) {
      const id = newId(args.id);
      const prev = ID.test(str(args.id)) ? ((await deps.readSubjectRecord?.(me, keyOf('prayer', id)).catch(() => null)) as Rec | null) : null;
      if (prev?.removedAt) return { refused: 'that prayer was removed' };
      if (yes(args.remove)) {
        if (!prev) return { refused: 'there is no such prayer to remove' };
        const refused = await write('prayer', id, { ...prev, removedAt: at, updatedAt: at });
        return refused ?? { removed: true, saved: { id }, answer: 'Removed from your prayers.' };
      }
      const label = str(args.label) || str(prev?.label);
      if (!label) return { refused: 'say what the prayer is for — a few words are enough' };
      const visibility = pick(args.visibility, VISIBILITIES) ?? (prev ? visibilityOf(prev) : 'Confidential');
      const sharedWith = args.sharedWith !== undefined ? agents(args.sharedWith) : (prev?.sharedWith ?? []);
      const answered = str(args.answered);
      const status = answered ? 'fulfilled' : pick(args.status, STATUSES) ?? (str(prev?.status) || 'expressed');
      const prayed = yes(args.prayed);
      const field = (k: string) => (args[k] !== undefined ? str(args[k]) : str(prev?.[k]));
      const rec: Rec = {
        ...base('prayer', id), label,
        ...(field('description') ? { description: field('description') } : {}),
        kind: pick(args.kind, PRAYER_KINDS) ?? (str(prev?.kind) || 'Request'),
        visibility, ...(sharedWith.length ? { sharedWith } : {}), status,
        ...(field('prayingFor') ? { prayingFor: field('prayingFor') } : {}),
        ...(field('passage') ? { passage: field('passage') } : {}),
        prayedCount: Number(prev?.prayedCount ?? 0) + (prayed ? 1 : 0),
        ...(prayed ? { lastPrayedAt: at } : prev?.lastPrayedAt ? { lastPrayedAt: prev.lastPrayedAt } : {}),
        createdAt: str(prev?.createdAt) || at, updatedAt: at,
      };
      const refused = await write('prayer', id, rec);
      if (refused) return refused;
      if (answered) {
        const r2 = await write('answered', id, { ...base('answered', id), answers: rec['@id'], description: answered, answeredAt: at });
        if (r2) return r2;
      }
      return { saved: { id, status, visibility }, ...(answered ? { answered: true } : {}), answer: `${answered ? 'Answered — kept with your words' : prayed ? `Prayed (${rec.prayedCount} time${rec.prayedCount === 1 ? '' : 's'})` : prev ? 'Updated' : 'Added to your prayers'}; ${whoSees(visibility, sharedWith)}.` };
    }

    // FAITH_CARE_REQUEST
    const id = newId(args.id);
    const prev = ID.test(str(args.id)) ? ((await deps.readSubjectRecord?.(me, keyOf('care', id)).catch(() => null)) as Rec | null) : null;
    if (yes(args.withdraw)) {
      if (!prev) return { refused: 'there is no such care request to withdraw' };
      const refused = await write('care', id, { ...prev, status: 'withdrawn', updatedAt: at });
      return refused ?? { saved: { id, status: 'withdrawn' }, answer: 'Withdrawn — the church sees that you no longer need it.' };
    }
    const label = str(args.label) || str(prev?.label);
    if (!label) return { refused: 'say what you would like — "please call me", "please visit"' };
    const church = agents(args.church)[0] ?? prev?.sharedWith?.[0];
    const urgency = pick(args.urgency, URGENCIES) ?? (str(prev?.urgency) || 'Normal');
    const rec: Rec = {
      ...base('care', id), label,
      ...((args.description !== undefined ? str(args.description) : str(prev?.description)) ? { description: args.description !== undefined ? str(args.description) : str(prev?.description) } : {}),
      urgency, ...(args.safeToText !== undefined ? { safeToText: yes(args.safeToText) } : prev?.safeToText !== undefined ? { safeToText: prev.safeToText } : {}),
      ...(church ? { sharedWith: [church] } : {}), visibility: 'LeadersOnly', status: str(prev?.status) || 'expressed',
      createdAt: str(prev?.createdAt) || at, updatedAt: at,
    };
    const refused = await write('care', id, rec);
    if (refused) return refused;
    return { saved: { id, status: rec.status, urgency, ...(church ? { church } : {}) }, answer: church ? `Kept — the leaders of the church you named can see it${urgency === 'High' ? '. If you are in danger, call local emergency services now' : ''}.` : 'Kept — name your church so its leaders can see it.' };
  };
}

export function nextStepsOf(stage: (typeof STAGES)[number] | undefined, have: string[]) {
  if (!stage) return [];
  const steps: Array<{ kind: 'milestone' | 'practice'; value: string; label: string; strength: 'requires' | 'recommends'; forStage: string }> = [];
  const add = (refs: string[], strength: 'requires' | 'recommends', forStage: string) => {
    for (const ref of refs) {
      const [kind, value] = ref.split(':') as ['milestone' | 'practice', string];
      if (kind === 'milestone' && have.includes(value)) continue;
      if (steps.some((s) => s.kind === kind && s.value === value)) continue;
      steps.push({ kind, value, label: kind === 'milestone' ? MILESTONE_LABEL[value as (typeof MILESTONES)[number]] : PRACTICE_LABEL[value] ?? value, strength, forStage });
    }
  };
  const here = NEXT_STEPS[stage];
  add(here.requires, 'requires', stage); add(here.recommends, 'recommends', stage);
  if (here.next) add(NEXT_STEPS[here.next].requires, 'requires', here.next);
  return steps;
}

/** What a named audience may see — decided by each record's own visibility and sharedWith, before anything is composed. */
export function sharedView(rows: Array<{ kind: Kind; key: string; rec: Rec }>, args: Record<string, unknown>) {
  const audience = ['friends', 'church', 'leaders'].includes(str(args.audience)) ? (str(args.audience) as 'friends' | 'church' | 'leaders') : null;
  if (!audience) return { refused: 'name the audience: friends, church or leaders' };
  const purpose = str(args.purpose);
  if (!purpose) return { refused: 'say why this view is wanted (purpose)' };
  const church = agents(args.church)[0];
  const friend = agents(args.friend)[0];
  if (audience !== 'friends' && !church) return { refused: 'name the church (its agent address)' };
  const sees = (r: Rec) => {
    const v = visibilityOf(r);
    const shared = (r.sharedWith ?? []).map((x) => String(x).toLowerCase());
    if (v === 'Confidential') return false;
    // Friends with no names reaches every friend; naming friends narrows it to them, so an unnamed friend sees nothing.
    if (audience === 'friends') return v === 'Open' || (v === 'Friends' && (!shared.length || (!!friend && shared.includes(friend))));
    const toThisChurch = shared.includes(church!);
    if (v === 'Open') return true;
    if (v === 'BodyOnly') return toThisChurch;
    if (v === 'LeadersOnly') return audience === 'leaders' && toThisChurch;
    return false;
  };
  let withheld = 0;
  const keep = (r: { kind: Kind; rec: Rec }) => { if (r.kind === 'care' ? audience === 'leaders' && (r.rec.sharedWith ?? []).map(String).map((x) => x.toLowerCase()).includes(church ?? '') : r.kind !== 'answered' && sees(r.rec)) return true; if (r.kind !== 'answered') withheld++; return false; };
  const stages = rows.filter((r) => r.kind === 'stage').sort((a, b) => str(b.rec.assertedAt).localeCompare(str(a.rec.assertedAt)));
  // Only the current stage is ever shared, never the history of earlier ones.
  const latest = stages[0];
  const stageOk = latest && keep(latest) ? pick(latest.rec.stage, STAGES) : undefined;
  const milestones = rows.filter((r) => r.kind === 'milestone' && keep(r));
  const prayers = rows.filter((r) => r.kind === 'prayer' && keep(r));
  const answers = new Map(rows.filter((r) => r.kind === 'answered').map((r) => [idOfKey(r.key), r.rec] as const));
  const care = rows.filter((r) => r.kind === 'care' && keep(r));
  return {
    audience, ...(church ? { church } : {}), purpose,
    ...(stageOk ? { stage: { stage: stageOk, label: STAGE_LABEL[stageOk], assertedAt: latest!.rec.assertedAt } } : {}),
    milestones: milestones.map(({ rec }) => ({ milestone: rec.milestone, label: MILESTONE_LABEL[rec.milestone as (typeof MILESTONES)[number]] ?? rec.milestone, ...(rec.occurredOn ? { occurredOn: rec.occurredOn } : {}) })),
    nextSteps: nextStepsOf(stageOk, milestones.map(({ rec }) => String(rec.milestone))),
    prayers: prayers.map(({ key, rec }) => { const a = answers.get(idOfKey(key)); return { label: rec.label, ...(rec.description ? { description: rec.description } : {}), kind: rec.kind, status: rec.status, ...(a ? { answered: { ...(a.description ? { description: a.description } : {}), answeredAt: a.answeredAt } } : {}) }; }),
    care: care.map(({ rec }) => ({ label: rec.label, ...(rec.description ? { description: rec.description } : {}), urgency: rec.urgency, status: rec.status, ...(rec.safeToText !== undefined ? { safeToText: rec.safeToText } : {}) })),
    withheld,
  };
}
