'use client';
import { WorkingBar } from './WorkingBar';
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
//   PLAY MONEY ONLY. The Home now DOES put coin in the account it opens, when the app declared one
//     (`new_member.currency`) — that was a deliberate reversal, and it comes with the gate that
//     makes it safe. The Home can put coin anywhere only by MINTING it, which is possible at all
//     only for a token anyone may mint, which is only ever true of a test token. So seeding needs
//     the app to declare `faucet: true` AND the chain to confirm it (a simulated mint,
//     `lib/member-coin.ts`), and a real asset is refused loudly rather than half-attempted. It is
//     also not a new power: the portal's Fund button has always minted demo USDC into a treasury
//     through this same rail, in the member's own name. This is that act, at the one moment the
//     account exists and a credential is in the room.
//
// The ceremonies themselves are NOT reimplemented — every one of the four effects is a call the
// portal already makes:
//   the account       → `createAgentWithBirthrights` (the /choose-treasury + portal create form,
//                       which records the agent to /connect/related-orgs so an app can find it)
//   the name          → `seedImpactProfileFields` (the fill-only-empty vault write the phone
//                       bootstrap uses to seed a verified number)
//   the opening coin  → `fundThroughHarness` → `treasury.fund` (the portal's Fund button)
//   the spend grant   → NOT here at all. It is the ordinary payment mandate
//                       (`issuePaymentDelegation`), minted in the grant leg of the connect a moment
//                       later, so it travels back to the app on the token exchange like every other
//                       mandate. See `lib/new-member.ts#coinMandateLeg`.
import { useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listManagedAgents, personSignHash, signsWithoutPrompt } from '../../connect-client';
import { activateVaultIfNeeded, type Via } from '../../home/onboarding';
import { fundThroughHarness } from '../../home/fund-harness';
import { loadImpactProfile, seedImpactProfileFields, VaultKeyUnauthorizedError } from '../../profile-store';
import { createAgentWithBirthrights } from '../portal/ManagedAgents';
import { coinBalanceOf, isOpenMintToken } from '../../lib/member-coin';
import {
  coinAmount,
  currencyConsentLines,
  newMemberWork,
  personDisplayName,
  planIsEmpty,
  splitPersonName,
  workIsEmpty,
  type MemberState,
  type NewMemberPlan,
  type NewMemberWork,
} from '../../lib/new-member';
import { whitelabel } from '../../whitelabel/config';
import { BrandShield } from '../shared/BrandShield';
import { BusyButton } from '../shared/BusyButton';

/** Read what the member already has. Both branches FAIL CLOSED — an unreadable answer is treated as
 *  "they have it", because the cost of skipping is one more prompt at the next connect and the cost
 *  of guessing wrong the other way is a duplicate on-chain account. */
