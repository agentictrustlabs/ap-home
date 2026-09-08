'use client';
// First-connect setup — the one screen that gives a brand-new member what the app they are joining
// declared they need (`new_member` in the relying-app registry), immediately after their own
// account is deployed and before the permission consent.
//
// WHY THIS EXISTS AT ALL. A person who signs up gets an identity and nothing to hold money in, and
// on the phone / email / social paths no human name either — so they arrive at a card room as
// `0x1a2b…9f0e` with no account to buy in from, and the app has to send them back out on an errand
// to fix both. The Home is already deploying their account at that moment; doing the rest here is
// one screen instead of a round trip.
//
// WHY IT IS A GATE AND NOT A STEP IN ONE CEREMONY. There are five credential families and four
// places a new home can come into existence (the passkey/wallet journey, the OTP cards, the social
// resume, an invite). Putting the work in any ONE of them would mean a member who signed up with
// email got something a member who signed up with a phone did not. So this mirrors the shape the
// codebase already uses for exactly this problem — `RequiredNameGate`, mounted by each enroll
// surface just before its consent — and every family passes through one of those mounts.
//
// THREE RULES, and they are not negotiable, because this runs for every new member of an app that
// asks for it:
//
//   IDEMPOTENT. The decision is subtractive and made from what the member ACTUALLY has (their agent
//     tree, their profile), never from "is this their first time" — which is unknowable here and
//     wrong the moment a ceremony is resumed. A returning member, a double-invoked effect and a
//     member who made a treasury by hand all fall straight through to `onDone`. Both reads FAIL
//     CLOSED toward "they already have it": an unreadable agent tree means we do NOT create a
//     second treasury.
//
//   NON-FATAL. Nothing here can cost someone their sign-in. Every failure lands on a screen with a
//     retry AND a way past it; taking the way past continues the connect exactly as if this screen
//     had never appeared. What did not get made is not lost — the next connect asks again (the
//     decision is subtractive), and the portal's own /treasuries and /profile pages remain the
//     ordinary way to do either by hand.
//
//   NO MINTING. The Home creates and custodies the account. It does not put money in it. Funding
//     is the relying app's business — the card room tops any treasury it can see up to its floor —
//     and a Home that mints play money is the wrong shape.
//
// The ceremony itself is NOT reimplemented: the treasury goes through `createAgentWithBirthrights`
// (the same call `/choose-treasury` and the portal's create form use, which records the agent to
// `/connect/related-orgs` so discovery can find it), and the name goes through
// `seedImpactProfileFields` (the same fill-only-empty vault write the phone bootstrap already uses
// to seed a verified number).
import { useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listManagedAgents, signsWithoutPrompt } from '../../connect-client';
import { activateVaultIfNeeded, type Via } from '../../home/onboarding';
import { loadImpactProfile, seedImpactProfileFields, VaultKeyUnauthorizedError } from '../../profile-store';
import { createAgentWithBirthrights } from '../portal/ManagedAgents';
import {
  newMemberWork,
  personDisplayName,
  planIsEmpty,
  splitPersonName,
  workIsEmpty,
  type NewMemberPlan,
  type NewMemberWork,
} from '../../lib/new-member';
import { whitelabel } from '../../whitelabel/config';
import { BrandShield } from '../shared/BrandShield';
import { BusyButton } from '../shared/BusyButton';

/** Read what the member already has. Both branches FAIL CLOSED — an unreadable answer is treated as
 *  "they have it", because the cost of skipping is one more prompt at the next connect and the cost
 *  of guessing wrong the other way is a duplicate on-chain account. */
async function readMemberState(person: Address, token: string): Promise<{ hasTreasury: boolean; hasProfileName: boolean }> {
  const [hasTreasury, hasProfileName] = await Promise.all([
    listManagedAgents(token)
      .then((agents) => agents.some((a) => a.kind === 'person-treasury'))
      .catch((e) => {
        console.warn('[new-member] agent tree unreadable — assuming a treasury exists (no duplicate):', e);
        return true;
      }),
    loadImpactProfile(person)
      .then((p) => personDisplayName(p.contact) !== '')
      .catch((e) => {
        // A home this new has no vault key bound yet, so "unauthorized" IS the honest answer "no
        // name on file". Any OTHER failure is unknown, and we do not nag a member whose name we
        // simply could not read.
        if (e instanceof VaultKeyUnauthorizedError) return false;
        console.warn('[new-member] profile unreadable — not asking for a name:', e);
        return true;
      }),
  ]);
  return { hasTreasury, hasProfileName };
}

