'use client';
// Service-workspace Manage pages (ADR-0046). Same stewardship read as org Records/Access —
// the workspace (or treasury) owns the vault; you oversee it via workspace → you.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { SectionShell } from './SectionShell';
import { DelegationCard, VaultReader } from './OrgDetail';
import { BusyButton } from '../shared/BusyButton';
import { BehaviourPlaybook } from './BehaviourPlaybook';
import { agentClassOf } from '../../lib/agent-class';
import type { DelegationWire } from '../../lib/delegation';

const lc = (s: string) => s.toLowerCase();

function useServiceAgent(agent: string) {
  const { session } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');
  const svc = agents.find((a) => agentClassOf(a.kind) === 'service' && lc(a.agent) === lc(agent));
  return { session, loaded, svc };
}

export function ServiceRecordsSection({ agent }: { agent: string }) {
  const { session, loaded, svc } = useServiceAgent(agent);
  if (!session) return <SectionShell title="Records"><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title="Records"><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!svc) {
    return (
      <SectionShell title="Records">
        <p className="manage-card-blurb">You don&apos;t manage a service agent at this address.</p>
      </SectionShell>
    );
  }
  const d = svc.stewardshipDelegation as DelegationWire | undefined;
  return (
    <SectionShell title="Records">
      {d ? (
        <VaultReader
          title={svc.kind === 'workspace' ? 'Workspace records' : 'Service records'}
          hint="Every record in this agent’s vault, read with your stewardship delegation (service → you). The agent owns the data; you oversee it."
          delegation={d}
        />
      ) : (
        <p className="manage-card-blurb">
          No stewardship delegation on this agent — Home cannot list its vault from here.
          {svc.kind === 'workspace'
            ? ' The roster still lives at gather27:organizations; gather27-a2a reads it over the service-agent-wire, not this portal.'
            : ''}
        </p>
      )}
    </SectionShell>
  );
}

export function ServiceAccessSection({ agent }: { agent: string }) {
  const { session, loaded, svc } = useServiceAgent(agent);
  if (!session) return <SectionShell title="Access"><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title="Access"><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!svc) {
    return (
      <SectionShell title="Access">
        <p className="manage-card-blurb">You don&apos;t manage a service agent at this address.</p>
      </SectionShell>
    );
  }
  const d = svc.stewardshipDelegation as DelegationWire | undefined;
  return (
    <SectionShell title="Access">
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        The scoped, revocable delegations between you and this service agent — the authority behind Records.
      </p>
      {d ? (
        <div className="manage-grid">
          <DelegationCard kind="Stewardship" d={d} />
        </div>
      ) : (
        <p className="manage-card-blurb">
          No stewardship recorded on this Home link.
          {svc.kind === 'workspace'
            ? ' The service-agent-wire (workspace → gather27-a2a) is held by the Worker, not this portal — authorize it from Gather ops.'
            : ''}
        </p>
      )}
    </SectionShell>
  );
}

/**
 * The agent's PLAYBOOK — the SKILL.md projection its own discussion turn runs under (spec 327 §4b).
 * For a workspace agent this is what answers Field's Ask: field-a2a only seeds a default when
 * the agent has none; what a custodian or steward writes here is the agent's voice from then on.
 * Same steward-gated pass-through the organization page uses (`/connect/channels` →
 * `channels.assistantSkill.get/put` → the agent's InteractionsDO); the DO verifies the wire.
 */
export function ServicePlaybookSection({ agent }: { agent: string }) {
  const { session, loaded, svc } = useServiceAgent(agent);
  const communityId = lc(agent);
  const authed = useMemo(
    () => (session ? { 'content-type': 'application/json', authorization: `Bearer ${session.token}` } : undefined),
    [session],
  );
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantSkillGet', communityId }) });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; skill?: { markdown?: string } | null };
        if (cancelled) return;
        if (r.ok && b.ok) setText(b.skill?.markdown ?? '');
        else setError(b.error ?? `could not read the playbook (${r.status})`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, communityId]);
  const save = useCallback(async () => {
    if (!authed) return;
    setBusy(true); setSaved(false); setError(null);
    try {
      const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantSkillPut', communityId, markdown: text }) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `save failed (${r.status})`);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [authed, communityId, text]);

  if (!session) return <SectionShell title="Playbook"><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title="Playbook"><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!svc) {
    return (
      <SectionShell title="Playbook">
        <p className="manage-card-blurb">You don&apos;t manage a service agent at this address.</p>
      </SectionShell>
    );
  }
  const what = svc.kind === 'workspace' ? 'workspace agent' : svc.kind === 'team' ? 'team' : 'service';
  return (
    <SectionShell title="Playbook">
      <BehaviourPlaybook agent={svc.agent} kind={svc.kind} name={svc.name || undefined} />
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        The instructions this {what} agent answers under — markdown, the agent’s SKILL.md. It shapes
        every reply the agent writes in its own discussion topics
        {svc.kind === 'workspace' ? ', including Field’s Ask' : ''}. Saving is a steward’s act: the
        agent verifies your stewardship before it accepts the text. An app may seed a default when none is
        set; it never overwrites what you write here.
      </p>
      {error && <p role="alert" className="manage-card-blurb" style={{ color: 'var(--color-danger, #b3261e)' }}>{error}</p>}
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        rows={16}
        maxLength={8192}
        disabled={!ready}
        aria-label={`${svc.name || what} playbook`}
        placeholder={'# Playbook\n\nDescribe who this agent is, what it knows, how it answers, and what it defers to a steward…'}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.85rem', lineHeight: 1.45, padding: '0.5rem 0.65rem', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface, #fff)', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', alignItems: 'center' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>{text.length} / 8192</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
          {saved && <span role="status" style={{ fontSize: '0.78rem', color: 'var(--color-sage-700)' }}>Saved ✓</span>}
          <BusyButton busy={busy} busyLabel="Saving playbook…" onClick={() => void save()} className="btn" style={{ width: 'auto' }}>
            Save playbook
          </BusyButton>
        </span>
      </div>
    </SectionShell>
  );
}
