/**
 * The translation workbench signs in as `skills-app`. Home refuse-closes any enroll whose
 * `redirect_uri` is not on that client's list ("Request blocked / Only start setup from a
 * site you trust.") — the same class of miss as gather-origins.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { whitelabel } from './config';
import { isAllowedRelyingOrigin } from '../lib/oidc-clients';

describe('skills-app registry includes the workbench', () => {
  const skills = whitelabel.relyingApps.find((a) => a.client_id === 'skills-app')!;

  it('keeps skills.faithnet.io as the first https entry (SSO logout hop)', () => {
    expect(skills.redirect_uris.find((u) => u.startsWith('https:'))).toBe('https://skills.faithnet.io/');
  });

  it('allows the live workbench and its local vite port', () => {
    expect(skills.redirect_uris).toContain('https://workbench.faithnet.io/');
    expect(skills.redirect_uris).toContain('http://localhost:5192/');
    expect(isAllowedRelyingOrigin('https://workbench.faithnet.io/')).toBe(true);
    expect(isAllowedRelyingOrigin('http://localhost:5192/')).toBe(true);
  });
});
