'use client';
// Skills (spec 282). Two-tier: your full skill set is PRIVATE (managed here; the per-SA vault is Phase 2b),
// and you assert a chosen subset PUBLICLY so the discovery matcher (spec 281) can rank you for a need. The
// public assertion is the agent's own `atl:skills` profile property (owner-signed, gasless) — projected by
// the indexer, ranked by /discover. Your Smart Agent address is unchanged; skills are a public facet.
// Self-contained inline styles (the app's class system has no card/chip classes).
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { getSkills, setSkills } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';

const cardSty: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, boxShadow: '0 1px 3px rgba(15,23,42,.07)', padding: '1rem 1.1rem' };
const btnSty: CSSProperties = { padding: '.5rem .9rem', borderRadius: 10, fontWeight: 700, fontSize: '.85rem', cursor: 'pointer', border: '1.5px solid #c7d2fe', background: '#fff', color: '#4f46e5', font: 'inherit' };
const btnPrimarySty: CSSProperties = { ...btnSty, background: '#4f46e5', color: '#fff', border: '1.5px solid #4f46e5' };
const chipSty: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '.4rem', fontSize: '.82rem', fontWeight: 600, padding: '.3rem .7rem', borderRadius: 999, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca' };

const toViaForSign = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

export default function SkillsPage() {
  const { session, agentAddress, agentName, agentDeployed } = useSession();
  const [skills, setSkillsState] = useState<string[]>([]);
  const [published, setPublished] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agentAddress) { setLoading(false); return; }
    setLoading(true);
    const cur = await getSkills(agentAddress);
    setSkillsState(cur); setPublished(cur); setLoading(false);
  }, [agentAddress]);
  useEffect(() => { void load(); }, [load]);

  const add = () => { const v = norm(input); if (v && !skills.some((s) => s.toLowerCase() === v.toLowerCase())) setSkillsState([...skills, v]); setInput(''); };
  const remove = (s: string) => setSkillsState(skills.filter((x) => x !== s));
  const dirty = skills.join('||') !== published.join('||');

  const publish = async () => {
    if (!agentAddress || !agentName) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const signHash = await signHashFor(toViaForSign(session?.via), agentAddress, session?.token ? { token: session.token } : undefined);
      const res = await setSkills(agentAddress, agentName, skills, signHash);
      if (res.ok) { setPublished(skills); setMsg('Skills published — discovery will rank you for these within seconds.'); }
      else setErr(res.error);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <SectionShell
      title="Skills"
      description="Publish the skills your agent can be discovered by. The matcher ranks you when someone's intent or a required-skill mandate matches what you've asserted."
    >
      <div style={{ ...cardSty, background: '#eff6ff', borderColor: '#bfdbfe', marginBottom: '1.1rem', fontSize: '.82rem', color: '#1e40af' }}>
        Skills you publish here are <strong>public</strong> (a profile facet of your Smart Agent) so discovery can match you.
        Your full skill set — proficiency, who endorsed you — stays <strong>private</strong> in your agent's vault; only the
        labels you assert here are public. Works the same for a person, organization, or service/treasury agent.
      </div>

      {!agentAddress ? <p style={{ color: '#64748b' }}>Sign in to manage your agent's skills.</p>
        : !agentName ? <p style={{ color: '#64748b' }}>Your home needs a public name first (Naming Service tab) before it can publish skills.</p>
        : agentDeployed === false ? <p style={{ color: '#64748b' }}>Your agent isn't deployed yet.</p>
        : loading ? <p style={{ color: '#64748b' }}>Loading your published skills…</p>
        : (
          <div style={cardSty}>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: skills.length ? '.8rem' : 0 }}>
              {skills.map((s) => (
                <span key={s} style={chipSty}>{s}<button onClick={() => remove(s)} aria-label={`remove ${s}`} style={{ border: 'none', background: 'none', color: '#6366f1', cursor: 'pointer', fontWeight: 800, fontSize: '1rem', lineHeight: 1, padding: 0 }}>×</button></span>
              ))}
              {skills.length === 0 && <span style={{ color: '#94a3b8', fontSize: '.85rem' }}>No skills yet — add a few capabilities others could discover you by.</span>}
            </div>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder="e.g. accounting, treasury management, smart contracts"
                style={{ flex: 1, minWidth: 200, padding: '.6rem .8rem', borderRadius: 10, border: '1.5px solid #cbd5e1', font: 'inherit' }}
              />
              <button style={btnSty} onClick={add} disabled={!norm(input)}>Add</button>
              <button style={btnPrimarySty} onClick={publish} disabled={busy || !dirty}>{busy ? 'Publishing…' : 'Publish skills'}</button>
            </div>
            <p style={{ fontSize: '.78rem', color: '#64748b', marginTop: '.7rem' }}>
              Your agent signs the update itself (<code>msg.sender == agent</code>) with your {toViaForSign(session?.via)} credential, sponsored — one prompt.
            </p>
            {msg && <p style={{ fontSize: '.82rem', color: '#047857', marginTop: '.4rem' }}>{msg}</p>}
            {err && <p style={{ fontSize: '.82rem', color: '#b91c1c', marginTop: '.4rem' }}>{err}</p>}
          </div>
        )}
    </SectionShell>
  );
}
