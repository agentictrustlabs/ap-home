'use client';
// Manage → Agent — the person-assistant config surface (spec 328 UX v2). Relocated from the
// Messages ⚙ "Messaging settings" dialog (0c07dde6): a horizontal sub-tab row —
//   · "Message bot"  — the auto-reply assistant on/off, plus the messaging/delivery status it
//                      depends on (vault-stored bodies must be enabled before the bot can reply).
//   · "Discussions"  — spec 329 §7: per-org "Discussion participation" — the consultability
//                      opt-in. The toggle RUNS THE CEREMONY: signs the member→org consult
//                      delegation (the authority, 180 days, discussion.consult only) and
//                      republishes the member's directory listing with the `consultable` hint.
//                      Revoke = immediate (org-side eligibility drop + best-effort on-chain revoke).
//                      Also spec 329 §12: a per-org ROLE input ("tax advisor") — self-asserted and
//                      member-signed (saving re-signs the listing with `orgRole`), which is what
//                      the org assistant routes role-addressed questions on.
// The person's PLAYBOOK is not here any more: it is the compiled archetype on `/playbook`
// (`BehaviourPlaybook`, spec 354 K3). The free-text "assistant instructions" markdown this tab used to
// edit was a second behaviour source the digest never covered; the auto-reply and consult turns now
// read the archetype's instructions instead.
// Reuses /connect/inbox-assistant + /connect/consultability + the spec-323 delivery activation.
// MessagesView shares useMessagingDelivery for its in-context nudge banner.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, resolveVia, signHashFor, type Via } from '../../../home/onboarding';
import { DELIVERY_SERVICE_SA } from '../../../lib/inbox-delivery';
import { issueConsultabilityDelegation, toWire, type DelegationWire } from '../../../lib/delegation';
import { issueDirectoryListing } from '../../../home/directory';
import { revokeGrantedDelegation } from '../../../connect-client';
import { shortId } from '../../../home/use-inbox';
import { BusyButton } from '../../shared/BusyButton';
import { Tabs, type TabItem } from '../../shared/ui';
import { mutedText } from '../theme';

/**
 * Messaging/delivery status for an inbox owner (spec 323 W3.2 — the InteractionsDO is the
 * delivery-wire residency; read its open status) + the enable ceremony. Shared by the Agent tab
 * (status section the message bot depends on) and MessagesView (in-context nudge banner).
 */
export function useMessagingDelivery(targetAgent?: Address): {
  /** null = still checking (or not applicable); true/false = delivery grant present. */
  enabled: boolean | null;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
} {
  const { session, agentAddress } = useSession();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !agentAddress || targetAgent || !DELIVERY_SERVICE_SA) return;
    let cancelled = false;
    void fetch(`/a2a/interactions/${agentAddress.toLowerCase()}/status`)
      .then((r) => r.json())
      .then((d: { deliveryGranted?: boolean }) => { if (!cancelled) setEnabled(d.deliveryGranted === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session, agentAddress, targetAgent]);

  const enable = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true); setError(null);
    try {
      // Normalize via (session stores 'Google'/'YouVersion' display form; isKmsVia matches lowercase) so a
      // SOCIAL home signs gesture-free via KMS instead of falling to a passkey prompt. FORCE-reissue BOTH
      // planes: the send path needs the interactions grant (inbox writes) AND the delivery grant (dm bodies),
      // and /status reports only presence — so a grant minted before the dm-body write scope stays stale and
      // causes record_scope_denied until forcibly refreshed. Target = the inbox owner (this person, or the
      // org when a targetAgent is set).
      const owner = (targetAgent ?? agentAddress) as Address;
      const via = (String(session.via ?? '').toLowerCase() || 'passkey') as Via;
      // Token always passed: a KMS home signs with it, and so does a DEMO account (its custodian
      // key lives at the Home) — which is what keeps 'Enable vault storage' from opening a wallet
      // prompt no demo user can satisfy. Wallet/passkey homes ignore it.
      const auth = { token: session.token };
      const a = await activateInteractionsIfNeeded(owner, via, auth, true);
      const b = await activateInboxDeliveryIfNeeded(owner, via, auth, true);
      if (a.ok && b.ok) setEnabled(true);
      else setError(!a.ok ? a.error : !b.ok ? b.error : 'could not enable messaging');
    } finally { setBusy(false); }
  }, [session, agentAddress, targetAgent]);

  return { enabled, busy, error, enable };
}

