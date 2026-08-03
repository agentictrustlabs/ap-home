// Subdomain → agent routing, untested until now.
//
// This is the function that decides WHICH PRINCIPAL a request is for. `alice.impact-agent.io` means
// "act as alice"; getting it wrong means acting as the wrong agent, so the interesting cases are all
// the ways a hostname can almost match:
//
//   the apex itself                    → no agent, the generic endpoint
//   a nested label (`a.b.base`)        → refused, NOT collapsed to `b`
//   a suffix that merely ends the same  → `evil-impact-agent.io` is not a subdomain of it
//   a port, mixed case                 → normalized, because Host headers carry both
//
// The suffix case is the one worth naming: a check written as `host.endsWith(base)` rather than
// `host.endsWith('.' + base)` would treat `notimpact-agent.io` as a subdomain and route someone else's
// traffic. That is a routing bug wearing the shape of a string comparison, and it is what the negative
// tests below are actually guarding.

import { describe, it, expect } from 'vitest';
import {
  buildA2aAgentCard,
  parseAgentSubdomain,
  agentNameForLabel,
  withConsultSkill,
  skillsFromLabels,
  CONSULT_SKILL_CARD,
  AGENT_NAME_PARENT,
  DEFAULT_PUBLIC_BASE_DOMAIN,
} from '../src/host-context.js';

const BASE = DEFAULT_PUBLIC_BASE_DOMAIN;

describe('subdomain → label', () => {
  it('extracts a single label', () => {
    expect(parseAgentSubdomain(`alice.${BASE}`, BASE)).toBe('alice');
  });

  it('normalizes case and strips the port — Host headers carry both', () => {
    expect(parseAgentSubdomain(`ALICE.${BASE.toUpperCase()}`, BASE)).toBe('alice');
    expect(parseAgentSubdomain(`alice.${BASE}:8787`, BASE)).toBe('alice');
  });

  it('the apex is NOT an agent — it is the generic endpoint', () => {
    expect(parseAgentSubdomain(BASE, BASE)).toBeNull();
    expect(parseAgentSubdomain(`${BASE}:443`, BASE)).toBeNull();
  });

  // THE routing bug this guards. `endsWith(base)` without the dot would match all of these and route
  // an attacker-controlled host to somebody's agent.
  it('REFUSES a host that merely ends with the base domain', () => {
    expect(parseAgentSubdomain(`evil-${BASE}`, BASE)).toBeNull();
    expect(parseAgentSubdomain(`not${BASE}`, BASE)).toBeNull();
    expect(parseAgentSubdomain(`x${BASE}`, BASE)).toBeNull();
  });

  // Collapsing `a.b.base` to `b` would let a nested host impersonate a single-label one.
  it('REFUSES nested labels rather than taking the last one', () => {
    expect(parseAgentSubdomain(`a.b.${BASE}`, BASE)).toBeNull();
    expect(parseAgentSubdomain(`deep.nested.alice.${BASE}`, BASE)).toBeNull();
  });

  it('REFUSES an empty label and a missing host', () => {
    expect(parseAgentSubdomain(`.${BASE}`, BASE)).toBeNull();
    expect(parseAgentSubdomain(undefined, BASE)).toBeNull();
    expect(parseAgentSubdomain('', BASE)).toBeNull();
  });

  it('REFUSES an unrelated domain entirely', () => {
    expect(parseAgentSubdomain('alice.example.com', BASE)).toBeNull();
  });

  it('works against a non-default base domain — the base is a parameter, not a constant', () => {
    expect(parseAgentSubdomain('bob.example.test', 'example.test')).toBe('bob');
    expect(parseAgentSubdomain(`bob.${BASE}`, 'example.test')).toBeNull();
  });
});

describe('label → agent name', () => {
  it('appends the deployment TLD', () => {
    expect(agentNameForLabel('alice')).toBe(`alice.${AGENT_NAME_PARENT}`);
    expect(AGENT_NAME_PARENT).toBe('impact');
  });

  // The round trip that matters: whatever the host resolves to is what the name is built from, so a
  // host that parses to `alice` must not produce a name for anyone else.
  it('round-trips from a hostname', () => {
    const label = parseAgentSubdomain(`alice.${BASE}`, BASE);
    expect(label).not.toBeNull();
    expect(agentNameForLabel(label!)).toBe('alice.impact');
  });
});

