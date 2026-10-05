'use client';
// Behaviour → Playbook → ROLES — spec 427 §4–§5.
//
// A role is what somebody DOES in an organization (field worker, team lead, coach). The organization names it and
// may offer a SKILL PACK with it: more that the person's agent knows how to do there. This section is where that
// offer is accepted or declined, and where a person sees which packs their playbook holds and why.
//
// THREE THINGS KEPT APART ON THE SCREEN, because collapsing any two is how somebody comes to believe a title is a
// permission: the ROLE (the organization's word), the PACK (behaviour — the person's to add), and AUTHORITY (still
// only a mandate they sign for each act). The pack is offered, never installed: an organization cannot write this
// record, and this component writes it only on the person's press — or drops a pack whose membership has ended,
// which is the one change that needs no press and is always said.
//
// The roles are read by asking the person's OWN agent (`person.roles.list`, a supplied plan), so each organization
// answers for its own record of them. A steward looking at an agent they custody sees what it holds; the offers are
// that agent's own session's to read.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import {
  currentPart, packHeading, planRolePacks, readMyRoles, recomposePlaybook,
  type ComposedAssignmentRecord, type ComposedPack, type PackOffer, type RolesRead,
} from '../../home/role-playbook';

const keyOf = (p: { context: string; archetype: string }): string => `${p.context}/${p.archetype}`;
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATE_WORDS: Record<string, { text: string; tone: 'ok' | 'warn' | 'muted' }> = {
  held: { text: 'you hold this role', tone: 'ok' },
  ended: { text: 'that membership has ended', tone: 'warn' },
  changed: { text: 'your role there changed', tone: 'warn' },
  unknown: { text: 'not checked just now', tone: 'muted' },
};

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const color = tone === 'ok' ? 'var(--color-sage-700, #3f6212)' : tone === 'warn' ? 'var(--color-warning, #92700e)' : 'var(--color-text-muted)';
  return <span style={{ fontSize: '.68rem', color, border: `1px solid ${color}`, borderRadius: 6, padding: '0 .35rem', whiteSpace: 'nowrap' }}>{children}</span>;
}

