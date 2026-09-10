/**
 * `signInMethods` narrows what ONE relying app's enroll screen offers. This suite exists to prove
 * the blast radius is exactly one client: curating Gather must not change what HeartCoach,
 * Pokernight, Field, Engage or anyone else shows.
 */
import { describe, expect, it } from 'vitest';

import { whitelabel } from './config';

/** The gate in EntryExperience, lifted verbatim so the rule is tested rather than described. */
type Method = 'social' | 'email' | 'phone' | 'passkey' | 'name';
const ALL: readonly Method[] = ['social', 'email', 'phone', 'passkey', 'name'];
function offered(curated: readonly Method[] | undefined, isEnroll = true): readonly Method[] {
  const list = isEnroll ? curated : undefined;
  return ALL.filter((m) => !list || list.includes(m));
}

describe('sign-in method curation (blast radius)', () => {
  const apps = whitelabel.relyingApps;

  it('only gather-app is curated — every other client keeps all five methods', () => {
    const curated = apps.filter((a) => a.signInMethods !== undefined).map((a) => a.client_id);
    expect(curated).toEqual(['gather-app']);
    for (const app of apps.filter((a) => a.client_id !== 'gather-app')) {
      expect(offered(app.signInMethods as readonly Method[] | undefined), `${app.client_id} changed`).toEqual(ALL);
    }
  });

  it('Pokernight specifically is untouched', () => {
    const poker = apps.find((a) => a.client_id === 'pokernight');
    expect(poker, 'pokernight missing from the registry').toBeDefined();
    expect(poker!.signInMethods).toBeUndefined();
    expect(offered(poker!.signInMethods as readonly Method[] | undefined)).toEqual(ALL);
  });

  it('any client added later is uncurated until someone opts it in', () => {
    // HeartCoach is the live example: its registry entry is still on an unmerged branch, so it is
    // absent here. Whenever it (or anything else) lands, the assertion above covers it — curation
    // is opt-in per client, so a new entry offers every method until it says otherwise.
    for (const id of ['heartcoach']) {
      const app = apps.find((a) => a.client_id === id);
      if (!app) continue;
      expect(app.signInMethods, `${id} was curated without being named here`).toBeUndefined();
    }
  });

  it('gather-app offers email and nothing else', () => {
    const gather = apps.find((a) => a.client_id === 'gather-app')!;
    expect(gather.signInMethods).toEqual(['email']);
    expect(offered(gather.signInMethods as readonly Method[])).toEqual(['email']);
  });

  it('curation never reaches the self-serve lane, even for a curated client', () => {
    const gather = apps.find((a) => a.client_id === 'gather-app')!;
    expect(offered(gather.signInMethods as readonly Method[], false)).toEqual(ALL);
  });

  it('an absent list is the same as offering everything', () => {
    expect(offered(undefined)).toEqual(ALL);
  });
});
