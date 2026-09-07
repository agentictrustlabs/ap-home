'use client';
// THE ASK FLYOUT — one sliding panel any page can open, addressed to the realm you are standing in.
//
// Spec 350 §3.5. This is the Ask doing what the buttons do: you type "create a team called outreach"
// instead of walking a form, and the agent asks back for whatever it turns out to need. The panel's whole
// job is to render four replies honestly and to answer the ONE question it can answer itself — which
// credential is connected (`credential` fields are filled here, never put to the person).
//
// Two signatures, and they are different things, so the panel never blurs them:
//   • the MANDATE — "you may create teams under this workspace, for this request, for the next hour".
//     Granting authority. Shown in words before it is signed.
//   • the GENESIS — "this is the team, and I custody it". Bringing an agent into being. What you create,
//     you custody: it is signed with YOUR credential, never the agent's.
//
// The addressee comes from the workspace switcher's active scope, not from a second picker — one source
// of truth for "where am I", exactly as the sidebar uses.
import { useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { ask, mintMandate, mintApprovedMandate, canGrantAs, describeRequirement, homeScope, homeVocabulary, capabilityWords, type AskReply, type AskPrompt, type AskTurnState, type SuppliedInput, type AskField, type AskEvidence, type UnfinishedRun, type PlannerTrace, type AskVocabularyEntry, type CommandField } from '../../../home/ask';
import { resolveNavigationTarget } from '../../../lib/interaction-registry';
import { BusyButton } from '../../shared/BusyButton';
import { XIcon } from '../../shared/Icons';
import { AgentName } from '../../shared/AgentName';
import { connectedCredential } from './credential';
import { createdAgentOf, recordCreatedAgent, invitationOf, recordInvitation } from '../../../home/ask-record';

type Entry =
  | { role: 'you'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'agent'; reply: AskReply };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function AskFlyout({ addressee, addresseeLabel, realm, onClose, seed, onSeedUsed}: {
  addressee: Address; addresseeLabel: string;
  /** Where the person is standing, as this app understands it — the agent narrows what it OFFERS to it,
   *  and derives standing itself (spec 353 §4). */
  realm?: { kind?: 'person' | 'org' | 'service' };
  onClose: () => void;
  /** An ask a page wants to start on this surface. Prefills the composer; never sends. */
  seed?: string | null;
  onSeedUsed?: () => void;
}) {
  const { session, profile, agentAddress } = useSession();
  const [thread, setThread] = useState<Entry[]>([]);
  const [q, setQ] = useState('');
  // A page asked to start this ask (e.g. "finish the payment you were waiting on"). It lands in the
  // composer, where the person reads it and presses send — the same rule every suggested ask follows.
  useEffect(() => {
    if (!seed) return;
    setQ(seed);
    onSeedUsed?.();
  }, [seed]);
  // WHAT THE PERSON PICKED, in this surface's own words. After choosing "nathan.me" from four Nathans the
  // answer travels as an address, so the next card would show a bare 0x… — asking someone to re-verify a
  // choice they just made, against a string that tells them nothing. This is the surface remembering its
  // own UI, never a claim about the chain: it labels only values it displayed a label for.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  /** "Someone has asked you for a way to reach your treasury." Reported, never acted on. */
  const [waiting, setWaiting] = useState<string | null>(null);
  // spec 350 W3 — other unfinished runs on this agent that this person could pick up. The run is durable
  // on the agent; this is how they find it again after closing the tab.
  const [unfinished, setUnfinished] = useState<UnfinishedRun[]>([]);
  const [unfinishedTotal, setUnfinishedTotal] = useState(0);
  // COLLAPSED BY DEFAULT. This is a note beside the conversation, never a competitor to it.
  const [showUnfinished, setShowUnfinished] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // WHAT THE AGENT ACTUALLY DID, kept for the whole conversation rather than the last answer. A generated
  // query is the one piece of evidence a reader cannot reconstruct from the reply, and "the directory does
  // not list any organizations" — said of a directory holding 37 — was indistinguishable from a true answer
  // until the query was visible (spec 357 §4).
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [showDiag, setShowDiag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ reply: AskReply; state: AskTurnState } | null>(null);
  // Can this session AUTHORIZE anything here, or only ask? An agent can sit in your home's tree while its
  // custodian is someone else's credential — say so on arrival rather than at the end of a ceremony.
  const [canAuthorize, setCanAuthorize] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread, pending]);

  // Can this session AUTHORIZE anything here, or only ask? An agent can sit in your home's tree while its
  // custodian is someone else's credential — say so on arrival rather than at the end of a ceremony.
  useEffect(() => {
    let live = true;
    if (!session || !agentAddress) return;
    void (async () => {
      try {
        const cred = await connectedCredential(resolveVia(profile?.credential, session.via), agentAddress as Address, session.token);
        const ok = await canGrantAs(addressee, cred);
        if (live) setCanAuthorize(ok);
      } catch {
        if (live) setCanAuthorize(null); // unknown is not "no" — the grant-time check is the one that decides
      }
    })();
    return () => { live = false; };
  }, [addressee, agentAddress, session?.token, session?.via, profile?.credential]);

  useEffect(() => {
    let live = true;
    if (!session || !agentAddress) return;
    void (async () => {
      try {
        const cred = await connectedCredential(resolveVia(profile?.credential, session.via), agentAddress as Address, session.token);
        const ok = await canGrantAs(addressee, cred);
        if (live) setCanAuthorize(ok);
      } catch {
        if (live) setCanAuthorize(null); // unknown is not "no" — the grant-time check is the one that decides
      }
    })();
    return () => { live = false; };
  }, [addressee, agentAddress, session?.token, session?.via, profile?.credential]);

  const via = resolveVia(profile?.credential, session?.via);
  const signAs = async (sa: Address) => signHashFor(via, sa, { token: session!.token });

  /** One turn: send what we have, render what came back, and answer anything WE can answer (the
   *  connected credential) without troubling the person. */
  const turn = async (state: AskTurnState, label: string) => {
    if (!session) return;
    setErr(null);
    setBusy(label);
    const startedAt = Date.now();
    try {
      const { reply, resumable, waiting, unfinishedRuns, unfinishedTotal: total } = await ask(session, state);
      // Recorded for EVERY turn, answer or not: a run that asked for authority, or was refused, is exactly
      // the run somebody wants to look at afterwards.
      setDiag((d) => [...d, {
        at: new Date().toISOString(), ms: Date.now() - startedAt, kind: reply.kind,
        ...(state.message ? { question: state.message } : {}),
        evidence: (reply as { evidence?: AskEvidence[] }).evidence ?? [],
        ...(reply.kind === 'refused' ? { error: reply.error } : {}),
        ...(reply.plannerTrace ? { trace: reply.plannerTrace } : {}),
      }]);
      // Once the agent holds this run, later turns carry the runRef and the new answers only — the
      // mandate stops living here between turns.
      const carried: AskTurnState = resumable
        ? { ...state, runRef: reply.runRef, resumable: true, presented: null, supplied: [] }
        : { ...state, runRef: reply.runRef };
      // A `credential` field is ours to fill: the person is signed in, and what they create they custody.
      if (reply.kind === 'prompt' && reply.prompt.kind === 'data') {
        const fields = reply.prompt.fields;
        const credField = fields.find((f) => f.type === 'credential');
        const others = fields.filter((f) => f.type !== 'credential');
        if (credField) {
          const credential = await connectedCredential(via, agentAddress as Address, session.token);
          const next: AskTurnState = { ...carried, supplied: [...carried.supplied, { stepRef: reply.resumeToken, data: { [credField.name]: credential } }] };
          if (others.length === 0) return turn(next, 'Working…');   // nothing left to ask a human
          setPending({ reply: { ...reply, prompt: { ...reply.prompt, fields: others } }, state: next });
          setBusy(null);
          return;
        }
      }
      setThread((t) => [...t, { role: 'agent', reply }]);
      setPending(reply.kind === 'prompt' || reply.kind === 'authority_required' ? { reply, state: carried } : null);
      // SOMEBODY IS WAITING ON THEM. Said once per turn, after the answer — never instead of it, and
      // never as a card that has to be dismissed before they can carry on with what they came to do.
      if (waiting) setWaiting(waiting);
      setUnfinished(unfinishedRuns ?? []);
      setUnfinishedTotal(total ?? unfinishedRuns?.length ?? 0);
      // An agent's creation finishes HERE: the chain has the SA, its name and its stewardship; the person's
      // private vault gets the link that puts it in their tree (ADR-0025). Without this the agent is real,
      // named, and invisible in its owner's own home.
      if (reply.kind === 'done' && session) {
        // SOMETHING HAPPENED. Surfaces beside this one are showing what was waiting on this person — a
        // request to finish, a treasury balance — and after a run they are stale. They listen; this says
        // so once, rather than each of them polling on a timer for a thing that happens twice a week.
        window.dispatchEvent(new CustomEvent('ap:ask-done'));
        // An invitation's private half: the signed grant goes into the ORG's vault, where the invitee's
        // join looks for it. Without this the ask says "invited" and the invitee finds nothing.
        const invitation = invitationOf(reply.result);
        if (invitation) {
          const stored = await recordInvitation(invitation, session.token);
          setThread((t) => [...t, stored.ok
            ? { role: 'agent', text: 'The invitation is stored — they will pick it up when they join.' }
            : { role: 'agent', text: `The invitation was signed, but storing it in the organization failed (${stored.error}) — they will not find it until that write succeeds.` }]);
        }
        const created = createdAgentOf(reply.result);
        if (created && !created.alreadyCreated) {
          const saved = await recordCreatedAgent(created, session.token);
          setThread((t) => [...t, saved.ok
            ? { role: 'agent', text: `${created.name} is in your agents now.` }
            : { role: 'agent', text: `${created.name} was created, but saving it to your private tree failed (${saved.error}) — it is on chain and yours; the list may not show it until that write succeeds.` }]);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDiag((d) => [...d, { at: new Date().toISOString(), ms: Date.now() - startedAt, kind: 'error', ...(state.message ? { question: state.message } : {}), evidence: [], error: message }]);
      setErr(message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const message = q.trim();
    if (!message || !session) return;
    setQ('');
    setAnswers({});
    setThread((t) => [...t, { role: 'you', text: message }]);
    // The scope is computed per ask, not per session: it is the agent's published vocabulary ∩ what this
    // flyout can finish, and the agent being asked may not offer what the last one did.
    const surface = await homeScope(realm, addressee);
    await turn({ message, addressee, runRef: `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface }, 'Thinking…');
  };

  // Spec 367 §7 — THE SAME COMMAND, FILLED BY CONTROLS. "Do" offers the agent's capabilities as forms whose
  // fields come from the contracts (an Agent is a party field, an Amount a number). Submitting posts the
  // command as a supplied plan through the SAME turn as a sentence would take: the same resolver, the same
  // prompts when something is missing, the same authority card, the same receipt. A click is not a sentence
  // (no model re-derives it), and a form is not a second path.
  const [commands, setCommands] = useState<AskVocabularyEntry[]>([]);
  const [command, setCommand] = useState<AskVocabularyEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    void homeVocabulary(addressee).then((caps) => { if (!cancelled) setCommands(caps.filter((c) => c.fields?.length)); });
    return () => { cancelled = true; };
  }, [addressee]);
  const doCommand = async (cap: AskVocabularyEntry, args: Record<string, unknown>) => {
    if (!session) return;
    setCommand(null);
    setAnswers({});
    const said = Object.entries(args).filter(([, v]) => v !== '' && v !== undefined && v !== false).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
    const message = `${cap.label ?? cap.id}${said ? ` — ${said}` : ''}`;
    setThread((t) => [...t, { role: 'you', text: message }]);
    const surface = await homeScope(realm, addressee);
    await turn({ message, addressee, runRef: `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface, plan: { steps: [{ toolId: cap.id, args }] } }, 'Working…');
  };

  /** Grant the authority the agent said it needs — signed by the credential that custodies the DELEGATOR
   *  (the parent), which for a steward is their own. Then run the same ask again, with it. */
  const grant = async (reply: Extract<AskReply, { kind: 'authority_required' }>, state: AskTurnState) => {
    setBusy('Granting authority…');
    setErr(null);
    try {
      // Never ask for a signature we already know the verifier will reject. Only the credential that
      // CUSTODIES the delegator can grant as it — being in your home's tree is not custody.
      const credential = await connectedCredential(via, agentAddress as Address, session!.token);
      if (!(await canGrantAs(reply.delegator, credential))) {
        setPending(null);
        setBusy(null);
        setThread((t) => [...t, { role: 'agent', text: `You can’t grant this: ${short(reply.delegator)} is custodied by a different credential than the one you are signed in with. Whoever custodies it has to grant this authority.` }]);
        return;
      }
      // ONE PROMPT (spec 361 I4): an act needing more signatures from the same delegator (an invitation
      // also needs the org→invitee grant) approveHashes them all in one org userOp — one signature covers
      // the mandate AND the rest, and the run finds the grant already approved instead of prompting again.
      const wire = reply.alsoApprove?.length
        ? await mintApprovedMandate(reply, await signAs(reply.delegator), session!)
        : await mintMandate(reply, await signAs(reply.delegator));
      setThread((t) => [...t, { role: 'agent', text: `Authority granted: ${capabilityWords(reply.capability)}, for this request.` }]);
      setPending(null);
      await turn({ ...state, presented: wire }, 'Working…');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  /** Answer a prompt. Data goes back as typed; a signature is signed with the connected credential over
   *  the digest the agent derived — and the agent re-derives and checks it before it acts on it. */
  const answer = async (reply: Extract<AskReply, { kind: 'prompt' }>, state: AskTurnState) => {
    const p = reply.prompt;
    setBusy(p.kind === 'signature' ? 'Signing…' : 'Working…');
    setErr(null);
    try {
      let supplied: SuppliedInput;
      if (p.kind === 'data') {
        supplied = { stepRef: reply.resumeToken, data: Object.fromEntries(p.fields.map((f) => [f.name, answers[f.name] ?? ''])) };
      } else if (p.kind === 'signature') {
        const signature = await (await signAs(agentAddress as Address))(p.digest);
        // Signed BY the person in front of us. A prompt that named no signer (an obligation with no
        // particular approver) must not be answered as nobody — an approval attributed to '' verifies
        // against nothing and is refused, which reads as "you approved and it was rejected".
        const signer = p.signer || (agentAddress as string);
        supplied = { stepRef: reply.resumeToken, signature: { digest: p.digest, signer, signature, payload: p.payload } };
      } else {
        supplied = { stepRef: reply.resumeToken, confirmed: true };
      }
      setPending(null);
      setAnswers({});
      await turn({ ...state, supplied: [...state.supplied, supplied] }, 'Working…');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="ask-flyout" data-testid="ask-flyout" role="dialog" aria-label={`Asking ${addresseeLabel}`}>
      <div className="ask-flyout-h">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Asking {addresseeLabel}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {canAuthorize === false
              ? 'You can ask questions here, but a different credential custodies this agent — only it can authorize changes.'
              : 'Follows the workspace you are in — switch it in the topbar.'}
          </div>
        </div>
        <button
          type="button" className="btn ghost" data-testid="ask-diagnostics-toggle"
          aria-label="Show what the agent did" aria-pressed={showDiag}
          title="What the agent did — the tools it used and the queries it ran"
          style={{ fontSize: 11, padding: '2px 8px', marginRight: 6 }}
          onClick={() => setShowDiag((v) => !v)}
        >
          {showDiag ? 'Hide' : 'How'}{diag.length ? ` (${diag.length})` : ''}
        </button>
        <button type="button" className="btn ghost" data-testid="ask-close" aria-label="Close Ask" onClick={onClose}><XIcon size={16} /></button>
      </div>

      <div className="ask-flyout-body">
        {thread.length === 0 && !pending && (
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Ask {addresseeLabel} a question, or ask it to do something — “create a team called outreach”.
            Anything that changes the world will ask you to grant the authority for it first, and you will
            see exactly what you are granting.
          </p>
        )}
        {thread.map((e, i) => (
          <div key={i} className={e.role === 'you' ? 'ask-msg you' : 'ask-msg agent'}>
            {'text' in e ? <span>{e.text}</span> : <ReplyView reply={e.reply} realm={realm} addressee={addressee} />}
          </div>
        ))}
        {/* Somebody is waiting on a decision only they can make. A line, with the place to make it — not
            a card in the way of what they came here to do. */}
        {waiting && (
          <div className="ask-msg agent" data-testid="ask-waiting" style={{ fontSize: 12, opacity: 0.9 }}>
            {waiting.split(/(https?:\/\/\S+)/).map((part, i) => (
              /^https?:\/\//.test(part)
                ? <a key={i} href={part} style={{ textDecoration: 'underline' }}>{part.replace(/^https?:\/\//, '')}</a>
                : <span key={i}>{part}</span>
            ))}
          </div>
        )}
        {/* spec 350 W3 — an ask you left unfinished. It lives on the agent, not in this tab, so it is
            still there after a reload; picking it up re-runs it through every gate exactly as the first
            turn did. One line each, and only ones this person may resume. */}
        {unfinished.length > 0 && (
          <div className="ask-msg agent" data-testid="ask-unfinished" style={{ fontSize: 12, opacity: 0.9 }}>
            {/* ONE LINE, COLLAPSED. Listing every unfinished ask inline put 167 of them between a person
                and the answer they had just asked for. The COUNT is the notification; the list is
                something they choose to open. */}
            <button
              type="button"
              data-testid="ask-unfinished-toggle"
              onClick={() => setShowUnfinished((v) => !v)}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {unfinishedTotal === 1 ? 'You have 1 unfinished ask here' : `You have ${unfinishedTotal} unfinished asks here`}
              {showUnfinished ? ' — hide' : ' — show'}
            </button>
            {showUnfinished && unfinished.map((r) => (
              <div key={r.runRef} style={{ marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => void turn({ message: r.message, addressee, runRef: r.runRef, presented: null, supplied: [], resumable: true }, 'Picking it up…')}
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--color-sage-700, #3f6212)', textDecoration: 'underline', cursor: 'pointer', textAlign: 'left' }}
                >
                  “{r.message}”
                </button>
                {r.awaiting && <span style={{ opacity: 0.75 }}> — waiting on {r.awaiting.kind === 'signature' ? 'your signature' : r.awaiting.kind === 'confirmation' ? 'your confirmation' : 'an answer'}</span>}
              </div>
            ))}
            {showUnfinished && unfinishedTotal > unfinished.length && (
              <div style={{ marginTop: 4, opacity: 0.7 }}>
                …and {unfinishedTotal - unfinished.length} more. Unfinished asks expire after a day.
              </div>
            )}
          </div>
        )}
        {pending?.reply.kind === 'authority_required' && (
          <AuthorityCard
            reply={pending.reply} busy={busy} onGrant={() => grant(pending.reply as never, pending.state)} onCancel={() => setPending(null)}
            chosen={chosen}
            checkCustody={async (delegator) => canGrantAs(delegator, await connectedCredential(via, agentAddress as Address, session!.token))}
            onRequest={(text) => { setPending(null); setQ(text); }}
          />
        )}
        {pending?.reply.kind === 'prompt' && (
          <PromptCard
            prompt={pending.reply.prompt} answers={answers} setAnswers={setAnswers} busy={busy}
            onChoose={(value, label) => setChosen((m) => ({ ...m, [value.toLowerCase()]: label }))}
            onSuggest={(message) => { setPending(null); setQ(message); }}
            onAnswer={() => answer(pending.reply as never, pending.state)} onCancel={() => setPending(null)}
          />
        )}
        {busy && !pending && <div className="muted" data-testid="ask-busy" style={{ fontSize: 12 }}><span className="spinner" /> {busy}</div>}
        {err && <div className="ask-err" role="alert">{err}</div>}
        <div ref={endRef} />
      </div>

      {showDiag && <DiagnosticsPane entries={diag} onClose={() => setShowDiag(false)} />}

      {command && <CommandForm command={command} onSubmit={(args) => void doCommand(command, args)} onCancel={() => setCommand(null)} />}
      {commands.length > 0 && !command && !pending && (
        <div className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, padding: '0 2px 4px' }}>
          <span>Do:</span>
          <select data-testid="ask-command" className="input" style={{ fontSize: 11.5, padding: '2px 6px', minHeight: 0, width: 'auto' }} value="" onChange={(e) => { const c = commands.find((x) => x.id === e.target.value); if (c) setCommand(c); }} disabled={!!busy}>
            <option value="">choose an action…</option>
            {commands.map((c) => <option key={c.id} value={c.id}>{c.label ?? c.id}</option>)}
          </select>
        </div>
      )}
      <div className="ask-flyout-f">
        <input
          className="input" data-testid="ask-input" value={q} placeholder={`Ask ${addresseeLabel}…`}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
          disabled={!!busy || !!pending}
        />
        <BusyButton busy={busy === 'Thinking…'} busyLabel="Thinking…" disabled={!q.trim() || !!pending} onClick={() => void send()} className="btn primary">Ask</BusyButton>
      </div>
    </div>
  );
}

/**
 * Spec 367 §7 — a command's form, generated from its fields. An agent field takes a name or address (the
 * agent resolves it in the person's own tier, and asks with choices when it cannot — the same prompt the
 * sentence path shows); an amount is a number in whole units as the person says it; a flag is a checkbox.
 * The values are the person's WORDS: nothing here resolves, ranks, or fills in what was not given.
 */
function CommandForm({ command, onSubmit, onCancel }: { command: AskVocabularyEntry; onSubmit: (args: Record<string, unknown>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const fields = command.fields ?? [];
  const missing = fields.filter((f) => f.required && !String(values[f.name] ?? '').trim());
  const submit = () => {
    const args: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (f.kind === 'flag') { if (v === true) args[f.name] = true; continue; }
      if (typeof v === 'string' && v.trim()) args[f.name] = v.trim();
    }
    onSubmit(args);
  };
  return (
    <div className="ask-card" data-testid="ask-command-form" style={{ margin: '0 0 6px' }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{command.label ?? command.id}</div>
      {fields.map((f: CommandField) => (
        <div key={f.name} style={{ marginTop: 8 }}>
          <label className="muted" style={{ fontSize: 11.5, display: 'block' }} htmlFor={`ask-c-${f.name}`}>
            {f.label}{f.required ? '' : ' (optional)'}{f.kind === 'agent' && f.types?.length ? ` — a ${f.types.join(' / ')}` : ''}
          </label>
          {f.hint && <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{f.hint}</div>}
          {f.kind === 'flag' ? (
            <input id={`ask-c-${f.name}`} type="checkbox" checked={values[f.name] === true} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
          ) : (
            <input
              id={`ask-c-${f.name}`} className="input" data-testid={`ask-command-${f.name}`}
              type={f.kind === 'amount' ? 'number' : 'text'} inputMode={f.kind === 'amount' ? 'decimal' : undefined} step={f.kind === 'amount' ? 'any' : undefined}
              placeholder={f.kind === 'agent' ? 'a name (alice.me), a person you know, or an address' : f.kind === 'amount' ? 'e.g. 10' : ''}
              value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="btn primary" data-testid="ask-command-submit" disabled={missing.length > 0} onClick={submit}>{missing.length ? `Needs ${missing.map((f) => f.label).join(', ')}` : 'Do it'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** The verifier's codes are precise and unreadable. Say what they MEAN — and keep the original after it,
 *  because a person who reports a problem should be able to quote the thing the logs contain. */
function plainReason(error: string): string {
  const say = (m: string) => `${m} (${error})`;
  if (/not-live: delegation signature did not verify/.test(error)) return say('The credential that signed this authority does not custody that agent');
  if (/not-live: .*revoked/.test(error)) return say('That authority has been revoked on chain');
  if (/intent-mismatch/.test(error)) return say('That authority was granted for a different request');
  if (/expired|validUntil|not-live: outside/.test(error)) return say('That authority has expired — ask again to grant a fresh one');
  if (/action-not-granted/.test(error)) return say('That authority does not cover this action');
  if (/no-handler/.test(error)) return say('Nothing here can bound that kind of authority, so it was refused');
  return error;
}

/** One turn, as the diagnostics pane shows it: what was asked, how long it took, what came back, and what
 *  the agent read to get there. Client-side only — the receipts are the authority record (spec 350); this
 *  is the run explaining itself to the person who ran it. */
interface DiagEntry {
  at: string;
  ms: number;
  kind: string;
  question?: string;
  evidence: AskEvidence[];
  error?: string;
  /** Spec 367 wave 1 — what the planner received: planner, tools, playbook, admission, plan, bindings. */
  trace?: PlannerTrace;
}

/**
 * WHAT THE AGENT DID — the pane behind "How".
 *
 * The Ask answers in prose, and prose is where a wrong answer hides. "The directory does not list any
 * organizations" reads the same whether the directory is empty or the agent searched NAMES for the word
 * "organizations" and matched none. One is a fact and the other was a bug, and until the query was visible
 * there was no way to tell them apart — not for the person, and not for me.
 *
 * So: per turn, the question, what came back, how long it took, which tool ran, how that tool read the
 * question, and the query it actually sent. Copyable, because a query worth showing is one somebody will
 * want to paste somewhere.
 */
function DiagnosticsPane({ entries, onClose }: { entries: DiagEntry[]; onClose: () => void }) {
  return (
    <div data-testid="ask-diagnostics" style={{ borderTop: '1px solid var(--c-border, rgba(127,127,127,.25))', padding: '8px 12px', maxHeight: '45vh', overflowY: 'auto', fontSize: 11.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong style={{ fontSize: 11.5 }}>What this agent did</strong>
        <button type="button" className="btn ghost" style={{ fontSize: 11, padding: '1px 6px' }} onClick={onClose}>Close</button>
      </div>
      {entries.length === 0 && (
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Nothing yet. Ask something, and every step it takes — the tools it used and the queries it wrote —
          appears here.
        </p>
      )}
      {entries.map((e, i) => (
        <div key={i} data-testid={`ask-diag-${i}`} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: i < entries.length - 1 ? '1px dashed var(--c-border, rgba(127,127,127,.2))' : 'none' }}>
          <div className="muted" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{e.kind}</strong></span>
            <span>{(e.ms / 1000).toFixed(1)}s</span>
            <span>{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          {e.question && <div style={{ margin: '2px 0' }}>&ldquo;{e.question}&rdquo;</div>}
          {e.error && <div style={{ color: 'var(--c-danger, #dc2626)' }}>{e.error}</div>}
          {/* A turn with no tool step is not a defect — a refusal or an authority request reads nothing. */}
          {e.evidence.length === 0 && !e.error && <div className="muted">No tool read anything on this turn.</div>}
          {e.trace && <PlannerTraceView trace={e.trace} />}
          {e.evidence.map((ev, k) => (
            <div key={k} style={{ marginTop: 4 }}>
              <div className="muted">
                <strong>{ev.toolId}</strong>
                {typeof ev.count === 'number' ? ` · ${ev.count} result${ev.count === 1 ? '' : 's'}` : ''}
              </div>
              {ev.interpretation && <div className="muted">read as: {ev.interpretation}</div>}
              {ev.searched && <div className="muted">searched names for &ldquo;{ev.searched}&rdquo;</div>}
              {ev.reason && <div className="muted">{ev.reason}</div>}
              {ev.query && (
                <div style={{ position: 'relative' }}>
                  <pre style={{ margin: '4px 0 0', padding: 8, overflowX: 'auto', fontSize: 10.5, background: 'var(--c-surface-2, rgba(127,127,127,.12))', borderRadius: 6, whiteSpace: 'pre' }}>
                    {ev.query}
                  </pre>
                  <button
                    type="button" className="btn ghost" data-testid={`ask-diag-copy-${i}-${k}`}
                    style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '1px 6px' }}
                    onClick={() => { void navigator.clipboard?.writeText(ev.query ?? ''); }}
                  >Copy</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * WHAT THE PLANNER RECEIVED — spec 367 wave 1. Before a turn is called a reasoning failure, this answers
 * whether the capability was even offered, which playbook was in force, what admission said, what plan the
 * executor got, and where each party came from. Compact by default; the plan and tool list expand.
 */
function PlannerTraceView({ trace }: { trace: PlannerTrace }) {
  const [open, setOpen] = useState(false);
  const short = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);
  const refusals = trace.admission.filter((a) => a.refused.length);
  return (
    <div className="muted" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5 }}>
      <div>
        <strong>planner</strong> {trace.planner}
        {' · '}<strong>playbook</strong> {trace.playbook ? `${trace.playbook.archetypeId.replace(/^skill:archetypes\//, '')} v${trace.playbook.archetypeVersion} ${short(trace.playbook.digest)}` : 'none (bare harness)'}
        {' · '}<strong>examples</strong> {trace.examplesRendered}
        {' · '}<strong>tools</strong> {trace.toolsExposed.length}
        {trace.surface ? <> · <strong>surface</strong> {trace.surface.realm ?? '?'}{typeof trace.surface.capabilities === 'number' ? ` (${trace.surface.capabilities} caps)` : ''}</> : null}
        {' '}<button type="button" className="btn ghost" style={{ fontSize: 10, padding: '0 6px', minHeight: 0 }} onClick={() => setOpen((o) => !o)}>{open ? 'less' : 'more'}</button>
      </div>
      {refusals.map((a, i) => (
        <div key={i} style={{ color: 'var(--c-warning, #92700e)' }}>
          admission refused{a.replanned ? ' (re-planned)' : ' (final)'}: {a.refused.map((v) => `${v.code}${v.toolId ? ` @${v.toolId}` : ''}`).join(', ')}
        </div>
      ))}
      {trace.plan.length > 0 && (
        <div>plan: {trace.plan.map((s) => `${s.toolId}${Object.keys(s.args).length ? ` ${JSON.stringify(s.args)}` : ''}`).join(' → ')}</div>
      )}
      {trace.bindings.length > 0 && (
        <div>bindings: {trace.bindings.map((b) => `${b.arg}: “${b.raw}” → ${b.label ?? short(b.agent)} (${b.source}${b.because ? `: ${b.because}` : ''})`).join('; ')}</div>
      )}
      {open && (
        <>
          <div>prompt {short(trace.promptDigest)}</div>
          <div>tools exposed: {trace.toolsExposed.join(', ')}</div>
          {refusals.map((a, i) => a.refused.map((v, k) => <div key={`${i}-${k}`}>· {v.message}</div>))}
        </>
      )}
    </div>
  );
}

/** What the agent said, in the shape it said it. */
function ReplyView({ reply, realm, addressee }: { reply: AskReply; realm?: { kind?: 'person' | 'org' | 'service' }; addressee?: `0x${string}` | null }) {
  if (reply.kind === 'answer') return <span>{reply.text}</span>;
  if (reply.kind === 'done') {
    const r = reply.result as { name?: string; agent?: string; txHash?: string; alreadyCreated?: boolean } | null;
    return (
      <div>
        {/* Spec 367 §6 — the reply claims what the evidence ESTABLISHED and no more: an invitation is "submitted",
            not "done"; a payment is "done, on chain". The words come from the agent's fulfillment record. */}
        <div>{r?.alreadyCreated ? `${r?.name ?? 'It'} already exists.` : reply.fulfillment ? (reply.fulfillment.established === 'submission' ? `Submitted — ${reply.fulfillment.words}.` : `Done — ${r?.name ? `${r.name} is live` : reply.fulfillment.words}.`) : `Done — ${r?.name ?? 'it'} is live.`}</div>
        {/* THE REFERENCE, whether or not an agent was created. This used to hang off `r.agent`, so a
            PAYMENT — whose result is a transfer, not an agent — reported "Done" and showed the person who
            had just moved money no transaction at all. The hash is carried in full for anything that
            needs to check it; the line stays short for the person reading it. */}
        {(r?.agent || r?.txHash) && (
          <div
            className="muted" style={{ fontSize: 11.5, marginTop: 2 }}
            {...(r?.txHash ? { 'data-testid': 'ask-tx', 'data-tx': r.txHash } : {})}
          >
            {r?.agent && <AgentName address={r.agent} />}
            {r?.agent && r?.txHash ? ' · ' : ''}
            {r?.txHash ? short(r.txHash) : ''}
          </div>
        )}
        {/* Spec 363 W6 — WHAT WAS DECIDED FOR THEM, after the fact. A person who was never asked which
            account paid should still be able to see which one did and why: before the act the authority
            card says it, and afterwards this does, because by then the card is gone and "why did it use
            that one" is exactly the question a receipt should answer. */}
        {(reply.decisions ?? []).map((d, i) => (
          <div key={i} className="muted" style={{ fontSize: 11.5, marginTop: 3 }} data-testid={`ask-decided-${d.arg}`}>
            {d.arg}: <AgentName address={d.chose as `0x${string}`} /> — {d.because}
          </div>
        ))}
        {/* Spec 360 — WHAT FOLLOWED, said plainly. An effect never fails the act, so without this line a
            payment that told nobody looks exactly like one that told both parties: "Done." The person who
            just moved money is the one who needs to know the other side has not heard. */}
        {(reply.effects ?? []).filter((e) => !e.ok).map((e, i) => (
          <div key={i} className="muted" style={{ fontSize: 11.5, marginTop: 4, color: 'var(--color-amber-700, #b45309)' }} data-testid="ask-effect-failed">
            It happened, but the receipt did not reach everyone — {plainReason(e.error ?? 'delivery failed')}
          </div>
        ))}
        {(reply.effects ?? []).some((e) => e.ok && e.produces === 'PaymentReceipt') && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }} data-testid="ask-effect-ok">
            Both sides have the receipt.
          </div>
        )}
        {/* Spec 361 I2 — WHERE THE OUTCOME LIVES, said by the capability's own contract. This used to be
            unknowable here: the flyout had no table of capability→screen and rightly refused to keep one.
            Now the SKILL.md declares a navigation KEY, the reply carries it for the acted step, and the
            app's registry resolves what it means in THIS deployment. */}
        {reply.interaction?.navigationTarget && (() => {
          const nav = resolveNavigationTarget(reply.interaction!.navigationTarget!, { kind: realm?.kind, addressee });
          return nav ? (
            <div style={{ marginTop: 4 }}>
              <a href={nav.href} data-testid="ask-open-target" style={{ fontSize: 12, textDecoration: 'underline', color: 'var(--color-sage-700, #3f6212)' }}>
                {nav.label} →
              </a>
            </div>
          ) : null;
        })()}
      </div>
    );
  }
  if (reply.kind === 'refused') {
    return (
      <div>
        <div>{reply.outcome === 'denied' ? 'Refused — the authority does not cover this.' : 'That did not go through.'}</div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{plainReason(reply.error)}</div>
      </div>
    );
  }
  return <span className="muted">…</span>;
}

/** The grant. Plain words first, the machine-readable underneath — a person should be able to refuse this
 *  for a reason. */
function AuthorityCard({ reply, busy, onGrant, onCancel, checkCustody, onRequest, chosen }: {
  reply: Extract<AskReply, { kind: 'authority_required' }>; busy: string | null;
  onGrant: () => void; onCancel: () => void;
  /** The way out of a dead end: prefill the composer with a request to whoever CAN grant. Prefilled and
   *  never auto-sent — a message sent on someone's behalf without them reading it is its own overreach. */
  onRequest: (text: string) => void;
  /** Labels this surface showed for values the person picked, so a chosen party is not shown as an address. */
  chosen: Record<string, string>;
  /** Does the connected credential custody the delegator? The ONE thing that decides whether a grant here
   *  can produce a valid mandate — asked of the chain, not of the record the agent read. */
  checkCustody: (delegator: Address) => Promise<boolean>;
}) {
  const d = describeRequirement(reply);
  // TWO HALVES OF ONE HONEST ANSWER (spec 353 S5). The chain says whether this person can grant; the
  // agent's derived standing says what they ARE and who would have to act instead. Either alone leaves a
  // person stuck: "you can't" with no route, or "you're a member" with a button that will fail.
  const [custody, setCustody] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void checkCustody(reply.delegator).then((ok) => { if (live) setCustody(ok); }).catch(() => { if (live) setCustody(null); });
    return () => { live = false; };
  }, [reply.delegator]);

  if (custody === false) {
    return (
      <div className="ask-card" data-testid="ask-authority-blocked">
        <div style={{ fontWeight: 600, fontSize: 13 }}>You can’t authorize this</div>
        <p style={{ fontSize: 12.5, margin: '6px 0 0', lineHeight: 1.5 }}>
          {reply.note
            ? reply.note
            : <>This needs {capabilityWords(reply.capability)} as <AgentName address={reply.delegator} />, which a different credential custodies.</>}
        </p>
        <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>Nothing was authorized, and nothing happened.</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {reply.standing?.relation === 'member' && (
            <button
              type="button" className="btn primary" data-testid="ask-request-authority"
              onClick={() => onRequest(`send a direct message to ${short(reply.delegator)} asking a steward to authorize ${capabilityWords(reply.capability)} for me`)}
            >Ask a steward</button>
          )}
          <button type="button" className="btn ghost" onClick={onCancel}>Close</button>
        </div>
      </div>
    );
  }
  return (
    <div className="ask-card" data-testid="ask-authority">
      <div style={{ fontWeight: 600, fontSize: 13 }}>This needs your authority</div>
      <p style={{ fontSize: 12.5, margin: '6px 0 0', lineHeight: 1.5 }}>
        To do this, <AgentName address={reply.delegate} /> needs permission to <strong>{capabilityWords(reply.capability)}</strong> as{' '}
        <strong><AgentName address={d.delegator} /></strong> — for <strong>this request only</strong>, expiring in {d.expiresInMinutes} minutes.
      </p>
      {/* WHO IT RESOLVED TO. When several agents answered to the name the person picked one and knows what
          they picked. When exactly ONE did, nobody was asked anything — which is precisely the case where a
          wrong resolution goes unnoticed until after the signature. So the words and what they became are
          shown together, and a person who typed "nathan" can see which Nathan they are about to authorize. */}
      {!!reply.parties?.length && (
        <div style={{ marginTop: 8 }} data-testid="ask-parties">
          {reply.parties.map((p) => (
            <div key={`${p.arg}:${p.agent}`} style={{ fontSize: 12, marginTop: 2 }}>
              <span className="muted">{p.arg}: </span>
              <strong>{p.label ?? chosen[p.agent.toLowerCase()] ?? <AgentName address={p.agent} />}</strong>
              {p.hint && <span className="muted" style={{ fontSize: 11 }}> — {p.hint}</span>}
              {!p.label && p.raw && p.raw.toLowerCase() !== p.agent.toLowerCase() && (
                <span className="muted" style={{ fontSize: 11 }}> (you said “{p.raw}”)</span>
              )}
              {/* WHY IT DECIDED RATHER THAN ASKED (spec 363 §2). A party the person never named is one
                  a rule chose, and a choice that cannot say why is indistinguishable from a guess — so
                  the reason is shown right where the person is about to sign, and it is the rule's own
                  words, not a model's. */}
              {p.because && (
                <div className="muted" style={{ fontSize: 11, marginLeft: 2 }} data-testid={`ask-because-${p.arg}`}>
                  ↳ {p.because}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
        {reply.standing?.relation === 'steward'
          ? <>You are granting it as a steward of <AgentName address={d.delegator} />. You can revoke it on chain at any time.</>
          : <>You are granting it because your credential custodies <AgentName address={d.delegator} />. You can revoke it on chain at any time.</>}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <BusyButton busy={busy === 'Granting authority…'} busyLabel="Granting…" onClick={onGrant} className="btn primary" data-testid="ask-grant">Grant &amp; continue</BusyButton>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={!!busy}>Not now</button>
      </div>
    </div>
  );
}

/** A question for the person. Never a credential field — this surface answered those already. */
function PromptCard({ prompt, answers, setAnswers, busy, onAnswer, onCancel, onChoose, onSuggest }: {
  prompt: AskPrompt; answers: Record<string, string>; setAnswers: (v: Record<string, string>) => void;
  busy: string | null; onAnswer: () => void; onCancel: () => void;
  /** Remember the label this surface showed for a chosen value, so the next card can say it back. */
  onChoose: (value: string, label: string) => void;
  /** Prefill the composer with the agent's suggested follow-up. Never sends it. */
  onSuggest: (message: string) => void;
}) {
  const ready = prompt.kind !== 'data' || prompt.fields.every((f) => !f.required || (answers[f.name] ?? '').trim().length > 0);
  return (
    <div className="ask-card" data-testid="ask-prompt">
      <div style={{ fontWeight: 600, fontSize: 13 }}>{prompt.prompt}</div>
      {prompt.kind === 'data' && prompt.fields.map((f: AskField) => (
        <div key={f.name} style={{ marginTop: 8 }}>
          <label className="muted" style={{ fontSize: 11.5, display: 'block' }} htmlFor={`ask-f-${f.name}`}>{f.label}</label>
          {f.hint && <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{f.hint}</div>}
          {/* A CHOICE IS SHOWN, NOT DESCRIBED. The agent had already worked out which agents could be
              meant and sent them; rendering that as a text box asked the person to retype something they
              could not see, and to know which "Nathan" was which without being told. Each row carries what
              tells them apart, and nothing is preselected — the agent deliberately does not rank these
              (that would need a score it refuses to invent), so neither does this. */}
          {f.type === 'choice' && f.choices?.length ? (
            <div role="radiogroup" aria-label={f.label} data-testid={`ask-choices-${f.name}`}>
              {f.choices.map((c) => {
                const picked = answers[f.name] === c.value;
                return (
                  <button
                    key={c.value} type="button" role="radio" aria-checked={picked}
                    data-testid={`ask-choice-${c.value}`}
                    onClick={() => { setAnswers({ ...answers, [f.name]: c.value }); onChoose(c.value, c.label); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', marginTop: 4, padding: '7px 9px',
                      borderRadius: 7, cursor: 'pointer', font: 'inherit',
                      border: `1px solid ${picked ? 'var(--accent, #2563eb)' : 'var(--border, #d8dbe0)'}`,
                      background: picked ? 'var(--accent-soft, #eff4ff)' : 'transparent',
                    }}
                  >
                    {/* An explicit colour: inheriting one rendered the label the same shade as the card
                        it sits on, so the choices were invisible and the person picked blind. */}
                    <span style={{ fontSize: 12.5, fontWeight: picked ? 600 : 500, color: 'var(--text, #14181f)' }}>{c.label}</span>
                    {c.hint && <span className="muted" style={{ fontSize: 11, display: 'block', marginTop: 1 }}>{c.hint}</span>}
                  </button>
                );
              })}
              {/* THE ANSWER IS OFTEN NOT IN THE LIST — that is why we are asking. A prompt that says "give
                  it in full" beside a list nobody can add to is a dead end with instructions on it: asked
                  to pay "alice" when her treasury is named alice2.treasury, the only offered choice was
                  her person agent, and typing the right one was impossible. */}
              {f.allowOther && (
                <input
                  className="input" data-testid={`ask-other-${f.name}`} style={{ marginTop: 6 }}
                  placeholder="or type a name (alice2.treasury) or address"
                  value={f.choices.some((c) => c.value === answers[f.name]) ? '' : answers[f.name] ?? ''}
                  onChange={(e) => setAnswers({ ...answers, [f.name]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) onAnswer(); }}
                />
              )}
            </div>
          ) : (
            <input
              id={`ask-f-${f.name}`} className="input" data-testid={`ask-field-${f.name}`} value={answers[f.name] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [f.name]: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) onAnswer(); }}
            />
          )}
        </div>
      ))}
      {prompt.kind === 'signature' && (
        <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0', lineHeight: 1.5 }}>
          {/* WHAT IS BEING SIGNED, not what was being signed the day this was written. A person approving
              a payment was told "this creates the agent and makes your credential its custodian", which
              describes a different act entirely — the one copy this card had. */}
          {/approve|second party/i.test(prompt.prompt)
            ? 'You are approving someone else’s step, as the second party its risk requires. It authorizes that one step and nothing further.'
            : 'Signing this creates the agent and makes your credential its custodian.'}
          {' '}The agent re-derives what you signed and refuses it if it differs.
        </p>
      )}
      {/* THE WAY OUT. When the answer is not among the choices — their treasury is unlisted, so nobody
          can name it — the question is a dead end unless it offers the next ask. Prefilled, never sent:
          the person reads it and presses send, which is the same rule the "ask a steward" route follows. */}
      {prompt.kind === 'data' && prompt.suggest && (
        <button
          type="button" className="btn ghost" data-testid="ask-suggest"
          style={{ marginTop: 8, fontSize: 12 }} disabled={!!busy}
          onClick={() => onSuggest(prompt.suggest!.message)}
        >{prompt.suggest.label}</button>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <BusyButton busy={!!busy} busyLabel={busy ?? 'Working…'} disabled={!ready} onClick={onAnswer} className="btn primary" data-testid="ask-answer">
          {prompt.kind === 'signature' ? 'Sign & continue' : prompt.kind === 'confirmation' ? 'Yes, continue' : 'Continue'}
        </BusyButton>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={!!busy}>Cancel</button>
      </div>
    </div>
  );
}
