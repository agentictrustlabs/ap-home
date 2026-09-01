/**
 * A failed passkey sign-in must say WHICH failure it is.
 *
 * `isValidSignature` returning false covered three unrelated situations under one sentence — "that
 * passkey is not a custodian of <name>" — which reads as "your passkey is wrong". Live case
 * (phone-6115, 2026-09-01): the account was healthy (3 custodians, 2 registered passkeys with valid
 * keys, both bound to the right rpIdHash) and the browser had simply offered a THIRD credential under
 * the same RP that was never added on chain. The discoverable picker offers such orphans happily,
 * because to the OS they are ordinary passkeys for this site.
 *
 * The member could not act on the verdict: nothing told them the credential was unregistered rather
 * than rejected, so "add this device's passkey" — the actual fix — was invisible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'with-name.ts'), 'utf8');
const BRANCH = SRC.slice(SRC.indexOf('const verdict = await accounts.verifySignature'), SRC.indexOf('principal = { kind: \'passkey\''));

describe('with-name passkey rejection', () => {
  it('separates an unregistered credential from a rejected signature', () => {
    expect(BRANCH).toContain('accounts.hasPasskey(agent');
    expect(BRANCH).toContain('is not one of the');
    expect(BRANCH).toContain('skipped its PIN or biometric');
  });

  it('names the way back in, not just the verdict', () => {
    expect(BRANCH).toContain('sign in with the credential that opened this home');
  });

  it('still AUTHORIZES on the chain verdict alone', () => {
    // The extra reads pick wording. If hasPasskey ever gates the success path, a client-supplied
    // digest starts influencing authorization — it is untrusted input.
    const guard = SRC.slice(SRC.indexOf('const verdict = await accounts.verifySignature'), SRC.indexOf('const detail'));
    expect(guard).toContain('verdict.valid');
    // hasPasskey is read INSIDE the failure branch, never as a condition for issuing a session.
    expect(SRC).not.toMatch(/if\s*\(\s*await accounts\.hasPasskey[\s\S]{0,80}status: 'issued'/);
  });

  it('an unreachable chain is 503, never a 403 that blames the credential', () => {
    // isValidSignature collapses transport failures into `false`, so an RPC outage used to read as
    // "that passkey is not a custodian" — sending a member off replacing a perfectly good credential.
    expect(BRANCH).toContain('verdict.unavailable');
    expect(BRANCH).toContain('503');
    expect(BRANCH).toContain('Nothing is wrong with your passkey');
  });
});

describe('the client surfaces the detail', () => {
  const CLIENT = readFileSync(join(__dirname, '..', '..', 'src', 'connect-client.ts'), 'utf8');
  it('joins error and detail instead of dropping the cause', () => {
    const seg = CLIENT.slice(CLIENT.indexOf("await fetch('/connect/with-name'"));
    expect(seg.slice(0, 900)).toContain('[b.error, b.detail].filter(Boolean).join');
  });
});

describe('verifySignature separates rejection from unavailability', () => {
  const CLIENT = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'packages', 'agent-account', 'src', 'client.ts'),
    'utf8',
  );
  const FN = CLIENT.slice(CLIENT.indexOf('async verifySignature('), CLIENT.indexOf('* Build an unsigned UserOp'));

  it('treats a revert as the account saying no', () => {
    expect(FN).toMatch(/reverted\s*\?\s*\{ valid: false \}/);
  });

  it('treats anything else as no answer at all', () => {
    expect(FN).toContain('unavailable: msg');
  });

  it('leaves isValidSignature a boolean, so nothing that GATES on it changes', () => {
    expect(CLIENT).toContain('return (await this.verifySignature(account, hash, signature)).valid;');
  });
});
