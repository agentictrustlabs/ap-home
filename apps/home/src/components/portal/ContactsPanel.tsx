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
import { playbookBehind, playbookBehindWords } from '../../home/playbook-behind';
import { Section, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta } from '../../ui';
import { AgentName } from '../shared/AgentName';
import { askCommand } from '../../home/ask-command';
import { readContactsThroughHarness, CONTACT_ROLES, type ContactRole, type ContactRow } from '../../home/contacts-harness';
import { searchAgentsKb } from '../../lib/agent-search';

const ROLE_WORDS: Record<string, string> = { friend: 'friend', family: 'family', coach: 'coach', assistant: 'assistant', runtime: 'runtime', other: 'contact' };

export function ContactsPanel() {
  const { session, agentAddress } = useSession();
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [removedCount, setRemovedCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [who, setWho] = useState('');
  const [role, setRole] = useState<ContactRole>('friend');
  const [hits, setHits] = useState<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>([]);
  const [picked, setPicked] = useState<{ agent: string; label: string } | null>(null);

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    const r = await readContactsThroughHarness({ person: agentAddress as Address, session: { token: session.token } });
    if (r.ok) { setRows(r.contacts); setRemovedCount(r.removed); setErr(''); } else { const behind = playbookBehind(r.error); setErr(behind ? playbookBehindWords(behind.toolId) : r.error); }
    setLoaded(true);
  }, [session, agentAddress]);
  useEffect(() => { void load(); }, [load]);
  // The flyout's run finishes elsewhere; re-read when it says something happened (`ap:ask-done`).
  useEffect(() => {
    const on = () => { void load(); };
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

  if (!session || !agentAddress) return null;
  return (
    <>
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
        {err && <ErrorNote>{err}</ErrorNote>}
        {!loaded && !err && <Meta>Reading your contacts…</Meta>}
        {loaded && !err && rows.length === 0 && <Empty title="No contacts yet.">Add a person, a coach service, or an outside runtime above — or tell your agent: “add bob.me as a contact”.</Empty>}
        {rows.length > 0 && (
          <List>
            {rows.map((c) => (
              <Row key={c.contact}
                title={c.name ? <span title={c.contact}>{c.name}</span> : <AgentName address={c.contact} />}
                meta={<>{c.since ? `since ${new Date(c.since).toLocaleDateString()}` : null}{c.grantDigest ? <> · grant <Mono title={c.grantDigest}>{c.grantDigest.slice(0, 10)}…</Mono></> : null}</>}
                side={<><Chip>{c.role}</Chip>{c.mutual === true ? <Chip tone="ok">mutual</Chip> : c.mutual === false ? <Chip>one-way</Chip> : null}<Button size="sm" variant="danger" onClick={() => remove(c)}>Remove</Button></>}
              />
            ))}
          </List>
        )}
        <Note>Held in your own vault, published nowhere. Removing a contact revokes the grant on chain — every gate refuses it from the next request.</Note>
      </Section>
    </>
  );
}
