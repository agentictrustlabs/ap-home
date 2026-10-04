'use client';
// Spec 397 §11 — THE ACT SET, chosen here before anything is signed. The acts offered are the ones HER compiled
// playbook carries (reads and instructions never appear — they need no wire); each checked act becomes one standing
// wire. A payment is bounded in the open: her treasury, one payee, one cap. The consent sheet below frames it; this
// is the part she fills in. Unchecked ⇒ no wire ⇒ that act still parks for her signature, exactly as before.
import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import { actCapabilitiesOf, PAYMENT_CAPABILITY, type ActChoice } from '../../lib/act-as-me';
import { CONTRACTS } from '../../lib/chain';
import { listManagedAgents } from '../../connect-client';
import { Loading } from '../shared/Loading';

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export function ActAsMeConsent({ token, agent, onChange }: { token: string; agent: Address; onChange: (choices: ActChoice[], problem: string | null) => void }) {
  const [caps, setCaps] = useState<Array<{ id: string; description: string; risk: string }> | null>(null);
  const [treasuries, setTreasuries] = useState<Array<{ agent: Address; name: string }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [treasury, setTreasury] = useState<string>('');
  const [payee, setPayee] = useState('');
  const [payeeAgent, setPayeeAgent] = useState<Address | null>(null);
  const [cap, setCap] = useState('5');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() }) });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: { definition?: AgentHarnessDefinitionV1 } | null };
        if (!r.ok) throw new Error('your playbook could not be read');
        const list = actCapabilitiesOf(b.record?.definition);
        const mine = (await listManagedAgents(token).catch(() => { throw new Error('your treasuries could not be read'); })).filter((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward').map((a) => ({ agent: a.agent, name: a.name }));
        if (!live) return;
        setCaps(list);
        setTreasuries(mine);
        if (mine[0]) setTreasury(mine[0].agent);
      } catch (e) { if (live) { setErr(e instanceof Error ? e.message : 'the acts could not be listed'); setCaps([]); } }
    })();
    return () => { live = false; };
  }, [token, agent]);

  // The payee: an address as typed, or a registry name resolved by the Home (never guessed from a similar name).
  useEffect(() => {
    const v = payee.trim();
    if (!v) { setPayeeAgent(null); return; }
    if (isAddress(v)) { setPayeeAgent(v as Address); return; }
    let live = true;
    fetch(`/connect/name-info?name=${encodeURIComponent(v.toLowerCase())}`).then((r) => r.json()).then((b: { exists?: boolean; agent?: string }) => { if (live) setPayeeAgent(b.exists && b.agent ? (b.agent as Address) : null); }).catch(() => { if (live) setPayeeAgent(null); });
    return () => { live = false; };
  }, [payee]);

  const wantsPayment = checked.has(PAYMENT_CAPABILITY);
  const choices = useMemo<{ choices: ActChoice[]; problem: string | null }>(() => {
    const out: ActChoice[] = [];
    let problem: string | null = null;
    for (const id of checked) {
      if (id === PAYMENT_CAPABILITY) {
        const n = Number(cap);
        if (!treasury) problem = 'choose the treasury the payments come from';
        else if (!payeeAgent) problem = 'name the one payee (an address, or a registry name)';
        else if (!Number.isFinite(n) || n <= 0) problem = 'set a cap above zero';
        else out.push({ capability: id, payment: { treasury: treasury as Address, payee: payeeAgent, asset: CONTRACTS.mockUsdc as Address, maxAmount: BigInt(Math.round(n * 1_000_000)) } });
      } else out.push({ capability: id });
    }
    return { choices: out, problem };
  }, [checked, treasury, payeeAgent, cap]);
  useEffect(() => { onChange(choices.choices, choices.problem); }, [choices, onChange]);

  if (caps === null) return <Loading label="Reading the acts on your playbook…" />;
  if (err) return <p className="error" data-testid="act-consent-error">{err}</p>;
  if (caps.length === 0) return <p className="muted" data-testid="act-consent-none">Your playbook carries no acts an assistant could be pre-authorized for. Everything it asks still waits for your signature.</p>;
  const toggle = (id: string) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (ids: string[], on: boolean) => setChecked((prev) => { const n = new Set(prev); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  // Grouped by family (the id's first segment: treasury · messaging · person …) so a long playbook reads as a few
  // headings, each with its own "all", and one "Check all" over the lot.
  const families = [...caps.reduce((m, c) => { const f = c.id.split('.')[0] ?? c.id; m.set(f, [...(m.get(f) ?? []), c]); return m; }, new Map<string, typeof caps>())].sort(([a], [b]) => a.localeCompare(b));
  const allIds = caps.map((c) => c.id);
  const allOn = allIds.every((id) => checked.has(id));
  return (
    <div className="act-consent" data-testid="act-consent">
      <p className="muted" style={{ margin: '0 0 .5rem' }}>Check the acts this assistant may run <b>without asking you again</b> for 30 days. Each one is its own wire; you can revoke any of them, or all, under Connected → Assistants.</p>
      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', margin: '0 0 .5rem', fontSize: '.9rem' }}>
        <button type="button" className="btn-ghost" onClick={() => setMany(allIds, !allOn)} data-testid="act-check-all">{allOn ? 'Clear all' : `Check all ${caps.length}`}</button>
        <span className="muted">{checked.size} of {caps.length} checked</span>
      </div>
      <div style={{ maxHeight: '22rem', overflowY: 'auto', border: '1px solid var(--line, #e5e7eb)', borderRadius: 8, padding: '.5rem .7rem' }}>
        {families.map(([family, items]) => {
          const ids = items.map((c) => c.id);
          const on = ids.every((id) => checked.has(id));
          return (
            <section key={family} style={{ marginBottom: '.6rem' }}>
              <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => setMany(ids, !on)} data-testid={`act-family-${family}`} />
                <span>{family} <span className="muted" style={{ fontWeight: 400 }}>· {items.length}</span></span>
              </label>
              <ul className="consent-list can" style={{ listStyle: 'none', padding: '0 0 0 1.4rem', margin: '.25rem 0 0' }}>
                {items.map((c) => (
                  <li key={c.id} style={{ marginBottom: '.3rem' }}>
                    <label style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} data-testid={`act-${c.id}`} />
                      <span><b>{c.id}</b> <span className="muted">· {c.risk}</span><br /><span className="muted" style={{ fontSize: '.85em' }}>{c.description}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {wantsPayment && (
        <div className="act-payment" data-testid="act-payment" style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: '.6rem', marginTop: '.4rem' }}>
          <p style={{ margin: '0 0 .4rem', fontWeight: 600 }}>Payments — from which treasury, to whom, up to how much</p>
          {treasuries.length === 0 ? (
            <p className="error">You hold no personal treasury yet, so no payment wire can be made. Uncheck the payment, or set up a treasury first.</p>
          ) : (
            <label style={{ display: 'block', marginBottom: '.4rem' }}>From <select value={treasury} onChange={(e) => setTreasury(e.target.value)} data-testid="act-treasury">{treasuries.map((t) => <option key={t.agent} value={t.agent}>{t.name || t.agent}</option>)}</select></label>
          )}
          <label style={{ display: 'block', marginBottom: '.4rem' }}>To (one payee — an address or a registry name) <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="nathan.treasury" data-testid="act-payee" style={{ width: '100%' }} />
            {payee.trim() && !payeeAgent && <span className="muted" style={{ fontSize: '.85em' }}> — not found yet</span>}
            {payeeAgent && !isAddress(payee) && <span className="muted" style={{ fontSize: '.85em' }}> → {payeeAgent.slice(0, 8)}…{payeeAgent.slice(-4)}</span>}
          </label>
          <label style={{ display: 'block' }}>Up to <input type="number" min="0" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} data-testid="act-cap" style={{ width: '6rem' }} /> USDC per payment</label>
        </div>
      )}
      {choices.problem && checked.size > 0 && <p className="muted" data-testid="act-consent-problem" style={{ marginTop: '.4rem' }}>Before you authorize: {choices.problem}.</p>}
    </div>
  );
}
