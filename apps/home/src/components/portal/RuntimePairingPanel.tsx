'use client';
// PAIR A RUNTIME (spec 400 W1b) — your own Claude Code / goose / Codex as a member of a workspace, from this screen.
//
// Three beats. MINT: name the member and the workspace, choose what it may do without asking, get a code and the one
// command to run where the runtime lives. CLAIM: the runtime shows up here with the key it generated — in words, what
// it will get. APPROVE: her browser charters, invites and equips it; every signature hers. Then the runtime takes its
// record and the member appears on the roster and on the grants screen, revocable there. A code lives fifteen minutes.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { listManagedAgents } from '../../connect-client';
import { Panel, Row, List, KeyValue, Button, Chip, Mono, Meta, ErrorNote, Note, Micro, type PanelState } from '../../ui';
import { WorkingBar } from '../onboarding/WorkingBar';
import { mintPairing, listPairings, cancelPairing, approvePairing, pairCommand, type PairingStateV1 } from '../../home/runtime-pairing';
import { nameLabel } from '../../lib/domain';

const AGENT_HINT: Record<string, string> = { 'claude-code-acp': 'Claude Code', 'acp-stub-agent': 'the stub agent', goose: 'goose' };
const agentWords = (a?: string) => (a ? AGENT_HINT[a] ?? a : 'a runtime');
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function RuntimePairingPanel() {
  const { session, agentAddress, profile } = useSession();
  const me = (agentAddress ?? '') as Address;
  const [orgs, setOrgs] = useState<Array<{ agent: Address; name: string; stewardshipDelegation?: unknown }> | null>(null);
  const [pairings, setPairings] = useState<PairingStateV1[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [replies, setReplies] = useState(true);
  const [wake, setWake] = useState<'poll' | 'container'>('poll');
  const [minting, setMinting] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [step, setStep] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session?.token || !me) return;
    try {
      const [o, p] = await Promise.all([listManagedAgents(session.token, 'any').catch(() => []), listPairings(me, session.token)]);
      setOrgs(o.filter((a) => a.relationship === 'steward' && a.kind !== 'service' && a.kind !== 'person-treasury' && a.kind !== 'org-treasury').map((a) => ({ agent: a.agent, name: a.name, ...(a.stewardshipDelegation ? { stewardshipDelegation: a.stewardshipDelegation } : {}) })));
      setPairings(p);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPairings([]); setOrgs([]); }
  }, [session?.token, me]);
  useEffect(() => { void load(); }, [load]);
  // A claim arrives from another machine — watch while a code is out.
  const waiting = (pairings ?? []).some((p) => p.state === 'minted' || p.state === 'claimed' || p.state === 'completed');
  useEffect(() => {
    if (!waiting || approving) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [waiting, approving, load]);

  const handle = profile?.name ?? '';
  const stewarded = orgs ?? [];
  const orgTypedName = (name: string) => (/\.[a-z]+$/.test(name) ? name : `${nameLabel(name)}.org`);

  async function mint() {
    if (!session?.token || !me) return;
    const clean = label.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (clean.length < 3) { setErr('Give the runtime a name of at least 3 characters — it becomes <name>.svc.'); return; }
    if (!workspace) { setErr('Pick the workspace it joins.'); return; }
    setMinting(true); setErr('');
    try {
      const ws = stewarded.find((o) => o.agent.toLowerCase() === workspace.toLowerCase());
      await mintPairing(me, session.token, handle, {
        member: `${clean}.svc`, workspace: orgTypedName(ws?.name ?? ''), validForSeconds: 30 * 86_400,
        openMandate: replies ? ['messaging.direct.send'] : [], messagingTo: [me, workspace as Address], wake,
      });
      setOpen(false); setLabel('');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setMinting(false); }
  }

  async function approve(p: Extract<PairingStateV1, { state: 'claimed' }>) {
    if (!session?.token || !me) return;
    setApproving(p.code); setStep('Starting…'); setErr(''); setDone(null);
    const r = await approvePairing({ me, handle, session: session.token, credential: profile?.credential, sessionVia: session.via, pairing: p, stewarded, onStep: setStep });
    setApproving(null); setStep('');
    if (!r.ok) setErr(r.error); else setDone(r.recordName);
    await load();
  }

  // The form, an approval in flight and a result all live in the body, so the panel is READY whenever one is showing.
  const state: PanelState = pairings === null ? 'loading' : pairings.length || open || approving || done || err ? 'ready' : 'empty';
  return (
    <Panel
      title="Your runtimes"
      count={pairings?.length}
      state={state}
      aside={<Button size="sm" variant={open ? 'secondary' : 'primary'} onClick={() => setOpen((v) => !v)}>{open ? 'Cancel' : 'Pair a runtime'}</Button>}
      empty={{ title: 'No runtime paired yet', hint: 'Your own Claude Code, goose or Codex can join a workspace you steward as a member — under grants you sign and can revoke.' }}
      testId="runtime-pairing"
      id="runtimes"
    >
      {err && <div className="ui-panel-body" style={{ paddingBottom: 0 }}><ErrorNote>{err}</ErrorNote></div>}
      {done && <div className="ui-panel-body" style={{ paddingBottom: 0 }}><Note>✓ {done} is paired — the runtime is picking up its record now. It is on the workspace roster and its grants are on your Grants screen.</Note></div>}
      {open && (
        <div className="ui-card ui-card--quiet" style={{ padding: 'var(--sp-3) var(--sp-4)', margin: 'var(--sp-3) var(--sp-4)', display: 'grid', gap: 'var(--sp-3)' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <Micro>Name for the runtime</Micro>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input className="ui-input" value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} placeholder="e.g. claude-laptop" aria-label="Runtime name" style={{ maxWidth: 260 }} />
              <Meta>.svc</Meta>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Micro>Workspace it joins</Micro>
            {orgs === null ? <Meta>reading the workspaces you steward…</Meta> : stewarded.length === 0 ? <Meta>You steward no workspace yet — create an organization first.</Meta> : (
              <select className="ui-input" value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace" style={{ maxWidth: 320 }}>
                <option value="">Choose…</option>
                {stewarded.map((o) => <option key={o.agent} value={o.agent}>{o.name}</option>)}
              </select>
            )}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--fs-sm)' }}>
            <input type="checkbox" checked={replies} onChange={(e) => setReplies(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Let it <strong>reply to messages</strong> without asking you each time (an open mandate for <Mono>messaging.direct.send</Mono> to you and the workspace, 30 days, revocable). Everything else it does still parks for your signature.</span>
          </label>
          <div style={{ display: 'grid', gap: 6 }}>
            <Micro>How it is reached</Micro>
            <div style={{ display: 'flex', gap: 12, fontSize: 'var(--fs-sm)', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="wake" checked={wake === 'poll'} onChange={() => setWake('poll')} /> It checks its inbox itself (your machine)</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="wake" checked={wake === 'container'} onChange={() => setWake('container')} /> Hosted next to the workspace, woken on each message</label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" size="sm" disabled={minting || !workspace || label.trim().length < 3} onClick={() => void mint()}>{minting ? 'Minting…' : 'Get a pairing code'}</Button>
            <Meta>The code lives 15 minutes and grants nothing by itself.</Meta>
          </div>
        </div>
      )}
      {approving && (
        <div className="ui-card ui-card--quiet" style={{ padding: 'var(--sp-3) var(--sp-4)', margin: 'var(--sp-3) var(--sp-4)' }}>
          <strong style={{ fontSize: 'var(--fs-sm)' }}>Approving {approving}</strong>
          <WorkingBar label={step} />
        </div>
      )}
      <List>
        {(pairings ?? []).map((p) => (
          <Row key={p.code}
            title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Mono>{p.code}</Mono><Chip tone={p.state === 'completed' ? 'ok' : p.state === 'claimed' ? 'warn' : undefined}>{p.state === 'minted' ? 'waiting for the runtime' : p.state === 'claimed' ? 'needs your approval' : p.state === 'completed' ? 'ready for the runtime to take' : p.state}</Chip></span>}
            meta={`${p.options.member} → ${p.options.workspace} · minted ${when(p.mintedAt)}${p.state === 'claimed' ? ` · claimed ${when(p.claim.claimedAt)} by ${agentWords(p.claim.agent)}` : ''}`}
            side={p.state === 'claimed' ? <Button size="sm" variant="primary" disabled={!!approving} onClick={() => void approve(p)}>Approve</Button> : p.state !== 'completed' ? <Button size="sm" onClick={() => void cancelPairing(me, session!.token, p.code).then(load)}>Cancel</Button> : undefined}
          >
            {p.state === 'minted' && (
              <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
                <Meta>Run this where the runtime lives:</Meta>
                <code className="ui-mono" style={{ display: 'block', padding: '.5rem .7rem', background: 'var(--color-surface-sunken)', borderRadius: 8, userSelect: 'all', overflowX: 'auto' }}>{pairCommand(p.code)}</code>
              </div>
            )}
            {p.state === 'claimed' && (
              <div style={{ marginTop: 8 }}>
                <KeyValue rows={[
                  ['Runtime key', <Mono key="k">{p.claim.address}</Mono>],
                  ['Runs', agentWords(p.claim.agent)],
                  ['It will get', `a session wire to speak as ${p.options.member} for ${Math.round(p.options.validForSeconds / 86_400)} days · your steward link · its vault key · the runtime-member playbook${p.options.openMandate.length ? ` · an open mandate for ${p.options.openMandate.join(', ')}` : ''}${p.options.messagingTo.length ? ` · a messaging rail to ${p.options.messagingTo.length} recipient(s)` : ''}`],
                  ['You sign', 'each grant with your connected credential — revocable on your Grants screen'],
                ]} />
              </div>
            )}
          </Row>
        ))}
      </List>
    </Panel>
  );
}
