// THE PERSON AS A PUBLISHER — her agent answers the publisher contract over her Library: the public lane sees only what
// she marked public; the private lane (her own ask) sees her marks. Read from the records as the Home writes them
// (`content.catalog` + `content.artifact.<id>`), never through a sibling helper.
import { describe, expect, it } from 'vitest';
import { indexOf, lociOf, osisBook, publisherRead, PUBLISHER_READ_SKILLS, PUBLISHER_TOOLS } from '../src/publisher-contract.js';
import { PUBLIC_LANE_SKILLS } from '../src/standard-a2a.js';
import { MOUNTED_PEER_SKILLS } from '../src/host-context.js';

const OWNER = '0x' + 'ab'.repeat(20);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const PLACES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'bethany-beyond-jordan',
      geometry: { type: 'Point', coordinates: [35.5546, 31.8372] },
      properties: { name: 'Where I stood by the Jordan', references: [{ osis: 'John.1.28', relation: 'locates', confidence: 1, method: 'person' }] },
    },
  ],
};
const HIGHLIGHTS = {
  '@context': { seed: 'https://seed-bible.org/ns#' },
  '@graph': [
    { '@id': 'urn:seed:h1', '@type': 'seed:Highlight', heldBy: OWNER, aboutPassage: 'JHN.3.16-JHN.3.17', highlightColor: 'yellow' },
    { '@id': 'urn:seed:h2', '@type': 'seed:Highlight', heldBy: OWNER, aboutPassage: 'JHN.3.3', deleted: true },
    { '@id': 'urn:seed:n1', '@type': 'seed:Annotation', heldBy: OWNER, aboutPassage: 'JHN.3.16', note: 'the whole gospel in one verse' },
  ],
};

function vault(extra: Record<string, unknown> = {}) {
  const records = new Map<string, unknown>([
    ['content.catalog', [
      { id: 'places', kind: 'json-ld', name: 'places.geojson', folder: 'faith/public', accessPolicy: 'public', version: 2, createdAt: 1_700_000_000_000, releases: [{ releaseId: 'r1', version: '2', signed: true }] },
      { id: 'jhn3', kind: 'json-ld', name: '3.jsonld', folder: 'seed-bible/highlights/JHN', version: 5, createdAt: 1_700_000_100_000 },
      { id: 'notes', kind: 'md', name: 'notes.md', folder: 'faith', accessPolicy: 'public', createdAt: 1 },
    ]],
    ['content.artifact.places', { id: 'places', name: 'places.geojson', bytesB64: b64(JSON.stringify(PLACES)) }],
    ['content.artifact.jhn3', { id: 'jhn3', name: '3.jsonld', bytesB64: b64(JSON.stringify(HIGHLIGHTS)) }],
    ['content.artifact.notes', { id: 'notes', name: 'notes.md', bytesB64: b64('# not scripture') }],
    ...Object.entries(extra),
  ]);
  return { readSubjectRecord: async (_s: string, t: string) => structuredClone(records.get(t) ?? null) };
}

describe('scripture references as a person writes them', () => {
  it('reads OSIS and USFM books, verses, and ranges inside a chapter', () => {
    expect(osisBook('JHN')).toBe('John');
    expect(osisBook('1Sam')).toBe('1Sam');
    expect(osisBook('nope')).toBeNull();
    expect(lociOf('JHN.3.16-JHN.3.18')).toEqual(['John.3.16', 'John.3.17', 'John.3.18']);
    expect(lociOf('John 3:16')).toEqual(['John.3.16']);
    expect(lociOf('JHN.3')).toEqual(['John.3']);
    expect(lociOf('not a verse')).toEqual([]);
  });
});

describe('the public lane', () => {
  it('describes only what the owner marked public, and says who answers', async () => {
    const out = await publisherRead(vault(), OWNER, 'public', 'publisher.describe', {});
    expect(out.ok).toBe(true);
    expect(out.publisher).toEqual({ address: OWNER, kind: 'person', profile: 'person-publisher' });
    expect(out.lanes).toEqual(['public']);
    expect((out.works as Array<{ work: string; access: string; kind: string }>).map((w) => [w.work, w.kind, w.access])).toEqual([[`${OWNER}/faith/public/places.geojson`, 'features', 'public']]);
    expect(out.relations).toEqual(['locates']);
  });

  it('answers a feature at its verse in the contract envelope, and nothing of the private marks', async () => {
    const deps = vault();
    const at = await publisherRead(deps, OWNER, 'public', 'publisher.at-verse', { verse: 'John 1:28' });
    const items = at.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect((it0.item as { kind: string; name: string }).kind).toBe('feature');
    expect(it0.references).toEqual([{ to: 'John.1.28', relation: 'locates', confidence: 1, method: 'person' }]);
    expect((it0.location as { bounds: number[] }).bounds).toEqual([35.5546, 31.8372, 35.5546, 31.8372]);
    expect(it0.release).toMatchObject({ work: `${OWNER}/faith/public/places.geojson`, version: '2', releaseId: 'r1', signatureStatus: 'signed' });
    expect(it0.access).toBe('public');
    expect(it0.license).toBe('all-rights-reserved');
    const marks = await publisherRead(deps, OWNER, 'public', 'publisher.at-verse', { verse: 'John.3.16' });
    expect(marks.items).toEqual([]);
    expect(marks.count).toBe(0);
  });

  it('finds the feature near a place and refuses an ask with no area', async () => {
    const deps = vault();
    const near = await publisherRead(deps, OWNER, 'public', 'publisher.near', { point: [35.5, 31.8], radiusKm: 20 });
    expect((near.items as unknown[]).length).toBe(1);
    const far = await publisherRead(deps, OWNER, 'public', 'publisher.near', { bbox: [10, 40, 12, 42] });
    expect(far.items).toEqual([]);
    const none = await publisherRead(deps, OWNER, 'public', 'publisher.near', {});
    expect(none.ok).toBe(false);
    expect(String(none.refused)).toMatch(/bbox/);
  });
});

