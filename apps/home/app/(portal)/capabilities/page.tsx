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
import { AgentCapabilitiesEditor } from '../../../src/components/portal/capabilities/AgentCapabilitiesEditor';

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
          <AgentCapabilitiesEditor
            claims={claims}
            onChange={setClaims}
            published={publishedPublic}
            busy={busy}
            onSaveRecord={savePrivate}
            onPublish={publishPublic}
          />
        )}
    </SectionShell>
  );
}
