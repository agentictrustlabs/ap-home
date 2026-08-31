/**
 * spec 348 — one nav shape for every agent class.
 *
 * WHAT THIS PINS, and why each case exists:
 *
 * The three navs used to disagree about where the same thing lived — Trust graph was in Manage for an
 * org and Discovery for a person, a service had no Library because nobody wired one, and `Manage` had
 * become the bucket for nine unrelated items. The shape is the contract now: a class may LACK a whole
 * area, but it may never put a shared item somewhere else.
 *
 * The per-item exceptions below are deliberate and each is grounded in a surface that does or does not
 * exist — never in making a list shorter. If one of them starts failing because the surface was built,
 * the fix is to delete the exception, not to loosen the test.
 */
import { describe, it, expect } from 'vitest';
import { buildNav, buildSettingsPane, buildUserMenu, type NavGroup } from './nav';
import { whitelabel } from '../../whitelabel/config';

const ORG = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const SVC = '0x3d653cbab0c99b1513439758eb2eac2039caa6e1';
const PERSON = { kind: 'person' } as const;
const ORG_SCOPE = { kind: 'org', org: ORG } as const;
const SVC_SCOPE = { kind: 'service', agent: SVC } as const;

const labels = (g: NavGroup[]): string[] => g.flatMap((x) => x.items.map((i) => i.label));
const area = (g: NavGroup[], heading: string) => g.find((x) => x.heading === heading);
const TOP = ['Overview', 'Messages', 'Activities', 'Library'];

describe('the top band is the same four for every class', () => {
  for (const [name, scope] of [['person', PERSON], ['org', ORG_SCOPE], ['service', SVC_SCOPE]] as const) {
    it(`${name}: Overview · Messages · Activities · Library, in that order, never collapsible`, () => {
      const first = buildNav(whitelabel, {}, scope)[0]!;
      expect(first.items.map((i) => i.label)).toEqual(TOP);
      expect(first.collapsible).toBeFalsy();
    });
  }
});

describe('areas are present or absent as a whole — never rearranged', () => {
  it('Stewardship is for agents that steward: person and org, not a service', () => {
    expect(area(buildNav(whitelabel, {}, PERSON), 'Stewardship')).toBeTruthy();
    expect(area(buildNav(whitelabel, {}, ORG_SCOPE), 'Stewardship')).toBeTruthy();
    expect(area(buildNav(whitelabel, {}, SVC_SCOPE), 'Stewardship')).toBeUndefined();
  });

  it('Stewardship starts COLLAPSED — it is a directory, not a destination', () => {
    const s = area(buildNav(whitelabel, {}, PERSON), 'Stewardship')!;
    expect(s.collapsible).toBe(true);
    expect(s.defaultOpen).toBe(false);
    expect(s.id).toBeTruthy(); // it must have a key to remember its state under
  });

  it('Records is an area for every class', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      expect(area(buildNav(whitelabel, {}, scope), 'Records')?.collapsible).toBe(true);
    }
  });

  it('Work is a main-nav item for person and org, absent for a service', () => {
    expect(labels(buildNav(whitelabel, {}, PERSON))).toContain('Work');
    expect(labels(buildNav(whitelabel, {}, ORG_SCOPE))).toContain('Work');
    expect(labels(buildNav(whitelabel, {}, SVC_SCOPE))).not.toContain('Work');
  });

  it('Settings is ONE main-nav item, never an area — the pane is the disclosure', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      const g = buildNav(whitelabel, {}, scope);
      expect(labels(g)).toContain('Settings');
      expect(area(g, 'Settings')).toBeUndefined();
    }
  });
});

