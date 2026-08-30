import { describe, expect, it } from 'vitest';
import { cardRowView, describeStage, publicEndpoints, problemsFrom, servedInterfacesFrom, onlyAddressProblems, liveStage, planPublish, publishSequence, landingCopySamples, FORBIDDEN_ON_LANDING, BINDING_PROMPT, PUBLISH_PHRASE } from './studio-flow';
import { listingCatalog, listingRow, lossSentence, listingCopySamples, studioTabs } from './studio-listings';
import type { StoredProjection } from '../studio-client';

const ALL = ['agent.card.read', 'agent.card.draft', 'agent.card.validate', 'agent.card.approve', 'agent.card.sign', 'agent.card.publish'];
const EDITOR = ['agent.card.read', 'agent.card.draft', 'agent.card.validate'];

describe('planPublish — one button, the whole chain, stops only where it must', () => {
  it('runs every step for a fresh draft when the viewer holds every duty', () => {
    const p = planPublish({ draftState: 'validated', errors: 0, release: null, draftChanged: true, scopes: ALL });
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') return;
    expect(p.steps).toEqual(['create-release', 'request-approval', 'approve', 'sign', 'publish', 'verify']);
    expect(p.runnable).toEqual(p.steps);
    expect(p.stopAt).toBeNull();
    expect(p.asksForBinding).toBe(true);
  });
  it('resumes from wherever the current version is', () => {
    expect(publishSequence({ state: 'approved' })).toEqual(['sign', 'publish', 'verify']);
    expect(publishSequence({ state: 'signed' })).toEqual(['publish', 'verify']);
    expect(publishSequence({ state: 'published' })).toEqual([]);
    expect(publishSequence({ state: 'revoked' })).toHaveLength(6);
  });
  it('is blocked — never a 4xx after a click — while the description has problems', () => {
    const p = planPublish({ draftState: 'draft', errors: 2, release: null, draftChanged: true, scopes: ALL });
    expect(p).toMatchObject({ kind: 'blocked', fixCount: 2, line: 'Fix 2 things in the description first.' });
  });
  it('is live when the published version matches the draft, and republishes when it does not', () => {
    expect(planPublish({ draftState: 'validated', errors: 0, release: { state: 'published' }, draftChanged: false, scopes: ALL }).kind).toBe('live');
    const p = planPublish({ draftState: 'validated', errors: 0, release: { state: 'published' }, draftChanged: true, scopes: ALL });
    expect(p.kind).toBe('ready');
    if (p.kind === 'ready') expect(p.steps[0]).toBe('create-release');
  });
  it('stops at the first step a DIFFERENT person must do, and says who', () => {
    const p = planPublish({ draftState: 'validated', errors: 0, release: null, draftChanged: true, scopes: EDITOR });
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') return;
    expect(p.runnable).toEqual(['create-release', 'request-approval']);
    expect(p.stopAt).toEqual({ step: 'approve', line: 'Waiting for someone with approval rights.' });
    expect(p.asksForBinding).toBe(false);
  });
});

describe('stage copy', () => {
  it('describe: problems → Show me; unchecked → review or publish as is; clean → ready', () => {
    expect(describeStage({ draftState: 'draft', errors: 3, checked: true, skillCount: 0, name: 'x' })).toMatchObject({ status: '3 things to fix', action: { id: 'show-problems' } });
    expect(describeStage({ draftState: 'draft', errors: 0, checked: false, skillCount: 2, name: 'x' }).body).toContain('Review it, or publish as is');
    expect(describeStage({ draftState: 'validated', errors: 0, checked: true, skillCount: 1, name: 'x' }).status).toBe('Ready to publish ✓');
  });
  it('live: needs a name → says so; live → Open; changed → Publish the update', () => {
    const uri = 'https://alice.faithnet.ai/.well-known/agent-card.json';
    expect(liveStage({ plan: { kind: 'live' }, release: { state: 'published', publication: { uri, publishedAt: '2026-08-30T12:00:00Z' } }, cardUri: uri, lastVerdict: null })).toMatchObject({ status: 'Live ✓', action: { id: 'open' } });
    expect(liveStage({ plan: { kind: 'live' }, release: null, cardUri: null, lastVerdict: null }).status).toBe('Needs a name first');
    const ready = { kind: 'ready' as const, steps: [], runnable: [], stopAt: null, asksForBinding: false };
    expect(liveStage({ plan: ready, release: { state: 'published' }, cardUri: uri, lastVerdict: null }).action).toEqual({ id: 'republish', label: 'Publish the update' });
    expect(liveStage({ plan: ready, release: null, cardUri: uri, lastVerdict: null }).action).toEqual({ id: 'publish', label: 'Publish' });
    expect(liveStage({ plan: ready, release: null, cardUri: uri, lastVerdict: null }).explain).toContain('Listing is step ③');
  });
});

