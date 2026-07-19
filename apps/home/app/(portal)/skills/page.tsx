'use client';
// "What this agent can do" (spec 282) — the DECLARED CAPABILITY surface. Two tiers, both managed here:
//   • PRIVATE — your capability record: the full capability claim credentials in your agent's Connect-home
//     vault (session-authorized; the per-SA MCP vault is the production target). Never public.
//   • PUBLIC  — you choose which entries to PUBLISH FOR DISCOVERY; the published labels become your agent's
//     `atl:skills` profile property (owner-signed, gasless), which the discovery matcher (spec 281) ranks.
// `atl:skills` / SkillClaim / setSkills — the DECLARED CAPABILITY projection (capability-architecture.md §1);
// the key and type names are legacy and immutable (ADR-0051 prose/key split), the prose says "capability".
// Your Smart Agent address is unchanged; capabilities are a facet. Works for person/org/service/treasury SAs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { listSkillClaims, saveSkillClaims, setSkills, getSkills, type SkillClaim } from '../../../src/connect-client';
import { lookupIndependentEndorsers } from '../../../src/lib/agent-search';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { cardSty, btnSty, btnPrimarySty, mutedText, errorText, inputSty, infoBannerSty, pillStyle as pill } from '../../../src/components/portal/theme';
import { Tooltip } from '../../../src/components/shared/ui';

const toViaForSign = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const assertedLabels = (cs: SkillClaim[]) => cs.filter((c) => c.asserted).map((c) => c.label).sort();