describe('the private lane', () => {
  it('reads the owner’s marks at a verse: a highlight across a range, a note, never a deleted one', async () => {
    const out = await publisherRead(vault(), OWNER, 'private', 'publisher.at-verse', { verse: 'JHN.3.16' });
    const items = out.items as Array<{ item: { kind: string; id: string }; references: Array<{ to: string; relation: string }>; access: string; license: string }>;
    expect(items.map((i) => [i.item.kind, i.item.id]).sort()).toEqual([['highlight', 'urn:seed:h1'], ['note', 'urn:seed:n1']]);
    const h = items.find((i) => i.item.id === 'urn:seed:h1')!;
    // Only the asked verse's reference comes back, not the whole range's.
    expect(h.references).toEqual([{ to: 'John.3.16', relation: 'annotates', confidence: 1, method: 'person' }]);
    expect(h.access).toBe('private');
    expect(h.license).toBe('private');
    const gone = await publisherRead(vault(), OWNER, 'private', 'publisher.at-verse', { verse: 'JHN.3.3' });
    expect(gone.items).toEqual([]);
  });

  it('reads a whole chapter as a span, narrowed by kind, and lists the works with counts', async () => {
    const deps = vault();
    const span = await publisherRead(deps, OWNER, 'private', 'publisher.at-verse', { span: 'JHN.3', kind: 'highlight' });
    expect((span.items as Array<{ item: { id: string } }>).map((i) => i.item.id)).toEqual(['urn:seed:h1']);
    const works = await publisherRead(deps, OWNER, 'private', 'publisher.works', {});
    const rows = works.works as Array<{ work: string; kind: string; items: number; located: number; access: string }>;
    expect(rows.map((w) => [w.work, w.kind, w.items, w.located, w.access])).toEqual([
      [`${OWNER}/seed-bible/highlights`, 'marks', 2, 0, 'private'],
      [`${OWNER}/faith/public/places.geojson`, 'features', 1, 1, 'public'],
    ]);
    const items = await publisherRead(deps, OWNER, 'private', 'publisher.items', { work: 'seed-bible/highlights', limit: 1 });
    expect(items.count).toBe(2);
    expect(items.cursor).toBe('1');
    const refusedWork = await publisherRead(deps, OWNER, 'private', 'publisher.items', { work: 'faith/notes.md' });
    expect(refusedWork.ok).toBe(false);
  });

  it('tells a registry what changed since a time, oldest first', async () => {
    const out = await publisherRead(vault(), OWNER, 'private', 'publisher.changes', { since: 1_700_000_000_000 });
    expect((out.changes as Array<{ work: string; change: string }>).map((c) => [c.work, c.change])).toEqual([[`${OWNER}/seed-bible/highlights`, 'published']]);
    expect(out.cursor).toBe('1700000100000');
  });

  it('refuses a verse it cannot read, and a skill outside the contract', async () => {
    expect((await publisherRead(vault(), OWNER, 'private', 'publisher.at-verse', { verse: 'somewhere' })).ok).toBe(false);
    expect((await publisherRead(vault(), OWNER, 'private', 'publisher.at-verse', { span: 'John.3.16' })).ok).toBe(false);
    expect((await publisherRead(vault(), OWNER, 'private', 'library.file.read', {})).ok).toBe(false);
  });

  it('reads the Library once while the catalog is unchanged', async () => {
    let reads = 0;
    const base = vault();
    const deps = { readSubjectRecord: async (s: string, t: string) => { if (t.startsWith('content.artifact.')) reads++; return base.readSubjectRecord(s, t); } };
    const owner = '0x' + 'cd'.repeat(20);
    await indexOf(deps, owner, 'private');
    await indexOf(deps, owner, 'private');
    expect(reads).toBe(2);
  });
});

describe('the wiring', () => {
  it('mounts every contract read on the public lane and advertises it on the card', () => {
    for (const id of PUBLISHER_READ_SKILLS) {
      expect(PUBLIC_LANE_SKILLS.has(id), id).toBe(true);
      expect(MOUNTED_PEER_SKILLS.some((s) => s.id === id), id).toBe(true);
    }
    expect(PUBLISHER_TOOLS.map((t) => t.id)).toEqual([...PUBLISHER_READ_SKILLS]);
  });
});
