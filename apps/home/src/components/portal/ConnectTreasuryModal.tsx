'use client';
// Connect-treasury ceremony as a POPUP off a treasury card (spec 283/284). Replaces the standalone
// /treasury-connect page: because we launch it FROM a specific treasury card we already have the treasury
// SA + name, so the agent is fixed (no selector) and the host endpoints pre-fill from the treasury's own
// name label (a2a = <label>.impact-agent.io, mcp = mcp.<label>.impact-agent.io — editable). The member
// supplies only the host's delegate SA + the profile to publish, then runs the three-step ritual via the
// pure orchestrator (src/lib/connect-treasury):
//   BIND      → write the treasury's a2aEndpoint + mcpEndpoint naming records (spec 280 rail).
//   AUTHORIZE → mint a scoped, monotonic delegation treasury → host (caveats from a TreasuryAuthorityScope).
//   ASSERT    → publish the treasury's public skill families (spec 282 → atl:skills) for discovery.
// Signs with the treasury's CURRENT credential (signHashFor); broadcast goes through the app's userOp path.
import { useMemo, useState, type CSSProperties } from 'react';
import type { Address } from '@agenticprimitives/types';
import { namehash } from '@agenticprimitives/agent-naming';
import { buildTreasuryScope, TREASURY_PROFILES, type TreasuryProfileId } from '@agenticprimitives/treasury-service-agent';
import { executeCalls, setSkills } from '../../connect-client';
import { signHashFor, type Via } from '../../home/onboarding';
import { issueScopedDelegation } from '../../lib/delegation';
import { CONTRACTS } from '../../lib/chain';
import { A2A_DOMAIN, nameLabel } from '../../lib/domain';
import { connectTreasuryCeremony, type ConnectTreasuryResult } from '../../lib/connect-treasury';
import { AddressChip } from '../shared/AddressChip';

const PROFILES: TreasuryProfileId[] = ['readonly', 'payments', 'markets', 'portfolio', 'yield', 'crossChain', 'full'];
const YEAR = 60 * 60 * 24 * 365;

const viaForSession = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex',
  alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 1rem', zIndex: 60, overflowY: 'auto',
};
const sheet: CSSProperties = {
  background: '#fff', borderRadius: 16, boxShadow: '0 12px 40px rgba(15,23,42,.25)', padding: '1.25rem 1.4rem',
  width: '100%', maxWidth: 520,
};
const field: CSSProperties = { display: 'block', width: '100%', padding: '.5rem .65rem', borderRadius: 10, border: '1.5px solid #e2e8f0', font: 'inherit', marginTop: '.25rem', boxSizing: 'border-box' };
const label: CSSProperties = { display: 'block', fontSize: '.8rem', fontWeight: 700, color: '#334155', marginTop: '.75rem' };

/** Default host endpoints for a treasury, derived from its OWN name label (spec 232 / 280). */
function deriveEndpoints(name: string): { a2a: string; mcp: string } {
  const label = nameLabel(name);
  if (!label) return { a2a: '', mcp: '' };
  return { a2a: `https://${label}.${A2A_DOMAIN}`, mcp: `https://mcp.${label}.${A2A_DOMAIN}` };
}

/** The connect-to-hosts ceremony for ONE treasury, rendered as a modal. The treasury (SA + name) is fixed by
 *  the card that opened this; the endpoints pre-fill from its name label; only the host delegate + profile
 *  are collected. `onDone` fires after a successful run (so the parent can refresh). */