const sectionTitleSty: React.CSSProperties = { fontSize: '0.85rem', fontWeight: 700, margin: '0 0 0.35rem' };

/** spec 329 §2.3 — the consent copy the opt-in MUST state (verbatim; topic-context disclosure). */
const CONSULT_CONSENT_COPY =
  "Questions from this organization's discussions — including surrounding discussion context — " +
  "will be sent to your agent. Your agent's reply may be quoted, with your name, in the discussion.";

/** One org row of the member's consultability state (/connect/consultability GET). */
interface ConsultOrgRow {
  orgAgent: string;
  orgName: string;
  relationship: string;
  consultable: boolean;
  consultGrantedAt: string | null;
  consultDelegation: DelegationWire | null;
  /** spec 329 §12 — the member's PRIMARY ROLE in this org, as last published in their signed
   *  listing (the projection copy; the listing is the authority). */
  orgRole: string | null;
}

/** Which stored tab id each left item renders. The ids are legacy state keys; the LABELS moved to the
 *  nav (`Ask` / `Discussion replies`) and the ids stay put. */
const ONLY_TAB = { ask: 'message-bot', discussion: 'discussions' } as const;

/** spec 348 §2.3 — the two panels are two unrelated configurations, and each is now its own left
 *  item rather than a sub-tab. `only` renders one of them with no tab strip; omitting it keeps the
 *  original tabbed page, which nothing routes to any more but which is still the whole thing in one
 *  place if a surface ever wants it. */