async function readMemberState(
  person: Address,
  token: string,
  plan: NewMemberPlan,
): Promise<MemberState & { treasury: Address | null }> {
  const [tre, hasProfileName] = await Promise.all([
    listManagedAgents(token)
      .then((agents) => ({ found: true, agent: (agents.find((a) => a.kind === 'person-treasury')?.agent as Address) ?? null }))
      .catch((e) => {
        console.warn('[new-member] agent tree unreadable — assuming a treasury exists (no duplicate):', e);
        return { found: false, agent: null as Address | null };
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
  // An unreadable tree means "they have one" (no duplicate) even though we hold no address for it —
  // which also means no balance to read, which means no seeding. Both halves fail closed together.
  const hasTreasury = tre.found ? tre.agent !== null : true;
  // The coin read happens ONLY for an app that declared one, and only when there is an account to
  // ask about. Every other app makes no extra request — the byte-identical guarantee is a guarantee
  // about network traffic too, not only about outcomes.
  const coinBalance = plan.currency && tre.agent ? await coinBalanceOf(plan.currency.asset, tre.agent) : null;
  return { hasTreasury, hasProfileName, coinBalance, treasury: tre.agent };
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
  // The account the coin goes into: the one they already had, or the one this screen makes. Held in
  // a ref rather than state because the seeding step reads it in the same tick it is written.
  const treasury = useRef<Address | null>(null);
  const read = useRef(false);

  // ONE read, guarded against React's double-invoked effects: two passes here would be two
  // `listManagedAgents` calls racing to conclude "no treasury yet" and two creates.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    void (async () => {
      if (planIsEmpty(plan)) { onDone(); return; }
      const state = await readMemberState(person, token, plan);
      treasury.current = state.treasury;
      const w = newMemberWork(plan, state);
      if (workIsEmpty(w)) { onDone(); return; } // returning member — no screen, no flash
      setWork(w);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!work?.treasury && !work?.seed) return;
    let live = true;
    void signsWithoutPrompt(via, token).then((v) => { if (live) setPromptless(v); }).catch(() => { if (live) setPromptless(null); });
    return () => { live = false; };
  }, [work?.treasury, work?.seed, via, token]);

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
      // WRAPPED, and this is a bug fix rather than defensive dressing. `createAgentWithBirthrights`
      // does not only return failures, it THROWS them — an aborted request, a dropped socket, a
      // bundler that never answers — and an unhandled rejection here left `busy` stuck true: the
      // screen sat on "Deploying your agent…" for ever, with no error, no retry and no way past,
      // and the person could not finish signing in. That is precisely the outcome the NON-FATAL
      // rule at the top of this file exists to forbid, so a throw is turned into the same failure
      // the `!ok` branch already routes into: an error, a retry, and the skip beside it.
      let res: Awaited<ReturnType<typeof createAgentWithBirthrights>>;
      try {
        res = await createAgentWithBirthrights(
          { kind: 'person-treasury', label: undefined, parent: person, person, via }, token, setStep,
        );
      } catch (e) {
        console.warn('[new-member] treasury create threw:', e);
        res = { ok: false, error: e instanceof Error ? e.message : 'Could not open the account just now.' };
      }
      if (!res.ok) {
        // The one failure worth stopping on, because there is something to retry. `onDone` is still
        // one click away and still finishes the connect.
        setBusy(false);
        setErr(res.error);
        return;
      }
      treasury.current = res.result.agent as Address;
    }

    // THE OPENING BALANCE. Through the SAME rail the portal's Fund button uses — a faucet mint made
    // in the member's own name, through the harness, leaving the ordinary funding receipt — so there
    // is one implementation of "put coin in an account" and not a private one for sign-up.
    //
    // BEST-EFFORT, ALWAYS. An account with nothing in it is a recoverable state (the app can fund
    // it, the member can fund it, the next connect tries again because the decision is a balance
    // check); an account they could not finish signing in to is not. So every failure here is a
    // console warning and nothing else — no error screen, no block.
    if (work.seed && plan.currency && treasury.current) {
      const coin = plan.currency;
      const into = treasury.current;
      try {
        setStep(`Adding your ${coin.plural}…`);
        // THE GATE. The registry saying `faucet: true` is the app's claim; this is the chain's
        // answer. A token that is not open-mint is refused here, loudly, before the member is asked
        // to sign anything — the Home must never try to conjure a real asset.
        if (!(await isOpenMintToken(coin.asset, person, into, coin.initialAmount))) {
          throw new Error('the declared coin is not an open-mint test token');
        }
        const sign = await personSignHash(person, via, token);
        if (typeof sign !== 'function') throw new Error(sign.error);
        const funded = await fundThroughHarness({
          treasury: into,
          amount: coin.initialAmount,
          asset: coin.asset,
          display: coinAmount(coin, coin.initialAmount),
          session: { token },
          signHash: sign,
        });
        if (!funded.ok) throw new Error(funded.error);
      } catch (e) {
        console.warn(`[new-member] opening balance not added (their account is empty — ${appName} can fund it, and the next connect tries again):`, e);
      }
    }

    setBusy(false);
    onDone();
  }

  // Nothing to do (or still deciding): render nothing. `onDone` has already fired in the first case.
  if (!work) return null;

  const coin = plan.currency;
  // WHAT WE ARE ABOUT TO DO TO THEIR MONEY, as one sentence built from the work that is actually
  // left. The four cases are: a new account with coin in it, a new empty account, coin into an
  // account they already had, and nothing at all.
  const opening = coin && work.seed ? coinAmount(coin, coin.initialAmount) : '';
  const accountSentence =
    work.treasury && opening
      ? `We’ll open a money account that’s yours to keep and put ${opening} in it to start you off. Your ${brand} home keeps the key to it.`
      : work.treasury
        ? `We’ll open a money account that’s yours to keep — it holds your funds, and your ${brand} home keeps the key to it.`
        : opening
          ? `We’ll put ${opening} into your money account to start you off.`
          : '';
  const nameSentence = work.name
    ? `${appName} will show you to other people by this name. It isn’t a login, and you can change it later.`
    : '';
  // Shown to everyone this screen renders for, INCLUDING a member who needs no account and no coin:
  // the mandate is minted for them too, a moment later, in the same connect.
  const grantLines = coin?.spendGrant ? currencyConsentLines(coin, appName) : null;

  if (busy) {
    return (
      <Shell>
        <div className="onboarding-busy">
          <WorkingBar />
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
      {/* THE HONEST LINES. Everything that is about to happen to them, before it happens, in the
          register the rest of onboarding uses — a person handing over their name or being given an
          account is entitled to know where both go at the moment it happens, not only in the consent
          list afterwards. Assembled from what is ACTUALLY left to do, so a member who already has an
          account is not told one is being opened. */}
      {nameSentence && <p className="onboarding-sub">{nameSentence}</p>}
      {accountSentence && <p className="onboarding-sub">{accountSentence}</p>}

      {/* WHAT THE APP MAY DO WITH THE COIN, with the ceilings, before they agree to it — the same
          sentences the consent sheet shows a moment later (`currencyConsentLines`), so the two
          screens cannot describe the same permission two different ways. */}
      {grantLines && (
        <div className="onboarding-note" data-testid="new-member-coin-grant">
          <p style={{ margin: '0 0 .35rem' }}><strong>{appName} will be able to:</strong></p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {grantLines.canDo.map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p style={{ margin: '.45rem 0 .35rem' }}><strong>It will not be able to:</strong></p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {grantLines.cannotDo.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
      )}

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

      {/* Say what THIS session will actually ask of them, and how many times. Opening the account is
          one confirmation and putting the coin in is a second, so a wallet home that was promised
          "a confirmation" and met two would rightly wonder what the extra one was for. Silent when
          we don't know (`null`) rather than guessing — the same rule the funding form follows. */}
      {(work.treasury || work.seed) && promptless === false && (
        <p className="onboarding-note">
          Your wallet will ask you to confirm{work.treasury && work.seed ? ' twice — once to open the account, once to put the money in' : work.treasury ? ' opening the account' : ' putting the money in'}. Gas is sponsored.
        </p>
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
