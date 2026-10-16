'use client';
// Naming → "Declare this account as the agent's home" (ap-federation spec 440 §C3 / spec 346 §3.8).
//
// A name claimed before 2026-10-15 carries `addr` and nothing that says which account is the agent's HOME —
// so the town's naming service shows "Agent (canonical id): Not declared" for it and, rightly, refuses to
// guess. Every claim since writes `atl:nativeId` + `atl:accounts` in the claim's own userOp. This card is the
// one-time catch-up for the names that predate it: every name this agent holds on this chain, the CAIP-10 of
// THIS account pre-filled, one signature, one userOp — then the card is gone, because there is nothing left
// to declare.
//
// It renders nothing when there is nothing to do. A satellite (home declared on another chain) is nothing to
// do; a record already naming a different account is a CONFLICT and is shown, not overwritten (ADR-0013).
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { readClaimedRoots } from '../../../connect-client';
import { signHashFor, type Via } from '../../../home/onboarding';
import { readNameRecords } from '../../../lib/name-properties';
import { caip10Of, declareHomeAccount, planHomeAccount, type HomeAccountPlan } from '../../../lib/declare-home-account';
import { CHAIN_ID } from '../../../lib/chain';
import { BusyButton } from '../../shared/BusyButton';
import { cardSty, btnPrimarySty, mono, mutedText, errorText } from '../theme';

export function DeclareHomeAccountCard({ agent, via, token, onDeclared }: {
  agent: Address;
  via: Via;
  token: string | null;
  /** After the write lands — the records section below re-reads itself from chain. */
  onDeclared?: (() => void) | undefined;
}) {
  const [plans, setPlans] = useState<HomeAccountPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const roots = await readClaimedRoots(agent);
      // Only names that still EXIST and have a label: an expired claim resolves nobody and has no node to write.
      const live = roots.filter((r) => r.name && !r.expired);
      const out = await Promise.all(live.map(async (r) => {
        const records = await readNameRecords(r.name!);
        return planHomeAccount({ name: r.name!, records }, agent);
      }));
      setPlans(out);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
  }, [agent]);
  useEffect(() => { void load(); }, [load]);

  if (!plans) return null;
  const toWrite = plans.filter((p) => p.action === 'write');
  const conflicts = plans.filter((p): p is Extract<HomeAccountPlan, { action: 'conflict' }> => p.action === 'conflict');
  if (!toWrite.length && !conflicts.length && !done) return null;

  const me = caip10Of(CHAIN_ID, agent);

  const declare = async () => {
    setBusy(true); setErr(null);
    try {
      const signHash = await signHashFor(via, agent, token ? { token } : undefined);
      const res = await declareHomeAccount(agent, plans, signHash);
      if (!res.ok) { setErr(res.error); return; }
      setDone(res.written);
      await load();
      onDeclared?.();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>✓ Home account declared</h3>
        <p style={{ fontSize: '.88rem', margin: 0 }}>
          <strong style={mono}>{done.join(', ')}</strong> now {done.length === 1 ? 'names' : 'name'}{' '}
          <code style={mono}>{me}</code> as the agent’s home. The town’s naming page reads it on its next refresh.
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-amber-400)' }}>
      <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>Declare this account as the agent’s home</h3>
      <p style={{ fontSize: '.85rem', color: 'var(--color-text-body)', marginTop: 0 }}>
        {toWrite.length === 1 ? 'This name was' : 'These names were'} claimed before names recorded which account is the agent’s
        home, so anyone looking {toWrite.length === 1 ? 'it' : 'them'} up sees <em>“Not declared”</em>. Declaring writes the
        home account (<code style={mono}>atl:nativeId</code>) and this chain’s entry in the accounts-by-chain list
        (<code style={mono}>atl:accounts</code>) — the same two records every new claim is born with.
      </p>
      {toWrite.length > 0 && (
        <ul style={{ fontSize: '.84rem', margin: '.4rem 0 .6rem', paddingLeft: '1.2rem' }}>
          {toWrite.map((p) => (
            <li key={p.name}>
              <strong style={mono}>{p.name}</strong>{' '}
              <span style={mutedText}>→ {p.action === 'write' ? p.missing.join(' + ') : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <p style={{ fontSize: '.8rem', ...mutedText, margin: '0 0 .6rem' }}>
        Home account: <code style={mono}>{me}</code>
      </p>
      {conflicts.length > 0 && (
        <div style={{ fontSize: '.82rem', ...errorText, margin: '.4rem 0 .6rem' }}>
          {conflicts.map((c) => <p key={c.name} style={{ margin: '.15rem 0' }}><strong style={mono}>{c.name}</strong>: {c.reason}. Not changed — fix it in the records below.</p>)}
        </div>
      )}
      {toWrite.length > 0 && (
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <BusyButton busy={busy} busyLabel="Declaring…" style={btnPrimarySty} onClick={declare}>
            Sign &amp; declare{toWrite.length > 1 ? ` (${toWrite.length} names, one signature)` : ''}
          </BusyButton>
          <span style={{ fontSize: '.78rem', ...mutedText }}>
            Your agent writes its own records — <code style={mono}>msg.sender == owner</code> — signed by your {via} credential, sponsored. One prompt.
          </span>
        </div>
      )}
      {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.5rem' }}>{err}</p>}
    </div>
  );
}
