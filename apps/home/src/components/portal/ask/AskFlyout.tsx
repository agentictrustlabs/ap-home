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
import { ask, mintMandate, canGrantAs, describeRequirement, homeScope, capabilityWords, type AskReply, type AskPrompt, type AskTurnState, type SuppliedInput, type AskField } from '../../../home/ask';
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
  const [busy, setBusy] = useState<string | null>(null);
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
    try {
      const { reply, resumable, waiting } = await ask(session, state);
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
      setErr(e instanceof Error ? e.message : String(e));
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
    const surface = await homeScope(realm);
    await turn({ message, addressee, runRef: `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface }, 'Thinking…');
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
      const wire = await mintMandate(reply, await signAs(reply.delegator));
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
            {'text' in e ? <span>{e.text}</span> : <ReplyView reply={e.reply} />}
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

/** What the agent said, in the shape it said it. */
function ReplyView({ reply }: { reply: AskReply }) {
  if (reply.kind === 'answer') return <span>{reply.text}</span>;
  if (reply.kind === 'done') {
    const r = reply.result as { name?: string; agent?: string; txHash?: string; alreadyCreated?: boolean } | null;
    return (
      <div>
        <div>{r?.alreadyCreated ? `${r?.name ?? 'It'} already exists.` : `Done — ${r?.name ?? 'it'} is live.`}</div>
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
