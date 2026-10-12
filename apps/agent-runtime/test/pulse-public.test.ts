import { describe, it, expect } from 'vitest';
import { answerFromDays, evidenceFor, factsFor, identifierish, kindWords, publicPulseAsk, rootsAsked, rootsIn, subjectOf, subjectsNamed, windowOf, type PulseDayRecord } from '../src/pulse-public';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const day = (d: string, rec: Partial<PulseDayRecord> = {}): { day: string; rec: PulseDayRecord } => ({ day: d, rec: { type: 'ap.town-pulse.v1', day: d, ...rec } });

describe('the pulse a context agent keeps, answered to a stranger (spec 436 §5.5 T3)', () => {
  it('reads the window out of the words, and says which window it used', () => {
    expect(windowOf('what did inference cost yesterday', NOW).words).toBe('yesterday');
    expect(windowOf('what did inference cost yesterday', NOW).days).toEqual(['2026-10-10']);
    expect(windowOf('how is the town doing this week', NOW).days).toHaveLength(7);
    expect(windowOf('which services were down in the last 7 days', NOW).to).toBe('2026-10-11');
    expect(windowOf('anything over the last 3 days', NOW).days).toHaveLength(3);
    // No window named is not an error: it is seven days, and the answer says so.
    expect(windowOf('how are things', NOW).words).toBe('the last 7 days');
  });

  it('matches the subject on words and never pretends to understand more', () => {
    expect(subjectOf('what did we spend on tokens')).toBe('cost');
    expect(subjectOf('which services were down')).toBe('status');
    expect(subjectOf('how many runs completed')).toBe('runs');
    expect(subjectOf('how is the town doing')).toBe('overall');
  });

  it('an absent record is an absence, never a zero — and the answer cites nothing because it read nothing', () => {
    const a = answerFromDays('what did we spend this week', windowOf('this week', NOW), []);
    expect(a.read).toBe(false);
    expect(a.cited).toEqual([]);
    expect(a.answer).toContain('I have none');
    expect(a.answer).not.toContain('$0.00');
  });

  it('names every record it answered from', () => {
    const w = windowOf('yesterday', NOW);
    const a = answerFromDays('what did it cost yesterday', w, [day('2026-10-10', { pulse: { cost: [{ basis: 'effective', days: [{ day: '2026-10-10', amountMicroUsd: 2_000_000 }] }] } })]);
    expect(a.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
    expect(a.answer).toContain('$2.00 effective');
  });

  it('keeps the bases apart: billed and effective are reported separately and never summed (I1)', () => {
    const w = windowOf('yesterday', NOW);
    const a = answerFromDays('cost yesterday', w, [day('2026-10-10', { pulse: { cost: [
      { basis: 'billed', days: [{ day: '2026-10-10', amountMicroUsd: 0 }] },
      { basis: 'effective', days: [{ day: '2026-10-10', amountMicroUsd: 3_250_000 }] },
    ] } })]);
    expect(a.answer).toContain('$0.00 billed');
    expect(a.answer).toContain('$3.25 effective');
    expect(a.answer).toContain('never added together');
    expect(a.answer).not.toContain('$3.25 billed');
  });

  it('a day with no cost recorded says so rather than reporting nothing spent', () => {
    const a = answerFromDays('what did we spend yesterday', windowOf('yesterday', NOW), [day('2026-10-10')]);
    expect(a.answer).toContain('No infrastructure cost is recorded');
    expect(a.answer).not.toMatch(/\$0\.00\b.*spent/);
  });

  it('answers which services were down from the probe counts, and distinguishes never from sometimes', () => {
    const w = windowOf('last 7 days', NOW);
    const a = answerFromDays('which services were down in the last 7 days', w, [
      day('2026-10-10', { services: { naming: { samples: 10, up: 10 }, skills: { samples: 10, up: 4 }, ghost: { samples: 10, up: 0 } } }),
    ]);
    expect(a.answer).toContain('Never answered');
    expect(a.answer).toContain('ghost');
    expect(a.answer).toContain('skills (4 of 10 probes)');
    expect(a.answer).not.toContain('naming');
  });

  it('says the window is partial when a day in it has no record', () => {
    const w = windowOf('this week', NOW);
    const a = answerFromDays('how is the town doing this week', w, [day(w.days[0]!, { services: { naming: { samples: 2, up: 2 } } })]);
    expect(a.answer).toContain('6 days');
    expect(a.answer).toContain('partial');
    expect(a.cited).toHaveLength(1);
  });

  it('reports runs and cost per completed run only when the record carries them', () => {
    const w = windowOf('yesterday', NOW);
    const withRuns = answerFromDays('how many runs', w, [day('2026-10-10', { heartbeat: { runs: { completed: 50, failed: 2 } }, pulse: { costPerCompletedRun: { microUsd: 12_000, completedRuns: 50, infraBasis: 'effective' } } })]);
    expect(withRuns.answer).toContain('50 completed runs');
    expect(withRuns.answer).toContain('2 failures');
    expect(withRuns.answer).toContain('$0.01');
    expect(withRuns.answer).toContain('effective');
    const without = answerFromDays('how many runs', w, [day('2026-10-10')]);
    expect(without.answer).toContain('No run counts are recorded');
  });

  it('reads the agent\'s own records for the window and answers from them, end to end', async () => {
    const vault: Record<string, PulseDayRecord> = {
      'pulse.day:2026-10-10': { day: '2026-10-10', heartbeat: { runs: { completed: 7 } }, services: { naming: { samples: 5, up: 5 } } },
    };
    const read = async (_subject: string, key: string) => vault[key] ?? null;
    const out = await publicPulseAsk({ readSubjectRecord: read }, '0xabc', { question: 'how did it go yesterday' }, NOW);
    expect(out.read).toBe(true);
    expect(out.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
    expect(String(out.answer)).toContain('7 completed runs');
    // a record the vault refuses is simply not read — never a thrown ask
    const refused = await publicPulseAsk({ readSubjectRecord: async () => { throw new Error('vault_key_unauthorized'); } }, '0xabc', { question: 'yesterday' }, NOW);
    expect(refused.read).toBe(false);
    expect(refused.cited).toEqual([]);
  });
});

// ── A GENERAL-PURPOSE ASK (the owner's 2026-10-11 request) ─────────────────────────────────────────
// "tell me about demo-a2a-faithnet" used to come back as the week's summary, because the answerer never
// looked at what the question NAMED. A town's day holds every service's probes and ~150 resources with
// their last reading, so the answer was there the whole time.
const DAY_FULL = (d: string): { day: string; rec: PulseDayRecord } => ({ day: d, rec: {
  type: 'ap.town-pulse.v1', day: d,
  services: { naming: { samples: 12, up: 12 }, skills: { samples: 12, up: 9 } },
  estates: { faithnet: {} },
  heartbeat: { runs: { completed: 40, failed: 3 }, inferenceMicroUsd: 1_500 },
  pulse: {
    infrastructure: [
      { platform: 'cloudflare', account: 'acctA', resource: 'demo-a2a-faithnet', kind: 'worker', owner: { kind: 'estate', id: 'faithnet' },
        latest: { status: 'up', ok: true, asOf: `${d}T11:00:00.000Z`, lagClass: 'hourly', metrics: { requests: 1106, errors: 0, cpuP50Ms: 1.237, cpuP99Ms: 314.663 } } },
      { platform: 'graphdb', account: 'https://g', resource: 'graphdb', kind: 'node', owner: null,
        latest: { status: 'unknown', ok: false, asOf: `${d}T11:00:00.000Z`, lagClass: 'hourly', error: 'answered 503', metrics: {} } },
    ],
    cost: [{ platform: 'vercel', basis: 'effective', owner: { kind: 'estate', id: 'faithnet' }, days: [{ day: d, amountMicroUsd: 3_000_000 }] }],
    unattributed: [{ platform: 'cloudflare', resource: 'stray', kind: 'worker' }],
  },
} });

describe('a general-purpose ask over everything the record holds', () => {
  const w = windowOf('this week', NOW);
  const found = [DAY_FULL('2026-10-10')];

  it('answers about a RESOURCE the question names, with its last reading — not the week', () => {
    const a = answerFromDays('tell me about demo-a2a-faithnet', w, found);
    expect(a.answer).toContain('demo-a2a-faithnet is a worker on cloudflare');
    expect(a.answer).toContain('estate:faithnet');
    expect(a.answer).toContain('requests 1,106');
    expect(a.answer).toContain('status up');
    // the week's summary is NOT what was asked for
    expect(a.answer).not.toContain('Every one of');
    expect(a.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
  });

  it('answers about a SERVICE, an ESTATE and a PLATFORM by name', () => {
    expect(answerFromDays('how is skills doing', w, found).answer).toMatch(/skills is a service the town lists and probes.*probes 12; answered 9/s);
    expect(answerFromDays('tell me about faithnet', w, found).answer).toMatch(/faithnet is an estate.*completed runs 40/s);
    expect(answerFromDays('what about vercel', w, found).answer).toContain('effective cost (USD) 3');
  });

  it('a resource that could not be read says why, rather than reading as healthy', () => {
    const a = answerFromDays('what is up with graphdb', w, found);
    expect(a.answer).toContain('unreadable because answered 503');
  });

  it('a name the records do not know is said to be unknown, never guessed at', () => {
    const a = answerFromDays('tell me about postgres-primary', w, found);
    expect(a.answer).toContain('no record of anything called "postgres-primary"');
    expect(a.read).toBe(true);
  });

  it('the longest matching name wins, so an estate inside a resource name is not a second subject', () => {
    expect(subjectsNamed('tell me about demo-a2a-faithnet', found)).toEqual(['demo-a2a-faithnet']);
  });

  it('an ordinary hyphenated word is not mistaken for a machine', () => {
    expect(identifierish('can I ask an open-ended question')).toEqual([]);
    expect(identifierish('tell me about town-mcp and faithnet.io')).toEqual(['town-mcp', 'faithnet.io']);
    // and a question that DID name something known never reports its other words as missing resources
    expect(answerFromDays('is demo-a2a-faithnet up-to-date', w, found).answer).not.toContain('no record of anything called');
  });

  it('the evidence a composer may use is drawn only from the records, and names where each item came from', () => {
    const facts = factsFor('tell me about demo-a2a-faithnet', w, found);
    const ev = evidenceFor(facts, found, 'stated');
    expect(ev.map((e) => e.tool)).toContain('pulse.record.about:demo-a2a-faithnet');
    expect(ev.some((e) => e.tool === 'pulse.window.gaps')).toBe(true); // 6 of 7 days are missing
    expect(JSON.stringify(ev)).toContain('1106');
  });

  it('WITH a composer the words are its own; WITHOUT one the facts are stated — same truth either way', async () => {
    const read = async (_s: string, k: string) => (k === 'pulse.day:2026-10-10' ? DAY_FULL('2026-10-10').rec : null);
    const stated = await publicPulseAsk({ readSubjectRecord: read }, '0xabc', { question: 'tell me about demo-a2a-faithnet' }, NOW);
    expect(stated.composed).toBe(false);
    expect(String(stated.answer)).toContain('requests 1,106');

    let sawEvidence = '';
    const composed = await publicPulseAsk({
      readSubjectRecord: read,
      compose: async (i) => { sawEvidence = JSON.stringify(i.evidence); return 'It is the estate’s A2A worker; it took 1,106 requests with no errors on 2026-10-10.'; },
    }, '0xabc', { question: 'tell me about demo-a2a-faithnet' }, NOW);
    expect(composed.composed).toBe(true);
    expect(String(composed.answer)).toContain('1,106 requests');
    expect(sawEvidence).toContain('demo-a2a-faithnet');
    // the stated form is kept beside it, so what the model was given is never lost
    expect(String(composed.stated)).toContain('requests 1,106');
    expect(composed.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
  });

  it('a composer that fails or says nothing falls back to the facts, never to silence', async () => {
    const read = async (_s: string, k: string) => (k === 'pulse.day:2026-10-10' ? DAY_FULL('2026-10-10').rec : null);
    for (const compose of [async () => { throw new Error('model down'); }, async () => '   ']) {
      const out = await publicPulseAsk({ readSubjectRecord: read, compose: compose as never }, '0xabc', { question: 'tell me about demo-a2a-faithnet' }, NOW);
      expect(out.composed).toBe(false);
      expect(String(out.answer)).toContain('requests 1,106');
    }
  });

  it('nothing read means nothing composed — a refusal is not something to write prose over', async () => {
    let called = false;
    const out = await publicPulseAsk({ readSubjectRecord: async () => null, compose: async () => { called = true; return 'invented'; } }, '0xabc', { question: 'anything' }, NOW);
    expect(called).toBe(false);
    expect(out.read).toBe(false);
    expect(String(out.answer)).toContain('I have none');
  });
});

// THE RECORDED SHAPE IS NOT THE LIVE SHAPE. `dayRollup` FLATTENS each resource — status/asOf/metrics sit at
// the top of the row — while `/api/pulse` nests the same facts under `latest`. Reading the record as though
// it were the live view found the platform and the owner and then silently nothing else: no status, no
// reading, no metrics, on a record that had all three. This fixture is the recorded shape, verbatim.
const RECORDED_DAY: PulseDayRecord = {
  type: 'ap.town-pulse.v1', day: '2026-10-10',
  services: { naming: { samples: 12, up: 12 } },
  pulse: {
    infrastructure: [
      { platform: 'cloudflare', account: 'acctA', resource: 'demo-a2a-faithnet', kind: 'worker', owner: { kind: 'estate', id: 'faithnet' },
        status: 'up', ok: true, asOf: '2026-10-10T11:00:00.000Z', lagClass: 'hourly',
        metrics: { requests: 1106, errors: 0, cpuP50Ms: 1.237, wallP99Ms: 26116.5 } },
      { platform: 'graphdb', account: 'https://g', resource: 'graphdb', kind: 'node', owner: null,
        status: 'unknown', ok: false, asOf: '2026-10-10T11:00:00.000Z', lagClass: 'hourly', error: 'answered 503', metrics: {} },
    ],
  },
};

describe('the record as the town actually writes it', () => {
  const w = windowOf('this week', NOW);
  const found = [{ day: '2026-10-10', rec: RECORDED_DAY }];

  it('reads the FLAT row: status, when it was read, how current, and every metric', () => {
    const a = answerFromDays('tell me about demo-a2a-faithnet', w, found);
    expect(a.answer).toContain('status up');
    expect(a.answer).toContain('requests 1,106');
    expect(a.answer).toContain('errors 0');
    expect(a.answer).toContain('CPU p50 (ms) 1.237');
    expect(a.answer).toContain('how current hourly');
  });

  it('an unreadable resource says why, from the flat row', () => {
    expect(answerFromDays('what about graphdb', w, found).answer).toContain('unreadable because answered 503');
  });

  it('the status roll-up sees a flat not-up row too', () => {
    expect(answerFromDays('which services were down', w, found).answer).toContain('graphdb');
  });
});

describe('the town of names, answered in counts (spec 430)', () => {
  const NAMES = {
    chainId: 34348, block: 89214, total: 297,
    roots: [
      { tld: 'me', kind: 'person', names: 'a person', count: 86 },
      { tld: 'org', kind: 'org', names: 'an organization', count: 69 },
      { tld: 'svc', kind: 'service', names: 'a service', count: 24 },
      { tld: 'church', kind: 'church', names: 'a church', count: 2 },
      { tld: 'impact', kind: null, names: null, count: 0 },
    ],
  };
  const w = windowOf('this week', NOW);
  const found = [day('2026-10-10', { names: { ...NAMES, roots: NAMES.roots.map((r) => (r.tld === 'me' ? { ...r, count: 85 } : r)) } }), day('2026-10-11', { names: NAMES })];

  it('a count is the latest day\'s, never a sum across days', () => {
    const me = rootsIn(found).find((r) => r.tld === 'me');
    expect(me).toMatchObject({ count: 86, day: '2026-10-11' });  // 85 yesterday + 86 today is 171 names that do not exist
  });

  it('pluralises the kind the record itself carries, and invents none', () => {
    expect(kindWords('person')).toEqual(['person', 'people']);
    expect(kindWords('church')).toEqual(['church', 'churches']);
    expect(kindWords('treasury')).toEqual(['treasury', 'treasuries']);
    expect(kindWords(null)).toEqual([]);
  });

  it('"how many people do we have" is the .me root — and "the naming service" is not the .svc root', () => {
    const roots = rootsIn(found);
    expect(rootsAsked('how many people do we have in naming service', roots)).toEqual(['me']);
    expect(rootsAsked('how many churches are there', roots)).toEqual(['church']);
    expect(rootsAsked('is the naming service up', roots)).toEqual([]);
    expect(rootsAsked('how many .org names', roots)).toEqual(['org']);
  });

  it('answers the question the owner actually asked, from the record, with the record named', () => {
    const a = answerFromDays('how many people do we have in naming service', w, found);
    expect(a.read).toBe(true);
    expect(a.answer).toContain('.me is the root that names a person');
    expect(a.answer).toContain('names 86');
    expect(a.answer).toContain('counted on 2026-10-11');
    expect(a.cited.map((c) => c.key)).toEqual(['pulse.day:2026-10-10', 'pulse.day:2026-10-11']);
    // It is a count of NAMES. Nothing here describes a person, and no owner is in the record to describe.
    expect(a.answer).not.toMatch(/0x[0-9a-f]{6}/i);
  });

  it('a question about names with no root named reports every ending, as of the day it was counted', () => {
    expect(subjectOf('how many names are registered')).toBe('names');
    const a = answerFromDays('how many names are registered', w, found);
    expect(a.answer).toContain('counted on 2026-10-11: 181 names under 4 endings');
    expect(a.answer).toContain('86 .me (a person)');
    expect(a.answer).toContain('never of people');
  });

  it('the roots are evidence a composer may use, labelled as running totals', () => {
    const items = evidenceFor(factsFor('how is the town doing', w, found), found, 'stated');
    const e = items.find((x) => x.tool === 'pulse.names.roots');
    expect(e).toBeTruthy();
    expect((e!.result as { note: string }).note).toContain('never added across days');
  });

  it('a record written before names were sampled says nothing about them', () => {
    const old = [day('2026-10-11', { services: { naming: { samples: 12, up: 12 } } })];
    expect(rootsIn(old)).toEqual([]);
    expect(answerFromDays('how many names are registered', w, old).answer).toContain('No name count is recorded');
  });
});