describe('listings — projections in the user\'s words', () => {
  const cat = listingCatalog({ brand: 'Faithnet', agentName: 'northern-colorado-field.workspace' });
  const LISTER = ['agent.projection.preview', 'agent.projection.approve', 'agent.projection.publish:ap-naming', 'agent.projection.publish:ap-registry'];
  const proj = (over: Partial<StoredProjection['instance']>, selected: string | null): StoredProjection => ({
    family: 'ap-naming', selectedCard: selected ? { cardResourceId: 'c', releaseId: selected } : null, planIds: [], receiptIds: [],
    instance: { type: 'ProjectionInstanceV1', instanceId: 'i', agent: 'eip155:1:0x1', definition: {} as never, configuration: null, configurationDigest: ('sha256:' + '0'.repeat(64)) as `sha256:${string}`, state: 'published', since: 't', desiredSources: {}, ...over } as StoredProjection['instance'],
  });
  it('names targets as products, not specs', () => {
    expect(cat['ap-naming'].title).toBe('Your name record');
    expect(cat['ap-registry'].title).toBe('Faithnet directory');
    expect(cat['ap-naming'].purpose).toContain('northern-colorado-field.workspace');
  });
  it('needs the card first, then List it, then Listed ✓, then Update listing', () => {
    expect(listingRow({ descriptor: cat['ap-naming'], projection: null, published: null, scopes: LISTER })).toMatchObject({ state: 'needs-card', button: null });
    expect(listingRow({ descriptor: cat['ap-naming'], projection: null, published: { releaseId: 'r1' }, scopes: LISTER })).toMatchObject({ state: 'not-listed', button: { label: 'List it' } });
    const listed = proj({ lastPublication: { receiptId: 'x', planId: 'p', artifactDigest: ('sha256:' + '1'.repeat(64)) as `sha256:${string}`, publishedAt: '2026-08-30T12:00:00Z' } }, 'r1');
    expect(listingRow({ descriptor: cat['ap-naming'], projection: listed, published: { releaseId: 'r1' }, scopes: LISTER })).toMatchObject({ state: 'listed', button: { label: 'Open' } });
    expect(listingRow({ descriptor: cat['ap-naming'], projection: listed, published: { releaseId: 'r2' }, scopes: LISTER })).toMatchObject({ state: 'out-of-date', button: { label: 'Update listing' } });
    expect(listingRow({ descriptor: cat['ap-naming'], projection: null, published: { releaseId: 'r1' }, scopes: [] })).toMatchObject({ state: 'missing-role', button: null });
    // A steward who does not custody the agent: the row says so BEFORE the click, instead of AA24 after it.
    const steward = listingRow({ descriptor: cat['ap-naming'], projection: null, published: { releaseId: 'r1' }, scopes: LISTER, custodian: false });
    expect(steward.state).toBe('missing-role');
    expect(steward.line).toContain("custodian");
    expect(steward.button).toBeNull();
    // Unknowable (wallet home) → the attempt is allowed and the chain decides.
    expect(listingRow({ descriptor: cat['ap-naming'], projection: null, published: { releaseId: 'r1' }, scopes: LISTER, custodian: null }).button).toEqual({ id: 'list', label: 'List it' });
  });
  it('summarises a loss in one sentence, never as a count headline', () => {
    expect(lossSentence('Faithnet directory', [{ category: 'truncated', severity: 'warning', sourcePointer: '/skills/3' }, { category: 'truncated', severity: 'warning', sourcePointer: '/skills/4' }], 5)).toBe("Faithnet directory can't show 2 of your 5 skills — it will list the other 3.");
    expect(lossSentence('x', [{ category: 'targetDefault', severity: 'info' }])).toBeNull();
  });
});

