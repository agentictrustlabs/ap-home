/**
 * The cross-device passkey button must actually be cross-device.
 *
 * A member set a passkey on `phone-6115.faithnet.me`, came back, and got "There aren't any passkeys for
 * phone-6115.faithnet.me on this device" from BOTH sign-in buttons. Verified on chain at the time: two
 * PasskeyAdded records on the SA, and `getPasskeyRpIdHash` for both equal to
 * sha256("phone-6115.faithnet.me") — the credentials were registered, discoverable (`residentKey:
 * 'required'`), and bound to exactly the right RP. Nothing on chain was wrong.
 *
 * The request was. `connectAssertionDiscoverable` built `allowCredentials` from the localStorage cache
 * no matter which mode it was called in; `preferLocalDevice` gated only `hints`, which is `undefined`
 * in choice mode and so gated nothing. A non-empty allowCredentials PINS the request to that one
 * credential, so the platform never looks for a synced or phone copy — and both buttons sent the
 * identical request. The escape hatch was a duplicate of the thing it was meant to escape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'passkey.ts'), 'utf8');
const FN = SRC.slice(SRC.indexOf('export async function connectAssertionDiscoverable'), SRC.indexOf('/** Sign a 32-byte digest', SRC.indexOf('export async function connectAssertionDiscoverable')));

describe('connectAssertionDiscoverable', () => {
  it('ignores the cached credential when the caller asked for the cross-device path', () => {
    expect(FN).toContain("opts.preferLocalDevice === false ? null : loadPasskey()");
  });

  it('still sends an EMPTY allowCredentials when there is no cache', () => {
    // An empty list is what makes the platform offer any passkey for this RP, synced ones included.
    expect(FN).toMatch(/:\s*\[\];\s*\/\/ no local cache/);
  });

  it('derives allowCredentials from that same `cached` binding, so the mode cannot be bypassed', () => {
    // If this ever reads loadPasskey() again below, the cross-device mode silently stops working.
    const below = FN.slice(FN.indexOf('const allowCredentials'));
    expect(below).not.toContain('loadPasskey()');
  });

  it('keeps pinning the request to this origin as the RP', () => {
    // Subdomain isolation (spec 229 P5) is not what was broken and must not be loosened to fix it:
    // the RP was already correct, confirmed against the SA's stored rpIdHash.
    expect(FN).toContain('rpId: passkeyRpId()');
  });
});

describe('the local-first failure names a way forward', () => {
  const CLIENT = readFileSync(join(__dirname, '..', 'connect-client.ts'), 'utf8');

  it('translates the platform error instead of surfacing it raw', () => {
    expect(CLIENT).toContain('No passkey on this device matched the one this browser remembers');
    expect(CLIENT).toContain('Use synced or phone passkey');
  });

  it('only translates a no-credential failure — other errors still propagate', () => {
    // A UV-skipped or WebAuthn-unavailable error means something different and must not be relabelled.
    const seg = CLIENT.slice(CLIENT.indexOf('const localFirst ='), CLIENT.indexOf("proof = { kind: 'passkey'"));
    expect(seg).toContain('if (!noCredential) throw e;');
  });
});
