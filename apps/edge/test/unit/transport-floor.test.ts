// The edge's transport floor (spec 339 §10) — testing the WIRING, not the library underneath it.
//
// `meetsTransportAssurance` is already tested in `admission`. What is worth testing HERE is that this
// app measures the right thing: what the handshake VALIDATED, never the label a request carried.
// Measuring the label would let a caller claim its way past a floor by setting a field.

import { describe, expect, it } from 'vitest';
import { transportEvidenceFromCf, type CfTlsClientAuth } from '@agenticprimitives/edge-cloudflare';
import { observedTransportAssurance } from '@agenticprimitives/admission';
import { transportFloorRefuses } from '../../src/index.js';

const NOW = new Date('2026-08-02T00:00:00.000Z');
const observed = (tls: CfTlsClientAuth | undefined) =>
  observedTransportAssurance(transportEvidenceFromCf(tls, { now: () => NOW }));

const goodCert: CfTlsClientAuth = {
  certPresented: '1',
  certVerified: 'SUCCESS',
  certRevoked: '0',
  certFingerprintSHA256: 'AABBCC',
  certNotBefore: '2026-01-01T00:00:00.000Z',
  certNotAfter: '2027-01-01T00:00:00.000Z',
};

describe('a route with no floor', () => {
  it('admits a plain HTTPS request — the baseline is normal, not degraded', () => {
    expect(transportFloorRefuses({}, observed(undefined))).toBe(false);
  });

  it('admits a request that happens to bring a certificate', () => {
    expect(transportFloorRefuses({}, observed(goodCert))).toBe(false);
  });
});

describe('a route that requires mTLS', () => {
  const route = { minTransportAssurance: 'MTLS' as const };

  it('REFUSES plain HTTPS', () => {
    expect(transportFloorRefuses(route, observed(undefined))).toBe(true);
  });

  it('admits a verified certificate', () => {
    expect(transportFloorRefuses(route, observed(goodCert))).toBe(false);
  });

  it('REFUSES a certificate that did not verify — presence is not proof', () => {
    expect(transportFloorRefuses(route, observed({ certPresented: '1', certVerified: 'FAILED' }))).toBe(true);
  });

  it('REFUSES a revoked certificate', () => {
    expect(transportFloorRefuses(route, observed({ ...goodCert, certRevoked: '1' }))).toBe(true);
  });

  it('REFUSES an expired certificate even when the handshake said SUCCESS', () => {
    expect(
      transportFloorRefuses(route, observed({ ...goodCert, certNotAfter: '2026-01-01T00:00:00.000Z' })),
    ).toBe(true);
  });
});

describe('the floor measures what was VALIDATED, not what was claimed', () => {
  it('a self-reported MTLS label on an unverified certificate does not clear an MTLS floor', () => {
    // The evidence object carries transportAssurance: 'HTTPS' because nothing validated — but even if
    // a producer mislabelled it, `observedTransportAssurance` recomputes from `validation`.
    const evidence = transportEvidenceFromCf({ certPresented: '1', certVerified: 'FAILED' }, { now: () => NOW });
    const mislabelled = { ...evidence, transportAssurance: 'MTLS' as const };
    expect(transportFloorRefuses({ minTransportAssurance: 'MTLS' }, observedTransportAssurance(mislabelled))).toBe(true);
  });
});

describe('what the deployed catalog declares today', () => {
  it('no route requires mTLS — accurate, because no mTLS hostname exists', () => {
    // Declaring MTLS on any route today would refuse ALL traffic: *.workers.dev cannot do mTLS.
    // This test exists so enabling one is a deliberate edit somebody has to make here too.
    expect(transportFloorRefuses({ minTransportAssurance: undefined }, 'HTTPS')).toBe(false);
  });
});
