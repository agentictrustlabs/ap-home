'use client';
// Behaviour → Archetype — the K3 assignment ceremony (spec 354 §4.2).
//
// A steward picks an archetype (filtered to the agent's class), the Home previews the DIFF — the tools
// the definition would expose, and the mandate types the agent would START ASKING for — and says, in one
// sentence, the invariant the whole design rests on: THIS GRANTS NO AUTHORITY. Assigning an archetype
// changes what the agent knows how to DO; the mandate still decides what it MAY do (spec 354 §1). The
// approval writes `ArchetypeAssignmentV1` to the agent's own vault (`archetype.assignment`, self-gated
// record.put), where the harness's run admission re-derives the digest and loads it — a tampered or
// absent playbook leaves the bare harness standing (`apps/agent-runtime/src/playbook.ts`).
//
// This is the STEWARDSHIP surface for the same record the a2a harness reads. It never signs and never
// grants; the only on-chain thing near it is the vault write itself, gated by the interactions grant's
// additive `vault:archetype.assignment` scope.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import { useSession } from '../../context/session';
import { TriggersPanel } from './TriggersPanel';
import { validateAgentHarnessDefinition, definitionDigest } from '@agenticprimitives/capability-claims';
import { catalogForKind, type CatalogArchetype } from '../../lib/archetype-catalog';
import { registryArchetypesFor, type RegistryArchetype } from '../../lib/skills-registry';
import { KIND_TO_TYPE_SLUG } from '../../lib/archetype-catalog';
import { BusyButton } from '../shared/BusyButton';
import { PlaybookRoles } from './PlaybookRoles';
import { recomposePlaybook, type ComposedFrom } from '../../home/role-playbook';

import { Loading } from '../shared/Loading';
/** The record shape written to the agent's vault (`archetype.assignment`). */
interface ArchetypeAssignmentRecord {
  type: 'ap.archetype-assignment.v1';
  archetypeId: string;
  archetypeVersion: string;
  definitionDigest: string;
  definition: AgentHarnessDefinitionV1;
  /** Spec 427 §5.2 — when the playbook is a base plus role packs: which part came from which membership. The runtime
   *  reads `definition` and `definitionDigest` only. */
  composedFrom?: ComposedFrom;
}

/** Read/write the agent's archetype assignment through the STEWARD-gated `/connect/channels` path — the
 *  same gate the assistant playbook uses. An org / workspace / treasury agent's behaviour is authored by
 *  its custodian, never by the agent's own session, so this is not a person self-write. */
async function readAssignment(token: string, agent: Address): Promise<ArchetypeAssignmentRecord | null> {
  const r = await fetch('/connect/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() }),
  });
  const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: ArchetypeAssignmentRecord | null; error?: string };
  if (!r.ok || b.ok !== true) throw new Error(b.error ?? `could not read the archetype (${r.status})`);
  return b.record ?? null;
}

interface PublishedBinding { archetypeId: string; archetypeVersion: string; definitionDigest: string }

/** The playbook binding this agent's PUBLIC card promises (spec 354 K6), or null. Public — no session:
 *  the released card is world-readable (ADR-0040). A Home compares its digest to the current assignment
 *  to say "Bound to release". */
async function readPublishedBinding(agent: Address): Promise<{ binding: PublishedBinding | null; releaseId: string | null }> {
  const r = await fetch(`/a2a/agent-cards/playbook-binding?agent=${agent.toLowerCase()}`);
  if (!r.ok) return { binding: null, releaseId: null };
  const b = (await r.json().catch(() => ({}))) as { binding?: PublishedBinding | null; releaseId?: string | null };
  return { binding: b.binding ?? null, releaseId: b.releaseId ?? null };
}

async function writeAssignment(token: string, agent: Address, definition: AgentHarnessDefinitionV1): Promise<void> {
  const check = validateAgentHarnessDefinition(definition);
  if (!check.ok) throw new Error(`the archetype is not a valid definition: ${check.errors[0]}`);
  const record: ArchetypeAssignmentRecord = {
    type: 'ap.archetype-assignment.v1', archetypeId: definition.archetypeId,
    archetypeVersion: definition.archetypeVersion, definitionDigest: definitionDigest(definition), definition,
  };
  const r = await fetch('/connect/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'archetypeAssignmentPut', communityId: agent.toLowerCase(), record }),
  });
  const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok || b.ok !== true) throw new Error(b.error ?? `archetype write failed (${r.status})`);
}