export function NewMemberSetup({
  person,
  token,
  via,
  appName,
  plan,
  onDone,
}: {
  /** The member's own Smart Agent — the PARENT the new treasury is created under. */
  person: Address;
  /** Home-session bearer. Required: this screen creates an agent and writes to the member's vault. */
  token: string;
  /** Credential family of this session — decides who signs (server-side for the KMS families). */
  via: Via;
  /** The app's REGISTERED display name (never a request param — same anti-spoof rule as consent). */
  appName: string;
  /** What this app declared its members need. `planIsEmpty` ⇒ this component does nothing at all. */
  plan: NewMemberPlan;
  /** Continue the connect. Called on success, on skip, AND when there was nothing to do. */
  onDone: () => void;
}) {
  const brand = whitelabel.brand.name;
  const [work, setWork] = useState<NewMemberWork | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  // Whether THIS session signs without a device prompt. `null` until known — the note says nothing
  // rather than guessing, the same rule the treasury chooser and the funding form follow.
  const [promptless, setPromptless] = useState<boolean | null>(null);
  const read = useRef(false);

  // ONE read, guarded against React's double-invoked effects: two passes here would be two
  // `listManagedAgents` calls racing to conclude "no treasury yet" and two creates.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    void (async () => {
      if (planIsEmpty(plan)) { onDone(); return; }
      const state = await readMemberState(person, token);
      const w = newMemberWork(plan, state);
      if (workIsEmpty(w)) { onDone(); return; } // returning member — no screen, no flash
      setWork(w);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!work?.treasury) return;
    let live = true;
    void signsWithoutPrompt(via, token).then((v) => { if (live) setPromptless(v); }).catch(() => { if (live) setPromptless(null); });
    return () => { live = false; };
  }, [work?.treasury, via, token]);

  const typed = name.trim();
  const nameMissing = !!work?.name && plan.name === 'required' && typed.length === 0;

  async function go() {
    if (busy || !work) return;
    if (nameMissing) { setErr('Tell us what to call you first.'); return; }
    setBusy(true); setErr(''); setStep('');

    // THE NAME FIRST, because it is the cheap half: a person who abandons the screen after a slow
    // treasury deploy should still have told us who they are.
    if (work.name && typed) {
      setStep('Saving your name…');
      try {
        // The private profile lives in the member's own encrypted vault, so the key has to be bound
        // before anything can be written to it. Idempotent — it SKIPS when already bound, so this
        // costs a returning member nothing and does not add a prompt the connect wasn't going to
        // make anyway (the grant activates the vault a moment later regardless).
        await activateVaultIfNeeded(person, via, { token });
        const { firstName, lastName } = splitPersonName(typed);
        await seedImpactProfileFields(person, { firstName, lastName });
      } catch (e) {
        // Non-fatal by design. Their name is not lost — nothing was written, the "do they have a
        // name" answer stays no, and the next connect asks again. /profile is the other way in.
        console.warn('[new-member] name not saved (they can set it on /profile):', e);
      }
    }

    // THE MONEY ACCOUNT. The same create ceremony every other surface runs: one on-chain account
    // custodied by this member's own credential, gas sponsored, recorded to /connect/related-orgs so
    // an app can discover it. NAMELESS — no label is claimed (see the schema for why).
    if (work.treasury) {
      const res = await createAgentWithBirthrights(
        { kind: 'person-treasury', label: undefined, parent: person, person, via }, token, setStep,
      );
      if (!res.ok) {
        // The one failure worth stopping on, because there is something to retry. `onDone` is still
        // one click away and still finishes the connect.
        setBusy(false);
        setErr(res.error);
        return;
      }
    }
    setBusy(false);
    onDone();
  }

  // Nothing to do (or still deciding): render nothing. `onDone` has already fired in the first case.
  if (!work) return null;

  if (busy) {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Setting you up" />
          <p className="onboarding-busy-msg">{step || 'Setting you up…'}</p>
          <p className="onboarding-busy-sub">This takes a few seconds.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">{work.name ? 'What should we call you?' : 'One more thing'}</h1>
      {/* THE HONEST LINE. What they are actually getting, in the register the rest of onboarding
          uses — and, for the name, who will see it. A person handing over their name is entitled to
          know where it goes at the moment they type it, not only in the consent list afterwards. */}
      <p className="onboarding-sub">
        {work.name && work.treasury
          ? `${appName} will show you to other people by this name — and we’ll open a money account that’s yours to keep.`
          : work.name
            ? `${appName} will show you to other people by this name. It isn’t a login, and you can change it later.`
            : `We’ll open a money account that’s yours to keep — it holds your funds, and your ${brand} home keeps the key to it.`}
      </p>

      {work.name && (
        <>
          <input
            className="onboarding-input"
            value={name}
            onChange={(e) => { setName(e.target.value.slice(0, 80)); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !nameMissing) void go(); }}
            placeholder="e.g. Rich Pedersen"
            aria-label="Your name"
            autoComplete="name"
            data-testid="new-member-name"
            autoFocus
          />
          <p className="onboarding-note">
            Your first name is enough. This is separate from your {brand} name — you don’t need one of those.
          </p>
        </>
      )}

      {err && <p className="onboarding-hint taken" data-testid="new-member-error">{err}</p>}

      <BusyButton
        busy={busy}
        busyLabel={step || 'Setting you up…'}
        className="btn-primary"
        data-testid="new-member-continue"
        onClick={() => void go()}
      >
        {err ? 'Try again' : 'Continue'}
      </BusyButton>

      {/* THE WAY PAST. Always present once something has failed — a person must never be locked out
          of their own home because a secondary setup step didn't work — and present from the start
          when the app said the name was optional. */}
      {(err || plan.name === 'optional') && (
        <button type="button" className="btn-ghost onboarding-secondary" data-testid="new-member-skip" onClick={onDone}>
          {err ? `Skip for now and continue to ${appName}` : 'Skip for now'}
        </button>
      )}

      {work.treasury && promptless === false && (
        <p className="onboarding-note">Your wallet will ask you to confirm opening the account. Gas is sponsored.</p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">{children}</div>
    </div>
  );
}
