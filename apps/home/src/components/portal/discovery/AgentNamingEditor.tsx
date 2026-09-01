'use client';
// Settings → Identity & presence → Naming (spec 348 §2.3) — the name, everything published under it, and
// the card projection that writes to it, in one place.
//
// Before this, one fact had three homes: the A2A endpoint was set inside the card editor (because the
// card needs it), the name records that carry it were edited on a `Metadata` page, and the projection
// that publishes the card to the name lived in the Studio under `Card & Projections`. Three screens, one
// question — "what does this name say, and where does it point?"
//
// The rule that collapses them: a name record is published under the name, so it is edited with the name.
// The projection writes name records, so it is run from the same page. What stays in the Studio is the
// CARD — a card is a document about the agent; a projection is what one target is told about it
// (ADR-0062), and they are not the same thing.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useCardDetail, useCards, useStudioAgent, type StudioScopeKind } from '../../studio/useStudio';
import { publishProjection } from '../../studio/publish-projection';
import { AccountProfilePanel } from './AgentMetadataTiers';
import { readNameRecords, writeNameProperties, EDITABLE_PROPS, type EditablePropKey } from '../../../lib/name-properties';
import { BusyButton } from '../../shared/BusyButton';
import { NameAgentForm, useManagedAgents } from '../ManagedAgents';
import { useSession } from '../../../context/session';
import { reverseAgentName } from '../../../lib/reverse-name';
import { cardSty, inputSty, mono, mutedText, errorText } from '../theme';

/**
 * ONE editor for what this name says on chain — and one Save.
 *
 * This screen used to carry two writers for one record: the card projection had its own button and its
 * own status ("Listed, but shows an older version of the card"), and the name-record editor had another
 * ("No changes"). Both write the same on-chain record for the same name, so they could contradict each
 * other on screen, and the person was asked to understand a distinction that is ours, not theirs.
 *
 * There is one record, so there is one Save. Under it, two writes still happen because the fields have
 * different provenance — the card-derived ones (display name, A2A endpoint, card address and digest) go
 * through the projection, which is what keeps the card's signature and the record tied together; the
 * hand-written ones are a direct property write. Which of those runs depends on what actually changed.
 */