const rarLabel = (t: string) => t.replace(/^urn:ap:rar:/, '');
/** `skill:<context>/<id>` → `<id>`: the context is already named on the line, so each driving skill
 *  reads as its own id. The full ref stays in the chip's title for anyone who needs it verbatim. */
const skillLabel = (ref: string) => ref.replace(/^skill:/, '').replace(/^[^/]+\//, '');

/** The human words for a mandate requirement type — falls back to the bare urn tail. Kept tiny and
 *  local: the authoritative label lives with the capability in the compiler; here we only need to make
 *  the diff legible to the steward. */
const MANDATE_WORDS: Record<string, string> = {
  'treasury.payment.execute': 'make payments',
  'treasury.fund': 'fund the treasury',
  'organization.membership.manage': 'manage membership',
  'organization.team.create': 'charter teams',
  'messaging.direct.send': 'send direct messages',
};
const mandateWords = (t: string) => MANDATE_WORDS[rarLabel(t)] ?? rarLabel(t);

function ToolLine({ id, description, risk }: { id: string; description: string; risk?: string }) {
  const informational = !risk || risk === 'informational';
  return (
    <li style={{ margin: '.35rem 0', lineHeight: 1.4 }}>
      <code style={{ fontSize: '.82rem', overflowWrap: 'anywhere' }}>{id}</code>
      {!informational && (
        <span style={{ marginLeft: '.4rem', fontSize: '.7rem', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '0 .35rem' }}>
          {risk} · needs a mandate
        </span>
      )}
      <div style={{ fontSize: '.78rem', color: 'var(--color-text-muted)' }}>{description}</div>
    </li>
  );
}

/** The diff panel: what this definition would make the agent able to do, and what it would start
 *  asking authority for. Reads only real fields of the definition. */
function DiffPreview({ def, assigned = false }: { def: AgentHarnessDefinitionV1; assigned?: boolean }) {
  const mandates = def.requiredMandateTypes ?? [];
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: '.85rem 1rem', background: 'var(--color-surface, #fff)' }}>
      <p style={{ margin: '0 0 .5rem', fontSize: '.82rem', color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap' }}>{def.instructions}</p>
      <h4 style={{ margin: '.6rem 0 .2rem', fontSize: '.82rem' }}>{assigned ? 'Tools this agent runs' : 'Tools it would use'}</h4>
      <ul style={{ margin: 0, paddingLeft: '1.1rem', listStyle: 'disc' }}>
        {(def.tools ?? []).map((t) => (
          <ToolLine key={t.id} id={t.id} description={t.description} risk={t.risk} />
        ))}
      </ul>
      <h4 style={{ margin: '.7rem 0 .2rem', fontSize: '.82rem' }}>{assigned ? 'Authority it asks for' : 'Authority it would start asking for'}</h4>
      {mandates.length === 0 ? (
        <p style={{ margin: 0, fontSize: '.8rem', color: 'var(--color-text-muted)' }}>None — this archetype only reads and converses.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', listStyle: 'disc', fontSize: '.82rem' }}>
          {mandates.map((m) => (
            <li key={m} style={{ margin: '.2rem 0' }}>{mandateWords(m)} <span style={{ color: 'var(--color-text-muted)', fontSize: '.72rem' }}>({rarLabel(m)})</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** WHERE A PLAYBOOK COMES FROM — its skills context and the SKILL.md contracts that compiled it. Shown only when a
 *  registry row for it is loaded; absent says nothing, because a definition held in the vault is real without it. */
function RegistrySource({ registry }: { registry: RegistryArchetype }) {
  return (
    <div style={{ fontSize: '.7rem', color: 'var(--color-text-muted)', marginTop: '.35rem' }}>
      <div>
        from <code>{registry.context}</code>
        {registry.skills.length === 0 && <> · no SKILL.md linked yet</>}
      </div>
      {registry.skills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '.25rem .3rem', marginTop: '.25rem' }}>
          <span>driven by</span>
          {registry.skills.map((sk) => (
            <code key={sk} title={sk} style={{ fontSize: '.68rem', whiteSpace: 'nowrap', overflowWrap: 'anywhere' }}>{skillLabel(sk)}</code>
          ))}
        </div>
      )}
      {registry.warnings.length > 0 && (
        <div style={{ color: 'var(--color-warning, #92700e)', marginTop: '.2rem' }}>
          {registry.warnings.length} capabilit{registry.warnings.length === 1 ? 'y has' : 'ies have'} no contract — running the built-in shape
        </div>
      )}
    </div>
  );
}

/**
 * The ceremony. `agent` is the managed agent's SA; `kind` its AgentKind (used to filter the catalog to
 * the agent's class); `name` for copy. Reads the current assignment, offers the class's archetypes,
 * previews the diff, and on approval writes the assignment record — one write, no signature, no grant.
 */
export function BehaviourPlaybook({ agent, kind, name }: { agent: Address; kind: string; name?: string }) {
  const { session, agentAddress } = useSession();
  const token = session?.token ?? null;
  const typeSlug = KIND_TO_TYPE_SLUG[(kind ?? '').toLowerCase()] ?? '';
  // TWO SOURCES, ONE SHAPE. The app-config catalog is spec 354 §3's defaults; the registry is where a
  // domain author's SKILL.md contracts actually live, so an archetype edited there shows up here. Both
  // hand back an AgentHarnessDefinitionV1, which is the point of compiling one.
  const builtIn = useMemo(() => catalogForKind(kind), [kind]);
  const [registry, setRegistry] = useState<RegistryArchetype[]>([]);
  const options = useMemo(() => {
    // A registry archetype WINS over a built-in of the same archetypeId: the corpus is the editable
    // source, and shadowing it with a compiled-in copy is how an edit stops mattering.
    const fromRegistry = registry.map((r) => ({ key: r.key, label: r.label, summary: r.summary, definition: r.definition, registry: r }));
    const shadowed = new Set(fromRegistry.map((o) => o.definition.archetypeId));
    return [
      ...fromRegistry,
      ...builtIn.filter((b) => !shadowed.has(b.definition.archetypeId)).map((b) => ({ ...b, registry: undefined as RegistryArchetype | undefined })),
    ];
  }, [builtIn, registry]);
  const [current, setCurrent] = useState<ArchetypeAssignmentRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<(CatalogArchetype & { registry?: RegistryArchetype }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ binding: PublishedBinding | null; releaseId: string | null } | null>(null);
  /** The registry row for the ASSIGNED playbook, when this Home happens to load its context — for its source chips. */
  const currentRegistry = useMemo(() => (current ? options.find((o) => o.registry && o.definition.archetypeId === current.archetypeId)?.registry : undefined), [current, options]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoaded(false);
    void readAssignment(token, agent)
      .then((rec) => { if (!cancelled) setCurrent(rec); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [agent, token]);

  useEffect(() => {
    let cancelled = false;
    void registryArchetypesFor(KIND_TO_TYPE_SLUG[(kind ?? '').toLowerCase()])
      .then((r) => { if (!cancelled) setRegistry(r); })
      .catch(() => { if (!cancelled) setRegistry([]); });
    return () => { cancelled = true; };
  }, [kind]);

  // spec 354 K6 — is the current playbook BOUND to a public card release? Public read, best-effort: a
  // nameless or unpublished agent simply shows nothing (private posture is the honest default).
  useEffect(() => {
    let cancelled = false;
    void readPublishedBinding(agent).then((p) => { if (!cancelled) setPublished(p); }).catch(() => { if (!cancelled) setPublished(null); });
    return () => { cancelled = true; };
  }, [agent, current?.definitionDigest]);

  const assign = useCallback(async () => {
    if (!selected || !token) return;
    setBusy(true); setSaved(false); setError(null);
    try {
      // SWITCHING PLAYBOOK KEEPS THE ROLE PACKS (spec 427): a person who equipped a role and then picks a different
      // base did not un-equip the role. A registry archetype is recomposed with the packs they hold; a built-in one
      // cannot be composed with anything, and the button says so before it is pressed.
      const packs = current?.composedFrom?.packs ?? [];
      if (packs.length && selected.registry && agentAddress) {
        await recomposePlaybook({ agent, token, typeSlug, actor: agentAddress, base: { context: selected.registry.context, archetype: selected.registry.key.slice(selected.registry.context.length + 1) } });
      } else {
        await writeAssignment(token, agent, selected.definition);
      }
      setSaved(true);
      setSelected(null);
      const rec = await readAssignment(token, agent).catch(() => null);
      if (rec) setCurrent(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [agent, selected, token, current?.composedFrom, agentAddress, typeSlug]);

  const clear = useCallback(async () => {
    setBusy(true); setSaved(false); setError(null);
    try {
      // "Clear" is a re-assignment to the bare state: write no archetype by removing the record's
      // teeth — here we simply re-present the picker. A true delete is a vault op we don't expose yet;
      // reassigning to another archetype is the supported change. Keep this honest:
      setSelected(null);
    } finally { setBusy(false); }
  }, []);

  if (options.length === 0 && loaded && !current) {
    return (
      <div style={{ marginBottom: '1.2rem' }}>
        <h3>Archetype</h3>
        <p className="manage-card-blurb" style={{ margin: 0 }}>No archetypes apply to this kind of agent yet.</p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '1.4rem' }}>
      <h3>Archetype</h3>
      <p className="manage-card-blurb" style={{ margin: '0 0 .7rem' }}>
        An archetype is a compiled behaviour — the skills, tools and reasoning {name || 'this agent'} runs
        under. Assigning one <strong>changes what the agent knows how to do; it grants no authority.</strong>{' '}
        Every action it takes still waits on a mandate you sign for that request.
      </p>
      {error && <p role="alert" className="manage-card-blurb" style={{ color: 'var(--color-danger, #b3261e)' }}>{error}</p>}

      {!loaded ? (
        <Loading />
      ) : (
        <>
          <div style={{ marginBottom: '.8rem', fontSize: '.85rem' }}>
            {current ? (
              // WHAT THIS AGENT RUNS, from the record it runs — the vault's `archetype.assignment` (compiled definition +
              // digest), never the picker below. The picker is the registry's offer and may not even list this playbook
              // (a domain context this Home does not browse); the assignment is real either way.
              <div style={{ border: '1px solid var(--color-sage-700, #3f6212)', borderRadius: 10, padding: '.7rem .85rem', background: 'var(--color-sage-50, #f2f7ec)' }}>
                <div>
                  Assigned: <strong>{current.composedFrom ? current.composedFrom.base.archetype : current.archetypeId.replace(/^skill:[^/]+\//, '')}</strong>{' '}
                  <span style={{ color: 'var(--color-text-muted)', fontSize: '.72rem' }}>v{current.archetypeVersion}</span>
                  {current.composedFrom && current.composedFrom.packs.length > 0 && (
                    <span style={{ marginLeft: '.4rem', fontSize: '.78rem' }}>
                      with {current.composedFrom.packs.length === 1 ? 'one role pack' : `${current.composedFrom.packs.length} role packs`} — {current.composedFrom.packs.map((p) => p.roleName).join(', ')}
                    </span>
                  )}
                  {saved && <span role="status" style={{ marginLeft: '.5rem', color: 'var(--color-sage-700)' }}>Saved ✓</span>}
                </div>
                {currentRegistry && <RegistrySource registry={currentRegistry} />}
                {current.definition && <div style={{ marginTop: '.6rem' }}><DiffPreview def={current.definition} assigned /></div>}
              </div>
            ) : (
              <span style={{ color: 'var(--color-text-muted)' }}>No archetype assigned — the agent runs the bare harness.</span>
            )}
          </div>

          {/* A NEWER VERSION of the assigned playbook in the registry — its contracts changed (a capability added, a
              contract rewritten) and this agent still runs the digest it was assigned. The ask says `unknown_tool` for
              anything the new contracts offer until the steward re-pins; the choice stays hers (K3: a receipt cites the
              version), so this is an offer, never a silent upgrade. */}
          {current && (() => {
            const same = registry.find((r) => r.definition.archetypeId === current.archetypeId);
            if (!same || !same.digest || same.digest === current.definitionDigest) return null;
            const added = same.definition.tools.map((t) => t.id).filter((id) => !current.definition?.tools?.some((t) => t.id === id));
            return (
              <div role="status" style={{ margin: '0 0 .8rem', padding: '.55rem .75rem', borderRadius: 8, background: 'var(--st-warn-bg, #fff7e6)', border: '1px solid var(--st-warn-border, #f2d38a)', fontSize: '.8rem' }}>
                <strong>A newer version of this playbook is in the registry</strong>{added.length ? <> — it adds {added.slice(0, 4).map((id) => <code key={id} className="ui-mono" style={{ margin: '0 2px' }}>{id}</code>)}{added.length > 4 ? ` and ${added.length - 4} more` : ''}</> : ''}.
                {' '}Until you take it, an ask for those says <code className="ui-mono">unknown_tool</code>.{' '}
                <button type="button" className="btn-ghost" style={{ padding: '.15rem .55rem', fontSize: '.78rem', marginLeft: '.4rem' }} disabled={busy} onClick={() => { setSelected({ key: same.key, label: same.label, summary: same.summary, definition: same.definition, registry: same }); }}>Review the update</button>
              </div>
            );
          })()}

          {/* spec 354 K6 — Bound to release. Whether the CURRENT playbook is the one this agent's public
              card promises. Verifiability is structural: the released card carries the definition digest,
              so anyone can check this playbook version against the corpus. Silent when nothing is
              published (private posture) or there is no assignment. */}
          {current && published?.binding && (
            published.binding.definitionDigest === current.definitionDigest ? (
              <p style={{ margin: '0 0 .8rem', fontSize: '.8rem', color: 'var(--color-sage-700)' }}>
                ✓ Bound to a published card release — the world can verify this exact playbook version against the corpus by its digest.
              </p>
            ) : (
              <p style={{ margin: '0 0 .8rem', fontSize: '.8rem', color: 'var(--color-text-muted)' }}>
                Your card publishes a <strong>different</strong> playbook version ({published.binding.archetypeVersion}). Release a new card to bind the current one.
              </p>
            )
          )}
          {current && published && !published.binding && (
            <p style={{ margin: '0 0 .8rem', fontSize: '.78rem', color: 'var(--color-text-muted)' }}>
              This playbook is private — no card release binds it. Publishing is the steward’s call; bind it in the Card Studio to make the version verifiable.
            </p>
          )}

          {/* Spec 427 — the roles this agent's person holds, and the skill packs those roles offer. A person's agent
              only: a role hangs on a person's membership. */}
          {typeSlug === 'person' && (
            <PlaybookRoles
              agent={agent} typeSlug={typeSlug} name={name} current={current}
              cardBound={!current || !published ? null : published.binding ? published.binding.definitionDigest === current.definitionDigest : null}
              onChanged={(rec) => { setCurrent(rec); setSaved(false); }}
            />
          )}

          {options.length > 0 && current && <h4 style={{ margin: '.2rem 0 .45rem', fontSize: '.85rem' }}>Switch playbook</h4>}
          <div style={{ display: 'grid', gap: '.55rem' }}>
            {options.map((opt) => {
              const isCurrent = current?.archetypeId === opt.definition.archetypeId;
              const isSel = selected?.key === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => { setSelected(isSel ? null : opt); setSaved(false); }}
                  style={{
                    // A raw <button> here is a CARD, not a CTA: the global button rule paints it as one
                    // (white text, centred inline-flex, nowrap) — which is how the archetype label became
                    // white on white and the skill list ran off the page. Every one of those is reset.
                    display: 'block', width: '100%', minHeight: 0, whiteSpace: 'normal', lineHeight: 1.4,
                    fontWeight: 400, fontSize: 'inherit', color: 'var(--color-text-body)', textAlign: 'left',
                    cursor: 'pointer', padding: '.6rem .8rem', borderRadius: 10, transform: 'none',
                    border: `1px solid ${isSel ? 'var(--color-sage-700, #3f6212)' : 'var(--color-border)'}`,
                    background: isSel ? 'var(--color-sage-50, #f2f7ec)' : 'var(--color-surface, #fff)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                    <strong style={{ fontSize: '.88rem' }}>{opt.label}</strong>
                    {isCurrent && <span style={{ fontSize: '.68rem', color: 'var(--color-sage-700)' }}>assigned</span>}
                  </div>
                  <div style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>{opt.summary}</div>
                  {/* WHERE THIS BEHAVIOUR COMES FROM. A steward picking a playbook should be able to see
                      which SKILL.md contract defines it — that file is the editable source, and an
                      archetype with no contract behind a capability is running a built-in fallback. */}
                  {opt.registry && <RegistrySource registry={opt.registry} />}
                </button>
              );
            })}
          </div>

          {selected && (
            <div style={{ marginTop: '.9rem', display: 'grid', gap: '.7rem' }}>
              <DiffPreview def={selected.definition} />
              <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center' }}>
                <BusyButton
                  busy={busy}
                  busyLabel="Assigning…"
                  onClick={() => void assign()}
                  className="btn"
                  style={{ width: 'auto' }}
                >
                  {current?.archetypeId === selected.definition.archetypeId ? 'Re-assign' : `Assign ${selected.label}`}
                </BusyButton>
                <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => void clear()} disabled={busy}>Cancel</button>
                <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--color-text-muted)' }}>
                  Writes to the agent’s vault · no signature, no grant
                  {(current?.composedFrom?.packs.length ?? 0) > 0 && (selected.registry ? ' · your role packs come along' : ' · this built-in playbook cannot carry role packs — they are removed; re-equip after choosing a registry playbook')}
                </span>
              </div>
            </div>
          )}
        </>
      )}
      {/* Spec 375 W3 — the schedule the assigned playbook keeps, beside the playbook itself. */}
      <TriggersPanel agent={agent} />
    </div>
  );
}
