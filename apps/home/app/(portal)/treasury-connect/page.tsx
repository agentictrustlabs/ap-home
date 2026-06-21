'use client';
// Connect a treasury (or any service) Smart Agent to its A2A + MCP hosts (spec 283/284 ceremony). The
// member picks one of their managed treasury agents, supplies its host endpoints + the host's delegate SA,
// and runs the three-step ritual via the pure orchestrator (src/lib/connect-treasury):
//   BIND      → write the treasury's a2aEndpoint + mcpEndpoint naming records (spec 280 rail).
//   AUTHORIZE → mint a scoped, monotonic delegation treasury → host (caveats from a TreasuryAuthorityScope).
//   ASSERT    → publish the treasury's public skill families (spec 282 → atl:skills) for discovery + carding.
// Signs with the treasury's CURRENT credential (signHashFor); all broadcast goes through the app's existing
// userOp path (executeCalls) + delegation/skills helpers. Card visibility is not authorization — hosts still
// re-check entitlement ∩ delegation ∩ assertion health ∩ policy at invoke.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Address } from '@agenticprimitives/types';
import { namehash } from '@agenticprimitives/agent-naming';
import { buildTreasuryScope, TREASURY_PROFILES, type TreasuryProfileId } from '@agenticprimitives/treasury-service-agent';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { useSession } from '../../../src/context/session';
import { executeCalls, listManagedAgents, setSkills, type ManagedAgent } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { issueScopedDelegation } from '../../../src/lib/delegation';
import { CONTRACTS } from '../../../src/lib/chain';
import { connectTreasuryCeremony, type ConnectTreasuryResult } from '../../../src/lib/connect-treasury';

const card: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, boxShadow: '0 1px 3px rgba(15,23,42,.07)', padding: '1rem 1.1rem', marginTop: '1rem' };
const field: CSSProperties = { display: 'block', width: '100%', padding: '.5rem .65rem', borderRadius: 10, border: '1.5px solid #e2e8f0', font: 'inherit', marginTop: '.25rem' };
const label: CSSProperties = { fontSize: '.8rem', fontWeight: 700, color: '#334155' };
const btn: CSSProperties = { padding: '.55rem 1rem', borderRadius: 10, fontWeight: 700, fontSize: '.9rem', cursor: 'pointer', border: '1.5px solid #4f46e5', background: '#4f46e5', color: '#fff', font: 'inherit' };
const PROFILES: TreasuryProfileId[] = ['readonly', 'payments', 'markets', 'portfolio', 'yield', 'crossChain', 'full'];
const YEAR = 60 * 60 * 24 * 365;

const viaForSession = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};
const isTreasury = (a: ManagedAgent) => a.kind === 'person-treasury' || a.kind === 'org-treasury';

export default function TreasuryConnectPage() {
  const { session } = useSession();
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [treasury, setTreasury] = useState<string>('');
  const [a2aEndpoint, setA2a] = useState('');
  const [mcpEndpoint, setMcp] = useState('');
  const [hostDelegate, setHostDelegate] = useState('');
  const [profile, setProfile] = useState<TreasuryProfileId>('payments');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ConnectTreasuryResult | null>(null);

  const load = useCallback(async () => {
    if (!session?.token) return;
    const all = await listManagedAgents(session.token);
    const treasuries = all.filter(isTreasury);
    setAgents(treasuries);
    if (treasuries[0]) setTreasury((t) => t || treasuries[0]!.agent);
  }, [session?.token]);
  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => agents.find((a) => a.agent === treasury), [agents, treasury]);
  const canRun = !!session && !!selected && (!!a2aEndpoint || !!mcpEndpoint) && /^0x[0-9a-fA-F]{40}$/.test(hostDelegate) && phase !== 'running';

  async function run() {
    if (!session || !selected) return;
    setPhase('running'); setErr(''); setResult(null);
    try {
      const via = viaForSession(session.via);
      const signHash = await signHashFor(via, selected.agent, { token: session.token });
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
          node: namehash(selected.name),
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
            const r = await executeCalls(selected.agent, signHash, calls);
            if (!r.ok) throw new Error(r.error);
            return { txHash: r.txHash };
          },
          issueHostDelegation: (caveats) => issueScopedDelegation(selected.agent, hostDelegate as Address, caveats, signHash),
          publishSkills: async (skills) => {
            const r = await setSkills(selected.agent, selected.name, skills, signHash);
            if (!r.ok) throw new Error(r.error);
            return { txHash: r.txHash };
          },
          onStep: (s) => setStep(s),
        },
      );
      setResult(res);
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'connect-treasury failed');
      setPhase('error');
    }
  }

  return (
    <SectionShell title="Connect a treasury to its hosts" description="Bind a treasury agent to its A2A + MCP hosts, authorize a scoped host delegation, and publish its skills.">
      {agents.length === 0 ? (
        <div style={card}>No treasury agents yet — create one under Treasuries first.</div>
      ) : (
        <div style={card}>
          <label style={label}>Treasury agent
            <select style={field} value={treasury} onChange={(e) => setTreasury(e.target.value)}>
              {agents.map((a) => <option key={a.agent} value={a.agent}>{a.name} ({a.kind})</option>)}
            </select>
          </label>
          <label style={label}>A2A endpoint
            <input style={field} placeholder="https://<handle>.example.io" value={a2aEndpoint} onChange={(e) => setA2a(e.target.value)} />
          </label>
          <label style={label}>MCP endpoint
            <input style={field} placeholder="https://mcp.<handle>.example" value={mcpEndpoint} onChange={(e) => setMcp(e.target.value)} />
          </label>
          <label style={label}>Host delegate SA (the host the treasury authorizes)
            <input style={field} placeholder="0x…" value={hostDelegate} onChange={(e) => setHostDelegate(e.target.value)} />
          </label>
          <label style={label}>Profile to publish
            <select style={field} value={profile} onChange={(e) => setProfile(e.target.value as TreasuryProfileId)}>
              {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <button style={{ ...btn, marginTop: '.9rem', opacity: canRun ? 1 : 0.5 }} disabled={!canRun} onClick={() => void run()}>
            {phase === 'running' ? `Connecting… (${step})` : 'Connect treasury'}
          </button>
          {phase === 'error' && <p style={{ color: '#b91c1c', marginTop: '.6rem' }}>{err}</p>}
          {phase === 'done' && result && (
            <div style={{ marginTop: '.8rem', fontSize: '.85rem' }}>
              <p>✓ Bound endpoints {result.bindTxHash ? `(tx ${result.bindTxHash.slice(0, 10)}…)` : ''}</p>
              <p>✓ Authorized host — delegation to {result.delegation.delegate.slice(0, 10)}… with {result.delegation.caveats.length} caveat(s)</p>
              <p>✓ Published skills: {result.publishedSkills.join(', ') || '(none)'}</p>
              {result.unmappedCaveats.length > 0 && (
                <p style={{ color: '#92400e' }}>Note: {result.unmappedCaveats.join(', ')} have no on-chain enforcer — enforced off-chain by the host policy.</p>
              )}
            </div>
          )}
        </div>
      )}
    </SectionShell>
  );
}