export default function SkillsPage() {
  const { session, agentAddress, agentName, agentDeployed } = useSession();
  const [claims, setClaims] = useState<SkillClaim[]>([]);
  const [publishedPublic, setPublishedPublic] = useState<string[]>([]); // currently on-chain asserted set
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // CLAIMED-tier corroboration: distinct non-self agents who have endorsed this subject for a
  // capability (aggregated + de-abused server-side). Best-effort — null = not loaded/unavailable.
  const [endorsers, setEndorsers] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!agentAddress || !session?.token) { setLoading(false); return; }
    setLoading(true);
    const [vault, onChain] = await Promise.all([listSkillClaims(session.token), getSkills(agentAddress)]);
    setClaims(vault); setPublishedPublic(onChain.slice().sort()); setLoading(false);
  }, [agentAddress, session?.token]);
  useEffect(() => { void load(); }, [load]);

  // Best-effort endorsement read: corroboration only, never gates the page. Failures stay silent.
  useEffect(() => {
    let live = true;
    if (!agentAddress) { setEndorsers(null); return; }
    void lookupIndependentEndorsers(agentAddress).then((n) => { if (live) setEndorsers(n); });
    return () => { live = false; };
  }, [agentAddress]);

  const add = () => { const v = norm(input); if (v && !claims.some((c) => c.label.toLowerCase() === v.toLowerCase())) setClaims([...claims, { label: v, relation: 'hasSkill', asserted: false, createdAt: Date.now() }]); setInput(''); };
  const remove = (label: string) => setClaims(claims.filter((c) => c.label !== label));
  const toggle = (label: string) => setClaims(claims.map((c) => (c.label === label ? { ...c, asserted: !c.asserted } : c)));

  const publicChanged = useMemo(() => assertedLabels(claims).join('||') !== publishedPublic.join('||'), [claims, publishedPublic]);

  // Save the private vault set (no prompt). The public assertion is a separate, owner-signed step.
  const savePrivate = async () => {
    if (!session?.token) return;
    setBusy('save'); setErr(null); setMsg(null);
    const res = await saveSkillClaims(session.token, claims);
    if (res.ok) setMsg('Saved to your private capability record.'); else setErr(res.error);
    setBusy(null);
  };

  // Publish the chosen subset on-chain (owner-signed) so discovery ranks you for it. Also re-saves private.
  const publishPublic = async () => {
    if (!agentAddress || !agentName || !session?.token) return;
    setBusy('publish'); setErr(null); setMsg(null);
    try {
      await saveSkillClaims(session.token, claims); // keep the vault in sync first
      const labels = assertedLabels(claims);
      const signHash = await signHashFor(toViaForSign(session.via), agentAddress, { token: session.token });
      const res = await setSkills(agentAddress, agentName, labels, signHash);
      if (res.ok) { setPublishedPublic(labels); setMsg(labels.length ? 'Published — discovery will rank you for these capabilities within seconds.' : 'Cleared what you publish for discovery.'); }
      else setErr(res.error);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(null); }
  };

  return (
    <SectionShell
      title="What this agent can do"
      description="Keep your capability record private, and publish a chosen subset for discovery so others can find you when what they need matches what you can do."
    >
      <div style={{ ...infoBannerSty, marginBottom: '1.1rem', fontSize: '.82rem' }}>
        Your capability record is <strong>private</strong> (held in your agent's vault). Mark an entry <strong>Published</strong> to
        publish it for discovery — only published capabilities become a public facet of your Smart Agent. Same for a person,
        organization, or service/treasury agent.
      </div>

      {agentAddress && endorsers && endorsers > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem', marginBottom: '1.1rem', fontSize: '.82rem', color: 'var(--color-sage-700)' }}>
          <span aria-hidden style={{ fontSize: '.9rem', lineHeight: 1 }}>✓</span>
          <span>
            <strong>Endorsed by {endorsers} independent {endorsers === 1 ? 'agent' : 'agents'}</strong> — other agents have
            corroborated what this agent can do. Corroboration only; it grants no authority.
          </span>
        </div>
      )}

      {!agentAddress ? <p style={mutedText}>Sign in to manage what your agent can do.</p>
        : !agentName ? <p style={mutedText}>Your home needs a public name first (Naming Service tab) before you can publish capabilities for discovery.</p>
        : loading ? <p style={mutedText}>Loading your capability record…</p>
        : (
          <div style={cardSty}>
            <div style={{ display: 'grid', gap: '.5rem', marginBottom: claims.length ? '.9rem' : 0 }}>
              {claims.map((c) => (
                <div key={c.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem', padding: '.5rem .7rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-8)' }}>
                  <span style={{ fontWeight: 600, fontSize: '.9rem' }}>{c.label}</span>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                    <span style={pill(c.asserted)} role="button" onClick={() => toggle(c.label)} title="Toggle publishing for discovery">{c.asserted ? '● Published' : '○ Private'}</span>
                    <Tooltip content={`Remove ${c.label}`}>
                      <button onClick={() => remove(c.label)} aria-label={`remove ${c.label}`} style={{ border: 'none', background: 'none', color: 'var(--color-text-faint)', cursor: 'pointer', fontWeight: 800, fontSize: '1.1rem', lineHeight: 1 }}>×</button>
                    </Tooltip>
                  </div>
                </div>
              ))}
              {claims.length === 0 && <span style={{ color: 'var(--color-text-faint)', fontSize: '.85rem' }}>Nothing in your capability record yet — add what this agent can do.</span>}
            </div>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder="e.g. treasury management, accounting, solidity audits"
                style={{ ...inputSty, flex: 1, minWidth: 200 }}
              />
              <button style={btnSty} onClick={add} disabled={!norm(input)}>Add</button>
            </div>
            <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <button style={btnSty} onClick={savePrivate} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save to your record'}</button>
              <button style={btnPrimarySty} onClick={publishPublic} disabled={!!busy || !publicChanged} title={publicChanged ? '' : 'Everything you publish is up to date'}>
                {busy === 'publish' ? 'Publishing…' : 'Publish for discovery'}
              </button>
            </div>
            <p style={{ fontSize: '.78rem', ...mutedText, marginTop: '.7rem' }}>
              Publishing writes your chosen capabilities on-chain — your agent signs it (<code>msg.sender == agent</code>) with your {toViaForSign(session?.via)} credential, sponsored. One prompt.
            </p>
            {msg && <p style={{ fontSize: '.82rem', color: 'var(--color-sage-700)', marginTop: '.4rem' }}>{msg}</p>}
            {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.4rem' }}>{err}</p>}
          </div>
        )}
    </SectionShell>
  );
}
