/**
 * Every nav item must point at a route that exists.
 *
 * A nav is a promise about what is there. The 2026-08-31 rework moved, split and renamed roughly thirty
 * surfaces at once — Activity became Activities, the org lifecycle page became Status, the Agent page
 * became three items — and a single stale href would ship a 404 behind a confident-looking label.
 * Typecheck cannot catch it (an href is a string) and the build cannot catch it (an unreachable route is
 * still a valid route), so it is checked here, against the actual `app/(portal)` tree.
 *
 * This is why the check is worth its weight: it fails on the mistake that is easiest to make and hardest
 * to notice — renaming a route and forgetting one of the three classes that link to it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildNav, buildSettingsPane, buildUserMenu } from './nav';
import { whitelabel } from '../../whitelabel/config';

const PORTAL = join(process.cwd(), 'app', '(portal)');

/** Every route the portal serves, as a path with dynamic segments left as `[param]`. */
function routes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Route GROUPS `(x)` do not appear in the URL.
    const seg = entry.name.startsWith('(') ? '' : `/${entry.name}`;
    const here = `${prefix}${seg}`;
    if (existsSync(join(dir, entry.name, 'page.tsx'))) out.push(here || '/');
    out.push(...routes(join(dir, entry.name), here));
  }
  return out;
}

const ALL = new Set(routes(PORTAL).concat('/'));

/** Does this concrete href match a route, treating `[param]` as a wildcard for one segment? */
function resolves(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/$/, '') || '/';
  if (ALL.has(path)) return true;
  const parts = path.split('/');
  for (const route of ALL) {
    const rp = route.split('/');
    if (rp.length !== parts.length) continue;
    if (rp.every((seg, i) => seg === parts[i] || (seg.startsWith('[') && seg.endsWith(']')))) return true;
  }
  return false;
}

const SCOPES = [
  ['person', { kind: 'person' } as const],
  ['org', { kind: 'org', org: '0xe26157068af46629691e2ab19726bf61476e6b6c' } as const],
  ['service', { kind: 'service', agent: '0x3d653cbab0c99b1513439758eb2eac2039caa6e1' } as const],
] as const;

describe('every nav item resolves to a real route', () => {
  it('the portal has routes to check against at all (guards the walker itself)', () => {
    expect(ALL.size).toBeGreaterThan(20);
    expect(resolves('/messages')).toBe(true);
    expect(resolves('/definitely-not-a-route')).toBe(false);
  });

  for (const [name, scope] of SCOPES) {
    it(`${name}: every left-nav href`, () => {
      const dead = buildNav(whitelabel, {}, scope)
        .flatMap((g) => g.items)
        .filter((i) => !resolves(i.href))
        .map((i) => `${i.label} → ${i.href}`);
      expect(dead).toEqual([]);
    });

    it(`${name}: every Settings pane href`, () => {
      const dead = buildSettingsPane(scope)
        .flatMap((g) => g.items)
        .filter((i) => !resolves(i.href))
        .map((i) => `${i.label} → ${i.href}`);
      expect(dead).toEqual([]);
    });
  }

  it('org member: every href the reduced nav offers', () => {
    const dead = buildNav(whitelabel, {}, SCOPES[1][1], 'member')
      .flatMap((g) => g.items)
      .filter((i) => !resolves(i.href))
      .map((i) => `${i.label} → ${i.href}`);
    expect(dead).toEqual([]);
  });

  it('the user menu', () => {
    const dead = buildUserMenu(whitelabel).filter((i) => !resolves(i.href)).map((i) => `${i.label} → ${i.href}`);
    expect(dead).toEqual([]);
  });
});
