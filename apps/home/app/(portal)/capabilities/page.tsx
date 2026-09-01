'use client';
// Capabilities — what this agent can do (ADR-0051). Two tiers, both managed here:
//   • PRIVATE — the full capability record in the agent's vault. Never public.
//   • PUBLIC  — the entries you publish: their IDS go on chain (`atl:capabilities`), and their content
//     projects onto the A2A card as `skills[]` (the wire's name for them) and into ARD `capabilities[]`.
// One structured row per capability, because a bare label cannot carry the description, tags and example
// queries that a card and an ARD document both need. Your Smart Agent address is unchanged; capabilities
// are a facet of it. Works for person / org / service / treasury SAs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { listSkillClaims, saveSkillClaims, setCapabilities, getCapabilities, capabilityIdFor, type CapabilityClaim } from '../../../src/connect-client';
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
/** The ids that go on chain — what discovery matches and what the card advertises. */
const publishedIds = (cs: CapabilityClaim[]) => cs.filter((c) => c.asserted).map((c) => capabilityIdFor(c)).sort();

export default function CapabilitiesPage() {
  const { session, agentAddress, agentName, agentDeployed } = useSession();
  const [claims, setClaims] = useState<CapabilityClaim[]>([]);
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
    const [vault, onChain] = await Promise.all([listSkillClaims(session.token), getCapabilities(agentAddress)]);
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
  const patch = (label: string, next: Partial<CapabilityClaim>) =>
    setClaims(claims.map((c) => (c.label === label ? { ...c, ...next } : c)));

  const publicChanged = useMemo(() => publishedIds(claims).join('||') !== publishedPublic.join('||'), [claims, publishedPublic]);

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
      const ids = publishedIds(claims);
      const signHash = await signHashFor(toViaForSign(session.via), agentAddress, { token: session.token });
      const res = await setCapabilities(agentAddress, agentName, ids, signHash);
      if (res.ok) { setPublishedPublic(ids); setMsg(ids.length ? 'Published — your agent card and discovery now advertise these capabilities.' : 'Cleared what you publish for discovery.'); }
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
                <div key={c.label} data-capability={capabilityIdFor(c)} style={{ padding: '.55rem .7rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-8)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: '.9rem' }}>{c.label}</span>
                      {/* The id is what actually travels: on chain, onto the card, into ARD. Show it, so a
                          steward is never guessing which string a matcher will see. */}
                      <code style={{ fontSize: '.72rem', color: 'var(--color-text-faint)', marginLeft: '.5rem' }}>{capabilityIdFor(c)}</code>
                    </div>
                    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                      <span style={pill(c.asserted)} role="button" aria-label={`toggle publishing ${c.label}`} onClick={() => toggle(c.label)} title="Toggle publishing for discovery">{c.asserted ? '● Published' : '○ Private'}</span>
                      <Tooltip content={`Remove ${c.label}`}>
                        <button onClick={() => remove(c.label)} aria-label={`remove ${c.label}`} style={{ border: 'none', background: 'none', color: 'var(--color-text-faint)', cursor: 'pointer', fontWeight: 800, fontSize: '1.1rem', lineHeight: 1 }}>×</button>
                      </Tooltip>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: '.35rem', marginTop: '.45rem' }}>
                    <input
                      value={c.description ?? ''} aria-label={`description for ${c.label}`}
                      onChange={(e) => patch(c.label, { description: e.target.value })}
                      placeholder="What this capability does — one sentence (shown on your agent card)"
                      style={{ ...inputSty, fontSize: '.82rem' }}
                    />
                    <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
                      <input
                        value={(c.tags ?? []).join(', ')} aria-label={`tags for ${c.label}`}
                        onChange={(e) => patch(c.label, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                        placeholder="tags, comma separated"
                        style={{ ...inputSty, fontSize: '.82rem', flex: 1, minWidth: 140 }}
                      />
                      <input
                        value={(c.examples ?? []).join(' | ')} aria-label={`example queries for ${c.label}`}
                        onChange={(e) => patch(c.label, { examples: e.target.value.split('|').map((t) => t.trim()).filter(Boolean).slice(0, 5) })}
                        placeholder="example questions, separated by |  (up to 5)"
                        style={{ ...inputSty, fontSize: '.82rem', flex: 2, minWidth: 180 }}
                      />
                    </div>
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
              Publishing writes the <strong>ids</strong> of your chosen capabilities on chain — your agent signs it
              (<code>msg.sender == agent</code>) with your {toViaForSign(session?.via)} credential, sponsored. One prompt.
              Their names, descriptions and examples travel with your agent card; the chain records which capabilities you
              claim, not their prose.
            </p>
            {msg && <p style={{ fontSize: '.82rem', color: 'var(--color-sage-700)', marginTop: '.4rem' }}>{msg}</p>}
            {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.4rem' }}>{err}</p>}
          </div>
        )}
    </SectionShell>
  );
}
