'use client';
import { WorkingBar } from './WorkingBar';
// Home-side MONEY-ACCOUNT chooser for an app that needs the member to have a personal treasury
// before it can do anything with money (spec 275 treasuries × spec 230 relying apps).
//
// It is the OrgChooser's sibling, deliberately. The org-create ceremony already solved this exact
// shape — an app sends the member here, the member picks one they already have or names a new one,
// and the Home hands the answer back — so this screen reuses its structure, its rows, its CSS and
// its copy register rather than inventing a second visual language for the same decision. The
// differences are the three that actually matter for money:
//
//   1. A treasury may be NAMELESS. An organization is counterparty-facing and must be named; a
//      treasury is not, and the address is its canonical id (MAM-D4 name-deferral). So "no name" is
//      the default here, not a fallback — and an unnamed treasury stays out of the public
//      directory, which is a reason to choose it, not a defect.
//   2. Each row shows its BALANCE. "Which of my accounts?" is unanswerable without the number, and
//      a person about to play for money should not have to guess whether there is any in it. It is
//      the same read the treasuries view does (`BalanceLine`), not a second one.
//   3. There is no auto-create. OrgChooser silently creates when the app already named the org and
//      the member has none — right for an org whose name came from the app, wrong for money: the
//      member must SEE the account being made for them and press the button that makes it.
//
// Choosing does not grant this app anything. It tells the app WHICH account is the member's, and
// nothing else; the app still has to ask the member, separately and by name, before a single dollar
// moves. That is why the copy below never says "allow".
import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BalanceLine, createAgentWithBirthrights, useManagedAgents } from '../portal/ManagedAgents';
import { signsWithoutPrompt, typedTldForKind } from '../../connect-client';
import { AGENT_NAME_PARENT } from '../../lib/domain';
import { displayAppDomain, displayAppName, toOrgLabel } from './org-chooser-label';
import { whitelabel } from '../../whitelabel/config';

/** What the member walked away with, and how it came to be. Both go back to the app. */
export interface TreasuryChoice {
  treasury: Address;
  origin: 'chosen' | 'created';
}

function TreasuryAvatar({ plus }: { plus?: boolean }) {
  // The org chooser colours its avatar by name hash so a list of orgs is scannable. Treasuries are
  // frequently NAMELESS, so a name hash would give every unnamed one the same colour — worse than
  // no colour. One steady mark for an account, a dashed plus for the new one.
  return (
    <span aria-hidden className={`org-chooser-avatar${plus ? ' plus' : ''}`} style={plus ? undefined : { background: 'var(--color-sage-700, #3f6212)' }}>
      {plus ? '+' : '$'}
    </span>
  );
}

