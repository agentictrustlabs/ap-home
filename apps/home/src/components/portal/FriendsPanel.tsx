'use client';
// FRIENDS — two-way, self-sovereign relationships (spec 401; owner, 2026-10-26). Written for anyone, not for engineers:
// no grants, digests or roles on the screen — just who your friends are, who wants to be, and what you can do next.
//
// A friendship is two halves, each kept by its own person in their own vault: you add someone (your half), they add
// you back (theirs). Until both stand it is a REQUEST — sent by you, or waiting on you. When the other person removes
// you, their half is gone: the friendship ENDS and this screen says so, and offers to remove yours too (your half is
// your grant, so only your signature can take it back — it is never removed for you).
//
// This surface adds NO invoker of its own: it reads `person.friend.list` and hands `person.contact.invite` /
// `person.contact.remove` (the capabilities' stored wire names) to the Ask as commands — the flyout asks, the person
// signs there, and the receipt lands where every receipt lands.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { Section, List, Empty, ErrorNote, Note, Button, LinkButton, Chip, Meta, FilterChip, Avatar } from '../../ui';
import { AgentName } from '../shared/AgentName';
import { askCommand } from '../../home/ask-command';
import { readFriendsThroughHarness, FRIEND_TYPES, FRIEND_TYPE_WORDS, type FriendType, type FriendsView } from '../../home/friends-harness';
import { playbookBehind, playbookBehindWords } from '../../home/playbook-behind';
import { searchAgentsKb } from '../../lib/agent-search';
import { kindOfName } from '@agenticprimitives/ontology/participant-vocabulary';
import { whitelabel } from '../../whitelabel/config';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (agent: string, name: string | null) => name ?? short(agent);

/** One person on the screen: their face (initials until friends' photos can be read), their name, a line under it. */
function Person({ agent, name, line, side, testId }: { agent: string; name: string | null; line?: React.ReactNode; side?: React.ReactNode; testId?: string }) {
  return (
    <div className="ui-row" {...(testId ? { 'data-testid': testId } : {})}>
      <div className="ui-row-lead"><Avatar name={name} address={agent} agent={false} /></div>
      <div className="ui-row-main">
        <div className="ui-row-title">{name ? <span title={agent}>{name}</span> : <AgentName address={agent} />}</div>
        {line && <div className="ui-row-meta">{line}</div>}
      </div>
      {side && <div className="ui-row-side" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>{side}</div>}
    </div>
  );
}

function TypeSelect({ value, onChange, label: aria }: { value: FriendType; onChange: (t: FriendType) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as FriendType)} aria-label={aria} style={{ minWidth: 0 }}>
      {FRIEND_TYPES.map((t) => <option key={t} value={t}>{FRIEND_TYPE_WORDS[t]}</option>)}
    </select>
  );
}

