'use client';
// THE HOUSEHOLD — spec 363 W4, and the test of whether the capability model is doing its job.
//
// This surface adds NO invoker, NO vocabulary entry and NO UI-only concept. It reads the person's own
// `household.data` record through the same Ask boundary the conversation uses, and it records a member
// through the same capability the sentence "carol is my daughter" reaches. If building it had required
// teaching the Ask about households separately, the model would have failed its own rule
// (docs/architecture/agent-rules/one-capability-model-generates-both.md).
//
// PRIVATE, AND THE PANEL SAYS SO. Who lives with whom is not on chain and not derivable from it, so it
// is in no public tier by construction (ADR-0040) — a family graph is exactly the data a platform should
// not hold, and the page states that rather than leaving it to be assumed.
//
// IT GRANTS NOBODY ANYTHING. A guardian recorded here cannot act for a dependent; that is a delegation
// their custodian issues. No gate reads this record — it answers "who did you mean".
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { AgentName } from '../shared/AgentName';
import { householdThroughHarness, readHouseholdThroughHarness, type HouseholdMemberRow } from '../../home/household-harness';
import { mutedText, errorText } from './theme';

const KIN = ['', 'spouse', 'child', 'parent', 'sibling'] as const;
const ROLES = ['member', 'guardian', 'dependent'] as const;

export function HouseholdPanel() {
  const { session, agentAddress } = useSession();
  const [rows, setRows] = useState<HouseholdMemberRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  const [kin, setKin] = useState<string>('');
  const [role, setRole] = useState<string>('member');

  const load = useCallback(async () => {
    if (!session?.token || !agentAddress) return;
    const out = await readHouseholdThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (out.ok) { setRows(out.members); setErr(''); } else setErr(out.error);
    setLoaded(true);
  }, [session?.token, agentAddress]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!session?.token || !agentAddress || !who.trim()) return;
    setBusy(true); setErr('');
    const out = await householdThroughHarness({
      person: agentAddress as Address, session: { token: session.token },
      member: who.trim(), ...(kin ? { kin } : {}), role,
    });
    if (!out.ok) setErr(out.error); else { setWho(''); setKin(''); setRole('member'); await load(); }
    setBusy(false);
  }

  async function remove(agent: string) {
    if (!session?.token || !agentAddress) return;
    setBusy(true); setErr('');
    const out = await householdThroughHarness({ person: agentAddress as Address, session: { token: session.token }, member: agent, remove: true });
    if (!out.ok) setErr(out.error); else await load();
    setBusy(false);
  }

  return (
    <div>
      <p style={{ ...mutedText, fontSize: 12, marginTop: 0 }}>
        The people you live with, as you record them. It is held in your own vault, published nowhere, and
        it gives nobody any authority — a guardian here still needs a delegation to act for anyone.
        What it does is let your agent understand you: <em>“send my daughter 20 usdc”</em> resolves here,
        without a directory learning who you asked about.
      </p>
      {err && <p style={errorText}>{err}</p>}
      {loaded && rows.length === 0 && (
        <p style={{ ...mutedText, fontSize: 12 }}>Nobody recorded yet.</p>
      )}
      {rows.map((m) => (
        <div key={m.agent} data-testid={`household-row-${m.agent}`}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border, #e6e8ec)' }}>
          <strong style={{ fontSize: 13 }}>{m.label ?? <AgentName address={m.agent as Address} />}</strong>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {m.relation ? `your ${m.relation}` : 'in your household'}{m.role && m.role !== 'member' ? ` · ${m.role}` : ''}
          </span>
          <button type="button" className="btn-ghost" style={{ marginLeft: 'auto', fontSize: 11 }}
            disabled={busy} onClick={() => void remove(m.agent)} data-testid={`household-remove-${m.agent}`}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="their agent (carol.me)" value={who}
          data-testid="household-who" onChange={(e) => setWho(e.target.value)} />
        <select className="input" style={{ flex: '0 0 130px' }} value={kin} data-testid="household-kin" onChange={(e) => setKin(e.target.value)}>
          {KIN.map((k) => <option key={k || 'none'} value={k}>{k || 'how related…'}</option>)}
        </select>
        <select className="input" style={{ flex: '0 0 130px' }} value={role} data-testid="household-role" onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <BusyButton busy={busy} busyLabel="Recording…" className="btn-primary" style={{ flex: '0 0 auto' }}
          data-testid="household-add" onClick={() => void add()}>Record</BusyButton>
      </div>
      <p style={{ ...mutedText, fontSize: 11, marginTop: 8 }}>
        They need an agent for you to record them — this record holds agents, not names on a list.
      </p>
    </div>
  );
}