describe('the shape after the 2026-08-31 design review', () => {
  it('Settings is LAST — it is the door you take to change the thing you were working in', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      const g = buildNav(whitelabel, {}, scope);
      // (a non-person workspace ends with the "Back to your home" exit)
      const meaningful = g.filter((x) => !x.isExit);
      expect(meaningful[meaningful.length - 1]!.items.map((i) => i.label)).toEqual(['Settings']);
    }
  });

  it('carries exactly ONE region divider — more than one carries no information', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      expect(buildNav(whitelabel, {}, scope).filter((g) => g.startsRegion)).toHaveLength(1);
    }
  });

  it('no group heads the nav with the workspace NAME — it uppercased a user-supplied string', () => {
    // It also existed for org/service and not person, so every row shifted when you switched context.
    const org = buildNav(whitelabel, {}, ORG_SCOPE, 'steward', 'alice-home-church');
    expect(org.some((g) => (g.heading ?? '').includes('alice'))).toBe(false);
    expect(org[0]!.heading).toBeUndefined();
  });

  it('a one-item area names itself, so the row reads as the destination', () => {
    // Records and Attestations hold one item each today; the sidebar folds them to plain rows, so the
    // item has to carry the area's noun rather than a disambiguator for a heading that is not rendered.
    const l = labels(buildNav(whitelabel, {}, PERSON));
    expect(l).toContain('Records');
    expect(l).toContain('Attestations');
    expect(l).not.toContain('All records');
    expect(l).not.toContain('Signed statements');
  });
});

describe('account surfaces left the workspace nav for the user menu', () => {
  it('no class shows Security, Connected, Your apps or Network in the left nav', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      const l = labels(buildNav(whitelabel, {}, scope));
      for (const gone of ['Security', 'Connected', 'Your apps', 'Network']) expect(l).not.toContain(gone);
    }
  });

  it('and they are all reachable from the user menu instead', () => {
    const menu = buildUserMenu(whitelabel).map((i) => i.label);
    expect(menu).toContain('Network');
    expect(menu).toContain('Your profile');
  });
});

describe('the Settings pane', () => {
  const groups = (scope: Parameters<typeof buildSettingsPane>[0]) => buildSettingsPane(scope).map((g) => g.heading);
  const items = (scope: Parameters<typeof buildSettingsPane>[0]) =>
    buildSettingsPane(scope).flatMap((g) => g.items.map((i) => i.label));

  it('is grouped the same way, in the same order, for every class that has the group', () => {
    for (const scope of [ORG_SCOPE, SVC_SCOPE]) {
      expect(groups(scope)).toEqual(['Identity & presence', 'Behaviour', 'People & access']);
    }
    // A person has no People & access group, and that is the honest outcome rather than an empty
    // heading (§5): they have no members, no lifecycle status, and their own access — credentials and
    // the delegations they hold — is Security, in the user menu, because it is about the person and
    // not about an agent in a workspace.
    expect(groups(PERSON)).toEqual(['Identity & presence', 'Behaviour']);
  });

  it('carries the shared identity items everywhere', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) {
      for (const item of ['Profile', 'Naming', 'Agent Card', 'Registry', 'Trust graph', 'Skills', 'Playbook']) {
        expect(items(scope)).toContain(item);
      }
    }
  });

  it('Members is org-only — the one item that varies by what the class IS', () => {
    expect(items(ORG_SCOPE)).toContain('Members');
    expect(items(PERSON)).not.toContain('Members');
    expect(items(SVC_SCOPE)).not.toContain('Members');
  });

  it('a service has no Ask: its Playbook IS what it answers as, so Ask would be a second name for one page', () => {
    expect(items(SVC_SCOPE)).not.toContain('Ask');
    expect(items(PERSON)).toContain('Ask');
    expect(items(ORG_SCOPE)).toContain('Ask');
  });

  it('only a person has Discussion replies — an org’s discussion behaviour is its assistant', () => {
    expect(items(PERSON)).toContain('Discussion replies');
    expect(items(ORG_SCOPE)).not.toContain('Discussion replies');
  });

  it('never offers "Discussions" — that word is the top band, where you take part', () => {
    for (const scope of [PERSON, ORG_SCOPE, SVC_SCOPE]) expect(items(scope)).not.toContain('Discussions');
  });

  it('Status replaces the org lifecycle page’s old name, which now names the pane', () => {
    expect(items(ORG_SCOPE)).toContain('Status');
    expect(items(ORG_SCOPE)).not.toContain('Settings');
  });
});

describe('membership is not widened by any of this (spec 318)', () => {
  it('an org member gets participation only — no Settings, no Stewardship, no Records', () => {
    const member = buildNav(whitelabel, {}, ORG_SCOPE, 'member');
    const l = labels(member);
    expect(l).toContain('Discussions');
    expect(l).toContain('Work');
    expect(l).not.toContain('Settings');
    expect(area(member, 'Stewardship')).toBeUndefined();
    expect(area(member, 'Records')).toBeUndefined();
    expect(buildSettingsPane(ORG_SCOPE, 'member')).toEqual([]);
  });
});