describe('cardRowView — a row says which card and whether it is live, nothing else', () => {
  const base = { displayName: 'Alice', environment: 'production', primary: true, servedReleaseId: null, listedCount: 1, listedTotal: 2 };
  it('reports live with how far the listings got', () => {
    expect(cardRowView({ ...base, draftState: 'clean', releaseState: 'published' })).toMatchObject({ status: 'Live ✓ · listed in 1 of 2 places', tone: 'good' });
    expect(cardRowView({ ...base, draftState: 'clean', releaseState: 'published', listedCount: 2 }).status).toBe('Live ✓ · listed everywhere');
    expect(cardRowView({ ...base, draftState: 'clean', releaseState: 'published', listedTotal: 0 }).status).toBe('Live ✓');
  });
  it('never shows a version number, a state word or a digest', () => {
    for (const rs of [null, 'signed', 'approved']) for (const ds of ['dirty', 'stale', 'clean'] as const) {
      const v = cardRowView({ ...base, draftState: ds, releaseState: rs });
      expect(`${v.title} ${v.subtitle} ${v.status}`.toLowerCase()).not.toMatch(/sha256|release|version|published|validate/);
    }
    expect(cardRowView({ ...base, draftState: 'dirty', releaseState: null }).status).toBe('Being written');
    expect(cardRowView({ ...base, draftState: 'stale', releaseState: null })).toMatchObject({ status: 'Needs a look', tone: 'warn' });
    expect(cardRowView({ ...base, draftState: null, releaseState: null }).status).toBe('Not live yet');
  });
  it('says what a non-primary card is for', () => {
    expect(cardRowView({ ...base, primary: false, draftState: null, releaseState: null }).subtitle).toContain('An additional card');
  });
});

describe('problems are named on the screen that says there are problems', () => {
  const diverge = (pointer: string, message: string) => ({ code: 'CATALOG_DIVERGENCE', severity: 'error' as const, sourcePointer: pointer, message });
  it('says which field and what is wrong, in words', () => {
    const p = problemsFrom([diverge('/supportedInterfaces', 'catalog interface JSONRPC https://x-workspace.faithnet.ai/api/a2a is missing from the card without an override binding')]);
    expect(p).toHaveLength(1);
    expect(p[0]!.where).toBe('How to reach it');
    expect(p[0]!.message).toBe("This doesn't match what the agent actually serves.");
  });
  it('reads the served address out of the divergence, so the fix can be one press', () => {
    const served = servedInterfacesFrom([
      diverge('/supportedInterfaces', 'catalog interface JSONRPC https://ncf-workspace.faithnet.ai/api/a2a is missing from the card without an override binding'),
      diverge('/supportedInterfaces/0', 'interface JSONRPC https://old.faithnet.io/api/a2a is not served per the surface catalog and carries no override binding'),
    ]);
    expect(served).toEqual([{ protocolBinding: 'JSONRPC', url: 'https://ncf-workspace.faithnet.ai/api/a2a' }]);
    expect(servedInterfacesFrom([{ code: 'OTHER', severity: 'error', message: 'nope' }])).toEqual([]);
  });
  it('knows when every problem is just the address, and when it is not', () => {
    const addr = [diverge('/supportedInterfaces', 'catalog interface JSONRPC https://a/api/a2a is missing from the card')];
    expect(onlyAddressProblems(addr)).toBe(true);
    expect(onlyAddressProblems([...addr, { code: 'SECRET_MATERIAL_DETECTED', severity: 'error', sourcePointer: '/description', message: 'x' }])).toBe(false);
    expect(onlyAddressProblems([])).toBe(false);
  });
});

