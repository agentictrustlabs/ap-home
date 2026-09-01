'use client';
// Naming → change or clear the name this agent presents.
//
// What the contracts actually allow, because the screen must not promise more:
//
//   • `PermissionlessSubregistry.claimedBy` is WRITE-ONCE and has no release. An SA gets exactly one
//     label per root, permanently. So "rename" can never mean "a different label under the same
//     suffix" — that reverts `AlreadyClaimed`, and a second claim through `claimName` is a silent
//     no-op that hands back the OLD name.
//   • `setPrimaryName(node)` is freely changeable, and `setPrimaryName(0)` clears it. That is the only
//     reset there is: the agent stops PRESENTING a name. The label stays claimed and still resolves
//     forward to this agent.
//
// So this screen offers the two real moves — present a different name you already hold, or claim your
// typed suffix if you have not used it yet — and says plainly that the old label does not come back.
// The alternative (a "rename" box that reverts on submit) was the thing to avoid.
import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import {
  readClaimedRoots, readPrimaryNameNode, setPrimaryName, claimName, typedTldForKind, type AgentKind,
} from '../../../connect-client';
import { signHashFor, type Via } from '../../../home/onboarding';
import { AGENT_NAME_PARENT } from '../../../lib/domain';
import { claimableSuffix, isPresented, clearingLeavesNoName, type HeldRoot } from '../../../lib/name-change';
import { BusyButton } from '../../shared/BusyButton';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty } from '../theme';

type Root = HeldRoot;

