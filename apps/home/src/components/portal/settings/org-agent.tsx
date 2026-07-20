'use client';
// Org Manage → Agent — the ORG's discussion-bot config, mirroring the person Manage → Agent tab.
// Two sub-tabs:
//   · "Manage Bot" — the org's own agent replies to @ask / @<org> in EVERY discussion topic
//                    (always on; enabled silently per topic on the Discussions page — spec 327).
//                    Here the steward turns on MEMBER ROUTING once (spec 329 §3.1): the ceremony
//                    signs the narrow org→interactions-session consult wire and flips routing on
//                    across the board. Turning it off clears the wire.
//   · "Playbook"   — the org-level assistant instructions (`apguide:AgentSkillPackage`; on disk a
//                    SKILL.md projection) that shape every reply the bot writes for this org's
//                    discussion topics. Moved here FROM the per-topic Discussions editor so skills
//                    are set once at the org agent, not on the board.
// All ops proxy through /connect/channels to the org's InteractionsDO (steward-gated there).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { issueOrgConsultRoutingDelegation, toWire, type DelegationWire } from '../../../lib/delegation';
import { BusyButton } from '../../shared/BusyButton';
import { Tabs, type TabItem } from '../../shared/ui';
import { SectionShell } from '../SectionShell';
import { mutedText } from '../theme';

const sectionTitleSty: React.CSSProperties = { fontSize: '0.85rem', fontWeight: 700, margin: '0 0 0.35rem' };

interface TopicRow { descriptor: { id: string }; title: string; assistant?: unknown }