export function TreasuryChooser({
  token,
  person,
  via,
  appName,
  appDomain,
  appLogo,
  defaultLabel,
  onChoose,
  onDecline,
}: {
  /** Home-session bearer. Required — this screen creates an agent, which needs the member's session. */
  token: string;
  /** The member's own Smart Agent: the PARENT a new personal treasury is created under. */
  person: Address;
  /** Credential family of this session ('passkey' | 'wallet' | 'google' | 'phone' | …). */
  via: string;
  /** The app's REGISTERED display name — never a request param (anti-spoof, same rule as consent). */
  appName: string;
  /** Host of the app's REGISTERED redirect_uri, for the quiet origin line under the name. */
  appDomain: string;
  /** The app's REGISTERED logo, when it has one. */
  appLogo?: string;
  /** `label` from the request — a name the app suggests for a NEW account. Only ever a prefill:
   *  the member can clear it, and an empty name is a legitimate finished answer. */
  defaultLabel?: string;
  onChoose: (choice: TreasuryChoice) => void;
  onDecline: () => void;
}) {
  const { agents, loaded, version } = useManagedAgents(token);
  const [selected, setSelected] = useState<'new' | Address>('new');
  const [label, setLabel] = useState(defaultLabel ? toOrgLabel(defaultLabel) : '');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  // Whether THIS session signs without a device prompt. `null` until known — the note says nothing
  // rather than guessing, the same rule the treasuries page's funding note follows: promising "no
  // prompt" to a home that will prompt is how a person decides the screen is lying to them.
  const [promptless, setPromptless] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void signsWithoutPrompt(via, token).then((v) => { if (live) setPromptless(v); }).catch(() => { if (live) setPromptless(null); });
    return () => { live = false; };
  }, [via, token]);

  // ONLY the member's own money accounts. Org treasuries belong to organizations the member helps
  // steward, and offering one here would invite them to play with somebody else's funds.
  const mine = useMemo(() => agents.filter((a) => a.kind === 'person-treasury'), [agents]);

  // Land on the account they already have, when there is exactly one — the overwhelmingly common
  // case, and the one where "create a new one" is the wrong default. With none, or with several,
  // the default stays "new": several accounts means only they know which one, and pre-committing
  // them to an account they did not look at is how the wrong one gets used.
  useEffect(() => {
    if (!loaded || mine.length !== 1) return;
    setSelected(mine[0].agent);
  }, [loaded, mine]);

  const politeName = displayAppName(appName, appDomain || appName);
  const politeDomain = displayAppDomain(appDomain || '');
  const initial = (politeName.trim().charAt(0) || '?').toUpperCase();
  const showDomain = Boolean(politeDomain) && politeDomain.toLowerCase() !== politeName.toLowerCase();
  const chosen = selected !== 'new' ? mine.find((t) => t.agent.toLowerCase() === selected.toLowerCase()) : undefined;
  const slug = toOrgLabel(label);
  // The suffix the claim will ACTUALLY use, from the same helper the create form uses. Hardcoding
  // `.treasury` here promised a name this chain does not issue: the typed root is only claimable
  // where it has been provisioned, and elsewhere the claim lands on the legacy parent. A screen that
  // names an account something it will not be called is worse than one that says nothing.
  const suffix = typedTldForKind('person-treasury')?.tld ?? AGENT_NAME_PARENT;

  async function go() {
    if (busy) return;
    if (chosen) {
      onChoose({ treasury: chosen.agent, origin: 'chosen' });
      return;
    }
    // A name is OPTIONAL, but a name of one or two characters is not a deferred name — it is a
    // typo that would fail at the claim. Say so here rather than at the chain.
    if (slug && slug.length < 3) {
      setErr('A name needs at least 3 letters or numbers — or leave it empty and create it without one.');
      return;
    }
    setBusy(true); setErr(''); setStep('');
    // The SAME ceremony the treasuries page runs (createAgentWithBirthrights → createManagedAgent):
    // one on-chain account custodied by this member's own credential, gas sponsored, plus the
    // playbook and timeline entry every new agent is born with. Nothing here is ceremony-specific.
    const res = await createAgentWithBirthrights(
      { kind: 'person-treasury', label: slug || undefined, parent: person, person, via }, token, setStep,
    );
    if (!res.ok) { setBusy(false); setErr(res.error); return; }
    onChoose({ treasury: res.result.agent, origin: 'created' });
  }

  if (!loaded) {
    return (
      <div className="onboarding-busy">
        <WorkingBar />
        <span className="spinner spinner-lg" role="status" aria-label="Loading your money accounts" />
        <p className="onboarding-busy-msg">Looking for money accounts you already have…</p>
      </div>
    );
  }

  return (
    <div className="org-chooser treasury-chooser">
      {/* WHO IS ASKING, in the same shape as the consent screen — logo (or initial), registered name,
          quiet origin line. All three come from the registry, never from the URL, so an app cannot
          arrive claiming to be a different one. */}
      <div className="consent-app">
        {appLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={appLogo} alt="" className="consent-app-logo" />
        ) : (
          <div className="consent-app-logo placeholder" aria-hidden="true">{initial}</div>
        )}
        <div>
          <div className="consent-app-name">{politeName}</div>
          {showDomain && <div className="consent-app-domain">{politeDomain}</div>}
        </div>
      </div>

      <p className="onboarding-hint">
        Almost there — {politeName} sent you here to pick the money account it should use.
      </p>
      {/* THE ASK, said as money and not as permission. The sign-in screen a moment ago asked "Allow
          {app}?", and a person who meets two screens in a row with the same question cannot tell them
          apart — so this one never uses that word. It asks WHICH ACCOUNT, which is a different
          question with a different kind of answer. */}
      <h1 className="onboarding-h1">Which account should {politeName} use?</h1>
      <p className="onboarding-sub">
        This is your own money account — it holds your funds, and your {whitelabel.brand.name} home keeps
        the key to it. {politeName} will learn which account you picked. It cannot sign as you, and it
        cannot take anything out until you approve an amount yourself.
      </p>

      {mine.length > 0 && (
        <>
          <p className="org-chooser-section">
            Accounts you already have
            <span className="org-chooser-count">{mine.length}</span>
          </p>
          <div className="org-chooser-list" role="listbox" aria-label="Your money accounts">
            {mine.map((t) => {
              const on = selected !== 'new' && selected.toLowerCase() === t.agent.toLowerCase();
              return (
                <label key={t.agent} className={`org-chooser-row${on ? ' on' : ''}`} data-testid="treasury-row">
                  <input type="radio" name="treasury-choice" className="org-chooser-sr" checked={on} disabled={busy}
                    onChange={() => { setSelected(t.agent); setErr(''); }} />
                  <TreasuryAvatar />
                  <span className="org-chooser-copy">
                    {/* The same words the treasuries page uses for the same thing. A treasury with no
                        name is not incomplete — it is simply not listed publicly. */}
                    <span className="org-chooser-name">{t.name || 'Unnamed treasury'}</span>
                    <span className="org-chooser-meta treasury-chooser-balance">
                      <BalanceLine address={t.agent} refreshKey={version} />
                    </span>
                  </span>
                  {on && <span aria-hidden className="org-chooser-check">✓</span>}
                </label>
              );
            })}
          </div>
        </>
      )}

      <label className={`org-chooser-row create${selected === 'new' ? ' on' : ''}`} data-testid="treasury-create-row">
        <input type="radio" name="treasury-choice" className="org-chooser-sr" checked={selected === 'new'} disabled={busy}
          onChange={() => { setSelected('new'); setErr(''); }} />
        <TreasuryAvatar plus />
        <span className="org-chooser-copy">
          <span className="org-chooser-name">{mine.length ? 'Open another account' : 'Open a money account'}</span>
          <span className="org-chooser-meta">It is yours to keep, and works anywhere in {whitelabel.brand.name}</span>
        </span>
        {selected === 'new' && <span aria-hidden className="org-chooser-check">✓</span>}
      </label>
      {selected === 'new' && (
        <>
          <input
            className="onboarding-input"
            placeholder="Name it (optional)"
            aria-label="Name for your new money account (optional)"
            value={label}
            disabled={busy}
            data-testid="treasury-label"
            onChange={(e) => { setLabel(e.target.value); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void go(); }}
          />
          {/* Name-deferral, said as a choice rather than as a missing field. The unnamed case is the
              default, and the reason it is worth choosing is privacy, not laziness. */}
          <p className="onboarding-hint">
            {slug
              ? <>It will be called <strong>{slug}.{suffix}</strong>, and people can find it by that name.</>
              : 'A name is optional. Without one your account still works — it just stays off the public list, so only people you give it to can find it.'}
          </p>
        </>
      )}

      {err && <p className="onboarding-hint taken" data-testid="treasury-error">{err}</p>}

      <button className="btn-primary" onClick={() => void go()} disabled={busy} data-testid="treasury-continue">
        {busy
          ? (step || 'Opening your account…')
          : chosen
            ? `Use ${chosen.name || 'this account'}`
            : slug
              ? `Open ${slug} and continue`
              : 'Open my account and continue'}
      </button>
      {/* What the create actually costs the member, in the same register the treasuries page uses. */}
      {selected === 'new' && (
        <p className="onboarding-note" style={{ margin: 0 }}>
          Opening an account is free — there is no fee and nothing to fund up front.
          {promptless === null ? '' : promptless ? ' Your home opens it for you: nothing to approve.' : via.toLowerCase() === 'wallet' ? ' Your wallet will ask you to approve it once.' : ' This device will ask you to approve it once.'}
        </p>
      )}
      <button className="btn-ghost onboarding-secondary" onClick={onDecline} disabled={busy}>
        Go back to {politeName}
      </button>
    </div>
  );
}
