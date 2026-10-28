import { describe, expect, it } from 'vitest';
import { fmtMs, isStale, parseHeartbeat, tilesOf, type Heartbeat } from '../src/model.js';

const base: Heartbeat = {
  estate: 'faithnet', at: '2026-10-28T12:00:00.000Z', window: '24h', generation: '1', versions: {},
  agents: { person: 82, org: 87, service: 60 }, homesActive24h: 7,
  runs: { started: 703, completed: 527, parked: 5, failed: 139, canceled: 0 }, parkedForSignature: 5,
  modelCalls: 62, tokensIn: 0, tokensOut: 0, inferenceMicroUsd: null, vaultCalls: 0, doRequests: 0, askLatencyP95Ms: 55_900,
  performance: { runDurationMs: { p50: 1000, p95: 57_200, count: 703 } },
  evidenceCoverage: { runs: 703, complete: 646, incomplete: 20, unknown: 37 },
};
const tile = (h: Heartbeat, label: string) => tilesOf(h).find((t) => t.label === label)!;

describe('tilesOf', () => {
  it('reads the figures the Pulse shows', () => {
    expect(tile(base, 'Runs 24h')).toMatchObject({ value: '703', sub: '527 completed · 139 failed' });
    expect(tile(base, 'Ask p95').value).toBe('55.9 s');
    expect(tile(base, 'Records complete')).toMatchObject({ value: '646 / 703', sub: '20 incomplete · 37 stopped early (not a gap)' });
    expect(tile(base, 'Run p95')).toMatchObject({ value: '57.2 s', sub: '703 runs in the block' });
  });
  it('says absent spend is absent, not $0', () => {
    expect(tile(base, 'Cost over the window')).toMatchObject({ value: '—', sub: 'not a gateway client yet' });
  });
  it('prices a run when the estate knows its spend', () => {
    expect(tile({ ...base, inferenceMicroUsd: 6_650_000 }, 'Cost over the window').value).toBe('$6.65');
  });
  it('says an uncomputed block is uncomputed', () => {
    const { evidenceCoverage: _e, performance: _p, ...rest } = base;
    expect(tile(rest as Heartbeat, 'Records complete').value).toBe('—');
    expect(tile(rest as Heartbeat, 'Run p95').value).toBe('—');
  });
});

describe('parseHeartbeat / isStale / fmtMs', () => {
  it('drops a malformed heartbeat rather than zero-filling it', () => {
    expect(parseHeartbeat({ estate: 'x' })).toBeNull();
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat(base)).not.toBeNull();
  });
  it('is stale after two sampling intervals', () => {
    const t = Date.parse(base.at);
    expect(isStale(base, t + 599_000)).toBe(false);
    expect(isStale(base, t + 601_000)).toBe(true);
  });
  it('formats null as a dash', () => { expect(fmtMs(null)).toBe('—'); expect(fmtMs(420)).toBe('420 ms'); });
});