export function AgentTab({ only }: { only?: 'ask' | 'discussion' } = {}) {
  const { session, agentAddress, agentName, profile: homeProfile } = useSession();
  const delivery = useMessagingDelivery();

  // spec 328 §6 — the owner's auto-reply assistant (person inbox only; never managed inboxes).
  const [assistant, setAssistant] = useState<{ enabled: boolean; displayName?: string } | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // spec 334 §6 — the person's auto-work switch (the agent does the work on the person's endeavors).
  const [autoWork, setAutoWork] = useState<boolean | null>(null);
  const [autoWorkBusy, setAutoWorkBusy] = useState(false);

  // spec 329 §7 — per-org discussion-participation (consultability) state.
  const [consultOrgs, setConsultOrgs] = useState<ConsultOrgRow[] | null>(null);
  const [consultBusyOrg, setConsultBusyOrg] = useState<string | null>(null);
  const [consultError, setConsultError] = useState<string | null>(null);
  // spec 329 §12 — per-org role drafts (uncommitted input text) + the row currently re-signing.
  const [roleDraft, setRoleDraft] = useState<Record<string, string>>({});
  const [roleBusyOrg, setRoleBusyOrg] = useState<string | null>(null);
  const [roleSavedOrg, setRoleSavedOrg] = useState<string | null>(null);

  const authedHeaders = useMemo(
    () => (session ? { 'content-type': 'application/json', authorization: `Bearer ${session.token}` } : undefined),
    [session],
  );

  useEffect(() => {
    if (!authedHeaders) return;
    let cancelled = false;
    void fetch('/connect/inbox-assistant', { headers: authedHeaders })
      .then((r) => r.json())
      .then((d: { ok?: boolean; assistant?: { enabled?: boolean; displayName?: string } | null }) => {
        if (cancelled || !d.ok) return;
        setAssistant({ enabled: d.assistant?.enabled === true, displayName: d.assistant?.displayName });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authedHeaders]);

  useEffect(() => {
    if (!authedHeaders) return;
    let cancelled = false;
    void fetch('/connect/inbox-assistant', { method: 'POST', headers: authedHeaders, body: JSON.stringify({ action: 'autoWorkStatus' }) })
      .then((r) => r.json())
      .then((d: { ok?: boolean; enabled?: boolean }) => { if (!cancelled && d.ok) setAutoWork(d.enabled === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authedHeaders]);

  const toggleAutoWork = useCallback(async () => {
    if (!authedHeaders) return;
    const on = autoWork === true;
    setAutoWorkBusy(true); setError(null);
    try {
      const res = await fetch('/connect/inbox-assistant', {
        method: 'POST', headers: authedHeaders,
        body: JSON.stringify({ action: on ? 'autoWorkDisable' : 'autoWorkEnable' }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; enabled?: boolean };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `auto-work ${on ? 'disable' : 'enable'} failed (${res.status})`);
      setAutoWork(b.enabled === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setAutoWorkBusy(false); }
  }, [autoWork, authedHeaders]);

  const toggleAssistant = useCallback(async () => {
    if (!authedHeaders) return;
    const enabled = assistant?.enabled === true;
    setAssistantBusy(true); setError(null);
    try {
      const res = await fetch('/connect/inbox-assistant', {
        method: 'POST', headers: authedHeaders,
        body: JSON.stringify({ action: enabled ? 'disable' : 'enable' }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; assistant?: { displayName?: string } };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `assistant ${enabled ? 'disable' : 'enable'} failed (${res.status})`);
      setAssistant({ enabled: !enabled, displayName: b.assistant?.displayName ?? assistant?.displayName });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setAssistantBusy(false); }
  }, [assistant, authedHeaders]);

  const loadConsultOrgs = useCallback(async () => {
    if (!authedHeaders) return;
    try {
      const r = await fetch('/connect/consultability', { headers: authedHeaders });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; orgs?: ConsultOrgRow[] };
      if (r.ok && b.ok) {
        const orgs = b.orgs ?? [];
        setConsultOrgs(orgs);
        // Seed the role inputs from the published values (loads follow every committed action).
        setRoleDraft(Object.fromEntries(orgs.map((o) => [o.orgAgent.toLowerCase(), o.orgRole ?? ''])));
      }
    } catch { /* row list stays in the checking state */ }
  }, [authedHeaders]);

  useEffect(() => { void loadConsultOrgs(); }, [loadConsultOrgs]);

  // spec 329 §2.1/§2.2 — the opt-in ceremony. AUTHORITY FIRST (the member-signed consult
  // delegation, custodied at the org's execution point), THEN the listing HINT (republish with
  // `consultable`). A failed hint publish leaves a delegation the router never surfaces — safe;
  // a failed grant leaves nothing. Revoke: org-side eligibility drop (immediate) + best-effort
  // ON-CHAIN revocation with the returned wire + hint clear.
  const toggleConsult = useCallback(async (row: ConsultOrgRow) => {
    if (!session || !agentAddress || !authedHeaders) return;
    const org = row.orgAgent.toLowerCase();
    setConsultBusyOrg(org); setConsultError(null);
    try {
      const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress as Address, { token: session.token });
      const displayName = agentName ?? `member-${agentAddress.slice(2, 8)}`;
      if (!row.consultable) {
        const d = await issueConsultabilityDelegation(agentAddress as Address, org as Address, sign);
        const res = await fetch('/connect/consultability', {
          method: 'POST', headers: authedHeaders,
          body: JSON.stringify({ action: 'grant', org, delegation: toWire(d) }),
        });
        const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !b.ok) throw new Error(b.error ?? `consult opt-in failed (${res.status})`);
        // The routing hint: republish the listing with the consultable flag (re-signed).
        // Re-publishing REPLACES the listing, so every facet the member still asserts must ride
        // along — the role included (spec 329 §12), or toggling consultability would silently
        // clear it.
        const listing = await issueDirectoryListing(agentAddress as Address, sign, {
          communityId: org, displayName, consultable: true, ...(row.orgRole ? { orgRole: row.orgRole } : {}),
        });
        const pub = await fetch('/connect/directory', { method: 'POST', headers: authedHeaders, body: JSON.stringify({ action: 'publish', listing }) });
        const pb = (await pub.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!pub.ok || !pb.ok) {
          // Delegation stored, hint missing ⇒ routing won't surface you yet (fail-closed, honest).
          setConsultError(pb.error ? `Opted in, but the listing flag did not publish: ${pb.error}` : 'Opted in, but the listing flag did not publish — try toggling again.');
        }
      } else {
        const res = await fetch('/connect/consultability', {
          method: 'POST', headers: authedHeaders,
          body: JSON.stringify({ action: 'revoke', org }),
        });
        const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; consultDelegation?: DelegationWire | null };
        if (!res.ok || !b.ok) throw new Error(b.error ?? `consult revoke failed (${res.status})`);
        // Best-effort ON-CHAIN revocation (the authority kill at your own gate) + hint clear.
        if (b.consultDelegation) {
          const rr = await revokeGrantedDelegation(b.consultDelegation, sign).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
          if (!rr.ok) setConsultError(`Opt-out recorded; on-chain revocation did not land: ${rr.error}`);
        }
        const listing = await issueDirectoryListing(agentAddress as Address, sign, {
          communityId: org, displayName, ...(row.orgRole ? { orgRole: row.orgRole } : {}),
        });
        await fetch('/connect/directory', { method: 'POST', headers: authedHeaders, body: JSON.stringify({ action: 'publish', listing }) }).catch(() => null);
      }
      await loadConsultOrgs();
    } catch (e) {
      setConsultError(e instanceof Error ? e.message : String(e));
    } finally { setConsultBusyOrg(null); }
  }, [session, agentAddress, agentName, authedHeaders, homeProfile?.credential, loadConsultOrgs]);

  // spec 329 §12 — set/clear the member's PRIMARY ROLE in one org. Same flow as the consultability
  // hint republish: the listing is member-signed, so the role is set by RE-SIGNING the listing
  // (the org's routing reads it from there). The KV projection is written after, for prefill only
  // — a failed projection write is cosmetic; a failed publish is the real failure and is surfaced.
  const saveRole = useCallback(async (row: ConsultOrgRow) => {
    if (!session || !agentAddress || !authedHeaders) return;
    const org = row.orgAgent.toLowerCase();
    const role = (roleDraft[org] ?? '').trim().slice(0, 80);
    if (role === (row.orgRole ?? '')) return; // nothing to re-sign
    setRoleBusyOrg(org); setConsultError(null); setRoleSavedOrg(null);
    try {
      const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress as Address, { token: session.token });
      const displayName = agentName ?? `member-${agentAddress.slice(2, 8)}`;
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: org, displayName,
        ...(row.consultable ? { consultable: true } : {}),
        ...(role ? { orgRole: role } : {}),
      });
      const pub = await fetch('/connect/directory', { method: 'POST', headers: authedHeaders, body: JSON.stringify({ action: 'publish', listing }) });
      const pb = (await pub.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!pub.ok || !pb.ok) throw new Error(pb.error ?? `publishing your role failed (${pub.status})`);
      await fetch('/connect/consultability', {
        method: 'POST', headers: authedHeaders,
        body: JSON.stringify({ action: 'setRole', org, orgRole: role }),
      }).catch(() => null);
      setRoleSavedOrg(org);
      await loadConsultOrgs();
    } catch (e) {
      setConsultError(e instanceof Error ? e.message : String(e));
    } finally { setRoleBusyOrg(null); }
  }, [session, agentAddress, agentName, authedHeaders, homeProfile?.credential, roleDraft, loadConsultOrgs]);

  if (!session) return <p style={mutedText}>Sign in to configure your agent.</p>;

  const messageBot = (
    <div style={{ display: 'grid', gap: '1rem', paddingTop: '0.9rem' }}>
      <section aria-label="Messaging status">
        <h3 style={sectionTitleSty}>Messaging status</h3>
        {delivery.enabled === null ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Checking message storage…</p>
        ) : delivery.enabled ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-sage-700)' }}>
            ✓ Messaging enabled — message contents are stored encrypted in your personal vault.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.82rem' }}>
              <b>Secure your message storage.</b> Store message contents encrypted in your personal vault — the
              message bot needs this before it can read or answer anything.
            </span>
            <BusyButton busy={delivery.busy} busyLabel="Signing…" onClick={() => void delivery.enable()} className="btn">
              Enable vault storage
            </BusyButton>
          </div>
        )}
        {delivery.error && <p role="alert" style={{ margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--color-danger)' }}>{delivery.error}</p>}
      </section>

      <section aria-label="Auto-reply assistant">
        <h3 style={sectionTitleSty}>Auto-reply assistant</h3>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <BusyButton
            busy={assistantBusy}
            busyLabel="…"
            onClick={() => void toggleAssistant()}
            className="ghost"
            disabled={assistant === null}
            aria-label={assistant?.enabled ? 'Auto-reply assistant on — disable' : 'Enable auto-reply assistant'}
            aria-pressed={assistant?.enabled === true}
            style={assistant?.enabled ? undefined : { opacity: 0.45 }}
            title={assistant?.enabled
              ? `Auto-reply assistant on${assistant.displayName ? ` (replies as ${assistant.displayName})` : ''} — click to disable`
              : 'Let your own agent auto-reply to new 1:1 messages while you are away'}
          >
            🤖
          </BusyButton>
          <span style={{ fontSize: '0.82rem' }}>
            {assistant === null
              ? 'Checking…'
              : assistant.enabled
                ? <>On{assistant.displayName ? <> — replies as <b>{assistant.displayName}</b></> : null}</>
                : 'Off'}
          </span>
        </div>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          Your agent answers messages sent to you (including <b>@ask</b>). Shape <i>how</i> it replies in the Playbook tab.
        </p>
      </section>

      <section aria-label="Do the work">
        <h3 style={sectionTitleSty}>Do the work</h3>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <BusyButton
            busy={autoWorkBusy}
            busyLabel="…"
            onClick={() => void toggleAutoWork()}
            className="ghost"
            disabled={autoWork === null}
            aria-label={autoWork ? 'Auto-work on — disable' : 'Enable auto-work'}
            aria-pressed={autoWork === true}
            style={autoWork ? undefined : { opacity: 0.45 }}
            title={autoWork
              ? 'Your agent executes plan steps it can do itself and advances your endeavors — click to disable'
              : 'Let your agent do the work: draft a plan, execute the steps it can, and advance your endeavors'}
          >
            🛠
          </BusyButton>
          <span style={{ fontSize: '0.82rem' }}>{autoWork === null ? 'Checking…' : autoWork ? 'On' : 'Off'}</span>
        </div>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          When a request becomes an endeavor, your agent drafts a plan, does the steps it can on its
          own, records what it did, and moves to the next step — instead of waiting for you. Steps that
          need someone else&rsquo;s authority stay open for a human. Shape the work in the Playbook tab.
        </p>
      </section>

      <section aria-label="Incoming intents">
        <h3 style={sectionTitleSty}>Incoming intents</h3>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-sage-700)' }}>
          ✓ Always on — your agent already processes incoming intents (goals other agents send you) and
          routes them to the right capability.
        </p>
      </section>
    </div>
  );

  // spec 329 §7 — the per-org "Discussion participation" section. Icon-only toggle conventions
  // (aria-pressed, dim when off) match the 🤖 assistant toggle above; revoke is immediate.
  const discussionsPanel = (
    <div style={{ display: 'grid', gap: '1rem', paddingTop: '0.9rem' }}>
      <section aria-label="Discussion participation">
        <h3 style={sectionTitleSty}>Discussion participation</h3>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          Let an organization&rsquo;s assistant consult <i>your</i> agent when a discussion question
          matches what you know. Per organization, revocable any time. {CONSULT_CONSENT_COPY}
        </p>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
          You can also state <b>your role in each organization</b> — you may be the tax advisor in
          one and the financial advisor in another. The organization&rsquo;s assistant routes
          role-addressed questions (&ldquo;@ask tax advisor …&rdquo;) to the member holding that
          role. Only you can set your own role; saving re-signs your listing.
        </p>
        {consultOrgs === null ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Checking your organizations…</p>
        ) : consultOrgs.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            You don&rsquo;t belong to any organizations yet — join one and its row appears here.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.4rem' }}>
            {consultOrgs.map((row) => (
              <li key={row.orgAgent} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.4rem 0.65rem' }}>
                <BusyButton
                  busy={consultBusyOrg === row.orgAgent.toLowerCase()}
                  busyLabel="…"
                  onClick={() => void toggleConsult(row)}
                  className="ghost"
                  disabled={consultBusyOrg !== null}
                  aria-label={row.consultable
                    ? `Consultable for ${row.orgName} — click to revoke`
                    : `Let ${row.orgName}'s assistant consult your agent`}
                  aria-pressed={row.consultable}
                  style={row.consultable ? undefined : { opacity: 0.45 }}
                  title={row.consultable
                    ? `Your agent may be consulted for ${row.orgName}'s discussions — click to revoke (immediate)`
                    : `Opt in: sign a scoped, revocable grant so ${row.orgName}'s assistant may ask your agent discussion questions`}
                >
                  🗣
                </BusyButton>
                <span style={{ fontSize: '0.82rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <b>{row.orgName}</b>
                  {' — '}
                  {row.consultable
                    ? <>consultable{row.consultGrantedAt ? ` since ${new Date(row.consultGrantedAt).toLocaleDateString()}` : ''}</>
                    : 'not consultable'}
                  {row.orgRole ? <> · <b>{row.orgRole}</b></> : null}
                </span>
                {/* spec 329 §12 — the member's own primary role IN THIS ORG. Saving re-signs and
                    republishes the listing (the same ceremony as the consultability hint), which
                    is what the org's assistant routes on. */}
                <span style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', marginLeft: 'auto' }}>
                  <label htmlFor={`org-role-${row.orgAgent}`} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    Your role in {row.orgName}
                  </label>
                  <input
                    id={`org-role-${row.orgAgent}`}
                    type="text"
                    maxLength={80}
                    value={roleDraft[row.orgAgent.toLowerCase()] ?? ''}
                    onChange={(e) => { setRoleSavedOrg(null); setRoleDraft((d) => ({ ...d, [row.orgAgent.toLowerCase()]: e.target.value })); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveRole(row); }}
                    placeholder="Your role in this organization — e.g. tax advisor"
                    title="Your role in this organization — e.g. tax advisor. Saving re-signs your listing; the organization's assistant can then route role-addressed questions (“@ask tax advisor …”) to your agent."
                    style={{ fontSize: '0.78rem', padding: '0.2rem 0.4rem', width: '17rem', maxWidth: '100%' }}
                  />
                  <BusyButton
                    busy={roleBusyOrg === row.orgAgent.toLowerCase()}
                    busyLabel="…"
                    className="ghost"
                    style={{ width: 'auto', padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                    disabled={roleBusyOrg !== null || (roleDraft[row.orgAgent.toLowerCase()] ?? '').trim() === (row.orgRole ?? '')}
                    onClick={() => void saveRole(row)}
                  >
                    {roleSavedOrg === row.orgAgent.toLowerCase() ? 'Saved' : 'Save role'}
                  </BusyButton>
                </span>
              </li>
            ))}
          </ul>
        )}
        {consultError && <p role="alert" style={{ margin: '0.45rem 0 0', fontSize: '0.82rem', color: 'var(--color-danger)' }}>{consultError}</p>}
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
          Opting in signs a delegation scoped to exactly one offering (discussion questions) for that
          organization only, valid 180 days. Your playbook also governs how your agent
          answers — including when to decline.
        </p>
      </section>
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'message-bot', label: 'Assistant', content: messageBot },
    { id: 'discussions', label: 'Discussions', content: discussionsPanel },
  ];

  return (
    <div>
      <p style={{ ...mutedText, fontSize: '0.82rem', margin: '0 0 0.75rem' }}>
        Your agent, acting for <b style={{ color: 'var(--color-text-body)' }}>{agentName ?? 'you'}</b>
        {agentAddress && <> · <code style={{ fontSize: '0.78rem' }}>{shortId(agentAddress)}</code></>}
      </p>
      {error && <p role="alert" style={{ color: 'var(--color-danger)', margin: '0 0 0.75rem', fontSize: '0.82rem' }}>{error}</p>}
      {only
        ? tabs.find((t) => t.id === ONLY_TAB[only])?.content
        : <Tabs tabs={tabs} aria-label="Agent settings" />}
    </div>
  );
}
