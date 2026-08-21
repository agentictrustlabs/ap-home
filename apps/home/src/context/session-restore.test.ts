import { describe, expect, it } from 'vitest';

import { shouldRestoreFromUrl } from './session-restore';

const SITE =
  'https://www.impact-agent.me/?client_id=gather-app&redirect_uri=https%3A%2F%2Fgather27-web.richardpedersen3.workers.dev%2F&delegate=0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0&code_challenge=x&delegation_template=site-login';
const ORG =
  'https://www.impact-agent.me/?client_id=gather-app&redirect_uri=https%3A%2F%2Fgather27-web.richardpedersen3.workers.dev%2F&delegate=0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0&code_challenge=x&delegation_template=org-create';

describe('shouldRestoreFromUrl', () => {
  it('restores a first-party Home visit', () => {
    expect(shouldRestoreFromUrl('https://www.impact-agent.me/', true, false)).toBe(true);
  });

  it('does not restore a nameless site-login enroll — that forces the chooser', () => {
    expect(shouldRestoreFromUrl(SITE, true, true)).toBe(false);
  });

  it('restores org-create so Gather is not asked to sign in twice', () => {
    expect(shouldRestoreFromUrl(ORG, true, false)).toBe(true);
    expect(shouldRestoreFromUrl(ORG, false, true)).toBe(true);
  });

  it('does not restore org-create with no stored session', () => {
    expect(shouldRestoreFromUrl(ORG, false, false)).toBe(false);
  });

  it('never restores over a Google code return', () => {
    expect(shouldRestoreFromUrl(`${ORG}&code=abc`, true, true)).toBe(false);
  });
});
