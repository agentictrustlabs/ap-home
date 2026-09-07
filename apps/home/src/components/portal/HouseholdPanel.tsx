'use client';
// THE HOUSEHOLD — spec 363 W4, and the test of whether the capability model is doing its job.
//
// This surface adds NO invoker, NO vocabulary entry and NO UI-only concept. It reads the person's own
// `household.data` record through the same Ask boundary the conversation uses, and it records a member
// through the same capability the sentence "carol is my daughter" reaches. If building it had required
// teaching the Ask about households separately, the model would have failed its own rule
// (docs/architecture/agent-rules/one-capability-model-generates-both.md).
//
// PRIVATE, AND THE PANEL SAYS SO. Who lives with whom is not on chain and not derivable from it, so it
// is in no public tier by construction (ADR-0040) — a family graph is exactly the data a platform should
// not hold, and the page states that rather than leaving it to be assumed.
//
// IT GRANTS NOBODY ANYTHING. A guardian recorded here cannot act for a dependent; that is a delegation
// their custodian issues. No gate reads this record — it answers "who did you mean".
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { AgentName } from '../shared/AgentName';
import { householdThroughHarness, readHouseholdThroughHarness, type HouseholdMemberRow } from '../../home/household-harness';
import { inviteThroughHarness } from '../../home/invite-harness';
import { signHashFor, resolveVia } from '../../home/onboarding';
import { useManagedAgents } from './ManagedAgents';
import { searchAgentsKb } from '../../lib/agent-search';
import { ensureCsrfToken, csrfHeaders } from '../../csrf';
import { mutedText, errorText } from './theme';

const KIN = ['', 'spouse', 'child', 'parent', 'sibling'] as const;
const ROLES = ['member', 'guardian', 'dependent'] as const;