describe('skill cards', () => {
  it('maps labels to slugged ids, preserving the human name', () => {
    expect(skillsFromLabels('Grant Writing, Legal Review')).toEqual([
      { id: 'grant-writing', name: 'Grant Writing', tags: ['skill'] },
      { id: 'legal-review', name: 'Legal Review', tags: ['skill'] },
    ]);
  });

  it('is empty for absent or blank input rather than producing a blank card', () => {
    expect(skillsFromLabels(null)).toEqual([]);
    expect(skillsFromLabels(undefined)).toEqual([]);
    expect(skillsFromLabels('')).toEqual([]);
    expect(skillsFromLabels(' , , ')).toEqual([]);
  });

  // Bounded because the source is a public on-chain string an agent controls: an unbounded label list
  // becomes an unbounded agent card.
  it('caps the list at 64', () => {
    expect(skillsFromLabels(Array.from({ length: 100 }, (_, i) => `s${i}`).join(','))).toHaveLength(64);
  });

  it('slugs punctuation without leaving stray separators', () => {
    expect(skillsFromLabels('C++ / Rust!')[0]).toEqual({ id: 'c-rust', name: 'C++ / Rust!', tags: ['skill'] });
  });

  it('adds the consult card only when consultable, and never twice', () => {
    expect(withConsultSkill([], false)).toEqual([]);
    expect(withConsultSkill([], true)).toEqual([CONSULT_SKILL_CARD]);
    // Dedup-safe: called twice on an already-carded list, the card appears once.
    const once = withConsultSkill([], true);
    expect(withConsultSkill(once, true)).toHaveLength(1);
  });

  it('preserves the existing skills it appends to', () => {
    const skills = skillsFromLabels('Grant Writing');
    const withConsult = withConsultSkill(skills, true);
    expect(withConsult).toHaveLength(2);
    expect(withConsult[0]?.id).toBe('grant-writing');
  });
});


// ADR-0059 / spec 341 §2.1 — asserted on the card demo-a2a ACTUALLY SERVES, not on the package
// builder. The recurring failure in this repo is a correct implementation reachable only from a path
// no deployment runs (spec 340 W11 → W12), so the test targets the deployed shape.
describe('the served Agent Card declares how to authenticate', () => {
  const ctx = {
    publicOrigin: 'https://alice.example.io',
    label: 'alice',
    name: 'alice.impact',
    agent: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  } as unknown as Parameters<typeof buildA2aAgentCard>[0];

  const card = (): Record<string, unknown> => buildA2aAgentCard(ctx, 84532);
  const caps = (): { extensions?: { uri: string }[] } =>
    card().capabilities as { extensions?: { uri: string }[] };

  it('carries the AP authority extension on the public card', () => {
    const uris = (caps().extensions ?? []).map((e) => e.uri);
    expect(uris.some((u) => u.includes('/a2a/authority/'))).toBe(true);
  });

  it('states that a bearer is an envelope and authority is re-checked per call', () => {
    const ext = (caps().extensions ?? []).find((e) => e.uri.includes('/a2a/authority/')) as
      | { params?: { bearerIsEnvelopeOnly?: boolean; reEvaluatedPerCall?: boolean; chain?: string } }
      | undefined;
    expect(ext?.params?.bearerIsEnvelopeOnly).toBe(true);
    expect(ext?.params?.reEvaluatedPerCall).toBe(true);
    // Chain-scoped, so a peer resolves the delegation against the right chain rather than guessing.
    expect(ext?.params?.chain).toBe('eip155:84532');
  });

  it('does not claim streaming or push it has not mounted', () => {
    const c = card().capabilities as { streaming: boolean; pushNotifications: boolean };
    expect(c.streaming).toBe(false);
    expect(c.pushNotifications).toBe(false);
  });
});
