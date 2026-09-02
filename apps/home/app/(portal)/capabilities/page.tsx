'use client';
// Capabilities — what this agent can do (ADR-0051). Three tiers, and the screen is honest about all of
// them because each has a different consequence:
//   • PRIVATE   — the full record in the agent's vault. No consent needed, so it AUTOSAVES: a button
//                 implies a decision, and there is none to make here. (There used to be a "Save to your
//                 record" button sitting beside the primary Publish, which is a large part of why this
//                 page read as "I have to publish just to save".)
//   • PUBLISHED — the ids on chain (`atl:capabilities`). World-readable, costs a signature, stays an
//                 explicit and separate act.
//   • ADVERTISED— the agent card, a separately SIGNED document. Publishing can add ids to its DRAFT;
//                 nothing on the public card changes until someone releases it. That is the point of
//                 signing a card, and no amount of UI convenience may paper over it.
// One structured row per capability, because a bare label cannot carry the description, tags and example
// queries that a card and an ARD document both need.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { listSkillClaims, saveSkillClaims, setCapabilities, getCapabilities, capabilityIdFor, type CapabilityClaim } from '../../../src/connect-client';
import { getCapabilityDefinition } from '@agenticprimitives/capability-claims';
import { lookupIndependentEndorsers } from '../../../src/lib/agent-search';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { storedStudioSelfGrant } from '../../../src/lib/studio-self-grant';
import { studioScopesFor } from '../../../src/lib/studio-view';
import { cardsFor, soleCardTarget, mayPatchDraft, addPublishedToCardDraft, type CardTarget } from '../../../src/lib/publish-to-card';
import type { DelegationWire } from '../../../src/lib/delegation';
import { mutedText, errorText, infoBannerSty } from '../../../src/components/portal/theme';
import { AgentCapabilitiesEditor } from '../../../src/components/portal/capabilities/AgentCapabilitiesEditor';

const toViaForSign = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};
/** The ids that go on chain — what discovery matches and what a card may then advertise. */
const publishedIds = (cs: CapabilityClaim[]) => cs.filter((c) => c.asserted).map((c) => capabilityIdFor(c)).sort();