export function PlaybookRoles({ agent, typeSlug, name, current, cardBound, onChanged }: {
  agent: Address;
  /** The ADR-0061 type slug of the agent — a pack that does not apply to it is refused by the registry, by name. */
  typeSlug: string;
  name?: string;
  current: ComposedAssignmentRecord | null;
  /** Whether the agent's PUBLIC card is bound to exactly this playbook: true, false, or null when nothing is published. */
  cardBound: boolean | null;
  onChanged: (record: ComposedAssignmentRecord) => void;
}) {
  const { session, agentAddress } = useSession();
  const token = session?.token ?? null;
  const own = !!agentAddress && agentAddress.toLowerCase() === agent.toLowerCase();
  const packs = current?.composedFrom?.packs ?? [];
  const packOrgs = useMemo(() => [...new Set(packs.map((p) => p.organization.toLowerCase()))].join(','), [packs]);

  const [read, setRead] = useState<RolesRead | null>(null);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** What the registry compiles for each part NOW — for "a newer version" and for what a pack adds. */
  const [parts, setParts] = useState<Record<string, { digest: string; tools: string[] } | null>>({});

  const load = useCallback(async () => {
    if (!token || !own) return;
    setReading(true); setReadFailed(false);
    const r = await readMyRoles(token, agent, packOrgs ? packOrgs.split(',') : []).catch(() => null);
    setRead(r); setReadFailed(!r); setReading(false);
  }, [token, own, agent, packOrgs]);
  useEffect(() => { void load(); }, [load]);

  const plan = useMemo(() => planRolePacks(current?.composedFrom, own ? read : null), [current?.composedFrom, read, own]);

  // The parts worth knowing about: the base and every equipped pack (freshness), every offered pack (what it adds).
  const wanted = useMemo(() => {
    const refs = new Map<string, { context: string; archetype: string }>();
    if (current?.composedFrom) refs.set(keyOf(current.composedFrom.base), current.composedFrom.base);
    for (const p of packs) refs.set(keyOf(p), p);
    for (const o of plan.offers) refs.set(keyOf(o.pack), o.pack);
    return [...refs.values()];
  }, [current?.composedFrom, packs, plan.offers]);
  const wantedKey = wanted.map(keyOf).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(wanted.map(async (ref) => [keyOf(ref), await currentPart(ref)] as const)).then((rows) => {
      if (cancelled) return;
      setParts(Object.fromEntries(rows.map(([k, v]) => [k, v ? { digest: v.digest, tools: v.tools } : null])));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey]);

  const have = useMemo(() => new Set((current?.definition?.tools ?? []).map((t) => t.id)), [current?.definition]);
  const adds = (ref: { context: string; archetype: string }): string[] => (parts[keyOf(ref)]?.tools ?? []).filter((t) => !have.has(t));
  const stale = useMemo(() => {
    const cf = current?.composedFrom;
    if (!cf) return [] as string[];
    const out: string[] = [];
    const b = parts[keyOf(cf.base)];
    if (b && b.digest !== cf.base.digest) out.push(cf.base.archetype);
    for (const p of cf.packs) { const now = parts[keyOf(p)]; if (now && now.digest !== p.digest) out.push(p.archetype); }
    return out;
  }, [current?.composedFrom, parts]);

  const run = useCallback(async (label: string, work: () => Promise<{ record: ComposedAssignmentRecord; toolsAdded: string[]; toolsRemoved: string[]; baseMoved: boolean }>, done: (r: { toolsAdded: string[]; toolsRemoved: string[]; baseMoved: boolean }) => string) => {
    if (!token || !agentAddress) return;
    setBusy(label); setError(null); setSaid(null);
    try {
      const r = await work();
      onChanged(r.record);
      setSaid(done(r));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [token, agentAddress, onChanged]);

  const list = (ids: string[]): string => (ids.length ? `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}` : 'no new tools');
  const equip = (o: PackOffer) => run(`equip:${o.role.org}:${keyOf(o.pack)}`,
    () => recomposePlaybook({ agent, token: token!, typeSlug, actor: agentAddress!, add: [o] }),
    (r) => `Equipped for ${o.role.roleName ?? o.role.assignedRole}${o.role.name ? ` at ${o.role.name}` : ''} — adds ${list(r.toolsAdded)}.${r.baseMoved ? ' Your base playbook moved to the registry’s current version at the same time.' : ''}`);
  const remove = (p: ComposedPack) => run(`remove:${p.organization}:${keyOf(p)}`,
    () => recomposePlaybook({ agent, token: token!, typeSlug, actor: agentAddress!, remove: [p] }),
    (r) => `Removed the ${p.roleName} pack${r.toolsRemoved.length ? ` — ${list(r.toolsRemoved)} went with it` : ''}.`);
  const update = () => run('update',
    () => recomposePlaybook({ agent, token: token!, typeSlug, actor: agentAddress! }),
    (r) => `Updated to the registry’s current version${r.toolsAdded.length ? ` — adds ${list(r.toolsAdded)}` : ''}.`);
  const dropEnded = () => run('drop',
    () => recomposePlaybook({ agent, token: token!, typeSlug, actor: agentAddress!, remove: plan.drop }),
    () => `Removed ${plan.drop.length === 1 ? 'the pack' : `${plan.drop.length} packs`} of ${plan.drop.length === 1 ? 'a role' : 'roles'} you no longer hold.`);

  // Nothing to say: not a person's own agent, nothing equipped, nothing offered, nothing being read.
  if (!packs.length && !plan.offers.length && !reading && !(own && readFailed)) {
    if (!own) return null;
    return (
      <div style={{ margin: '0 0 1rem' }}>
        <h4 style={{ margin: '.2rem 0 .3rem', fontSize: '.85rem' }}>Roles</h4>
        <p className="manage-card-blurb" style={{ margin: 0 }}>
          No organization you belong to has named a role for you that offers a skill pack. When one does, it appears here — offered, for you to add.
        </p>
      </div>
    );
  }

  return (
    <div style={{ margin: '0 0 1.1rem' }}>
      <h4 style={{ margin: '.2rem 0 .3rem', fontSize: '.85rem' }}>Roles</h4>
      <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>
        A role is what {own ? 'you do' : `${name || 'this agent'} does`} in an organization. It can offer a <strong>skill pack</strong> — more
        that {own ? 'your' : 'the'} agent knows how to do there. The organization offers it; only {own ? 'you add' : 'its custodian adds'} it.{' '}
        <strong>A role and its pack grant no authority</strong>: every act still waits on a mandate signed for that request.
      </p>
      {error && <p role="alert" className="manage-card-blurb" style={{ color: 'var(--color-danger, #b3261e)' }}>{error}</p>}
      {said && <p role="status" style={{ margin: '0 0 .6rem', fontSize: '.8rem', color: 'var(--color-sage-700)' }}>{said}</p>}

      {packs.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 .7rem', padding: 0, display: 'grid', gap: '.45rem' }}>
          {plan.equipped.map(({ pack, state }) => {
            const words = STATE_WORDS[state]!;
            const now = parts[keyOf(pack)];
            const newer = !!now && now.digest !== pack.digest;
            return (
              <li key={`${pack.organization}:${keyOf(pack)}`} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: '.55rem .75rem', background: 'var(--color-surface, #fff)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '.4rem' }}>
                  <strong style={{ fontSize: '.86rem' }}>{packHeading(pack)}</strong>
                  {own && <Chip tone={words.tone}>{words.text}</Chip>}
                  {newer && <Chip tone="warn">a newer version is published</Chip>}
                  <button type="button" className="btn-ghost" style={{ marginLeft: 'auto', padding: '.15rem .55rem', fontSize: '.76rem' }} disabled={!!busy} onClick={() => void remove(pack)}>
                    {busy === `remove:${pack.organization}:${keyOf(pack)}` ? 'Removing…' : 'Remove'}
                  </button>
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--color-text-muted)', marginTop: '.2rem' }}>
                  <code title={pack.digest}>{keyOf(pack)}</code> v{pack.version} · added {pack.equippedAt.slice(0, 10)}
                  {pack.equippedAs === 'steward' ? <> · <strong>by this agent’s steward</strong> ({short(pack.equippedBy)}), not by the agent itself</> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {own && plan.drop.length > 0 && (
        <div role="status" style={{ margin: '0 0 .7rem', padding: '.5rem .7rem', borderRadius: 8, background: 'var(--st-warn-bg, #fff7e6)', border: '1px solid var(--st-warn-border, #f2d38a)', fontSize: '.8rem' }}>
          {plan.drop.length === 1 ? 'One pack belongs' : `${plan.drop.length} packs belong`} to a role you no longer hold.{' '}
          <button type="button" className="btn-ghost" style={{ padding: '.15rem .55rem', fontSize: '.78rem', marginLeft: '.3rem' }} disabled={!!busy} onClick={() => void dropEnded()}>{busy === 'drop' ? 'Removing…' : 'Remove'}</button>
        </div>
      )}

      {stale.length > 0 && (
        <div role="status" style={{ margin: '0 0 .7rem', padding: '.5rem .7rem', borderRadius: 8, background: 'var(--st-warn-bg, #fff7e6)', border: '1px solid var(--st-warn-border, #f2d38a)', fontSize: '.8rem' }}>
          <strong>The registry has a newer version</strong> of {stale.map((s) => <code key={s} className="ui-mono" style={{ margin: '0 2px' }}>{s}</code>)}. This playbook keeps the versions it was composed from until you take the new ones.{' '}
          <button type="button" className="btn-ghost" style={{ padding: '.15rem .55rem', fontSize: '.78rem', marginLeft: '.3rem' }} disabled={!!busy} onClick={() => void update()}>{busy === 'update' ? 'Updating…' : 'Update'}</button>
        </div>
      )}

      {own && reading && <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>Asking the organizations you belong to what role each records for you…</p>}
      {own && !reading && readFailed && (
        <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>
          Your roles could not be read just now{current && !current.definition.tools.some((t) => t.id === 'person.roles.list') ? ' — this playbook does not include that read yet; it does once it is updated to the registry’s current version' : ''}.{' '}
          <button type="button" className="btn-ghost" style={{ padding: '.1rem .5rem', fontSize: '.76rem' }} onClick={() => void load()}>Try again</button>
        </p>
      )}
      {own && read && read.unread.length > 0 && plan.equipped.some((e) => e.state === 'unknown') && (
        <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>Some organizations could not be asked just now. Their packs stay as they are — unknown is not ended.</p>
      )}

      {plan.offers.length > 0 && (
        <>
          <h5 style={{ margin: '.5rem 0 .35rem', fontSize: '.8rem' }}>Offered to you</h5>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '.45rem' }}>
            {plan.offers.map((o) => {
              const k = `equip:${o.role.org}:${keyOf(o.pack)}`;
              const added = adds(o.pack);
              const known = parts[keyOf(o.pack)];
              return (
                <li key={k} style={{ border: '1px dashed var(--color-sage-700, #3f6212)', borderRadius: 10, padding: '.6rem .75rem', background: 'var(--color-sage-50, #f2f7ec)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '.4rem' }}>
                    <strong style={{ fontSize: '.86rem' }}>{o.role.roleName ?? o.role.assignedRole}</strong>
                    <span style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>at {o.role.name || short(o.role.org)}</span>
                    <BusyButton busy={busy === k} busyLabel="Equipping…" onClick={() => void equip(o)} className="btn" style={{ width: 'auto', marginLeft: 'auto', padding: '.25rem .7rem', fontSize: '.8rem' }} disabled={!!busy || known === null}>
                      Equip my agent
                    </BusyButton>
                  </div>
                  {o.role.description && <div style={{ fontSize: '.8rem', margin: '.25rem 0 0' }}>{o.role.description}</div>}
                  <div style={{ fontSize: '.72rem', color: 'var(--color-text-muted)', marginTop: '.25rem' }}>
                    <code>{keyOf(o.pack)}</code>
                    {known === null ? <> · the registry does not serve this pack — ask the organization’s steward</> : known ? <> · adds {list(added)}</> : null}
                    {o.role.accessRole ? <> · the role’s access (<code>{o.role.accessRole}</code>) is issued separately, by the organization</> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p style={{ margin: '.4rem 0 0', fontSize: '.72rem', color: 'var(--color-text-muted)' }}>Equipping writes your playbook · no signature, no grant · you can remove it here at any time. Joining without it changes nothing about your membership.</p>
        </>
      )}

      {packs.length > 0 && cardBound !== true && (
        <p style={{ margin: '.6rem 0 0', fontSize: '.76rem', color: 'var(--color-text-muted)' }}>
          {cardBound === false ? 'Your public card is bound to a different playbook version' : 'No public card is bound to this playbook'}, so it does not advertise what these roles add yet. {own ? 'Your' : 'Its'} own asks reach those tools now; another agent asking for one is told it is not offered until a card bound to this playbook is released in the Card Studio.
        </p>
      )}
    </div>
  );
}