export function ConnectTreasuryModal({
  treasury, name, person: _person, via, token, onClose, onDone,
}: {
  treasury: string; name: string; person?: string | null; via?: string; token: string; onClose: () => void; onDone?: () => void;
}) {
  const derived = useMemo(() => deriveEndpoints(name), [name]);
  const [a2aEndpoint, setA2a] = useState(derived.a2a);
  const [mcpEndpoint, setMcp] = useState(derived.mcp);
  const [hostDelegate, setHostDelegate] = useState('');
  const [profile, setProfile] = useState<TreasuryProfileId>('payments');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ConnectTreasuryResult | null>(null);

  const canRun = !!name && (!!a2aEndpoint || !!mcpEndpoint) && /^0x[0-9a-fA-F]{40}$/.test(hostDelegate) && phase !== 'running';

  async function run() {
    if (!name) { setErr('Name this treasury first — the host binding needs its name.'); setPhase('error'); return; }
    setPhase('running'); setErr(''); setResult(null);
    try {
      const signHash = await signHashFor(viaForSession(via), treasury as Address, { token });
      const now = Math.floor(Date.now() / 1000);
      const scope = buildTreasuryScope({
        allowedSkillIds: TREASURY_PROFILES[profile].skillIds,
        allowedTargets: [hostDelegate as Address],
        networks: ['eip155:84532'],
        notBefore: now,
        notAfter: now + YEAR,
      });
      const res = await connectTreasuryCeremony(
        {
          resolver: CONTRACTS.agentNameResolver,
          node: namehash(name),
          endpoints: { a2aEndpoint: a2aEndpoint || undefined, mcpEndpoint: mcpEndpoint || undefined },
          scope,
          enforcers: {
            timestampEnforcer: CONTRACTS.timestampEnforcer,
            valueEnforcer: CONTRACTS.valueEnforcer,
            allowedTargetsEnforcer: CONTRACTS.allowedTargetsEnforcer,
          },
          profile,
        },
        {
          executeBatch: async (calls) => {
            const r = await executeCalls(treasury as Address, signHash, calls);
            if (!r.ok) throw new Error(r.error);
            return { txHash: r.txHash };
          },
          issueHostDelegation: (caveats) => issueScopedDelegation(treasury as Address, hostDelegate as Address, caveats, signHash),
          publishSkills: async (skills) => {
            const r = await setSkills(treasury as Address, name, skills, signHash);
            if (!r.ok) throw new Error(r.error);
            return { txHash: r.txHash };
          },
          onStep: (s) => setStep(s),
        },
      );
      setResult(res);
      setPhase('done');
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'connect-treasury failed');
      setPhase('error');
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Connect treasury to its hosts"
      onClick={(e) => { if (e.target === e.currentTarget && phase !== 'running') onClose(); }}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '.75rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Connect to hosts</h3>
            <p style={{ margin: '.2rem 0 0', fontSize: '.85rem', color: '#64748b' }}>
              Bind <b>{name || 'this treasury'}</b> to its A2A + MCP hosts, authorize a scoped host delegation, and publish its skills.
            </p>
          </div>
          <button type="button" className="btn-ghost" style={{ fontSize: '.85rem', padding: '.25rem .55rem' }}
            disabled={phase === 'running'} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ margin: '.85rem 0 .25rem', padding: '.55rem .7rem', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.8rem', fontWeight: 700, color: '#334155', marginBottom: '.3rem' }}>Treasury agent</div>
          <AddressChip address={treasury as `0x${string}`} size="sm" />
          <div style={{ fontSize: '.82rem', color: '#64748b', marginTop: '.25rem' }}>{name || 'Unnamed — name it first'}</div>
        </div>

        <label style={label}>A2A endpoint
          <input style={field} placeholder={`https://<label>.${A2A_DOMAIN}`} value={a2aEndpoint} onChange={(e) => setA2a(e.target.value)} disabled={phase === 'running'} />
        </label>
        <label style={label}>MCP endpoint
          <input style={field} placeholder={`https://mcp.<label>.${A2A_DOMAIN}`} value={mcpEndpoint} onChange={(e) => setMcp(e.target.value)} disabled={phase === 'running'} />
        </label>
        <label style={label}>Host delegate SA (the host the treasury authorizes)
          <input style={field} placeholder="0x…" value={hostDelegate} onChange={(e) => setHostDelegate(e.target.value)} disabled={phase === 'running'} />
        </label>
        <label style={label}>Profile to publish
          <select style={field} value={profile} onChange={(e) => setProfile(e.target.value as TreasuryProfileId)} disabled={phase === 'running'}>
            {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
          <button type="button" className="btn-primary" style={{ fontSize: '.9rem', padding: '.55rem 1rem', opacity: canRun ? 1 : 0.5 }} disabled={!canRun} onClick={() => void run()}>
            {phase === 'running' ? `Connecting… (${step})` : 'Connect treasury'}
          </button>
          <button type="button" className="btn-ghost" style={{ fontSize: '.9rem', padding: '.55rem 1rem' }} disabled={phase === 'running'} onClick={onClose}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>

        {phase === 'error' && <p className="onboarding-hint taken" style={{ marginTop: '.6rem' }}>{err}</p>}
        {phase === 'done' && result && (
          <div style={{ marginTop: '.8rem', fontSize: '.85rem', display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
            <p style={{ margin: 0 }}>✓ Bound endpoints {result.bindTxHash ? `(tx ${result.bindTxHash.slice(0, 10)}…)` : ''}</p>
            <p style={{ margin: 0 }}>✓ Authorized host — delegation to {result.delegation.delegate.slice(0, 10)}… with {result.delegation.caveats.length} caveat(s)</p>
            <p style={{ margin: 0 }}>✓ Published skills: {result.publishedSkills.join(', ') || '(none)'}</p>
            {result.unmappedCaveats.length > 0 && (
              <p style={{ margin: 0, color: '#92400e' }}>Note: {result.unmappedCaveats.join(', ')} have no on-chain enforcer — enforced off-chain by the host policy.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