export function FriendsPanel() {
  const { session, agentAddress, agentName } = useSession();
  const [view, setView] = useState<FriendsView | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<FriendType | 'all'>('all');
  // Add a friend: a name typed or picked from what the search finds, and the type you give them.
  const [who, setWho] = useState('');
  const [picked, setPicked] = useState<{ agent: string; label: string } | null>(null);
  const [hits, setHits] = useState<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>([]);
  const [addType, setAddType] = useState<FriendType>('friend');
  // Accepting a request: the type you give them, per request.
  const [acceptType, setAcceptType] = useState<Record<string, FriendType>>({});
  // Invite by email — someone with no home yet; the mail goes out as you.
  const [emailOpen, setEmailOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNote, setInviteNote] = useState('');
  const [inviteState, setInviteState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false });
  // Where each friend is right now (the runtime's /presence/friends); this page beats so friends see "at their Home".
  const [presence, setPresence] = useState<Record<string, Array<{ app: string; label?: string; at: number }>>>({});

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    const r = await readFriendsThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (r.ok) { setView({ friends: r.friends, requests: r.requests, requested: r.requested, ended: r.ended }); setErr(''); }
    else { const behind = playbookBehind(r.error); setErr(behind ? playbookBehindWords(behind.toolId) : r.error); }
  }, [session, agentAddress]);
  useEffect(() => { void load(); }, [load]);
  // The flyout's run finishes elsewhere; read again when it says something happened.
  useEffect(() => {
    const on = () => { void load(); };
    window.addEventListener('ap:ask-done', on);
    return () => window.removeEventListener('ap:ask-done', on);
  }, [load]);

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

  // A link can name whom to add (`/friends?add=bob.me`) or open the email invitation (`?invite=<email>` or `?invite=1`).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const add = (q.get('add') ?? '').trim();
    if (add) setWho(add);
    const em = (q.get('invite') ?? '').trim();
    if (em) { setEmailOpen(true); if (em !== '1') setInviteEmail(em); }
  }, []);
  // AN APP'S ONE REQUEST (`?add=<address or name>&from=<app>`): the add starts once the session is here, so the one tap
  // left is the approval itself. A name is looked up first; one that resolves to nobody stays in the field.
  const addAsked = useRef(false);
  useEffect(() => {
    if (!session || addAsked.current) return;
    const add = (new URLSearchParams(window.location.search).get('add') ?? '').trim();
    if (!add) return;
    addAsked.current = true;
    void (async () => {
      const agent = ADDRESS.test(add)
        ? add.toLowerCase()
        : await fetch(`/connect/name-info?name=${encodeURIComponent(add.toLowerCase())}`)
            .then((r) => r.json())
            .then((b: { exists?: boolean; agent?: string }) => (b.exists && b.agent ? b.agent.toLowerCase() : null))
            .catch(() => null);
      if (!agent) return;
      const name = (new URLSearchParams(window.location.search).get('name') ?? '').trim() || add;
      askCommand({ toolId: 'person.contact.invite', args: { contact: agent, role: 'friend' }, message: `add ${name} as a friend`, ...(/^0x/i.test(name) ? {} : { labels: { [agent]: name } }) });
    })();
  }, [session]);
  // …or whom to remove (`?remove=<address or name>`): the same act as the row's Remove — the flyout still asks first.
  const removeAsked = useRef(false);
  useEffect(() => {
    if (!session || removeAsked.current) return;
    const rm = (new URLSearchParams(window.location.search).get('remove') ?? '').trim();
    if (!ADDRESS.test(rm) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(rm)) return;
    removeAsked.current = true;
    const name = (new URLSearchParams(window.location.search).get('name') ?? '').trim();
    askCommand({ toolId: 'person.contact.remove', args: { contact: rm }, message: `remove ${name || rm} as a friend`, ...(name && ADDRESS.test(rm) ? { labels: { [rm.toLowerCase()]: name } } : {}) });
  }, [session]);
  // Opened by an app for one add or remove (`&from=<app>`): once it is done, say so and close, back to the app.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('from') || !(q.get('add') || q.get('remove'))) return;
    const done = () => { setClosing(true); setTimeout(() => window.close(), 1500); };
    window.addEventListener('ap:ask-done', done);
    return () => window.removeEventListener('ap:ask-done', done);
  }, []);

  // FIND THEM BY NAME rather than typing an address. A name is public (ADR-0040); searching discloses nothing about you.
  useEffect(() => {
    const term = who.trim();
    if (term.length < 2 || term.includes('.') || /^0x[0-9a-fA-F]{6,}$/.test(term)) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchAgentsKb(term, 6)
        .then((r) => { if (!cancelled) setHits(r.filter((x) => x.smartAgent && (kindOfName(x.name ?? null) ?? 'person') === 'person')); })
        .catch(() => { if (!cancelled) setHits([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [who]);

  const sendRequest = () => {
    const contact = picked?.agent ?? who.trim();
    if (!contact) return;
    const name = picked?.label ?? contact;
    askCommand({ toolId: 'person.contact.invite', args: { contact, role: addType }, message: addType === 'friend' ? `add ${name} as a friend` : `add ${name} as a friend (${addType})`, ...(picked && !/^0x/i.test(name) ? { labels: { [picked.agent.toLowerCase()]: name } } : {}) });
    setWho(''); setPicked(null); setHits([]); setAddType('friend');
  };
  const accept = (agent: string, name: string | null) => {
    const type = acceptType[agent] ?? 'friend';
    askCommand({ toolId: 'person.contact.invite', args: { contact: agent, role: type }, message: type === 'friend' ? `add ${label(agent, name)} as a friend` : `add ${label(agent, name)} as a friend (${type})`, ...(name ? { labels: { [agent]: name } } : {}) });
  };
  const remove = (agent: string, name: string | null, words: (who: string) => string) => {
    askCommand({ toolId: 'person.contact.remove', args: { contact: agent }, message: words(label(agent, name)), ...(name ? { labels: { [agent]: name } } : {}) });
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
      setInviteState({ busy: false, done: d.delivery === 'sent' ? `Invitation sent to ${email}.` : `This Home doesn't send mail, so nothing went out to ${email}.` });
      setInviteEmail(''); setInviteNote('');
    } catch (e) { setInviteState({ busy: false, error: e instanceof Error ? e.message : String(e) }); }
  };

  if (!session || !agentAddress) return null;
  // Opened by an app for one friend act: that act is the whole page.
  const forApp = typeof window !== 'undefined' && /[?&]from=/.test(window.location.search) && /[?&](add|remove)=/.test(window.location.search);
  if (forApp)
    return (
      <Section title={closing ? 'Done' : /[?&]add=/.test(window.location.search) ? 'Adding a friend' : 'Removing a friend'} testId="friends-for-app">
        <Meta>{closing ? 'Done — taking you back.' : 'Answer the question that opened beside this. This window closes by itself when you have.'}</Meta>
      </Section>
    );

  const friends = view?.friends ?? [];
  const types = FRIEND_TYPES.filter((t) => friends.some((f) => f.type === t));
  const shown = friends.filter((f) => filter === 'all' || f.type === filter);
  const here = (agent: string) => presence[agent.toLowerCase()] ?? [];

  return (
    <>
      {closing && <Meta>Done — taking you back.</Meta>}
      {err && <ErrorNote>{err}</ErrorNote>}

      {view && view.requests.length > 0 && (
        <Section title="Friend requests" count={view.requests.length} testId="friend-requests">
          <List>
            {view.requests.map((r) => (
              <Person key={r.agent} agent={r.agent} name={r.name} testId={`request-${r.agent}`}
                line={`Wants to be your friend${r.at ? ` · ${day(r.at)}` : ''}`}
                side={<>
                  <TypeSelect value={acceptType[r.agent] ?? 'friend'} onChange={(t) => setAcceptType((p) => ({ ...p, [r.agent]: t }))} label={`What ${label(r.agent, r.name)} is to you`} />
                  <Button size="sm" variant="primary" onClick={() => accept(r.agent, r.name)}>Accept</Button>
                </>} />
            ))}
          </List>
        </Section>
      )}

      <Section title="Your friends" count={friends.length || undefined} testId="friends">
        {!view && !err && <Meta>Loading your friends…</Meta>}
        {view && types.length > 1 && (
          <div className="ui-filter" style={{ marginBottom: 'var(--sp-2)' }}>
            <FilterChip active={filter === 'all'} count={friends.length} onClick={() => setFilter('all')}>All</FilterChip>
            {types.map((t) => <FilterChip key={t} active={filter === t} count={friends.filter((f) => f.type === t).length} onClick={() => setFilter(t)}>{FRIEND_TYPE_WORDS[t]}</FilterChip>)}
          </div>
        )}
        {view && friends.length === 0 && view.ended.length === 0 && (
          <Empty title="No friends yet">Find someone below and send a friend request. You become friends when they accept.</Empty>
        )}
        {(shown.length > 0 || (view?.ended.length ?? 0) > 0) && (
          <List>
            {shown.map((f) => (
              <Person key={f.agent} agent={f.agent} name={f.name} testId={`friend-${f.agent}`}
                line={<>
                  {f.type !== 'friend' && <>{FRIEND_TYPE_WORDS[f.type]} · </>}Friends since {day(f.since)}
                  {here(f.agent).length > 0 && <> · <span style={{ color: 'var(--color-sage-700)' }}>● {here(f.agent).map((p) => p.label ?? p.app).join(', ')}</span></>}
                </>}
                side={<>
                  <LinkButton size="sm" href={`/messages?to=${f.agent}`}>Message</LinkButton>
                  <Button size="sm" variant="ghost" onClick={() => remove(f.agent, f.name, (w) => `remove ${w} as a friend`)}>Remove</Button>
                </>} />
            ))}
            {/* THEY REMOVED YOU — shown, never silently dropped: your half still stands (they can still see your
                profile) until you remove it, which only your signature can do. */}
            {filter === 'all' && view?.ended.map((e) => (
              <Person key={e.agent} agent={e.agent} name={e.name} testId={`ended-${e.agent}`}
                line={<span style={{ color: 'var(--color-danger, #b3261e)' }}>{label(e.agent, e.name)} removed you as a friend{e.endedAt ? ` on ${day(e.endedAt)}` : ''}. Remove them too to stop sharing your profile.</span>}
                side={<><Chip tone="warn">No longer friends</Chip><Button size="sm" variant="primary" onClick={() => remove(e.agent, e.name, (w) => `remove ${w} as a friend`)}>Remove</Button></>} />
            ))}
          </List>
        )}
      </Section>

      <Section title="Add a friend" testId="add-friend">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <input value={who} onChange={(e) => { setWho(e.target.value); setPicked(null); }} placeholder="Search by name" aria-label="Who to add" style={{ width: '100%' }} />
            {hits.length > 0 && !picked && (
              <List>
                {hits.map((h) => {
                  const name = h.name || h.displayName || null;
                  return (
                    <Person key={h.smartAgent} agent={h.smartAgent!} name={h.displayName || h.name || null} line={h.displayName && h.name ? h.name : undefined}
                      side={<Button size="sm" onClick={() => { setPicked({ agent: h.smartAgent!, label: name ?? h.smartAgent! }); setWho(h.displayName || h.name || h.smartAgent!); setHits([]); }}>Choose</Button>} />
                  );
                })}
              </List>
            )}
          </div>
          <TypeSelect value={addType} onChange={setAddType} label="What they are to you" />
          <Button variant="primary" onClick={sendRequest} disabled={!who.trim()}>Send request</Button>
        </div>
        <Note>They’ll get your request and become your friend when they accept. Friends can see your profile; you can remove a friend at any time.</Note>
        {!emailOpen
          ? <Button size="sm" variant="ghost" onClick={() => setEmailOpen(true)}>Not on {whitelabel.brand.name} yet? Invite them by email</Button>
          : (
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="their email" aria-label="Their email" style={{ flex: '1 1 220px', minWidth: 0 }} />
                <input value={inviteNote} onChange={(e) => setInviteNote(e.target.value)} placeholder="a short note (optional)" aria-label="A note" style={{ flex: '2 1 240px', minWidth: 0 }} />
                <Button variant="primary" onClick={() => void sendInvite()} disabled={inviteState.busy || !inviteEmail.trim()}>{inviteState.busy ? 'Sending…' : 'Send invitation'}</Button>
              </div>
              <Meta>The email comes from you. When they join, they can add you — then you’ll see their request here.</Meta>
              {inviteState.done && <Note>{inviteState.done}</Note>}
              {inviteState.error && <ErrorNote>{inviteState.error}</ErrorNote>}
            </div>
          )}
      </Section>

      {view && view.requested.length > 0 && (
        <Section title="Requests you sent" count={view.requested.length} testId="friend-requests-sent">
          <List>
            {view.requested.map((r) => (
              <Person key={r.agent} agent={r.agent} name={r.name} testId={`sent-${r.agent}`}
                line={`Waiting for them to accept · sent ${day(r.since)}`}
                side={<Button size="sm" variant="ghost" onClick={() => remove(r.agent, r.name, (w) => `cancel my friend request to ${w}`)}>Cancel</Button>} />
            ))}
          </List>
        </Section>
      )}

      <Note>Only you can see this list. It’s kept in your own private storage, not on any public directory.</Note>
    </>
  );
}
