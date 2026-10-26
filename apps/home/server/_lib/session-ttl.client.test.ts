import { describe, it, expect } from 'vitest';
import { clientSessionTtl, idTokenTtl, SESSION_TTL_DEFAULT } from './session-ttl';

// AN APP MAY ASK FOR ITS OWN SIGN-IN LIFETIME: the Seed Bible reader's people keep it open for days, so its id_token
// lasts seven; every other app keeps the deployment's setting (faithnet: one hour).
describe('a sign-in lifetime per app', () => {
  it('the reader gets its own seven days, whatever the deployment says', () => {
    expect(clientSessionTtl('seed-bible-reader')).toBe(604_800);
    expect(idTokenTtl({ ID_TOKEN_TTL_SECONDS: '3600' }, 'seed-bible-reader')).toBe(604_800);
  });
  it('an app that declares none keeps the deployment setting, or the default', () => {
    expect(clientSessionTtl('no-such-app')).toBeNull();
    expect(idTokenTtl({ ID_TOKEN_TTL_SECONDS: '3600' }, 'no-such-app')).toBe(3600);
    expect(idTokenTtl({ ID_TOKEN_TTL_SECONDS: '3600' })).toBe(3600);
    expect(idTokenTtl({ ID_TOKEN_TTL_SECONDS: undefined } as never, null)).toBe(SESSION_TTL_DEFAULT);
  });
});