export default function CapabilitiesPage() {
  const { session, agentAddress, agentName } = useSession();
  const [claims, setClaims] = useState<CapabilityClaim[]>([]);
  const [publishedPublic, setPublishedPublic] = useState<string[]>([]); // currently on-chain asserted set
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'publish' | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [cardMsg, setCardMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [endorsers, setEndorsers] = useState<number | null>(null);

  // The card this publish can also update, when there is exactly one and this person may edit it.
  const [grant, setGrant] = useState<DelegationWire | null>(null);
  const [cardTarget, setCardTarget] = useState<CardTarget | null>(null);
  const [alsoCard, setAlsoCard] = useState(true);
  const statusRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!agentAddress || !session?.token) { setLoading(false); return; }
    setLoading(true);
    const [vault, onChain] = await Promise.all([listSkillClaims(session.token), getCapabilities(agentAddress)]);
    setClaims(vault); setPublishedPublic(onChain.slice().sort()); setLoading(false);
  }, [agentAddress, session?.token]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    if (!agentAddress) { setEndorsers(null); return; }
    void lookupIndependentEndorsers(agentAddress).then((n) => { if (live) setEndorsers(n); });
    return () => { live = false; };
  }, [agentAddress]);

  // Resolve the card option WITHOUT minting anything. A Studio grant costs a device prompt on a passkey
  // home, and popping one just to render a checkbox would be a prompt for nothing. A person who has used
  // the Studio already has the grant cached; anyone else still gets the option, named generically, and
  // the grant is minted at publish time from the signature they are giving anyway.
  useEffect(() => {
    let live = true;
    if (!session?.token) return;
    void (async () => {
      const g = await storedStudioSelfGrant(session.token).catch(() => null);
      if (!live || !g) return;
      setGrant(g);
      if (!mayPatchDraft(studioScopesFor({ principalKind: 'human', relationship: 'self' }))) return;
      const cards = await cardsFor(g).catch(() => []);
      if (live) setCardTarget(soleCardTarget(cards));
    })();
    return () => { live = false; };
  }, [session?.token]);

  // ── AUTOSAVE the private record ────────────────────────────────────────────────────────────────
  // Debounced, cancelled on unmount, and never blocking. The vault write carries no consent, so the
  // only thing a person needs from it is to know it happened.
  const firstRender = useRef(true);
  useEffect(() => {
    if (loading || !session?.token) return;
    if (firstRender.current) { firstRender.current = false; return; }
    setSaveState('saving');
    const t = setTimeout(() => {
      void saveSkillClaims(session.token, claims).then((r) => setSaveState(r.ok ? 'saved' : 'error'));
    }, 700);
    return () => clearTimeout(t);
  }, [claims, loading, session?.token]);

  const changed = useMemo(() => publishedIds(claims).join('||') !== publishedPublic.join('||'), [claims, publishedPublic]);

  /** ONE action. Publishing signs and writes the ids on chain; the card draft, if chosen, is a second,
   *  independent, unsigned write reported on its own line — never merged into the publish's outcome. */
  const publish = async () => {
    if (!agentAddress || !agentName || !session?.token) return;
    setBusy('publish'); setErr(null); setMsg(null); setCardMsg(null);
    try {
      await saveSkillClaims(session.token, claims); // flush any in-flight debounce before signing
      const ids = publishedIds(claims);
      const signHash = await signHashFor(toViaForSign(session.via), agentAddress, { token: session.token });
      const res = await setCapabilities(agentAddress, agentName, ids, signHash);
      if (!res.ok) { setErr(res.error); return; }
      setPublishedPublic(ids);
      setMsg(ids.length
        ? 'Published on chain — discovery can match on these now.'
        : 'Cleared what you publish for discovery. Any agent card release already signed keeps advertising these as they were — start a new draft in Card Studio to remove them there too.');

      if (!ids.length || !alsoCard || !cardTarget || !grant) return;
      const added = await addPublishedToCardDraft(grant, cardTarget, ids, (id) => {
        const local = claims.find((c) => capabilityIdFor(c) === id);
        const def = getCapabilityDefinition(id);
        const description = (local?.description ?? def?.description ?? '').trim();
        return description
          ? { name: def?.title ?? local?.label ?? id, description, ...(local?.examples?.length ? { examples: local.examples } : {}) }
          : null;
      });
      setCardMsg(added.ok
        ? added.added.length
          ? { tone: 'ok', text: `Added to ${added.displayName}'s draft. Release and sign it in Card Studio to advertise them publicly.` }
          : { tone: 'ok', text: `${added.displayName}'s draft already carried these.` }
        : { tone: 'warn', text: `Published on chain, but the card draft was not updated: ${added.reason}. Add them in Card Studio.` });
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally {
      setBusy(null);
      // Move focus to the outcome: someone who pressed Publish and looked away must not miss that a
      // release still stands between them and a public card.
      queueMicrotask(() => statusRef.current?.focus());
    }
  };

  const savedLabel = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Couldn’t save — your last change is not stored' : '';

  return (
    <SectionShell
      title="What this agent can do"
      description="Pick from the shared catalog of capability definitions. Changes save automatically. Publishing is a separate, signed step that makes an id world-readable on chain."
    >
      <div style={{ ...infoBannerSty, marginBottom: '1.1rem', fontSize: '.82rem' }}>
        Capabilities come from a <strong>shared catalog</strong>, so every agent claiming one claims the same id — that is what
        lets anyone match on it. Your record stays <strong>private</strong> in your agent&rsquo;s vault; mark an entry
        <strong> Published</strong> and only its <em>id</em> goes public, <strong>on chain</strong>. Your agent card is a
        separate, signed document — publishing can add ids to its draft, but nothing on the card changes until you release it.
        Descriptions and example questions are never written on chain: they save to your record, and travel to a card when you add
        the capability to its draft.
      </div>

      {agentAddress && endorsers !== null && endorsers > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem', marginBottom: '1.1rem', fontSize: '.82rem', color: 'var(--color-sage-700)' }}>
          <span aria-hidden style={{ fontSize: '.9rem', lineHeight: 1 }}>✓</span>
          <span>
            <strong>Endorsed by {endorsers} independent {endorsers === 1 ? 'agent' : 'agents'}</strong> — other agents have
            corroborated what this agent can do. Corroboration only; it grants no authority.
          </span>
        </div>
      )}

      {!agentAddress ? <p style={mutedText}>Sign in to manage what your agent can do.</p>
        : loading ? <p style={mutedText}>Loading your capability record…</p>
        : (
          <>
            {/* STICKY. Autosave feedback has to be visible where the editing happens: this sat above the
                list, so anyone editing a row further down watched their change disappear into nothing and
                went looking for a Save button. An acknowledgement nobody can see is not an
                acknowledgement. */}
            <div
              role="status"
              aria-live="polite"
              style={{
                ...mutedText, fontSize: '.78rem', minHeight: '1.1em', marginBottom: '.4rem',
                position: 'sticky', top: 0, zIndex: 2, padding: '.25rem 0',
                background: 'var(--color-surface, #fff)',
                ...(saveState === 'error' ? errorText : {}),
              }}
            >
              {savedLabel}
            </div>
            <AgentCapabilitiesEditor
              claims={claims}
              onChange={setClaims}
              published={publishedPublic}
              busy={busy}
              onPublish={publish}
              changed={changed}
              {...(cardTarget && changed ? { cardOption: { label: cardTarget.displayName, checked: alsoCard, onChange: setAlsoCard } } : {})}
              {...(agentName ? {} : { disabledReason: 'Publishing needs a public name — give this agent one under Identity → Naming. Your record is private and works without one.' })}
            />
          </>
        )}

      <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite" style={{ marginTop: '.7rem' }}>
        {msg && <p style={{ ...mutedText, fontSize: '.82rem', margin: 0 }}>{msg}</p>}
        {cardMsg && <p style={{ ...(cardMsg.tone === 'warn' ? errorText : mutedText), fontSize: '.82rem', margin: '.3rem 0 0' }}>{cardMsg.text}</p>}
        {err && <p style={{ ...errorText, fontSize: '.82rem', margin: '.3rem 0 0' }} role="alert">{err}</p>}
      </div>
    </SectionShell>
  );
}