export function OrgAgentSection({ orgSa }: { orgSa: string }) {
  const { session, profile: homeProfile } = useSession();
  const communityId = orgSa.toLowerCase();
  const authed = useMemo(
    () => (session ? { 'content-type': 'application/json', authorization: `Bearer ${session.token}` } : undefined),
    [session],
  );

  // ── Manage Bot: member-routing wire status (org-level; spec 329 §3.1) ──
  const [wirePresent, setWirePresent] = useState<boolean | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!authed) return;
    try {
      const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'routingStatus', communityId }) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; wirePresent?: boolean };
      setWirePresent(r.ok && b.ok ? b.wirePresent === true : false);
    } catch { setWirePresent(false); }
  }, [authed, communityId]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Enable member routing across the board: sign the org consult wire once, then flag every topic.
  // Each topic needs its assistant on first (routing is a mode of the 327 assistant), so we enable
  // the assistant where missing — the same defaults the Discussions page applies silently.
  const enableRouting = useCallback(async () => {
    if (!session || !authed) return;
    setRoutingBusy(true); setError(null);
    try {
      const listRes = await fetch(`/connect/channels?communityId=${communityId}`, { headers: authed });
      const list = (await listRes.json().catch(() => ({}))) as { channels?: TopicRow[] };
      const channels = list.channels ?? [];
      if (channels.length === 0) throw new Error('create a discussion topic first, then turn on member routing');

      const st = await (await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'routingStatus', communityId }) })).json().catch(() => ({})) as { ok?: boolean; wirePresent?: boolean; sessionKey?: string | null };
      let delegation: DelegationWire | undefined;
      if (!st.wirePresent) {
        if (!st.sessionKey) throw new Error('routing is unavailable — the interactions-session key is not provisioned on this deployment');
        const via = resolveVia(homeProfile?.credential, session.via);
        const sign = await signHashFor(via, communityId as Address, { token: session.token });
        delegation = toWire(await issueOrgConsultRoutingDelegation(communityId as Address, st.sessionKey as Address, sign));
      }

      let carriedWire = false;
      let firstError: string | null = null;
      for (const c of channels) {
        if (!c.assistant) {
          await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantEnable', communityId, channelId: c.descriptor.id, trigger: 'mention' }) }).catch(() => null);
        }
        const r = await fetch('/connect/channels', {
          method: 'POST', headers: authed,
          body: JSON.stringify({ action: 'routingEnable', communityId, channelId: c.descriptor.id, maxFanout: 3, ...(!carriedWire && delegation ? { delegation } : {}) }),
        });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (r.ok && b.ok) carriedWire = true;
        else if (!firstError) firstError = b.error ?? `routing enable failed (${r.status})`;
      }
      // If the wire never landed (every topic errored before custody), surface why.
      if (delegation && !carriedWire) throw new Error(firstError ?? 'routing could not be enabled on any topic');
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRoutingBusy(false); }
  }, [session, authed, communityId, homeProfile?.credential, loadStatus]);

  const disableRouting = useCallback(async () => {
    if (!authed) return;
    setRoutingBusy(true); setError(null);
    try {
      const listRes = await fetch(`/connect/channels?communityId=${communityId}`, { headers: authed });
      const list = (await listRes.json().catch(() => ({}))) as { channels?: TopicRow[] };
      const channels = list.channels ?? [];
      // Disable per topic; clear the org wire on the last call (clearWire).
      for (let i = 0; i < channels.length; i++) {
        const last = i === channels.length - 1;
        await fetch('/connect/channels', {
          method: 'POST', headers: authed,
          body: JSON.stringify({ action: 'routingDisable', communityId, channelId: channels[i].descriptor.id, ...(last ? { clearWire: true } : {}) }),
        }).catch(() => null);
      }
      // No topics ⇒ nothing to iterate; wire (if any) stays until a topic exists to clear it.
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRoutingBusy(false); }
  }, [authed, communityId, loadStatus]);

  // ── Playbook: the org-level assistant instructions (moved from the Discussions board) ──
  const [skillText, setSkillText] = useState('');
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillSaved, setSkillSaved] = useState(false);
  const [skillLoaded, setSkillLoaded] = useState(false);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantSkillGet', communityId }) });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; skill?: { markdown?: string } | null };
        if (!cancelled && r.ok && b.ok) setSkillText(b.skill?.markdown ?? '');
      } catch { /* editor opens empty */ } finally { if (!cancelled) setSkillLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [authed, communityId]);

  const saveSkill = useCallback(async () => {
    if (!authed) return;
    setSkillBusy(true); setSkillSaved(false); setError(null);
    try {
      const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantSkillPut', communityId, markdown: skillText }) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `save failed (${r.status})`);
      setSkillSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSkillBusy(false); }
  }, [authed, communityId, skillText]);

  if (!session) return <SectionShell title="Agent"><p>Not signed in.</p></SectionShell>;

  const manageBot = (
    <div style={{ display: 'grid', gap: '1rem', paddingTop: '0.9rem' }}>
      <section aria-label="Discussion assistant">
        <h3 style={sectionTitleSty}>Discussion assistant</h3>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-sage-700)' }}>
          ✓ Always on — the organization&rsquo;s own agent replies when someone writes <b>@ask</b> (or
          &nbsp;@&lt;your org&rsquo;s name&gt;) in any discussion topic. There is no per-topic switch; new
          topics get the assistant automatically.
        </p>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          Shape <i>how</i> it replies in the <b>Playbook</b> tab. (Discussion storage must be enabled for
          the organization first — a steward does that once on the Discussions page.)
        </p>
      </section>

      <section aria-label="Member routing">
        <h3 style={sectionTitleSty}>Member routing</h3>
        <p style={{ margin: '0 0 0.55rem', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          Let the assistant consult opted-in members&rsquo; agents when a discussion question matches what
          they know, and quote their answers (with attribution). Turning it on signs a scoped, revocable
          authorization once; it then applies to every topic.
        </p>
        {wirePresent === null ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Checking…</p>
        ) : wirePresent ? (
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--color-sage-700)' }}>✓ Member routing is on for this organization&rsquo;s discussions.</span>
            <BusyButton busy={routingBusy} busyLabel="…" onClick={() => void disableRouting()} className="ghost" style={{ width: 'auto' }}>
              Turn off
            </BusyButton>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.82rem' }}>Member routing is <b>off</b>.</span>
            <BusyButton busy={routingBusy} busyLabel="Signing…" onClick={() => void enableRouting()} className="btn" style={{ width: 'auto' }}>
              Turn on member routing
            </BusyButton>
          </div>
        )}
        <p style={{ margin: '0.55rem 0 0', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
          Members choose whether to be consultable per organization on their own <b>Manage → Agent → Discussions</b> tab.
        </p>
      </section>
    </div>
  );

  const playbook = (
    <div style={{ display: 'grid', gap: '0.5rem', paddingTop: '0.9rem' }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
        Assistant instructions (markdown) — the <b>Playbook</b> for this organization&rsquo;s discussion
        bot. Applies to every topic; the reply contract (one reply per mention) always applies regardless.
        Describe the organization, tone, what the assistant may say, and what to defer to a steward.
      </div>
      <textarea
        value={skillText}
        onChange={(e) => { setSkillText(e.target.value); setSkillSaved(false); }}
        rows={12}
        maxLength={8192}
        disabled={!skillLoaded}
        aria-label="Organization assistant instructions"
        placeholder={'# Assistant playbook\n\nDescribe how the assistant should reply: tone, what it knows about this organization, what to defer to stewards…'}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.85rem', lineHeight: 1.45, padding: '0.5rem 0.65rem', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface, #fff)', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.1rem', alignItems: 'center' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>{skillText.length} / 8192</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
          {skillSaved && <span role="status" style={{ fontSize: '0.78rem', color: 'var(--color-sage-700)' }}>Saved ✓</span>}
          <BusyButton busy={skillBusy} busyLabel="Saving instructions…" onClick={() => void saveSkill()} className="btn" style={{ width: 'auto' }}>
            Save instructions
          </BusyButton>
        </span>
      </div>
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'manage-bot', label: 'Manage Bot', content: manageBot },
    { id: 'playbook', label: 'Playbook', content: playbook },
  ];

  return (
    <SectionShell title="Agent">
      <p style={{ ...mutedText, fontSize: '0.82rem', margin: '0 0 0.75rem' }}>
        The organization&rsquo;s own agent — its discussion auto-reply bot and the playbook that shapes
        every reply. Steward-managed.
      </p>
      {error && <p role="alert" style={{ color: 'var(--color-danger)', margin: '0 0 0.75rem', fontSize: '0.82rem' }}>{error}</p>}
      <Tabs tabs={tabs} aria-label="Organization agent settings" />
    </SectionShell>
  );
}
