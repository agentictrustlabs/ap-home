import { describe, expect, it } from 'vitest';
import { demoPersonaFor, listDemoPersonas, mergeRegistries } from './demo-custody';

const K1 = `0x${'11'.repeat(32)}`, K2 = `0x${'22'.repeat(32)}`, K3 = `0x${'33'.repeat(32)}`;
const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`;
const primary = JSON.stringify({ alice: { sa: A, eoaPrivateKey: K1, name: 'Alice' }, seedreader: { sa: B, eoaPrivateKey: K2 } });

describe('DEMO_PERSONA_KEYS_EXTRA — additive only', () => {
  it('adds a persona the primary roster does not hold, and keeps every primary persona', () => {
    const m = mergeRegistries(primary, JSON.stringify({ 'demo-publisher': { sa: C, eoaPrivateKey: K3, name: 'Demo Publisher' } }));
    expect([...m.keys()].sort()).toEqual([A, B, C]);
    expect(m.get(C)?.handle).toBe('demo-publisher');
  });
  it('can never replace or re-key a persona already in the primary roster', () => {
    const m = mergeRegistries(primary, JSON.stringify({ mallory: { sa: A, eoaPrivateKey: K3 }, [B]: K3 }));
    expect(m.get(A)?.handle).toBe('alice');
    expect(m.get(A)?.privateKey).toBe(K1);
    expect(m.get(B)?.privateKey).toBe(K2);
  });
  it('a missing or malformed extra secret changes nothing', () => {
    for (const extra of [undefined, '', 'not json', '[]', '{"x":{"sa":"nope"}}']) {
      expect([...mergeRegistries(primary, extra).keys()].sort()).toEqual([A, B]);
    }
  });
  it('the Home resolves an extra persona by handle and lists it', () => {
    const env = { DEMO_PERSONA_KEYS: primary, DEMO_PERSONA_KEYS_EXTRA: JSON.stringify({ 'demo-publisher': { sa: C, eoaPrivateKey: K3 } }) } as never;
    expect(demoPersonaFor(env, 'demo-publisher')?.sa).toBe(C);
    expect(listDemoPersonas(env).map((p) => p.handle).sort()).toEqual(['alice', 'demo-publisher', 'seedreader']);
  });
});
