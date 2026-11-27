// SPEC 405 / 412 — WHO READS A LIBRARY THROUGH `library.files.list` AND `library.file.read`. The door that admits an ask
// establishes who is asking; it never establishes what they may read of the agent they addressed. The owner's own ask
// and a steward's (stewardship the chain confirms — the standing a write needs) read every document. Anyone else — a
// member, a contact, a stranger, another agent — reads the PUBLIC SHELF through these tools and nothing more: a private
// document is not listed, not counted, not named in a refusal, and never fetched. A standing that cannot be established
// is no standing. The writes and the grants list keep the rule they had.
import { describe, expect, it } from 'vitest';
import type { Address } from '@agenticprimitives/types';
import { definitionDigest, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import {
  libraryInvoker, libraryStandingOf,
  LIBRARY_FILES_LIST, LIBRARY_FILE_READ, LIBRARY_FILE_SAVE, LIBRARY_FILE_VISIBILITY, LIBRARY_FILE_PUBLISH, LIBRARY_GRANTS_LIST,
  type LibraryEntry, type LibraryToolDeps,
} from '../src/library-tools.js';
import { runUnderMandate, type HarnessDeps, type HarnessEnv } from '../src/harness-run.js';
import orgSteward from '../../../.agentic/definitions/agentic-trust/org-steward.json';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const OWNER = addr(0xa11);     // the household / organization whose Library this is
const STEWARD = addr(0xb22);   // a person the chain confirms as its steward
const MEMBER = addr(0xc33);    // a member: belongs, stewards nothing
const STRANGER = addr(0xd44);  // signed in, unrelated

const enc = (t: string) => btoa(unescape(encodeURIComponent(t)));
// Every way an entry is private (declared, undeclared, declared inside a public folder) and public (declared, inherited).
const catalog: LibraryEntry[] = [
  { id: 'art-diary', kind: 'md', name: 'diary.md', folder: 'personal', accessPolicy: 'private', version: 3, size: 4242, contentCommitment: '0xc0ffee01', createdAt: 5 },
  { id: 'family-plan-v1', kind: 'json-ld', name: 'family-plan.json', folder: '', version: 7, size: 9191, contentCommitment: '0xc0ffee02', createdAt: 4 },
  { id: 'art-licence', kind: 'md', name: 'LICENSE.md', folder: '', accessPolicy: 'public', version: 1, size: 20, contentCommitment: '0xfeed0001', createdAt: 3 },
  { id: 'fold-shelf', kind: 'md', name: 'shelf', folder: '', isFolder: true, accessPolicy: 'public' },
  { id: 'art-notice', kind: 'md', name: 'NOTICE.md', folder: 'shelf', version: 1, size: 12, contentCommitment: '0xfeed0002', createdAt: 2 },
  { id: 'art-held', kind: 'md', name: 'held-back.md', folder: 'shelf', accessPolicy: 'private', version: 1, size: 7373, contentCommitment: '0xc0ffee03', createdAt: 1 },
];
const bodies: Record<string, string> = {
  'art-diary': 'DIARY-BODY the children and the move', 'family-plan-v1': '{"plan":"PLAN-BODY"}', 'art-licence': 'LICENCE-BODY CC BY 4.0',
  'art-notice': 'NOTICE-BODY', 'art-held': 'HELD-BODY',
};
const PRIVATE_IDS = ['art-diary', 'family-plan-v1', 'art-held'];
/** Anything of a private entry that must never appear in an answer to a caller with no standing. */
const PRIVATE_MARKS = ['diary', 'family-plan', 'held-back', 'personal', ...PRIVATE_IDS, 'DIARY-BODY', 'PLAN-BODY', 'HELD-BODY', '0xc0ffee', '4242', '9191', '7373'];
const leaks = (out: unknown): string[] => { const s = JSON.stringify(out); return PRIVATE_MARKS.filter((m) => s.includes(m)); };

interface World { deps: LibraryToolDeps; reads: string[]; asked: Array<[string, string]> }
function world(steward: LibraryToolDeps['stewardOf'] | null = async (who) => (who === STEWARD ? { steward: true, because: 'your stewardship wire verifies on chain' } : { steward: false, because: who === MEMBER ? 'you are a member of this agent, and membership reads nothing' : 'you have no link to this agent' })): World {
  const reads: string[] = [];
  const asked: Array<[string, string]> = [];
  const deps: LibraryToolDeps = {
    readSubjectRecord: async (subject, type) => {
      reads.push(`${subject === OWNER ? 'owner' : subject}:${type}`);
      if (subject !== OWNER) return null;
      if (type === 'content.catalog') return structuredClone(catalog);
      const id = type.replace(/^content\.artifact\./, '');
      return bodies[id] !== undefined ? { id, bytesB64: enc(bodies[id]!) } : null;
    },
    ...(steward ? { stewardOf: async (who: string, owner: string) => { asked.push([who, owner]); return steward(who, owner); } } : {}),
  };
  return { deps, reads, asked };
}
const ctx = () => ({ step: { id: 's0' }, index: 0, supplied: [{ stepRef: 's0', data: { keep: 'yes' } }], intent: { goal: 'x' }, operationId: 'op-0' }) as never;
const call = (w: World, person: string | undefined, tool: string, args: Record<string, unknown> = {}) => libraryInvoker(w.deps, OWNER, person)(tool, args, ctx()) as Promise<Record<string, any>>;

describe('the owner and a steward read the whole Library, as before', () => {
  it('the owner lists every document and reads a private one — no stewardship is asked about its own Library', async () => {
    const w = world();
    const list = await call(w, OWNER, LIBRARY_FILES_LIST);
    expect(list.count).toBe(5);
    expect(list.files.map((f: { id: string }) => f.id).sort()).toEqual(['art-diary', 'art-held', 'art-licence', 'art-notice', 'family-plan-v1']);
    expect(list.publicOnly).toBeUndefined();
    const read = await call(w, OWNER, LIBRARY_FILE_READ, { id: 'art-diary' });
    expect(read).toMatchObject({ read: true, text: bodies['art-diary'], file: { id: 'art-diary', commitment: '0xc0ffee01', accessPolicy: 'private' } });
    expect(read.publicOnly).toBeUndefined();
    expect(w.asked).toEqual([]);
  });

  it('a steward the chain confirms lists and reads everything; the standing is decided once per invocation', async () => {
    const w = world();
    const list = await call(w, STEWARD, LIBRARY_FILES_LIST);
    expect(list.count).toBe(5);
    expect(w.asked).toEqual([[STEWARD, OWNER]]);
    const read = await call(w, STEWARD, LIBRARY_FILE_READ, { name: 'family-plan.json' });
    expect(read).toMatchObject({ read: true, text: bodies['family-plan-v1'], file: { id: 'family-plan-v1' } });
    expect(w.asked).toHaveLength(2); // one per invocation, never two
    expect((await call(w, STEWARD, LIBRARY_FILE_READ, { id: 'art-held' })).text).toBe('HELD-BODY');
  });

  it('the owner\'s unknown name is still answered with what the Library holds (unchanged)', async () => {
    const out = await call(world(), OWNER, LIBRARY_FILE_READ, { name: 'nothing-like-this' });
    expect(out.read).toBe(false);
    expect(out.refused).toContain('the Library holds: ');
    expect(out.refused).toContain('personal/diary.md');
  });
});

describe.each([['a stranger', STRANGER], ['a member', MEMBER]])('%s is narrowed to the public shelf', (_who, person) => {
  it('lists only public entries — declared or inherited — and nothing of a private one', async () => {
    const w = world();
    const list = await call(w, person, LIBRARY_FILES_LIST);
    expect(list.files.map((f: { id: string }) => f.id).sort()).toEqual(['art-licence', 'art-notice']);
    expect(list.count).toBe(2); // the count is of what they may see, never of the Library
    expect(list.truncated).toBe(false);
    expect(list.publicOnly).toBe(true);
    expect(list.note).toMatch(/public shelf is open to you/);
    expect(leaks(list)).toEqual([]);
    // The filters do not reach past the shelf either.
    expect((await call(w, person, LIBRARY_FILES_LIST, { folder: 'personal' })).count).toBe(0);
    expect((await call(w, person, LIBRARY_FILES_LIST, { q: 'diary' })).count).toBe(0);
    expect(leaks(await call(w, person, LIBRARY_FILES_LIST, { folder: 'shelf' }))).toEqual([]);
    expect(w.reads.filter((r) => r.startsWith('owner:content.artifact.'))).toEqual([]);
  });

  it('is refused a private document in words — by id, by name, declared or undeclared — with no body and no metadata', async () => {
    const w = world();
    for (const args of [{ id: 'art-diary' }, { name: 'diary.md' }, { name: 'diary', folder: 'personal' }, { id: 'family-plan-v1' }, { name: 'family-plan.json' }, { id: 'art-held' }, { name: 'held-back.md', folder: 'shelf' }, { id: 'art-diary', offset: 5 }]) {
      const out = await call(w, person, LIBRARY_FILE_READ, args);
      expect(out.read).toBe(false);
      expect(out.refused).toMatch(/readable by you/);
      expect(out.refused).toMatch(/read in full by its own agent or by a steward of it/);
      expect(out.text).toBeUndefined();
      expect(out.file).toBeUndefined();
      expect(out.which).toBeUndefined();
      // Only what the caller typed may echo back; nothing the Library knows about the entry does.
      const echoed = Object.values(args).map(String);
      expect(leaks(out).filter((m) => !echoed.some((e) => e.includes(m)))).toEqual([]);
    }
    // No private record was fetched from the vault on the way to refusing.
    expect(w.reads.filter((r) => r.startsWith('owner:content.artifact.'))).toEqual([]);
  });

  it('a private id and an id that does not exist are one answer', async () => {
    const w = world();
    const strip = (o: Record<string, any>, id: string) => JSON.stringify(o).split(id).join('<id>');
    expect(strip(await call(w, person, LIBRARY_FILE_READ, { id: 'art-diary' }), 'art-diary')).toBe(strip(await call(w, person, LIBRARY_FILE_READ, { id: 'art-nope' }), 'art-nope'));
  });

  it('still reads a public file, declared or under a public folder, as the shelf shows it', async () => {
    const w = world();
    const licence = await call(w, person, LIBRARY_FILE_READ, { id: 'art-licence' });
    expect(licence).toMatchObject({ read: true, text: bodies['art-licence'], publicOnly: true, untrusted: true, file: { id: 'art-licence', path: 'LICENSE.md' } });
    const notice = await call(w, person, LIBRARY_FILE_READ, { name: 'NOTICE.md' });
    expect(notice).toMatchObject({ read: true, text: 'NOTICE-BODY', file: { id: 'art-notice' } });
    expect(leaks(licence)).toEqual([]);
    expect(leaks(notice)).toEqual([]);
  });

  it('an ambiguous name is disambiguated among public documents only', async () => {
    const out = await call(world(), person, LIBRARY_FILE_READ, { name: '.md' });
    expect(out.read).toBe(false);
    expect(out.which.map((f: { id: string }) => f.id).sort()).toEqual(['art-licence', 'art-notice']);
    expect(leaks(out)).toEqual([]);
  });
});

describe('a standing that cannot be established is no standing (fail closed)', () => {
  const publicOnly = async (w: World, person: string | undefined, why: RegExp) => {
    const list = await call(w, person, LIBRARY_FILES_LIST);
    expect(list.files.map((f: { id: string }) => f.id).sort()).toEqual(['art-licence', 'art-notice']);
    expect(list.note).toMatch(why);
    expect(leaks(list)).toEqual([]);
    const read = await call(w, person, LIBRARY_FILE_READ, { id: 'art-diary' });
    expect(read.read).toBe(false);
    expect(read.refused).toMatch(why);
    expect(read.text).toBeUndefined();
    expect(w.reads.filter((r) => r.startsWith('owner:content.artifact.'))).toEqual([]);
  };
  it('the derivation throws (a chain read failed, the caller\'s links were unreadable)', async () => {
    await publicOnly(world(async () => { throw new Error('rpc timeout'); }), STEWARD, /your standing could not be read \(rpc timeout\)/);
  });
  it('this deployment cannot judge stewardship at all', async () => {
    await publicOnly(world(null), STEWARD, /this deployment cannot judge stewardship/);
  });
  it('there is no verified caller on the run', async () => {
    await publicOnly(world(), undefined, /no verified caller/);
    await publicOnly(world(), 'alice.me', /no verified caller/);
  });
  it('an answer that is not exactly `steward: true` is not stewardship', async () => {
    await publicOnly(world(async () => ({ steward: 'yes', because: '' }) as never), STRANGER, /you hold no stewardship/);
    await publicOnly(world(async () => undefined as never), STRANGER, /you hold no stewardship/);
  });
  it('libraryStandingOf says which of the three a caller is', async () => {
    const w = world();
    expect(await libraryStandingOf(w.deps, OWNER, OWNER.toUpperCase().replace('0X', '0x'))).toEqual({ full: true, as: 'owner' });
    expect(await libraryStandingOf(w.deps, OWNER, STEWARD)).toEqual({ full: true, as: 'steward' });
    expect(await libraryStandingOf(w.deps, OWNER, MEMBER)).toMatchObject({ full: false, because: expect.stringContaining('membership reads nothing') });
  });
});

describe('the writes and the grants list keep their rule', () => {
  it('a stranger and a member are refused every write and the grants list, in the same words as before', async () => {
    const w = world();
    for (const person of [STRANGER, MEMBER]) {
      for (const [tool, args] of [[LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' }], [LIBRARY_FILE_VISIBILITY, { id: 'art-diary', accessPolicy: 'public' }], [LIBRARY_FILE_PUBLISH, { id: 'art-licence' }]] as const) {
        expect(await call(w, person, tool, args)).toMatchObject({ owner: OWNER, refused: expect.stringMatching(/^a Library is written by its own agent or by a steward of it — /) });
      }
      expect(await call(w, person, LIBRARY_GRANTS_LIST)).toMatchObject({ owner: OWNER, refused: expect.stringMatching(/^a Library's grants are read by its own agent or by a steward of it — /) });
    }
    expect(await call(world(null), STEWARD, LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' })).toMatchObject({ refused: 'a Library is written by its own agent or by a steward of it — this deployment cannot judge stewardship' });
    expect(await call(world(async () => { throw new Error('boom'); }), STEWARD, LIBRARY_GRANTS_LIST)).toMatchObject({ refused: expect.stringContaining('your standing could not be read (boom)') });
  });
  it('no signed-in person: a write throws and the grants list is refused (unchanged)', async () => {
    await expect(call(world(), undefined, LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' })).rejects.toThrow(/there is no signed-in person on this run/);
    expect(await call(world(), undefined, LIBRARY_GRANTS_LIST)).toMatchObject({ refused: expect.stringContaining('there is no signed-in person on this run') });
  });
  it('the owner and a steward pass the gate and reach the write (which this fixture cannot perform)', async () => {
    for (const person of [OWNER, STEWARD]) await expect(call(world(), person, LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' })).rejects.toThrow(/cannot write its Library/);
    expect(await call(world(), STEWARD, LIBRARY_GRANTS_LIST)).toMatchObject({ count: 0 });
  });
});

// ── at the door: `/harness/ask` hands the run its verified asker (`person`) and whatever addressee the ask named ──────
describe('a supplied plan at another agent\'s door (the harness, end to end)', () => {
  const HARNESS = addr(0xdd);
  const env = {
    CHAIN_ID: '34348', DELEGATION_MANAGER: addr(0xd00), UNIVERSAL_SIGNATURE_VALIDATOR: addr(0xd01), HARNESS_AGENT_SA: HARNESS,
    DIGEST_BINDING_ENFORCER: addr(0xe01), TIMESTAMP_ENFORCER: addr(0xe02), ALLOWED_TARGETS_ENFORCER: addr(0xe03),
    ALLOWED_METHODS_ENFORCER: addr(0xe04), VALUE_ENFORCER: addr(0xe05), PAYMENT_ENFORCER: addr(0xe06),
  } as unknown as HarnessEnv;
  // The organization's assigned playbook is the pinned org-steward definition, which declares both Library reads.
  const def = orgSteward as unknown as AgentHarnessDefinitionV1;
  const assignment = { type: 'ap.archetype-assignment.v1', archetypeId: def.archetypeId, archetypeVersion: def.archetypeVersion, definitionDigest: definitionDigest(def), definition: def };
  const harness = (verifyStewardship: (a: { org: string; person: string }) => Promise<boolean>) => {
    const artifactReads: string[] = [];
    const deps = {
      audit: { write: async () => undefined },
      readContract: async () => { throw new Error('no chain in this test'); },
      agentTypeOf: async () => 'org',
      readSubjectRecord: async (subject: string, type: string) => {
        const s = subject.toLowerCase();
        if (s === OWNER) {
          if (type === 'archetype.assignment') return structuredClone(assignment);
          if (type === 'content.catalog') return structuredClone(catalog);
          if (type.startsWith('content.artifact.')) { artifactReads.push(type); const id = type.slice('content.artifact.'.length); return bodies[id] !== undefined ? { id, bytesB64: enc(bodies[id]!) } : null; }
          return null;
        }
        // The steward's own links carry the organization's stewardship wire; the stranger's carry nothing.
        // The real `relationships.data` shape (spec 323 W1, `relationshipRows`): an `orgs` map keyed by agent address.
        if (s === STEWARD && type === 'relationships.data') return { orgs: { [OWNER]: { orgName: 'the org', relationship: 'steward', stewardshipDelegation: { delegator: OWNER, delegate: STEWARD, authority: `0x${'f'.repeat(64)}`, caveats: [], salt: '1', signature: '0x01' } } } };
        return null;
      },
      verifyStewardship: async (a: { org: string; person: string }) => verifyStewardship(a),
    } as unknown as HarnessDeps;
    const ask = async (person: Address, steps: Array<{ toolId: string; args: Record<string, unknown> }>) => {
      const { result } = await runUnderMandate(env, deps, {
        intent: { goal: 'read the documents' }, plan: { steps }, rowsOnly: true, presented: null,
        person, session: 'session', addressee: OWNER, runRef: `run-${person.slice(-4)}`,
        mcpInvoke: async () => { throw new Error('not wired'); },
      } as never);
      return (result.steps ?? []).map((o) => ({ toolId: o.step.toolId, ok: o.ok, result: o.result as Record<string, any> | undefined }));
    };
    return { ask, artifactReads };
  };
  const PLAN = [
    { toolId: LIBRARY_FILES_LIST, args: {} },
    { toolId: LIBRARY_FILE_READ, args: { id: 'art-diary' } },
    { toolId: LIBRARY_FILE_READ, args: { name: 'family-plan.json' } },
    { toolId: LIBRARY_FILE_READ, args: { id: 'art-licence' } },
  ];

  it('an unrelated signed-in person naming the organization as addressee gets its public shelf and nothing private', async () => {
    const h = harness(async () => true); // even a chain that says yes to everything: the stranger holds no wire to verify
    const rows = await h.ask(STRANGER, PLAN);
    expect(rows.map((r) => r.toolId)).toEqual(PLAN.map((s) => s.toolId));
    expect(rows[0]!.result).toMatchObject({ count: 2, publicOnly: true });
    expect(rows[1]!.result).toMatchObject({ read: false, refused: expect.stringMatching(/readable by you/) });
    expect(rows[2]!.result).toMatchObject({ read: false, refused: expect.stringMatching(/readable by you/) });
    expect(rows[3]!.result).toMatchObject({ read: true, text: bodies['art-licence'], publicOnly: true });
    expect(leaks(rows.map((r) => r.result)).filter((m) => m !== 'art-diary' && m !== 'family-plan' && m !== 'diary')).toEqual([]); // the ids/names the plan itself typed
    expect(JSON.stringify(rows)).not.toMatch(/DIARY-BODY|PLAN-BODY|HELD-BODY|0xc0ffee/);
    expect(h.artifactReads).toEqual(['content.artifact.art-licence']);
  });

  it('a steward whose wire verifies reads all of it through the same plan; a wire that does not verify reads the shelf', async () => {
    const yes = harness(async ({ org, person }) => org.toLowerCase() === OWNER && person.toLowerCase() === STEWARD);
    const rows = await yes.ask(STEWARD, PLAN);
    expect(rows[0]!.result).toMatchObject({ count: 5 });
    expect(rows[0]!.result!.publicOnly).toBeUndefined();
    expect(rows[1]!.result).toMatchObject({ read: true, text: bodies['art-diary'] });
    expect(rows[2]!.result).toMatchObject({ read: true, text: bodies['family-plan-v1'] });

    const no = harness(async () => false); // revoked, or never signed by the organization
    const refused = await no.ask(STEWARD, PLAN);
    expect(refused[0]!.result).toMatchObject({ count: 2, publicOnly: true });
    expect(refused[1]!.result).toMatchObject({ read: false });
    expect(JSON.stringify(refused)).not.toMatch(/DIARY-BODY|PLAN-BODY/);

    const down = harness(async () => { throw new Error('chain unreachable'); });
    const closed = await down.ask(STEWARD, PLAN);
    expect(closed[0]!.result).toMatchObject({ count: 2, publicOnly: true });
    expect(JSON.stringify(closed)).not.toMatch(/DIARY-BODY|PLAN-BODY/);
  });

  it('the organization\'s own run reads its own Library', async () => {
    const h = harness(async () => false);
    const rows = await h.ask(OWNER, PLAN);
    expect(rows[0]!.result).toMatchObject({ count: 5 });
    expect(rows[1]!.result).toMatchObject({ read: true, text: bodies['art-diary'] });
  });
});