function NameRecordSection({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  const ctx = useStudioAgent(kind, agent);
  const { cards, loaded: cardsLoaded } = useCards(ctx.delegation);
  const primary = useMemo(
    () => cards.find((c) => c.resource.primary && c.resource.environment === 'production') ?? cards[0] ?? null,
    [cards],
  );
  const cardId = primary?.resource.cardResourceId ?? '';
  const state = useCardDetail(ctx.delegation, cardId);
  const published = state.detail?.releases.filter((r) => r.state === 'published').at(-1) ?? null;

  /** The managed-agent row supplies what naming a NEW name needs: its kind and its parent. */
  const { agents } = useManagedAgents(ctx.session?.token ?? null, 'any');
  const { agentAddress: personSA } = useSession();
  const managed = agents.find((a) => a.agent.toLowerCase() === (ctx.sa ?? '').toLowerCase()) ?? null;
  const [records, setRecords] = useState<Partial<Record<EditablePropKey, string>> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditablePropKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // THE NAME THIS RECORD LIVES UNDER, reverse-resolved from the chain — not the workspace's display
  // label. `ctx.name` is whatever the managed-agent row calls this agent, which for a workspace is a
  // human label ("Northern Colorado Field"). Reading records under that asks the naming service for a
  // name nobody registered, so every field came back empty and the page reported that a named,
  // registered agent had no naming entry.
  const [name, setName] = useState<string | null>(null);
  const [nameLoaded, setNameLoaded] = useState(false);
  useEffect(() => {
    if (!ctx.sa) return;
    let cancelled = false;
    void reverseAgentName(ctx.sa as Address)
      .then((n) => { if (!cancelled) { setName(n); setNameLoaded(true); } })
      .catch(() => { if (!cancelled) setNameLoaded(true); });
    return () => { cancelled = true; };
  }, [ctx.sa]);

  const load = useCallback(async () => {
    if (!name) { setRecords({}); return; }
    const r = await readNameRecords(name).catch(() => ({} as Record<string, string | undefined>));
    const only: Partial<Record<EditablePropKey, string>> = {};
    for (const { key } of EDITABLE_PROPS) only[key] = (r as Record<string, string | undefined>)[key] ?? '';
    setRecords(only); setDraft(only);
  }, [name]);
  useEffect(() => { void load(); }, [load]);

  const edited = records ? EDITABLE_PROPS.filter(({ key }) => (draft[key] ?? '') !== (records[key] ?? '')) : [];
  // The card carries fields this record is supposed to mirror. "Moved" means the published card is not
  // the one this record was last written from — either it was never written, or a newer card replaced the
  // one it names. Saving then re-runs the projection, which is the whole of "point my name at my card",
  // with no second button for it.
  const naming = state.projections.find((p) => p.family === 'ap-naming') ?? null;
  const cardMoved = !!published
    && (!naming?.instance.lastPublication || naming.selectedCard?.releaseId !== published.releaseId);
  const pending = edited.length + (cardMoved ? 1 : 0);

  const save = (): void => {
    setBusy(true); setError(null); setNote(null);
    void (async () => {
      try {
        if (!name || !ctx.delegation || !ctx.sa) return;
        if (cardMoved && published) {
          await publishProjection({
            family: 'ap-naming',
            delegation: ctx.delegation,
            sa: ctx.sa as Address,
            cardResourceId: cardId,
            releaseId: published.releaseId,
            signHashFor: ctx.signHashFor,
            newMutation: () => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() }),
            onPhase: (ph) => setPhase(PHASE[ph]),
          });
        }
        if (edited.length > 0) {
          setPhase('Writing to the naming service…');
          const changes: Partial<Record<EditablePropKey, string>> = {};
          for (const { key } of edited) changes[key] = draft[key] ?? '';
          const signHash = await ctx.signHashFor();
          const out = await writeNameProperties(ctx.sa as Address, name, changes, signHash);
          if (!out.ok) { setError(out.error); return; }
        }
        setNote('Saved. Anyone who resolves this name reads this.');
        await load();
        state.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false); setPhase('');
      }
    })();
  };

  if (!nameLoaded) return <p style={{ ...mutedText, fontSize: '.82rem' }}>Reading the naming service…</p>;
  if (!name) {
    // Naming an unnamed agent belongs HERE, on the page about its name — it used to live only on the
    // org Overview, mixed in with creating a treasury, so the one page about naming could not name.
    return (
      <div style={cardSty}>
        <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
          Nothing in the naming service resolves to this agent yet. Give it a name and this becomes what
          the name tells the world — and where other agents find it.
        </p>
        {ctx.session && ctx.sa && managed && (
          <NameAgentForm
            agent={ctx.sa}
            kind={managed.kind}
            parent={managed.parent || personSA || ''}
            person={personSA ?? ''}
            token={ctx.session.token}
            via={ctx.session.via}
            onDone={() => { setNameLoaded(false); void reverseAgentName(ctx.sa as Address).then((n) => { setName(n); setNameLoaded(true); }); }}
          />
        )}
      </div>
    );
  }
  if (records === null || !cardsLoaded) return <p style={{ ...mutedText, fontSize: '.82rem' }}>Reading the naming service…</p>;

  return (
    <div style={cardSty}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
        <h3 style={{ margin: 0 }}>What this name says</h3>
        <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '.15rem .5rem', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>public</span>
      </div>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        Written on chain under <code style={mono}>{name}</code>. Anyone who resolves the name reads these —
        including the <b>A2A endpoint</b>, which is where other agents send messages.
      </p>

      {cardMoved && (
        <p style={{ fontSize: '.82rem', margin: '0 0 .6rem', padding: '.5rem .6rem', borderRadius: 8, background: 'var(--c-primary-subtle, #fffbeb)' }}>
          Your agent card has changed since this record was written. Saving points the name at the current
          card as well as writing anything you edit below.
        </p>
      )}

      {EDITABLE_PROPS.map(({ key, label, hint }) => (
        <div key={key} style={{ marginBottom: '.7rem' }}>
          <label htmlFor={`rec-${key}`} style={{ display: 'block', fontSize: '.8rem', fontWeight: 600 }}>{label}</label>
          <span style={{ ...mutedText, fontSize: '.74rem' }}>{hint}</span>
          <input id={`rec-${key}`} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} style={{ ...inputSty, width: '100%' }} />
        </div>
      ))}

      <BusyButton className="btn-primary" busy={busy} busyLabel={phase || 'Saving…'} disabled={pending === 0} onClick={save}>
        {pending === 0 ? 'No changes to save' : 'Save to the naming service'}
      </BusyButton>
      {note && <p style={{ ...mutedText, fontSize: '.82rem', marginTop: '.5rem' }} role="status">{note}</p>}
      {error && <p style={{ ...errorText, fontSize: '.82rem', marginTop: '.5rem' }}>{error}</p>}
    </div>
  );
}

const PHASE: Record<'preparing' | 'custodian' | 'writing' | 'confirming', string> = {
  preparing: 'Preparing…',
  custodian: 'Waiting for your custodian…',
  writing: 'Writing to the naming service…',
  confirming: 'Confirming…',
};

/** The published half of Naming: the records under the name, the projection that writes them, and the
 *  read-only account profile. Each class renders its own "the name itself" section above this. */
export function AgentNamingEditor({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  const ctx = useStudioAgent(kind, agent);
  const cls = kind === 'org' ? 'org' : kind === 'service' ? 'service' : 'person';
  if (!ctx.sa) return null;
  return (
    <>
      <div style={{ marginTop: '1.5rem' }}>
        <NameRecordSection kind={kind} agent={agent} />
      </div>
      <div style={{ marginTop: '1.5rem' }}>
        <AccountProfilePanel agent={ctx.sa as Address} />
      </div>
    </>
  );
}