export function HouseholdPanel() {
  const { session, agentAddress, profile } = useSession();
  // THE HOUSEHOLD AGENT (spec 368): the family's SHARED record, as this note is the person's own. When the
  // person stewards one, each recorded person can be invited into it — the household Bob is in as spouse
  // is then the same household Alice founded, not two private notes that happen to agree.
  const { agents: managed } = useManagedAgents(session?.token ?? null);
  const householdAgents = useMemo(() => managed.filter((a) => a.kind === 'household' && a.relationship !== 'member'), [managed]);
  const [rows, setRows] = useState<HouseholdMemberRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  /** Who the naming service says answers to what they typed. Nothing is chosen until they pick one. */
  const [hits, setHits] = useState<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>([]);
  const [picked, setPicked] = useState<{ agent: string; label: string } | null>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [kin, setKin] = useState<string>('');
  const [role, setRole] = useState<string>('member');
  /** Which household the form is adding to. `#new` opens a box for one that does not exist yet — a
   *  person with two homes should not have to discover that typing a name creates one. */
  const [into, setInto] = useState<string>('home');
  const [newName, setNewName] = useState('');

  /** The rows as SECTIONS — one per household, in the order they were first seen, with the one called
   *  "home" first because that is the one most people only ever have. */
  const groups = useMemo(() => {
    const by = new Map<string, HouseholdMemberRow[]>();
    for (const m of rows) {
      const key = (m.household ?? 'home').trim() || 'home';
      by.set(key, [...(by.get(key) ?? []), m]);
    }
    return [...by.entries()].sort((a, b) => (a[0] === 'home' ? -1 : b[0] === 'home' ? 1 : a[0].localeCompare(b[0])));
  }, [rows]);
  /** The households they already keep, plus "home" so there is always somewhere to add the first person. */
  const houses = useMemo(() => [...new Set(['home', ...groups.map(([h]) => h)])], [groups]);

  // FIND THE PERSON, rather than making somebody type an address correctly from memory. The naming
  // service is the source: a name is a public, on-chain fact (ADR-0040), so searching it discloses
  // nothing about who is asking and nothing about the household they are building.
  useEffect(() => {
    const term = who.trim();
    if (term.length < 2 || term.includes('@') || /^0x[0-9a-fA-F]{6,}$/.test(term)) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchAgentsKb(term, 6)
        .then((r) => { if (!cancelled) setHits(r.filter((x) => x.smartAgent)); })
        .catch(() => { if (!cancelled) setHits([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [who]);

  const load = useCallback(async () => {
    if (!session?.token || !agentAddress) return;
    const out = await readHouseholdThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (out.ok) { setRows(out.members); setErr(''); } else setErr(out.error);
    setLoaded(true);
  }, [session?.token, agentAddress]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!session?.token || !agentAddress || !who.trim()) return;
    setBusy(true); setErr(''); setInvited(null);
    // WHAT THEY PICKED, or what they typed. A picked person is an address the naming service resolved;
    // a typed one still resolves at the capability, which knows how.
    const member = picked?.agent ?? who.trim();
    // WHICH HOUSEHOLD they are being recorded in. A name typed for a new one is used as given; an empty
    // one falls back to "home" rather than creating a household called nothing.
    const house = into === '#new' ? (newName.trim() || 'home') : into;
    const out = await householdThroughHarness({
      person: agentAddress as Address, session: { token: session.token },
      member, ...(kin ? { kin } : {}), role, household: house, ...(picked?.label ? { label: picked.label } : {}),
    });
    if (!out.ok) setErr(out.error);
    else {
      setWho(''); setKin(''); setRole('member'); setPicked(null); setHits([]);
      // Stay in the household they just added to — the next person usually lives there too.
      setInto(house); setNewName('');
      await load();
    }
    setBusy(false);
  }

  /**
   * THEY HAVE NO AGENT YET — so invite them to get one, by the address you already have for them.
   *
   * The household record holds AGENTS, so somebody who has none cannot be recorded in it: an invitation
   * is the honest step, and it is theirs to accept. Nothing about the household is disclosed in the mail
   * and no place is held for them — when they have an agent, the person adds them.
   */
  async function invite() {
    const address = who.trim();
    if (!session?.token || !address.includes('@')) return;
    setBusy(true); setErr(''); setInvited(null);
    try {
      // A browser POST to the a2a needs the CSRF pair like every other one — the send is an outward
      // act, and the 403 without it ("csrf required") is the boundary doing its job.
      await ensureCsrfToken();
      const res = await fetch('/a2a/email/send', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          session: session.token, to: address,
          subject: 'An invitation to set up your own agent',
          text: 'I would like to add you to my household — the private note my agent keeps of the people I live with.\n\nIt needs you to have an agent of your own. Setting one up takes a minute and gives you your own name, your own vault and your own keys; nothing of mine is shared with it, and nothing of yours with me unless you say so.',
        }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; via?: string };
      if (!b.ok) throw new Error(b.error ?? `the invitation did not send (${res.status})`);
      setInvited(`Invitation sent to ${address}${b.via ? ` (via ${b.via})` : ''} — add them once they have an agent.`);
      setWho('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /**
   * INVITE INTO THE HOUSEHOLD AGENT — the same one-prompt ceremony as any organization invitation, run
   * through the harness with the kinship and role this note records carried onto the invitation and, when
   * they accept, onto their membership. The household's custodian (this person) signs; nothing here is
   * done on the side.
   */
  async function inviteToHousehold(m: HouseholdMemberRow, house: { agent: string; name?: string | null }) {
    if (!session?.token) return;
    setBusy(true); setErr(''); setInvited(null);
    try {
      const via = resolveVia(profile?.credential, session.via);
      const sign = await signHashFor(via, house.agent as Address, { token: session.token });
      const out = await inviteThroughHarness({
        org: house.agent as Address, invitee: m.agent as Address, session: { token: session.token }, signHash: sign,
        ...(m.relation ? { kin: m.relation } : {}), ...(m.role ? { role: m.role } : {}),
      });
      if (!out.ok) throw new Error(out.error);
      const label = house.name ? house.name.split('.')[0] : 'your household';
      setInvited(`${m.label ?? m.agent} was invited to ${label}${m.relation ? ` as your ${m.relation}` : ''} — they are in it once they accept.${out.recorded ? '' : ' (The vault record could not be stored; it can be re-sent.)'}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /** Removing names the household too: the same person can be in two, and taking them out of one is not
   *  taking them out of the other. */
  async function remove(agent: string, house: string) {
    if (!session?.token || !agentAddress) return;
    setBusy(true); setErr('');
    const out = await householdThroughHarness({ person: agentAddress as Address, session: { token: session.token }, member: agent, household: house, remove: true });
    if (!out.ok) setErr(out.error); else await load();
    setBusy(false);
  }

  return (
    <div>
      <p style={{ ...mutedText, fontSize: 12, marginTop: 0 }}>
        The people you live with, as you record them. It is held in your own vault, published nowhere, and
        it gives nobody any authority — a guardian here still needs a delegation to act for anyone.
        What it does is let your agent understand you: <em>“send my daughter 20 usdc”</em> resolves here,
        without a directory learning who you asked about. You can keep more than one — a second home, a
        week somewhere else, a house you share part of the time.
      </p>
      {err && <p style={errorText}>{err}</p>}
      {loaded && rows.length === 0 && (
        <p style={{ ...mutedText, fontSize: 12 }}>Nobody recorded yet.</p>
      )}
      {/* ONE SECTION PER HOUSEHOLD. A person can keep more than one — a child between two homes, a
          second home, a carer's week — and appending "· the farm" to a row in one long list makes the
          second household look like a note about a person rather than a place they live. The heading
          appears once there IS more than one: a single home needs no label. */}
      {groups.map(([house, people]) => (
        <div key={house} data-testid={`household-group-${house}`} style={{ marginTop: 10 }}>
          {groups.length > 1 && (
            <div style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted, #6b7280)' }}>
              {house}
              <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> · {people.length} {people.length === 1 ? 'person' : 'people'}</span>
            </div>
          )}
          {people.map((m) => (
        <div key={m.agent} data-testid={`household-row-${m.agent}`}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border, #e6e8ec)' }}>
          <strong style={{ fontSize: 13 }}>{m.label ?? <AgentName address={m.agent as Address} />}</strong>
          {/* TWO DIFFERENT QUESTIONS, said as two different sentences. "your child · dependent" reads as
              one label with a mysterious suffix; it is in fact HOW THEY ARE RELATED to you and WHO IS
              RESPONSIBLE in this home, which are independent (an adult sibling is kin and neither cared
              for nor caring). Conflating them is how a system decides a spouse may act for a spouse
              because the words sounded close enough. */}
          <span className="muted" style={{ fontSize: 11.5 }}>
            {m.relation ? `your ${m.relation}` : 'lives with you'}
            {m.role === 'dependent' ? ' — cared for here' : m.role === 'guardian' ? ' — responsible for dependents here' : ''}
          </span>
          {householdAgents.length > 0 && (() => {
            // The household agent this section belongs with: the one whose label matches the section, else the first.
            const target = householdAgents.find((a) => (a.name ?? '').toLowerCase().split('.')[0] === house.toLowerCase()) ?? householdAgents[0]!;
            return (
              <button type="button" className="btn-ghost" style={{ marginLeft: 'auto', fontSize: 11 }}
                disabled={busy} onClick={() => void inviteToHousehold(m, target)} data-testid={`household-invite-agent-${m.agent}`}>
                Invite to {target.name ? target.name.split('.')[0] : 'household'}
              </button>
            );
          })()}
          <button type="button" className="btn-ghost" style={{ marginLeft: householdAgents.length ? 0 : 'auto', fontSize: 11 }}
            disabled={busy} onClick={() => void remove(m.agent, m.household ?? house)} data-testid={`household-remove-${m.agent}`}>
            Remove
          </button>
        </div>
          ))}
        </div>
      ))}
      {/* WHAT THE TWO WORDS MEAN, where the person is choosing them — not in a tooltip they will not
          open. A role grants nothing here: a guardian still needs a delegation to act for anyone. */}
      <p style={{ ...mutedText, fontSize: 11, marginTop: 14, marginBottom: 4 }}>
        <strong>How related</strong> is kinship — spouse, child, parent, sibling. <strong>Role</strong> is
        who looks after whom in this home: <em>member</em> for an adult with no dependency either way,
        <em> guardian</em> for someone responsible, <em>dependent</em> for someone cared for. They are
        separate questions, and neither one grants any authority.
      </p>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="find them by name, or type an email" value={who}
          data-testid="household-who" onChange={(e) => { setWho(e.target.value); setPicked(null); }} />
        <select className="input" style={{ flex: '0 0 130px' }} value={kin} data-testid="household-kin" onChange={(e) => setKin(e.target.value)}>
          {KIN.map((k) => <option key={k || 'none'} value={k}>{k || 'how related…'}</option>)}
        </select>
        <select className="input" style={{ flex: '0 0 130px' }} value={role} data-testid="household-role" onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {/* WHICH HOME. Present even when there is only one, so a person can see that "home" is a choice
            and not a fixed fact about them — the second household is discoverable rather than something
            you have to know the conversation can do. */}
        <select className="input" style={{ flex: '0 0 150px' }} value={into} data-testid="household-into"
          onChange={(e) => { setInto(e.target.value); if (e.target.value !== '#new') setNewName(''); }}>
          {houses.map((h) => <option key={h} value={h}>{h}</option>)}
          <option value="#new">a different household…</option>
        </select>
        {into === '#new' && (
          <input className="input" style={{ flex: '0 0 150px' }} placeholder="what you call it (the farm)"
            value={newName} data-testid="household-new-name" onChange={(e) => setNewName(e.target.value)} />
        )}
        {who.includes('@') ? (
          <BusyButton busy={busy} busyLabel="Sending…" className="btn-primary" style={{ flex: '0 0 auto' }}
            data-testid="household-invite" onClick={() => void invite()}>Invite by email</BusyButton>
        ) : (
          <BusyButton busy={busy} busyLabel="Recording…" className="btn-primary" style={{ flex: '0 0 auto' }}
            data-testid="household-add" onClick={() => void add()}>Record</BusyButton>
        )}
      </div>
      {/* WHO ANSWERS TO THAT NAME, from the naming service. Nothing is chosen for them: a household is a
          record about real people, and the wrong Sarah recorded silently is worse than a second question. */}
      {hits.length > 0 && !picked && (
        <div style={{ marginTop: 6 }} data-testid="household-hits">
          {hits.map((h) => (
            <button key={h.smartAgent} type="button" className="btn-ghost" data-testid={`household-hit-${h.smartAgent}`}
              style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 12, padding: '5px 7px' }}
              onClick={() => { setPicked({ agent: h.smartAgent!, label: h.displayName || h.name || h.smartAgent! }); setWho(h.name || h.smartAgent!); }}>
              <strong>{h.name ?? h.displayName ?? 'unnamed'}</strong>
              <span className="muted" style={{ fontSize: 11 }}> · {h.smartAgent!.slice(0, 8)}…{h.smartAgent!.slice(-4)}</span>
            </button>
          ))}
        </div>
      )}
      {picked && <p style={{ ...mutedText, fontSize: 11, marginTop: 4 }}>Adding <strong>{picked.label}</strong>.</p>}
      {invited && <p style={{ ...mutedText, fontSize: 11.5, marginTop: 6 }} data-testid="household-invited">{invited}</p>}
      {/* THE SHARED HOUSEHOLD (spec 368). This note is yours; a household AGENT is the family's own — one
          record everyone is in, with a vault, an inbox and, if you like, a treasury. Without one, "your
          spouse" and their "spouse" are two private notes; with one, they are two memberships of the same
          household. */}
      {loaded && householdAgents.length === 0 && rows.length > 0 && (
        <p style={{ ...mutedText, fontSize: 11.5, marginTop: 8 }} data-testid="household-make-agent">
          This is your own note. To share one household with the people in it, <a href="/agents" style={{ textDecoration: 'underline' }}>create a household agent</a> — then each person here can be invited into it, with how you are related carried onto their membership.
        </p>
      )}
      <p style={{ ...mutedText, fontSize: 11, marginTop: 8 }}>
        They need an agent for you to record them — this record holds agents, not names on a list.
      </p>
    </div>
  );
}
