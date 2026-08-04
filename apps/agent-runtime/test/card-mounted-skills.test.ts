// spec 341 §2.3 — the Card must advertise what the runtime MOUNTS.
//
// The defect this closes: every bound agent served `skills: []`, because the Card carried only the
// agent's self-asserted `atl:skills` label and almost nobody sets it — while `makeMessagingSkills`
// mounted three handlers on every agent's task runtime. So the entire messaging rail was
// undiscoverable, and §2's exit criterion (*a third-party agent, reading only the public Card, can
// invoke `messaging.deliver`*) was unreachable for every agent on the deployment.
//
// THE TEST THAT MATTERS IS THE COUPLING ONE. A test that restates the three ids would pass forever
// while the runtime mounted a fourth, or dropped one — which is the failure mode of an advertisement:
// it does not break, it just stops being true.

import { describe, it, expect } from 'vitest';
import { MOUNTED_PEER_SKILLS, withMountedSkills, buildA2aAgentCard, type A2aSkill } from '../src/host-context.js';
import { makeMessagingSkills } from '../src/messaging-skills.js';

const RECIPIENT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const mountedIds = makeMessagingSkills(RECIPIENT, async () => undefined).map((h) => h.skill).sort();

describe('the Card and the runtime cannot drift', () => {
  it('advertises EXACTLY the skills the runtime mounts', () => {
    // Both directions. Missing one makes the rail undiscoverable — the bug being fixed. Advertising
    // one that is not mounted is worse: a peer builds against it, sends, and gets a rejection that
    // reads like an authorization problem and is not one.
    expect(MOUNTED_PEER_SKILLS.map((s) => s.id).sort()).toEqual(mountedIds);
  });

  it('gives every advertised skill a name and a description', () => {
    // The id alone tells a peer what to type, not what it does or what it costs them to be refused.
    for (const s of MOUNTED_PEER_SKILLS) {
      expect(s.name, s.id).toBeTruthy();
      expect(String(s.description ?? ''), s.id).not.toHaveLength(0);
    }
  });

  it('says a card entry grants nothing', () => {
    // ADR-0041 on the wire, not only in a comment: a peer reading this must not conclude that
    // discovering a skill is being permitted to call it.
    const blob = JSON.stringify(MOUNTED_PEER_SKILLS).toLowerCase();
    expect(blob).toMatch(/never authority|grants nothing|requires a delegation|is not acceptance/);
  });
});

describe('merging with the agent’s own labels', () => {
  it('keeps self-asserted skills and adds the mounted ones', () => {
    const own: A2aSkill[] = [{ id: 'grant-writing', name: 'Grant writing', tags: ['skill'] }];
    const merged = withMountedSkills(own);
    expect(merged.map((s) => s.id)).toContain('grant-writing');
    expect(merged.map((s) => s.id)).toContain('messaging.deliver');
  });

  it('lets the agent’s OWN description win a collision', () => {
    // An agent that describes its own `messaging.deliver` knows more about it than this generic
    // entry does, and a merge that overwrote it would silently replace specific truth with generic.
    const own: A2aSkill[] = [{ id: 'messaging.deliver', name: 'My bespoke delivery', tags: ['x'] }];
    const merged = withMountedSkills(own);
    expect(merged.filter((s) => s.id === 'messaging.deliver')).toHaveLength(1);
    expect(merged.find((s) => s.id === 'messaging.deliver')?.name).toBe('My bespoke delivery');
  });

  it('is idempotent — merging twice advertises nothing twice', () => {
    expect(withMountedSkills(withMountedSkills([]))).toEqual(withMountedSkills([]));
  });
});

describe('the card carries them through', () => {
  const ctx = {
    publicOrigin: 'https://alice.impact-agent.io',
    label: 'alice',
    name: 'alice.impact',
    agent: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  } as never;

  it('serves the mounted skills on a BOUND agent’s card', () => {
    const card = buildA2aAgentCard(ctx, 84532, withMountedSkills([]));
    expect((card.skills as A2aSkill[]).map((s) => s.id)).toEqual(MOUNTED_PEER_SKILLS.map((s) => s.id));
  });

  it('still declares the authority extension alongside them', () => {
    // Skills without an authority declaration is the half-fix: a peer learns what exists and nothing
    // about how to become allowed to call it (§2.1).
    const card = buildA2aAgentCard(ctx, 84532, withMountedSkills([]));
    const ext = (card.capabilities as { extensions?: { uri: string }[] }).extensions ?? [];
    expect(ext.some((e) => e.uri.includes('/authority/'))).toBe(true);
  });
});
