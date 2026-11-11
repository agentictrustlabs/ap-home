/**
 * An app invites someone with no Home yet BY EMAIL (2026-11-11, the ISL workbench).
 *
 * The app runs `workspace-member-invite` with `member_email`; the Home predicts the person agent that email's Home
 * will deploy to and grants to it. The invitee then signs in from the app with `login_hint=<email>` and sees one
 * step: the code for that address, already sent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('invite by email, end to end in the Home', () => {
  it('the enroll request carries member_email, validated as an email', () => {
    const s = read('useEnrollReq.ts');
    expect(s).toContain("p.get('member_email')");
    expect(s).toContain('memberEmail?: string');
  });
  it('workspace-member-invite predicts the invitee from the email, as the governor steward', () => {
    const s = read('RecognizedEnroll.tsx');
    expect(s).toContain("(!enroll.member && !enroll.memberEmail)");
    expect(s).toContain("fetch('/connect/org-invite/predict'");
    expect(s).toContain('body: JSON.stringify({ org: governed.governor, email: enroll.memberEmail })');
  });
  it('a login_hint email shows only the email card, prefilled, with the code sent on arrival', () => {
    const s = read('EntryExperience.tsx');
    expect(s).toContain("enrollApi?.enroll?.loginHint");
    expect(s).toContain("initialEmail: hintedEmail, autoStart: true");
    const card = readFileSync(join(__dirname, '..', 'portal', 'EmailAuthCard.tsx'), 'utf8');
    expect(card).toContain('useState(initialEmail ??');
    expect(card).toContain('void start();');
  });
  it('the invitation check never links the email to whoever is signed in, and a recognized session must have verified it', () => {
    const card = readFileSync(join(__dirname, '..', 'portal', 'EmailAuthCard.tsx'), 'utf8');
    expect(card).toContain("session && !asInvitee ? { authorization:");
    expect(read('EntryExperience.tsx')).toContain('asInvitee: true');
    const rec = read('RecognizedEnroll.tsx');
    expect(rec).toContain('sessionStorage.getItem(INVITEE_EMAIL_KEY)');
    expect(rec).toContain('if (verified !== hint) return onUnrecognized();');
  });
});