describe('publicEndpoints — both documents a live agent serves', () => {
  it('names the card and the discovery entry on the same host, each with its standard', () => {
    const e = publicEndpoints('https://ncf-workspace.faithnet.ai/.well-known/agent-card.json');
    expect(e.map((x) => x.url)).toEqual([
      'https://ncf-workspace.faithnet.ai/.well-known/agent-card.json',
      'https://ncf-workspace.faithnet.ai/.well-known/ard.json',
    ]);
    expect(e.map((x) => x.standard)).toEqual(['A2A 1.0', 'ARD 0.91']);
    expect(e[1]!.what).toContain('crawlers and directories');
  });
  it('has nothing to show without an address', () => {
    expect(publicEndpoints(null)).toEqual([]);
    expect(publicEndpoints('not a url')).toEqual([]);
  });
});

describe('§9.4 — the landing never speaks our vocabulary', () => {
  it('no forbidden word appears in any main-path string', () => {
    const all = [...landingCopySamples(), ...listingCopySamples(), ...Object.values(BINDING_PROMPT), ...Object.values(PUBLISH_PHRASE)];
    expect(all.length).toBeGreaterThan(40);
    for (const s of all) for (const w of FORBIDDEN_ON_LANDING) expect(s.toLowerCase(), `"${s}" contains "${w}"`).not.toContain(w);
  });
});

describe('studioTabs — Agent Card first, one tab per place, each carrying its own status', () => {
  const base = { brand: 'Faithnet', agentName: 'alice.me', cardStatus: { status: 'Ready to publish ✓', tone: 'good' as const }, scopes: ['agent.projection.preview', 'agent.projection.approve', 'agent.projection.publish:ap-naming', 'agent.projection.publish:ap-registry'], projections: [] };
  it('gates every listing on the card before it exists', () => {
    const tabs = studioTabs({ ...base, published: null });
    expect(tabs.map((t) => t.label)).toEqual(['Agent Card', 'Your name record', 'Faithnet directory', 'History']);
    expect(tabs[0]!.suffix).toBe('');
    expect(tabs[1]!.suffix).toBe('/listing/ap-naming');
    expect(tabs.slice(1, 3).map((t) => t.status)).toEqual(['Card first', 'Card first']);
  });
  it('shows Not listed once the card is live, and Listed ✓ when it is done', () => {
    expect(studioTabs({ ...base, published: { releaseId: 'r1' } })[1]!.status).toBe('Not listed');
    const listed = [{ family: 'ap-naming' as const, instance: { lastPublication: {}, state: 'published' }, selectedCard: { releaseId: 'r1' } }];
    const tabs = studioTabs({ ...base, published: { releaseId: 'r1' }, projections: listed });
    expect(tabs[1]).toMatchObject({ status: 'Listed ✓', tone: 'good' });
    expect(studioTabs({ ...base, published: { releaseId: 'r2' }, projections: listed })[1]).toMatchObject({ status: 'Out of date', tone: 'warn' });
  });
  it('says when a listing needs someone else rather than offering it', () => {
    expect(studioTabs({ ...base, published: { releaseId: 'r1' }, custodian: false })[1]!.status).toBe('Needs someone else');
    expect(studioTabs({ ...base, published: { releaseId: 'r1' }, scopes: [] })[1]!.status).toBe('Needs someone else');
  });
  it('never speaks our vocabulary', () => {
    for (const t of studioTabs({ ...base, published: { releaseId: 'r1' } })) {
      for (const w of ['projection', 'release', 'digest', 'adapter', 'artifact']) {
        expect(`${t.label} ${t.status}`.toLowerCase()).not.toContain(w);
      }
    }
  });
});
