'use client';
// CONTACTS — membership on the person agent (spec 401 C2). A contact is an agent you let in — a friend, a coach
// service, an outside runtime, an assistant — admitted with a grant you sign (they may read your contact profile),
// kept in your own vault, revocable by you. The same mechanism an organization uses for a member; your word for it.
//
// This surface adds NO invoker and NO vocabulary of its own: it reads `person.contact.list` and hands
// `person.contact.invite` / `person.contact.remove` to the Ask as commands — the flyout runs the ceremony (your
// mandate; for adding, the grant you sign), and the receipt lands where every receipt lands.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { kindOfName, KIND_WORDS } from '@agenticprimitives/ontology/participant-vocabulary';
import { playbookBehind, playbookBehindWords } from '../../home/playbook-behind';
import { Section, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, FilterChip } from '../../ui';

/** The KIND beside the role (agent-vocabulary.md §1) — from the typed name, bound to the T-box's three kinds. */
const kindWords = (name: string | null): string => { const k = kindOfName(name); return k ? KIND_WORDS[k].one : 'unnamed'; };
import { AgentName } from '../shared/AgentName';
import { askCommand } from '../../home/ask-command';
import { readContactsThroughHarness, readFriendsThroughHarness, CONTACT_ROLES, type ContactRole, type ContactRow, type FriendsView } from '../../home/contacts-harness';
import { searchAgentsKb } from '../../lib/agent-search';

const ROLE_WORDS: Record<string, string> = { friend: 'friend', family: 'family', coach: 'coach', assistant: 'assistant', runtime: 'runtime', other: 'contact' };