export function ChangeNameCard({
  agent, kind, via, token, onChanged,
}: {
  agent: Address;
  kind: AgentKind | 'person';
  via: Via;
  token: string | null;
  onChanged: () => void;
}) {
  const [held, setHeld] = useState<Root[] | null>(null);
  const [primary, setPrimary] = useState<Hex | null>(null);
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [roots, node] = await Promise.all([readClaimedRoots(agent), readPrimaryNameNode(agent)]);
      setHeld(roots);
      setPrimary(node);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
  }, [agent]);
  useEffect(() => { void load(); }, [load]);

  const typed = typedTldForKind(kind);
  const claimable = claimableSuffix(typed, held ?? []);

  const run = async (what: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(what); setErr(null); setStep('');
    try {
      const res = await fn();
      if (!res.ok) { setErr(res.error); return; }
      await load();
      onChanged();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(''); setStep(''); }
  };

  const present = (node: Hex) => run(`present:${node}`, async () => {
    const signHash = await signHashFor(via, agent, token ? { token } : undefined);
    return setPrimaryName(agent, signHash, node);
  });

  const clear = () => run('clear', async () => {
    const signHash = await signHashFor(via, agent, token ? { token } : undefined);
    return setPrimaryName(agent, signHash, null);
  });

  const claim = () => run('claim', async () => {
    const clean = label.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (clean.length < 3) return { ok: false as const, error: 'Pick a name with at least 3 characters.' };
    const signHash = await signHashFor(via, agent, token ? { token } : undefined);
    const res = await claimName(agent, signHash, clean, (s) => setStep(s), undefined, claimable ?? {});
    if (!res.ok) return res;
    // A claim this root has already seen returns the OLD name unchanged. Reporting that as success is
    // how a member walks away believing they renamed something that never moved.
    if (res.alreadyClaimed) {
      return { ok: false as const, error: `This agent already holds ${res.name} under .${claimable?.tld ?? AGENT_NAME_PARENT} — a root gives each agent one name, permanently.` };
    }
    setLabel('');
    return { ok: true as const };
  });

  if (held === null) {
    return <div style={cardSty}><p style={mutedText}>Reading the names this agent holds…</p></div>;
  }

  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem' }}>
      <h3 style={{ marginTop: 0, marginBottom: '.3rem' }}>Change the name this agent presents</h3>
      <p style={{ fontSize: '.85rem', color: 'var(--color-text-body)', margin: '0 0 .8rem' }}>
        A name is a facet pointing at the Smart Agent address, which never changes. You can switch which
        of your names is the public one, or remove it entirely.
      </p>

      {held.length > 0 && (
        <div style={{ marginBottom: '.9rem' }}>
          <div style={{ fontSize: '.7rem', letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-faint)', marginBottom: '.35rem' }}>
            Names this agent holds
          </div>
          {held.map((r) => {
            const isPrimary = isPresented(r.node, primary);
            return (
              <div key={r.node} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem', flexWrap: 'wrap', padding: '.4rem 0', borderTop: '1px solid var(--color-border, #e2e8f0)' }}>
                <div>
                  <span style={mono as React.CSSProperties}>{r.name ?? `(unreadable label) .${r.tld}`}</span>
                  {!r.typed && (
                    <span style={{ ...mutedText, fontSize: '.72rem', marginLeft: '.45rem' }}>
                      legacy suffix — carries no agent type
                    </span>
                  )}
                </div>
                {isPrimary ? (
                  <span style={{ fontSize: '.75rem', color: 'var(--color-sage-600, #047857)' }}>● presented now</span>
                ) : (
                  <BusyButton busy={busy === `present:${r.node}`} busyLabel="Switching…" style={btnSty} onClick={() => void present(r.node)}>
                    Present this one
                  </BusyButton>
                )}
              </div>
            );
          })}
        </div>
      )}

      {claimable ? (
        <div style={{ marginBottom: '.9rem' }}>
          <div style={{ fontSize: '.7rem', letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-faint)', marginBottom: '.35rem' }}>
            Claim your .{claimable.tld} name
          </div>
          <p style={{ fontSize: '.8rem', ...mutedText, margin: '0 0 .45rem' }}>
            This agent has not claimed a <strong>.{claimable.tld}</strong> name yet. The suffix states the
            agent&rsquo;s type on chain, so this is how an agent moves off a legacy <code>.{AGENT_NAME_PARENT}</code> name.
          </p>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="new name" autoCapitalize="none" spellCheck={false} aria-label={`New .${claimable.tld} name`}
              disabled={!!busy}
              style={{ ...inputSty, flex: 1, minWidth: 180 }}
            />
            <span style={{ ...mutedText, fontSize: '.82rem' }}>.{claimable.tld}</span>
            <BusyButton busy={busy === 'claim'} busyLabel={step || 'Claiming…'} style={btnPrimarySty} onClick={() => void claim()} disabled={label.trim().length < 3}>
              Claim + present
            </BusyButton>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: '.8rem', ...mutedText, marginBottom: '.9rem' }}>
          {typed
            ? <>This agent already holds its <strong>.{typed.tld}</strong> name. Each root gives an agent one
                name permanently, so a different <code>.{typed.tld}</code> label is not available to it.</>
            : <>This deployment does not offer a typed suffix for this kind of agent, so there is no new
                name to claim here.</>}
        </p>
      )}

      <div style={{ borderTop: '1px solid var(--color-border, #e2e8f0)', paddingTop: '.7rem' }}>
        {primary ? (
          confirmClear ? (
            <div>
              <p style={{ fontSize: '.82rem', margin: '0 0 .5rem' }}>
                This removes the public name. Anyone looking up this address gets no name back, and any
                surface that needs one — the agent card, registry listing and trust graph — goes quiet
                until a name is presented again.{' '}
                {!clearingLeavesNoName(held) && 'You hold other names and can present one of those instead. '}
                <strong>The label is not released:</strong> it stays claimed by this agent and still
                resolves to it, so you cannot give it to anyone else or take it again under a new spelling.
              </p>
              <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                <BusyButton busy={busy === 'clear'} busyLabel="Removing…" style={btnPrimarySty} onClick={() => void clear()}>
                  Remove the public name
                </BusyButton>
                <button style={btnSty} onClick={() => setConfirmClear(false)} disabled={!!busy}>Cancel</button>
              </div>
            </div>
          ) : (
            <button style={btnSty} onClick={() => setConfirmClear(true)}>Remove the public name…</button>
          )
        ) : (
          <p style={{ ...mutedText, fontSize: '.8rem', margin: 0 }}>
            This agent presents no public name right now.
            {held.length > 0 && ' Present one of the names above to give it one again.'}
          </p>
        )}
      </div>

      {err && <p style={{ ...errorText, fontSize: '.82rem', marginTop: '.6rem' }}>{err}</p>}
    </div>
  );
}
