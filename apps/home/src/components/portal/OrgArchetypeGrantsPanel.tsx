'use client';
// Org ARCHETYPE DISPATCH console — the host side of cross-org specialist work.
//
// This org hosts archetypes (roles defined in its own library, served as `archetype.<slug>` on its
// A2A endpoint). This panel is where a steward OPTS IN to another organization dispatching work to
// them: it builds the delegation, signs it with the ORG's custodian, and hands it to the calling
// org's InteractionsDO, which verifies and custodies it.
//
// THE DIRECTION IS THE OPPOSITE OF WHAT THE UI LOOKS LIKE, and the copy has to carry that. The
// steward is granting SOMEONE ELSE the right to spend THIS org's agent budget — so the delegator is
// this org, the delegate is the caller, and the grant lands in the CALLER's store. A steward who
// reads it as "I am getting access to them" would grant exactly backwards, which is why the button
// says who may ask whom rather than "grant access".
//
// PER-ARCHETYPE, never all-or-nothing: `allowedMethods` carries one selector per role, so a steward
// can offer the Ontologist and withhold the Creation Planner. That is the whole reason archetypes
// are distinct A2A methods, and the checkbox list is where it becomes visible.
//
// Revocation is NOT here. `forget` only drops the caller's stored copy; withdrawing authority is an
// on-chain revocation of the delegation, and a button in this panel that looked like revocation but
// only forgot locally would be the dangerous kind of wrong.
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { issueArchetypeDispatchDelegation, toWire } from '../../lib/delegation';
import { resolveVia, signHashFor } from '../../home/onboarding';

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-8)',
  font: 'inherit',
  background: 'var(--color-surface)',
};

/** The roles this org can offer. Sourced from its own library — a role advertised here whose
 *  SKILL.md is absent would fail the dispatch at read time, so the list must come from the same
 *  place the harness loads from rather than being hand-kept. */
export interface OrgArchetypeOption {
  slug: string;
  description?: string;
}

export function OrgArchetypeGrantsPanel({
  org,
  archetypes,
  credential,
}: {
  /** THIS org — the host, and therefore the delegator. */
  org: Address;
  archetypes: OrgArchetypeOption[];
  /** Home credential, for resolving how this org's custodian signs. */
  credential?: string;
}) {
  const { session } = useSession();
  const [caller, setCaller] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = (slug: string) =>
    setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));

  const callerOk = /^0x[0-9a-fA-F]{40}$/.test(caller.trim());
  const sameOrg = callerOk && caller.trim().toLowerCase() === org.toLowerCase();

  async function grant(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      if (!session?.token) throw new Error('sign in to grant dispatch');
      // Signed by the custodian of THIS ORG — `sender` is the org SA, not the person, because the
      // delegator is the org. Passing the person here would mint a wire that verifies nowhere.
      const sign = await signHashFor(resolveVia(credential, session.via), org, { token: session.token });
      const d = await issueArchetypeDispatchDelegation(org, caller.trim() as Address, picked, sign);
      const res = await fetch('/connect/archetype-grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'grant', caller: caller.trim().toLowerCase(), delegation: toWire(d), archetypes: picked }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; archetypes?: string[] };
      if (!res.ok || b.ok === false) throw new Error(b.error ?? `grant failed (${res.status})`);
      setNote({ ok: true, text: `Granted ${(b.archetypes ?? picked).join(', ')} to ${caller.trim()}.` });
      setPicked([]);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ display: 'grid', gap: '0.75rem' }}>
      <div>
        <h3 style={{ margin: 0 }}>Archetype dispatch</h3>
        <p style={{ margin: '0.25rem 0 0', color: 'var(--color-text-muted)' }}>
          Let another organization send work to this org&apos;s specialists. They ask; this
          org&apos;s agent does the work and spends its own budget.
        </p>
      </div>

      <label style={{ display: 'grid', gap: '0.25rem' }}>
        <span>Organization that may ask (their agent address)</span>
        <input
          style={inputStyle}
          value={caller}
          placeholder="0x…"
          onChange={(e) => setCaller(e.target.value)}
        />
      </label>
      {caller && !callerOk && <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>That is not an agent address.</p>}
      {sameOrg && <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>That is this organization — it needs no grant to ask itself.</p>}

      <fieldset style={{ border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-8)', padding: '0.6rem' }}>
        <legend style={{ padding: '0 0.3rem' }}>Roles they may ask for</legend>
        {archetypes.length === 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
            This organization&apos;s library defines no archetypes yet.
          </p>
        )}
        {archetypes.map((a) => (
          <label key={a.slug} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.2rem 0' }}>
            <input type="checkbox" checked={picked.includes(a.slug)} onChange={() => toggle(a.slug)} />
            <span>
              <code>{a.slug}</code>
              {a.description && <span style={{ color: 'var(--color-text-muted)' }}> — {a.description}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <button
        type="button"
        onClick={() => void grant()}
        disabled={busy || !callerOk || sameOrg || picked.length === 0}
        style={{ ...inputStyle, cursor: busy ? 'progress' : 'pointer' }}
      >
        {busy ? 'Signing…' : `Allow them to ask for ${picked.length || 'no'} role${picked.length === 1 ? '' : 's'}`}
      </button>

      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        Valid 90 days. To withdraw it before then, revoke the delegation on-chain — removing it here
        would only stop them presenting it, not stop this org honouring it.
      </p>

      {note && (
        <p style={{ margin: 0, color: note.ok ? 'inherit' : 'var(--color-danger, crimson)' }}>{note.text}</p>
      )}
    </section>
  );
}