export function ContactsPanel() {
  const { session, agentAddress, agentName } = useSession();
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [removedCount, setRemovedCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [who, setWho] = useState('');
  const [roleFilter, setRoleFilter] = useState<ContactRole | 'all'>('all');
  const [role, setRole] = useState<ContactRole>('friend');
  const [hits, setHits] = useState<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>([]);
  const [picked, setPicked] = useState<{ agent: string; label: string } | null>(null);
  // FRIENDS — the view over contacts (`person.friend.list`): who added me back, who is waiting on whom.
  const [friends, setFriends] = useState<FriendsView | null>(null);
  const [friendsErr, setFriendsErr] = useState('');
  // PRESENCE — where each friend is right now (the runtime's /presence/friends under the Home session; the Home
  // itself beats while this page is open, so friends see "at their Home").
  const [presence, setPresence] = useState<Record<string, Array<{ app: string; label?: string; at: number }>>>({});
  // INVITE BY EMAIL — a friend with no home yet; the mail goes out as the person through the Worker's rail.
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNote, setInviteNote] = useState('');
  const [inviteState, setInviteState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false });

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    const r = await readContactsThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (r.ok) { setRows(r.contacts); setRemovedCount(r.removed); setErr(''); } else { const behind = playbookBehind(r.error); setErr(behind ? playbookBehindWords(behind.toolId) : r.error); }
    setLoaded(true);
  }, [session, agentAddress]);
  useEffect(() => { void load(); }, [load]);
  const loadFriends = useCallback(async () => {
    if (!session || !agentAddress) return;
    const r = await readFriendsThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (r.ok) { setFriends({ friends: r.friends, requests: r.requests, requested: r.requested }); setFriendsErr(''); } else setFriendsErr(r.error);
  }, [session, agentAddress]);
  useEffect(() => { void loadFriends(); }, [loadFriends]);
  useEffect(() => {
    if (!session) return;
    const auth = { authorization: `Bearer ${session.token}` };
    const beat = () => { void fetch('/a2a/presence/beat', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ label: 'at their Home' }) }).catch(() => {}); };
    const read = () => {
      void fetch('/a2a/presence/friends', { headers: auth }).then((r) => r.json()).then((d: { ok?: boolean; friends?: Array<{ agent: string; presence: Array<{ app: string; label?: string; at: number }> }> }) => {
        if (d.ok) setPresence(Object.fromEntries((d.friends ?? []).map((f) => [f.agent.toLowerCase(), f.presence])));
      }).catch(() => {});
    };
    beat(); read();
    const t = setInterval(() => { beat(); read(); }, 30_000);
    const gone = () => { void fetch('/a2a/presence/beat', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ gone: true }), keepalive: true }).catch(() => {}); };
    window.addEventListener('pagehide', gone);
    return () => { clearInterval(t); window.removeEventListener('pagehide', gone); gone(); };
  }, [session]);
  // A link from an app can name whom to add (`/contacts?add=bob.me`) or open the email invitation (`?invite=1`).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const add = (q.get('add') ?? '').trim();
    if (add) { setWho(add); setRole('friend'); }
    const em = (q.get('invite') ?? '').trim();
    if (em && em !== '1') setInviteEmail(em);
  }, []);
  // The flyout's run finishes elsewhere; re-read when it says something happened (`ap:ask-done`).
  useEffect(() => {
    const on = () => { void load(); void loadFriends(); };
    window.addEventListener('ap:ask-done', on);
    return () => window.removeEventListener('ap:ask-done', on);
  }, [load]);

  // FIND THE AGENT, rather than typing an address from memory. A name is a public, on-chain fact (ADR-0040); searching
  // it discloses nothing about who is asking. A typed name (bob.me, goose-1.svc) is used as typed.
  useEffect(() => {
    const term = who.trim();
    if (term.length < 2 || term.includes('.') || /^0x[0-9a-fA-F]{6,}$/.test(term)) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => { void searchAgentsKb(term, 6).then((r) => { if (!cancelled) setHits(r.filter((x) => x.smartAgent)); }).catch(() => { if (!cancelled) setHits([]); }); }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [who]);

  const add = () => {
    const contact = picked?.agent ?? who.trim();
    if (!contact) return;
    const label = picked?.label ?? contact;
    askCommand({ toolId: 'person.contact.invite', args: { contact, role }, message: `add ${label} as a contact (${ROLE_WORDS[role]})` });
    setWho(''); setPicked(null); setHits([]);
  };
  const remove = (c: ContactRow) => {
    askCommand({ toolId: 'person.contact.remove', args: { contact: c.contact }, message: `remove ${c.name ?? c.contact} as a contact` });
  };

  const sendInvite = async () => {
    if (!session) return;
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteState({ busy: true });
    try {
      const r = await fetch('/connect/friend-invite/email', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ email, note: inviteNote.trim() || undefined, fromName: agentName ?? undefined }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; delivery?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? `could not send (${r.status})`);
      setInviteState({ busy: false, done: d.delivery === 'sent' ? `Sent to ${email}. When they accept and you add them back, you are friends.` : `Logged (this deployment sends no mail): ${email}.` });
      setInviteEmail(''); setInviteNote('');
    } catch (e) { setInviteState({ busy: false, error: e instanceof Error ? e.message : String(e) }); }
  };
  const addBack = (agent: string, name: string | null) => {
    askCommand({ toolId: 'person.contact.invite', args: { contact: agent, role: 'friend' }, message: `add ${name ?? agent} as a contact (friend)` });
  };

  if (!session || !agentAddress) return null;
  return (
    <>
      <Section title="Friends" count={friends?.friends.length || undefined} testId="friends">
        {friendsErr && <ErrorNote>{friendsErr}</ErrorNote>}
        {!friends && !friendsErr && <Meta>Reading your friends…</Meta>}
        {friends && friends.requests.length > 0 && (
          <>
            <Meta>Waiting on you — they added you:</Meta>
            <List>
              {friends.requests.map((r) => (
                <Row key={r.agent}
                  title={r.name ? <span title={r.agent}>{r.name}</span> : <AgentName address={r.agent} />}
                  meta={r.at ? `added you ${new Date(r.at).toLocaleDateString()}` : undefined}
                  side={<Button size="sm" variant="primary" onClick={() => addBack(r.agent, r.name)}>Add back</Button>} />
              ))}
            </List>
          </>
        )}
        {friends && friends.friends.length === 0 && friends.requests.length === 0 && (
          <Empty title="No friends yet.">Add a person as a contact (role friend) below, or invite one by email. You are friends once they add you back.</Empty>
        )}
        {friends && friends.friends.length > 0 && (
          <List>
            {friends.friends.map((f) => (
              <Row key={f.agent}
                title={f.name ? <span title={f.agent}>{f.name}</span> : <AgentName address={f.agent} />}
                meta={<>{`friends since ${new Date(f.since).toLocaleDateString()}`}{presence[f.agent.toLowerCase()]?.length ? <> · <span style={{ color: 'var(--color-sage-700)' }}>● {presence[f.agent.toLowerCase()]!.map((p) => p.label ?? p.app).join(', ')}</span></> : null}</>}
                side={<Chip tone="ok">mutual</Chip>} />
            ))}
          </List>
        )}
        {friends && friends.requested.length > 0 && (
          <Note>Not yet added you back: {friends.requested.map((r) => r.name ?? r.agent).join(', ')}.</Note>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 'var(--sp-2)' }}>
          <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="invite a friend by email" aria-label="Friend's email" style={{ flex: '1 1 220px', minWidth: 0 }} />
          <input value={inviteNote} onChange={(e) => setInviteNote(e.target.value)} placeholder="a note (optional)" aria-label="Note" style={{ flex: '2 1 240px', minWidth: 0 }} />
          <Button variant="primary" onClick={() => void sendInvite()} disabled={inviteState.busy || !inviteEmail.trim()}>{inviteState.busy ? 'Sending…' : 'Invite'}</Button>
        </div>
        {inviteState.done && <Note>{inviteState.done}</Note>}
        {inviteState.error && <ErrorNote>{inviteState.error}</ErrorNote>}
        <Note>The mail goes out as you. The link lets them sign in or set up a home and add you as a friend; you then add them back. Nothing in the link grants anything.</Note>
      </Section>
      <Section title="Add a contact">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <input value={who} onChange={(e) => { setWho(e.target.value); setPicked(null); }} placeholder="a name, bob.me, goose-1.svc, or an address" aria-label="Who to add" style={{ width: '100%' }} />
            {hits.length > 0 && !picked && (
              <List>
                {hits.map((h) => (
                  <Row key={h.smartAgent} title={h.displayName || h.name || h.smartAgent} meta={h.name && h.displayName ? h.name : undefined} side={<Button size="sm" onClick={() => { setPicked({ agent: h.smartAgent!, label: h.name || h.displayName || h.smartAgent! }); setWho(h.name || h.displayName || h.smartAgent!); setHits([]); }}>Pick</Button>} />
                ))}
              </List>
            )}
          </div>
          <select value={role} onChange={(e) => setRole(e.target.value as ContactRole)} aria-label="Role">
            {CONTACT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button variant="primary" onClick={add} disabled={!who.trim()}>Add</Button>
        </div>
        <Note>Adding a contact is your act: you sign a grant that lets them read your contact profile — nothing else. The role says what they are to you; it authorizes nothing. A person becomes mutual when they add you back; a coach or a runtime is one-way.</Note>
      </Section>
      <Section title="Your contacts" count={rows.length || undefined} aside={removedCount ? <Meta>{removedCount} removed</Meta> : undefined}>
        {/* agent-vocabulary.md D3 — a role is what the contact is TO YOU; the filter narrows by it. A coach is a contact with
            role coach: hiring a coaching SERVICE (the study grant, the specialist lines) lives behind that filter. */}
        {rows.length > 0 && (
          <div className="ui-filter" style={{ marginBottom: 'var(--sp-2)' }}>
            <FilterChip active={roleFilter === 'all'} count={rows.length} onClick={() => setRoleFilter('all')}>All</FilterChip>
            {CONTACT_ROLES.filter((r) => rows.some((c) => c.role === r)).map((r) => <FilterChip key={r} active={roleFilter === r} count={rows.filter((c) => c.role === r).length} onClick={() => setRoleFilter(r)}>{r}</FilterChip>)}
          </div>
        )}
        {roleFilter === 'coach' && <Note>A coach is a service you consult under a study grant. <a href="/coaches">Hire or release a coaching service →</a></Note>}
        {err && <ErrorNote>{err}</ErrorNote>}
        {!loaded && !err && <Meta>Reading your contacts…</Meta>}
        {loaded && !err && rows.length === 0 && <Empty title="No contacts yet.">Add a person, a coach service, or an outside runtime above — or tell your agent: “add bob.me as a contact”.</Empty>}
        {rows.length > 0 && (
          <List>
            {rows.filter((c) => roleFilter === 'all' || c.role === roleFilter).map((c) => (
              <Row key={c.contact}
                title={c.name ? <span title={c.contact}>{c.name}</span> : <AgentName address={c.contact} />}
                meta={<>{c.since ? `since ${new Date(c.since).toLocaleDateString()}` : null}{c.grantDigest ? <> · grant <Mono title={c.grantDigest}>{c.grantDigest.slice(0, 10)}…</Mono></> : null}</>}
                side={<><Chip>{c.role}</Chip><Chip>{kindWords(c.name)}</Chip>{c.mutual === true ? <Chip tone="ok">mutual</Chip> : c.mutual === false ? <Chip>one-way</Chip> : null}<Button size="sm" variant="danger" onClick={() => remove(c)}>Remove</Button></>}
              />
            ))}
          </List>
        )}
        <Note>Held in your own vault, published nowhere. Removing a contact revokes the grant on chain — every gate refuses it from the next request.</Note>
      </Section>
    </>
  );
}
