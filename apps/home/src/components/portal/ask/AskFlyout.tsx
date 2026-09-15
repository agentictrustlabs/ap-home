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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useRouter } from 'next/navigation';
import { useSession } from '../../../context/session';
import { RunInspector } from '../runs/RunInspector';
import { BasisLine } from '../BasisLine';
import { useManagedAgents } from '../ManagedAgents';
import { orgHref, serviceHref } from '../../../lib/workspace';
import { agentClassOf } from '../../../lib/agent-class';
import { nameLabel } from '../../../lib/domain';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { useVoice, blobToBase64 } from './useVoice';
import { yesNo, matchChoice, listenAfter, plainSpeech, navigationIntent, closestOption } from './voice-text';
import { ask, hear, warmHearing, readProgress, type ProgressLine, mintMandate, mintApprovedMandate, canGrantAs, describeRequirement, homeScope, homeVocabulary, homeModels, readDraft, capabilityWords, type AskReply, type AskPrompt, type AskTurnState, type SuppliedInput, type AskField, type AskEvidence, type UnfinishedRun, type PlannerTrace, type AskVocabularyEntry, type CommandField, type AskModelOption, listConfirmations, forgetConfirmation, type RememberedChoice, listInstructions, forgetInstruction, type StandingInstruction } from '../../../home/ask';
import type { AskSelection } from '../../../home/ask-selection';
import { resolveNavigationTarget } from '../../../lib/interaction-registry';
import { resultApp, reviewApp } from './interaction-apps';
import type { AskCommand } from '../../../home/ask-command';

/** Spec 377 — where this browser remembers which model the person picked for the Ask. */
const MODEL_PREF_KEY = 'ask.model';
import { BusyButton } from '../../shared/BusyButton';
import { XIcon, MicIcon } from '../../shared/Icons';
import { AgentName } from '../../shared/AgentName';
import { connectedCredential } from './credential';
import { createdAgentOf, recordCreatedAgent, invitationOf, recordInvitation } from '../../../home/ask-record';

type Entry =
  | { role: 'you'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'agent'; reply: AskReply };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function AskFlyout({ addressee, addresseeLabel, realm, selection, onClose, seed, onSeedUsed, resumeRun, onResumeUsed, command: screenCommand, onCommandUsed }: {
  /** Spec 397 §6 — a parked run to pick up on open (`/you?run=`): resumed at once, every gate re-run; the person signs here. */
  resumeRun?: string | null;
  onResumeUsed?: () => void;
  /** Spec 361 I6 — what the screen has selected; reaches the agent as validated context. */
  selection?: AskSelection | null;
  addressee: Address; addresseeLabel: string;
  /** Where the person is standing, as this app understands it — the agent narrows what it OFFERS to it,
   *  and derives standing itself (spec 353 §4). */
  realm?: { kind?: 'person' | 'org' | 'service' };
  onClose: () => void;
  /** An ask a page wants to start on this surface. Prefills the composer; never sends. */
  seed?: string | null;
  onSeedUsed?: () => void;
  /** Spec 361 I4 — a screen's command: the one act it knows, with the person's choices as arguments. */
  command?: AskCommand | null;
  onCommandUsed?: () => void;
}) {
  const { session, profile, agentAddress, agentName, personName } = useSession();
  const router = useRouter();
  // The agents this person can stand in — the switcher's rows — so "switch to missio nexus" moves the Ask
  // the way tapping the switcher does. The flyout stays up; the addressee follows the room.
  const { agents: managed } = useManagedAgents(session?.token ?? null);
  const rooms = () => [
    // The person answers to their display name AND their handle: "switch to alice" when the profile says
    // "Alice Okoro" — and "back to me" by the self flag.
    { label: personName ?? (agentName ? nameLabel(agentName) : 'me'), self: true, href: '/', aliases: [agentName ?? '', agentName ? nameLabel(agentName) : ''].filter(Boolean) },
    ...managed.map((a) => ({ label: a.name ? nameLabel(a.name) : a.agent, self: false, href: agentClassOf(a.kind) === 'org' ? orgHref(a.agent, 'overview') : serviceHref(a.agent), aliases: a.name ? [a.name] : [] })),
  ];
  /** "Switch to X": a SURFACE act, never sent to an agent. Returns true when the words were that. */
  const navigate = (text: string, spoken: boolean): boolean => {
    const intent = navigationIntent(text);
    if (!intent) return false;
    const { target, explicit } = intent;
    const opts = rooms();
    const hit = closestOption(target, opts);
    // A LOOSE PHRASING THAT NAMES NO ROOM IS NOT A MOVE. "ask carol for a way to pay their treasury so I
    // can send 1.66 usdc" begins with `ask`, and answering it with a list of rooms swallowed the one
    // sentence the person had been handed to send (2026-09-08). Only "switch to X" earns the "I don't
    // have anywhere called X" reply; everything else falls through to the agent.
    if (!hit && !explicit) return false;
    if (hit) {
      setThread((t) => [...t, { role: 'you', text: spoken ? `🎙 ${text}` : text }, { role: 'agent', text: `Now asking ${hit.label}.` }]);
      router.push(hit.href);
      return true;
    }
    const near = opts.filter((o) => closestOption(target, [o]));
    setThread((t) => [...t, { role: 'you', text: spoken ? `🎙 ${text}` : text }, { role: 'agent', text: near.length > 1 ? `Which one — ${near.map((o) => o.label).join(', ')}?` : `I don’t have anywhere called “${target}”. You can stand in: ${opts.map((o) => o.label).join(', ')}.` }]);
    return true;
  };
  const [thread, setThread] = useState<Entry[]>([]);
  const [q, setQ] = useState('');
  // A page asked to start this ask (e.g. "finish the payment you were waiting on"). It lands in the
  // composer, where the person reads it and presses send — the same rule every suggested ask follows.
  useEffect(() => {
    if (!seed) return;
    setQ(seed);
    onSeedUsed?.();
  }, [seed]);
  // Spec 397 §6 — the run an assistant parked for this person's signature: picked up exactly as an unfinished ask is
  // (the same turn, the same gates); the requirement and the preview appear, and the signature is given here.
  useEffect(() => {
    if (!resumeRun || !session) return;
    onResumeUsed?.();
    void turn({ message: '', addressee, runRef: resumeRun, presented: null, supplied: [], resumable: true }, 'Picking up what the assistant asked…');
  }, [resumeRun, session]);
  // Spec 361 I4 — a SCREEN'S COMMAND: run exactly as the command picker runs one (a supplied plan on a fresh
  // run), so a button and a sentence reach the same boundary and the same ceremony. The screen named the act;
  // the agent verifies it, asks for the mandate, and the person signs here.
  useEffect(() => {
    if (!screenCommand || !session) return;
    onCommandUsed?.();
    const cmd = screenCommand;
    void (async () => {
      setThread((t) => [...t, { role: 'you', text: cmd.message }]);
      const surface = await homeScope(realm, addressee, selection ?? undefined);
      await turn({ message: cmd.message, addressee, runRef: `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface, plan: { steps: [{ toolId: cmd.toolId, args: cmd.args }] } }, 'Working…');
    })();
  }, [screenCommand, session]);
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
  // Spec 385 W2 — WHAT THE AGENT REMEMBERS THEY CHOSE ("the Somali Corridor Team you meant when inviting"),
  // in the open so it can be cleared. The person's own, whichever room they ask in; refreshed after every
  // turn because the turn that answered a "which one?" is the one that wrote it.
  const [remembered, setRemembered] = useState<RememberedChoice[]>([]);
  // Spec 394 — the person's standing instructions, listed beside their remembered choices so each can be cleared.
  const [instructions, setInstructions] = useState<StandingInstruction[]>([]);
  const [showRemembered, setShowRemembered] = useState(false);
  const forgetStanding = async (i: StandingInstruction) => {
    if (!session) return;
    const key = `forget-standing:${i.context}:${i.capability}:${i.arg}`;
    setBusy(key);
    try {
      const out = await forgetInstruction(session, { context: i.context, capability: i.capability, arg: i.arg });
      if (out.ok) setInstructions(out.entries);
    } finally { setBusy(null); }
  };
  const refreshRemembered = useCallback(async () => {
    if (!session) return;
    try { const [r, i] = await Promise.all([listConfirmations(session), listInstructions(session)]); setRemembered(r); setInstructions(i); } catch { /* a listing that failed is an empty note, never an error in the thread */ }
  }, [session?.token]);
  useEffect(() => { void refreshRemembered(); }, [refreshRemembered]);
  const forget = async (r: RememberedChoice) => {
    if (!session) return;
    setBusy(`forget:${r.word}:${r.capability}:${r.arg}`);
    try {
      const out = await forgetConfirmation(session, { word: r.word, capability: r.capability, arg: r.arg, ...(r.context ? { context: r.context } : {}) });
      if (out.ok) setRemembered(out.entries);
      else setThread((t) => [...t, { role: 'agent', text: `I could not clear that: ${out.error}` }]);
    } finally { setBusy(null); }
  };
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
  // Spec 369 — VOICE AS A FACET. The browser captures and plays; the agent hears (`/harness/hear`) and
  // decides what is said (`reply.spoken`). A spoken word goes down the same path a typed one does.
  const voice = useVoice();
  const pendingRef = useRef<typeof pending>(null);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  const busyRef = useRef<string | null>(null);
  useEffect(() => { busyRef.current = busy; }, [busy]);

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
    // Spec 370 P2 — while the turn is in flight, read what the agent says about its own progress and
    // show the latest line where the busy label was; the voice reads each new one. Stops with the reply.
    let polling = true;
    setProgress([]);
    // The cursor survives across the turns of one run — the agent numbers a run's lines once — and starts
    // over for a new run.
    if (progressCursor.current.runRef !== state.runRef) progressCursor.current = { runRef: state.runRef, after: 0 };
    void (async () => {
      while (polling) {
        try {
          const got = await readProgress(session, state.addressee, state.runRef, progressCursor.current.after);
          if (!polling) break;
          if (got.lines.length) { progressCursor.current.after = got.lines[got.lines.length - 1]!.seq; setProgress((p) => [...p, ...got.lines]); }
          if (got.terminal) break;
          if (!got.lines.length) await new Promise((r) => setTimeout(r, 400));
        } catch { await new Promise((r) => setTimeout(r, 1_000)); }
      }
    })();
    try {
      // Spec 377 — the person's model pick rides EVERY turn of a run (a resume composes with it too); this is
      // the one place all turns pass through, so it is the one place it is attached.
      const { reply, resumable, waiting, unfinishedRuns, unfinishedTotal: total } = await ask(session, { ...state, ...(model ? { model } : {}) }).finally(() => { polling = false; });
      // Recorded for EVERY turn, answer or not: a run that asked for authority, or was refused, is exactly
      // the run somebody wants to look at afterwards.
      setDiag((d) => [...d, {
        at: new Date().toISOString(), ms: Date.now() - startedAt, kind: reply.kind,
        ...(state.message ? { question: state.message } : {}),
        evidence: (reply as { evidence?: AskEvidence[] }).evidence ?? [],
        ...(reply.kind === 'refused' ? { error: reply.error } : {}),
        ...(reply.plannerTrace ? { trace: reply.plannerTrace } : {}),
        ...(reply.runRef ? { runRef: reply.runRef, addressee: state.addressee } : {}),
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
      void refreshRemembered();
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

  const send = async (text?: string, channel?: 'voice') => {
    const message = (text ?? q).trim();
    if (!message || !session) return;
    setQ('');
    if (navigate(message, channel === 'voice')) return;
    setAnswers({});
    setThread((t) => [...t, { role: 'you', text: channel === 'voice' ? `🎙 ${message}` : message }]);
    // The scope is computed per ask, not per session: it is the agent's published vocabulary ∩ what this
    // flyout can finish, and the agent being asked may not offer what the last one did.
    const surface = await homeScope(realm, addressee, selection ?? undefined);
    await turn({ message, addressee, runRef: `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface, ...(channel ? { channel } : {}) }, 'Thinking…');
  };

  /**
   * Spec 369 — WHAT WAS HEARD, routed. A pending prompt takes the words as its answer (yes/no, a choice by
   * ordinal or label, or the field's text); otherwise they are an ask. An authority card and a signature
   * prompt take "approve" (or "no"): the word does what the button does — hands the digest to the connected
   * credential, which signs, or whose device asks on screen. The word is never the signature (spec 350 §3.6).
   */
  const onVoice = (text: string, opts?: { viaHearing?: boolean }) => {
    // The hearing turn itself sets `busy` ("Hearing…") — the words it produces must not be refused by it.
    // They were, once: "change your first name to george" was heard, routed here, and dropped in silence.
    if (busy && !opts?.viaHearing) return;
    const p = pendingRef.current;
    if (p?.reply.kind === 'prompt') {
      const prompt = p.reply.prompt;
      setThread((t) => [...t, { role: 'you', text: `🎙 ${text}` }]);
      if (prompt.kind === 'confirmation') {
        const yn = yesNo(text);
        if (yn === 'yes') void answer(p.reply as never, p.state);
        else if (yn === 'no') { setPending(null); voice.speak('Okay — cancelled.'); }
        else voice.speak('Yes or no?', () => listenRef.current());
        return;
      }
      if (prompt.kind === 'signature') {
        const yn = yesNo(text);
        if (yn === 'yes') void answer(p.reply as never, p.state);
        else if (yn === 'no') { setPending(null); voice.speak('Okay — not signed.'); }
        else voice.speak('Say approve to sign it, or no to cancel.', () => listenRef.current());
        return;
      }
      const fields = prompt.fields.filter((f) => f.type !== 'credential');
      const target = fields.find((f) => f.required && !(answers[f.name] ?? '').trim()) ?? fields[0];
      if (!target) return;
      let value = text;
      if (target.type === 'choice' && target.choices?.length) {
        const m = matchChoice(text, target.choices);
        if (m) { value = m; setChosen((c) => ({ ...c, [m.toLowerCase()]: target.choices!.find((x) => x.value === m)!.label })); }
        else if (!target.allowOther) { voice.speak("I didn't catch which one.", () => listenRef.current()); return; }
      }
      const next = { ...answers, [target.name]: value };
      setAnswers(next);
      const stillMissing = fields.find((f) => f.required && !(next[f.name] ?? '').trim());
      if (stillMissing) voice.speak(stillMissing.label, () => listenRef.current());
      else void answer(p.reply as never, p.state, next);
      return;
    }
    if (p?.reply.kind === 'authority_required') {
      setThread((t) => [...t, { role: 'you', text: `🎙 ${text}` }]);
      const yn = yesNo(text);
      if (yn === 'yes') void grant(p.reply as never, p.state);
      else if (yn === 'no') { setPending(null); voice.speak('Okay — not granted.'); }
      else voice.speak('Say approve to grant it for this request, or no to cancel.', () => listenRef.current());
      return;
    }
    if (p) return;
    void send(text, 'voice');
  };
  /** The recording goes to the AGENT to hear; what comes back is shown before anything acts on it. */
  const onAudio = async (blob: Blob) => {
    if (!session) return;
    setErr(null);
    setBusy('Hearing…');
    try {
      const h = await hear(session, addressee, await blobToBase64(blob), blob.type);
      if (!h.ok) {
        setErr(`${h.error} — you can type it instead.`);
        voice.speak('I could not hear that. Say it again, or type it.', () => listenRef.current());
        return;
      }
      // A repaired name is shown AS a repair: the person sees what was heard and what it was taken to mean.
      if (h.repairs.length) setThread((t) => [...t, { role: 'agent', text: `Heard “${h.heard}” — taken as ${h.repairs.map((r) => `“${r.to}”`).join(', ')}.` }]);
      setBusy(null);
      if (h.transcript.trim()) { emptyHears.current = 0; onVoiceRef.current(h.transcript.trim(), { viaHearing: true }); }
      else if (++emptyHears.current < 2) {
        // Silence is an answer too — said, never swallowed. Said ONCE: a room whose noise keeps opening the
        // mic would otherwise hear "I didn't catch anything" every few seconds forever.
        setThread((t) => [...t, { role: 'agent', text: 'I didn’t catch anything — try again, a little closer to the microphone.' }]);
      } else {
        emptyHears.current = 0;
        setVoiceNote('I didn’t hear anything — tap 🎙 when you’re ready.');
      }
    } finally {
      setBusy((b) => (b === 'Hearing…' ? null : b));
    }
  };
  const emptyHears = useRef(0);
  const onVoiceRef = useRef(onVoice); onVoiceRef.current = onVoice;
  const onAudioRef = useRef(onAudio); onAudioRef.current = onAudio;
  /** Open the mic for one utterance — and warm the agent's ear meanwhile, so hearing costs only the transcription. */
  const listen = () => {
    // Tapping the mic IS asking for a dialog: from here the agent reads its replies aloud and listens again
    // after each one, until Voice is switched off. A toggle nobody found was a dialog nobody had.
    if (!voice.enabled) voice.setEnabled(true);
    voice.prime(); // this tap is the gesture the speaker is unlocked by (iOS)
    if (session) warmHearing(session, addressee);
    setVoiceNote(null);
    // The first tap gets a word of welcome and the question — and nothing about what can be done unless
    // they ask. The reply's ear opens when the greeting ends.
    if (!greetedRef.current) {
      greetedRef.current = true;
      // No `voice.enabled` check here: this closure was made by the render BEFORE the tap switched Voice on,
      // and read it as off — so the greeting played and the ear never opened. Voice IS on: this tap did it.
      voice.speak(`Hi${personName ? ` ${personName.split(/\s+/)[0]}` : ''} — what do you need?`, () => open());
      return;
    }
    open();
  };
  const greetedRef = useRef(false);
  const open = () => {
    void voice.startListening(
      (blob) => void onAudioRef.current(blob),
      (m) => setErr(`${m} — you can type it instead.`),
      // Nothing was said: the dialog pauses here rather than holding an open mic on a room. A tap resumes it.
      () => setVoiceNote('I didn’t hear anything — tap 🎙 when you’re ready.'),
    );
  };
  const listenRef = useRef(listen); listenRef.current = listen;
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // Spec 370 P2 — what the agent has said about this turn so far; the last line is the busy text.
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const progressSpoken = useRef(0);
  const progressCursor = useRef<{ runRef: string; after: number }>({ runRef: '', after: 0 });

  // A turn takes as long as it takes (a plan, chain reads, sometimes a userOp). Silence for ten seconds
  // sounds like a dead line: the agent's own progress lines are read as they arrive; "one moment" only
  // when three seconds pass with nothing said.
  useEffect(() => {
    if (!voice.enabled || !busy || busy === 'Hearing…' || busy === 'Listening…') return;
    if (progress.length) return;
    const t = setTimeout(() => voice.speak('One moment.', undefined, { append: true }), 3_000);
    return () => clearTimeout(t);
  }, [busy, voice.enabled, progress.length]);
  useEffect(() => {
    if (!voice.enabled) { progressSpoken.current = progress.length; return; }
    // The step lines are worth hearing (checking authority, doing, done); the plan bookkeeping is not.
    const SAID = new Set(['StepProposed', 'MandateChecked', 'MandateDenied', 'ToolInvoked', 'StepReplayed', 'ApprovalRequested', 'RunFailed']);
    if (progress.length < progressSpoken.current) progressSpoken.current = 0; // a new turn's list
    const fresh = progress.slice(progressSpoken.current).filter((l) => SAID.has(l.type) && !l.terminal);
    progressSpoken.current = progress.length;
    if (fresh.length) voice.speak(fresh.map((l) => l.said).join(' '), undefined, { append: true });
  }, [progress, voice.enabled]);

  // SPEAK what the agent said, once per entry, from the agent's own spoken rendering; after an answer the
  // mic reopens once (a dialog). Prompts and authority are spoken by the pending effect below.
  const spokenIdx = useRef(0);
  useEffect(() => {
    if (!voice.enabled) { spokenIdx.current = thread.length; return; }
    const parts: string[] = [];
    for (let i = spokenIdx.current; i < thread.length; i++) {
      const e = thread[i]!;
      if (e.role !== 'agent') continue;
      if ('text' in e) parts.push(plainSpeech(e.text));
      else if (e.reply.kind !== 'prompt' && e.reply.kind !== 'authority_required') parts.push(e.reply.spoken ?? '');
    }
    spokenIdx.current = thread.length;
    const text = parts.filter(Boolean).join(' ');
    // Appended, not spoken over: "Done — …" and "abc.org is in your agents now." arrive a second apart and
    // are one breath. The mic reopens when nothing is pending and no turn is running — a mic opened while
    // the agent works would record the agent's next sentence.
    if (text) voice.speak(text, () => { if (!pendingRef.current && !busyRef.current && voice.enabled) listenRef.current(); }, { append: true });
  }, [thread, voice.enabled]);
  const spokenPending = useRef('');
  useEffect(() => {
    if (!voice.enabled || !pending) return;
    const key = `${pending.reply.kind}:${pending.reply.runRef}:${pending.reply.kind === 'prompt' ? pending.reply.prompt.prompt : ''}`;
    if (spokenPending.current === key) return;
    spokenPending.current = key;
    const text = pending.reply.spoken ?? '';
    const again = listenAfter(pending.reply);
    voice.speak(text, () => { if (again && voice.enabled && pendingRef.current) listenRef.current(); }, { append: true });
  }, [pending, voice.enabled]);

  // Spec 367 §7 — THE SAME COMMAND, FILLED BY CONTROLS. "Do" offers the agent's capabilities as forms whose
  // fields come from the contracts (an Agent is a party field, an Amount a number). Submitting posts the
  // command as a supplied plan through the SAME turn as a sentence would take: the same resolver, the same
  // prompts when something is missing, the same authority card, the same receipt. A click is not a sentence
  // (no model re-derives it), and a form is not a second path.
  const [commands, setCommands] = useState<AskVocabularyEntry[]>([]);
  const [command, setCommand] = useState<AskVocabularyEntry | null>(null);
  // Spec 377 — WHICH MODEL PROPOSES, chosen by the person. The agent publishes what it offers with its
  // vocabulary; the pick is remembered per browser and sent on every turn. It changes who proposes, never
  // what is permitted — authority is unchanged whichever is picked (369's rule for voice, applied here).
  const [models, setModels] = useState<AskModelOption[]>([]);
  const [model, setModelState] = useState<string | null>(null);
  const setModel = (id: string) => {
    setModelState(id);
    try { localStorage.setItem(MODEL_PREF_KEY, id); } catch { /* private mode */ }
  };
  useEffect(() => {
    let cancelled = false;
    void homeVocabulary(addressee).then((caps) => { if (!cancelled) setCommands(caps.filter((c) => c.fields?.length)); });
    void homeModels(addressee).then((offered) => {
      if (cancelled) return;
      setModels(offered);
      // The remembered pick, if the agent still offers it; else the agent's default; else nothing named.
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(MODEL_PREF_KEY); } catch { /* private mode */ }
      const pick = offered.find((m) => m.id === remembered) ?? offered.find((m) => m.default) ?? offered[0] ?? null;
      setModelState(pick?.id ?? null);
    });
    return () => { cancelled = true; };
  }, [addressee]);
  // Spec 361 I5 — a DRAFT being edited: the run the form was opened from. Submitting resumes THAT run with
  // the edited plan; the agent re-plans and re-verifies from scratch, so the last edit is what executes.
  const [draftRun, setDraftRun] = useState<{ runRef: string; message: string; initial: Record<string, unknown> } | null>(null);
  const doCommand = async (cap: AskVocabularyEntry, args: Record<string, unknown>) => {
    if (!session) return;
    setCommand(null);
    setAnswers({});
    const draft = draftRun; setDraftRun(null);
    // A structured argument (the files a build left, handed to the PR) is said by its size, never stringified.
    const said = Object.entries(args).filter(([, v]) => v !== '' && v !== undefined && v !== false).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} ${k === 'files' ? 'file' : 'item'}${v.length === 1 ? '' : 's'}` : typeof v === 'object' && v !== null ? '…' : String(v)}`).join(', ');
    const message = draft?.message ?? `${cap.label ?? cap.id}${said ? ` — ${said}` : ''}`;
    setThread((t) => [...t, { role: 'you', text: draft ? `${message} (edited: ${said})` : message }]);
    const surface = await homeScope(realm, addressee, selection ?? undefined);
    await turn({ message, addressee, runRef: draft?.runRef ?? `ask-${Date.now().toString(36)}`, presented: null, supplied: [], surface, plan: { steps: [{ toolId: cap.id, args }] }, ...(draft ? { resumable: true } : {}) }, draft ? 'Sending the edited draft…' : 'Working…');
  };
  const editDraft = async (r: UnfinishedRun) => {
    if (!session) return;
    const d = await readDraft(session, addressee, r.runRef);
    const step = d?.plan?.steps?.[0];
    const cap = step ? commands.find((c) => c.id === step.toolId) : undefined;
    if (!d || !step || !cap) { setErr('this run has no form to edit — resume it in the conversation instead'); return; }
    // The draft's values: the plan's args, with anything the person already answered laid over them.
    const answered = Object.assign({}, ...d.supplied.map((s) => s.data ?? {}));
    setDraftRun({ runRef: d.runRef, message: d.message, initial: { ...step.args, ...answered } });
    setCommand(cap);
    setShowUnfinished(false);
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
  const answer = async (reply: Extract<AskReply, { kind: 'prompt' }>, state: AskTurnState, withAnswers?: Record<string, string>) => {
    const p = reply.prompt;
    const given = withAnswers ?? answers;
    setBusy(p.kind === 'signature' ? 'Signing…' : 'Working…');
    setErr(null);
    try {
      let supplied: SuppliedInput;
      if (p.kind === 'data') {
        supplied = { stepRef: reply.resumeToken, data: Object.fromEntries(p.fields.map((f) => [f.name, given[f.name] ?? ''])) };
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
        {voice.canSpeak && (
          <button
            type="button" className="btn ghost" data-testid="ask-voice-toggle" aria-pressed={voice.enabled}
            title={voice.enabled ? 'Voice is on: replies are read aloud and the mic reopens after each one. Switch off to end the dialog.' : 'Voice: read replies aloud and listen after each one. Saying “approve” does what the button does; the credential signs.'}
            style={{ fontSize: 11, padding: '2px 8px', marginRight: 6 }}
            onClick={() => voice.setEnabled(!voice.enabled)}
          >
            Voice {voice.enabled ? 'on' : 'off'}
          </button>
        )}
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
            {voice.canListen && <> Tap the microphone to talk instead: it answers aloud and listens for your reply until you switch Voice off. When it needs your authority or a signature, say “approve” — your credential signs, and a device that asks will still ask.</>}
          </p>
        )}
        {thread.map((e, i) => ('reply' in e && (e.reply.kind === 'authority_required' || e.reply.kind === 'prompt')) ? null : (   /* those render as the pending card, not as an empty bubble */
          <div key={i} className={e.role === 'you' ? 'ask-msg you' : 'ask-msg agent'}>
            {'text' in e ? <span>{e.text}</span> : <ReplyView reply={e.reply} realm={realm} addressee={addressee} onNext={(n) => void doCommand({ id: n.capability, label: n.words } as AskVocabularyEntry, n.args)} />}
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
                {/* Spec 361 I5 — the draft is the checkpoint, made a surface: open this run's plan in the form. */}
                <button type="button" className="btn ghost" data-testid={`ask-unfinished-edit-${r.runRef}`} style={{ fontSize: 10, padding: '0 6px', minHeight: 0, marginLeft: 6 }} onClick={() => void editDraft(r)}>Edit in form</button>
              </div>
            ))}
            {showUnfinished && unfinishedTotal > unfinished.length && (
              <div style={{ marginTop: 4, opacity: 0.7 }}>
                …and {unfinishedTotal - unfinished.length} more. Unfinished asks expire after a day.
              </div>
            )}
          </div>
        )}
        {/* Spec 385 W2 — remembered choices. A memory nobody can see is a memory nobody can say "no" to:
            each line names the word, the place it was decided in, and whom it settled on, with a way to
            clear it. Clearing grants and revokes nothing — the mandate was asked and signed regardless. */}
        {(remembered.length > 0 || instructions.length > 0) && (
          <div className="ask-msg agent" data-testid="ask-remembered" style={{ fontSize: 12, opacity: 0.9 }}>
            <button
              type="button"
              data-testid="ask-remembered-toggle"
              onClick={() => setShowRemembered((v) => !v)}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {[remembered.length ? (remembered.length === 1 ? '1 choice you made' : `${remembered.length} choices you made`) : '', instructions.length ? (instructions.length === 1 ? '1 standing instruction' : `${instructions.length} standing instructions`) : ''].filter(Boolean).reduce((a, b) => (a ? `I remember ${a} and ${b}` : `I remember ${b}`), '')}
              {showRemembered ? ' — hide' : ' — show'}
            </button>
            {showRemembered && remembered.map((r) => {
              const key = `forget:${r.word}:${r.capability}:${r.arg}`;
              return (
                <div key={key} style={{ marginTop: 4 }} data-testid="ask-remembered-row">
                  “{r.word}” means {r.label ? <span title={r.agent}>{r.label}</span> : <AgentName address={r.agent} />} as the {r.arg} when you {r.capabilityWords}
                  <button type="button" className="btn ghost" data-testid={`ask-remembered-forget-${r.word}`} style={{ fontSize: 10, padding: '0 6px', minHeight: 0, marginLeft: 6 }} disabled={busy === key} onClick={() => void forget(r)}>{busy === key ? 'Clearing…' : 'Forget'}</button>
                </div>
              );
            })}
            {/* Spec 394 — the person's standing instructions: a declared default per act + argument, per room. */}
            {showRemembered && instructions.map((i) => {
              const key = `forget-standing:${i.context}:${i.capability}:${i.arg}`;
              return (
                <div key={key} style={{ marginTop: 4 }} data-testid="ask-standing-row">
                  When you {i.capabilityWords}{i.context !== 'any' ? <> at <AgentName address={i.context} /></> : ''}, the {i.arg} is {i.label ? <span title={i.value}>{i.label}</span> : <AgentName address={i.value} />} unless you say otherwise
                  <button type="button" className="btn ghost" data-testid={`ask-standing-forget-${i.arg}`} style={{ fontSize: 10, padding: '0 6px', minHeight: 0, marginLeft: 6 }} disabled={busy === key} onClick={() => void forgetStanding(i)}>{busy === key ? 'Clearing…' : 'Forget'}</button>
                </div>
              );
            })}
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
        {busy && !pending && (
          <div className="muted" data-testid="ask-busy" style={{ fontSize: 12 }}>
            <span className="spinner" /> {progress.length && !progress[progress.length - 1]!.terminal ? progress[progress.length - 1]!.said : busy}
            {progress.length > 1 && (
              <div data-testid="ask-progress" style={{ marginTop: 4, opacity: 0.7, fontSize: 11 }}>
                {progress.filter((l) => !l.terminal).slice(0, -1).map((l) => <div key={l.seq}>· {l.said}</div>)}
              </div>
            )}
          </div>
        )}
        {err && <div className="ask-err" role="alert">{err}</div>}
        <div ref={endRef} />
      </div>

      {showDiag && <DiagnosticsPane entries={diag} token={session?.token ?? ""} onClose={() => setShowDiag(false)} />}

      {command && <CommandForm command={command} realm={realm} addressee={addressee} addresseeLabel={addresseeLabel} selection={selection ?? undefined} initial={draftRun?.initial} draftOf={draftRun?.message} onSubmit={(args) => void doCommand(command, args)} onCancel={() => { setCommand(null); setDraftRun(null); }} />}
      {/* One control strip: what to do (a generated form) and which model proposes — small, in one row above the input. */}
      {(commands.length > 0 || models.length > 1) && !command && !pending && (
        <div className="ask-flyout-strip">
          {commands.length > 0 && (
            <label className="ask-flyout-strip__ctl">
              <span>Do</span>
              <select data-testid="ask-command" value="" onChange={(e) => { const c = commands.find((x) => x.id === e.target.value); if (c) setCommand(c); }}>
                <option value="">choose an action…</option>
                {commands.map((c) => <option key={c.id} value={c.id}>{c.label ?? c.id}</option>)}
              </select>
            </label>
          )}
          {/* Spec 377 — which model proposes, chosen by the person; rendered only when the agent offers more than one. */}
          {models.length > 1 && (
            <label className="ask-flyout-strip__ctl">
              <span>Model</span>
              <select data-testid="ask-model" aria-label="Model" title="Which model plans and answers this conversation. Authority is unchanged whichever you pick." value={model ?? ''} disabled={!!busy} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {(voice.listening || voice.speaking || voiceNote) && (
        <div aria-live="polite" className="muted" data-testid="ask-voice-status" style={{ fontSize: 11, padding: '0 2px 2px' }}>
          {voice.listening ? `Listening… ${'▮'.repeat(Math.round(voice.level * 6))}` : voice.speaking ? 'Speaking…' : voiceNote}
        </div>
      )}
      <div className="ask-flyout-f">
        {voice.canListen && (
          <button
            type="button" className={`ui-btn ${voice.listening ? 'ui-btn--primary' : 'ui-btn--secondary'}`} data-testid="ask-mic"
            aria-pressed={voice.listening} aria-label={voice.listening ? 'Stop listening' : 'Speak your ask'}
            title={voice.listening ? 'Stop listening' : 'Speak — your agent hears it'}
            disabled={!!busy || pending?.reply.kind === 'authority_required' || (pending?.reply.kind === 'prompt' && pending.reply.prompt.kind === 'signature')}
            onClick={() => (voice.listening ? voice.stopListening() : listen())}
          ><MicIcon size={16} /></button>
        )}
        <input
          className="input" data-testid="ask-input" value={q} placeholder={voice.listening ? 'Listening…' : `Ask ${addresseeLabel}…`}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
          disabled={!!busy || !!pending}
        />
        <BusyButton busy={busy === 'Thinking…'} busyLabel="Thinking…" disabled={!q.trim() || !!pending} onClick={() => void send()} className="ui-btn ui-btn--primary">Ask</BusyButton>
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
function CommandForm({ command, realm, addressee, addresseeLabel, selection, initial, draftOf, onSubmit, onCancel }: { command: AskVocabularyEntry; realm?: { kind?: 'person' | 'org' | 'service' }; addressee?: `0x${string}` | null; addresseeLabel?: string; selection?: AskSelection; initial?: Record<string, unknown>; draftOf?: string; onSubmit: (args: Record<string, unknown>) => void; onCancel: () => void }) {
  const fields = command.fields ?? [];
  // THE ROOM YOU STAND IN FILLS ITS OWN FIELD. Opened inside an organization, a command whose party may be
  // an organization is prefilled with THIS one — the same rule the agent applies to a sentence (a
  // context-side or acting party the realm's class admits). A person realm prefills nothing: "you" is never
  // the default counterparty of your own command. Editable: the prefill is a value, not a lock.
  const realmSuffix = realm?.kind === 'org' ? 'org' : realm?.kind === 'service' ? 'svc' : null;
  const selSuffix = selection ? ({ person: 'me', me: 'me', org: 'org', team: 'team', workspace: 'workspace', treasury: 'treasury', 'person-treasury': 'treasury', 'org-treasury': 'treasury', circle: 'circle', church: 'church', service: 'svc' } as Record<string, string>)[selection.kind] ?? selection.kind : null;
  const prefilled: Record<string, string | boolean> = {};
  // The SELECTION first (spec 361 I6 — the member you clicked, the team you have open), then the realm.
  for (const f of fields) {
    if (f.kind !== 'agent') continue;
    if (selection && selSuffix && f.types?.includes(selSuffix)) prefilled[f.name] = selection.entity;
    else if (realmSuffix && addressee && f.types?.includes(realmSuffix)) prefilled[f.name] = addressee;
  }
  // A DRAFT being edited (spec 361 I5) starts from its own values, not the context's.
  if (initial) for (const [k, v] of Object.entries(initial)) if (typeof v === 'string' || typeof v === 'boolean') prefilled[k] = v;
  const [values, setValues] = useState<Record<string, string | boolean>>(prefilled);
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
      <div style={{ fontWeight: 600, fontSize: 13 }}>{command.label ?? command.id}{draftOf ? <span className="muted" style={{ fontWeight: 400 }}> — editing the draft “{draftOf}”</span> : null}</div>
      {fields.map((f: CommandField) => (
        <div key={f.name} style={{ marginTop: 8 }}>
          <label className="muted" style={{ fontSize: 11.5, display: 'block' }} htmlFor={`ask-c-${f.name}`}>
            {f.label}{f.required ? '' : ' (optional)'}{f.kind === 'agent' && f.types?.length ? ` — a ${f.types.join(' / ')}` : ''}
          </label>
          {f.hint && <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{f.hint}</div>}
          {f.kind === 'flag' ? (
            <input id={`ask-c-${f.name}`} type="checkbox" checked={values[f.name] === true} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
          ) : (<>
            <input
              id={`ask-c-${f.name}`} className="input" data-testid={`ask-command-${f.name}`}
              type={f.kind === 'amount' ? 'number' : 'text'} inputMode={f.kind === 'amount' ? 'decimal' : undefined} step={f.kind === 'amount' ? 'any' : undefined}
              placeholder={f.kind === 'agent' ? (f.acceptsEmail ? 'a name (alice.me), a person you know, an address — or an email for someone without an agent yet' : 'a name (alice.me), a person you know, or an address') : f.kind === 'amount' ? 'e.g. 10' : ''}
              value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
            {f.kind === 'agent' && selection && String(values[f.name] ?? '').toLowerCase() === selection.entity.toLowerCase() && (
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{selection.label ?? selection.entity} — the one you selected; change it to name another</div>
            )}
            {f.kind === 'agent' && addressee && addresseeLabel && String(values[f.name] ?? '').toLowerCase() === addressee.toLowerCase() && !(selection && selection.entity.toLowerCase() === addressee.toLowerCase()) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{addresseeLabel} — the one you are in; change it to name another</div>
            )}
          </>)}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="btn primary" data-testid="ask-command-submit" disabled={missing.length > 0} onClick={submit}>{missing.length ? `Needs ${missing.map((f) => f.label).join(', ')}` : draftOf ? 'Send the edited draft' : 'Do it'}</button>
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
  /** Spec 381 W3 — the run this turn belonged to, and whose agent ran it: what "what my agent did" reads back. */
  runRef?: string;
  addressee?: Address;
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
function DiagnosticsPane({ entries, token, onClose }: { entries: DiagEntry[]; token: string; onClose: () => void }) {
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
          {e.runRef && e.addressee && <RunInspector token={token} addressee={e.addressee} runRef={e.runRef} open={false} />}
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
        <strong>planner</strong> {trace.planner}{trace.model ? `(${trace.model})` : ''}
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
          {/* Spec 377 — what the planner was SHOWN of the playbook, and what a provider's budget made it do
              without. A drop the person cannot see is a drop they cannot account for when a plan is worse. */}
          {trace.instructionsRendered && (
            <div>playbook shown: {trace.instructionsRendered.chars.toLocaleString()} of {trace.instructionsRendered.of.toLocaleString()} chars (the doctrine; the per-act bodies ride as tools)</div>
          )}
          {trace.promptBudget && (
            <div>
              prompt budget: ~{trace.promptBudget.estimated.toLocaleString()} of {trace.promptBudget.tokens.toLocaleString()} tokens
              {trace.promptBudget.trimmed.length ? ` — fitted by ${trace.promptBudget.trimmed.join(', ')}` : ' — nothing dropped'}
            </div>
          )}
          <div>tools exposed: {trace.toolsExposed.join(', ')}</div>
          {refusals.map((a, i) => a.refused.map((v, k) => <div key={`${i}-${k}`}>· {v.message}</div>))}
        </>
      )}
    </div>
  );
}

/** What the agent said, in the shape it said it. */
function ReplyView({ reply, realm, addressee, onNext }: { reply: AskReply; realm?: { kind?: 'person' | 'org' | 'service' }; addressee?: `0x${string}` | null; onNext?: (next: { capability: string; args: Record<string, unknown>; words: string; why?: string }) => void }) {
  if (reply.kind === 'answer') {
    // Spec 380 W2 — WHAT EACH MEMBER SAID, in their own words: an answer, a decline WITH ITS REASON, or "not
    // asked" and why. The composed sentence above it may summarise; this is the evidence, per member.
    // The consults ran at the ORGANIZATION (routed, spec 366), so what each member's agent said reaches this
    // reply as evidence — one line per member: "asked X's agent … — it declined: <their reason>", "skipped X:
    // no consultability grant". The organization's composed sentence may summarise; these are the words.
    const consults = ((reply as { evidence?: AskEvidence[] }).evidence ?? []).filter((e) => e.toolId === 'organization.member.consult' && e.interpretation);
    // Spec 402 W4 — THE APP INSIDE THE ASK: the answered read's contract names a result component; it renders here over
    // that step's result, beside the sentence. An unknown name renders nothing and the sentence stands.
    const appStep = reply.interaction?.result ? (reply.results ?? []).find((x) => x.toolId === reply.interaction?.toolId) ?? (reply.results ?? [])[0] : undefined;
    const app = appStep ? resultApp(reply.interaction?.result, { result: appStep.result, toolId: appStep.toolId }) : null;
    return (
      <div>
        <span>{reply.text}</span>
        {app}
        {/* Spec 402 W1b — a memory PROPOSED from what she said: one click keeps it; nothing is written until then. */}
        {reply.next && (
          <div style={{ marginTop: 6 }} data-testid="ask-next">
            <button type="button" className="btn" style={{ fontSize: 12, padding: '4px 10px', minHeight: 0 }} onClick={() => onNext?.(reply.next!)}>
              {reply.next.words.charAt(0).toUpperCase() + reply.next.words.slice(1)} →
            </button>
            {reply.next.why && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{reply.next.why}</div>}
          </div>
        )}
        {consults.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11.5 }} data-testid="ask-consults">
            {consults.map((c, i) => <li key={i} className="muted">{c.interpretation}</li>)}
          </ul>
        )}
      </div>
    );
  }
  // Spec 374 — the run waits on another agent's steward: said as a sentence, asked of nobody here. The run
  // stays in the unfinished list until the other agent's answer arrives; there is nothing to click.
  if (reply.kind === 'waiting') return <span>{reply.text}</span>;
  if (reply.kind === 'done') {
    const r = reply.result as { name?: string; agent?: string; txHash?: string; alreadyCreated?: boolean } | null;
    const doneApp = resultApp(reply.interaction?.result, { result: reply.result });
    return (
      <div>
        {doneApp}
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
        {/* Spec 376 W2 — HANDED TO A SPECIALIST: the step ran at another agent under a child mandate attenuated
            from the one this person signed. Said here because "Done" alone reads as "your agent did it". */}
        {(reply.routed ?? []).filter((x) => x.observedVia === 'handoff').map((x, i) => (
          <div key={`handoff-${i}`} className="muted" style={{ fontSize: 11.5, marginTop: 3 }} data-testid="ask-handed-to">
            Handed to {x.name ? <span title={x.agent}>{x.name}</span> : <AgentName address={x.agent} />} — it ran there under a child mandate cut from yours{x.runRef ? ` (its run ${x.runRef.slice(0, 18)}…)` : ''}.
          </div>
        ))}
        {/* Spec 383 W2 — THE CHAIN ON THE RECEIPT, in words: a routed step ran at another agent, and that agent's
            receipt names the standing it ran under — for whom, and under which steward wire, by digest. */}
        {(reply.routed ?? []).filter((x) => x.observedVia !== 'handoff').flatMap((x, i) => {
          const st = x.standing && x.standing.relation !== 'none' ? x.standing : undefined;
          return st ? [
            <div key={`standing-${i}`} className="muted" style={{ fontSize: 11.5, marginTop: 3 }} data-testid="ask-standing-link">
              Done by {x.name ? <span title={x.agent}>{x.name}</span> : <AgentName address={x.agent} />}’s agent — {st.relation === 'self' ? 'its own' : st.relation === 'steward' ? `for it, under a steward wire${st.wireRef ? ` ${short(st.wireRef)}` : ''} held by ${short(st.principal)}` : `as a ${st.relation}`}: {st.because}.
            </div>,
          ] : [];
        })}
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
        {/* Spec 368 §3 — WHAT MAY FOLLOW, proposed by the agent as a compiled command ("invite Bob to your
            household as spouse"). One click runs it as a new turn, which asks for its own signature: the
            proposal carries no authority, and nothing was done on the side. */}
        {reply.next && (
          <div style={{ marginTop: 6 }} data-testid="ask-next">
            <button type="button" className="btn" style={{ fontSize: 12, padding: '4px 10px', minHeight: 0 }} onClick={() => onNext?.(reply.next!)}>
              {reply.next.words.charAt(0).toUpperCase() + reply.next.words.slice(1)} →
            </button>
            {reply.next.why && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{reply.next.why}</div>}
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
      {/* spec 398 §4.4 — the two facts, side by side, on the review card: who acts, in what, on what basis. */}
      <BasisLine needs={`${capabilityWords(reply.capability)} as ${short(d.delegator)}, this request only`} style={{ margin: '4px 0 2px' }} />
      <p style={{ fontSize: 12.5, margin: '6px 0 0', lineHeight: 1.5 }}>
        To do this, <AgentName address={reply.delegate} /> needs permission to <strong>{capabilityWords(reply.capability)}</strong> as{' '}
        <strong><AgentName address={d.delegator} /></strong> — for <strong>this request only</strong>, expiring in {d.expiresInMinutes} minutes.
      </p>
      {/* WHO IT RESOLVED TO. When several agents answered to the name the person picked one and knows what
          they picked. When exactly ONE did, nobody was asked anything — which is precisely the case where a
          wrong resolution goes unnoticed until after the signature. So the words and what they became are
          shown together, and a person who typed "nathan" can see which Nathan they are about to authorize. */}
      {/* Spec 402 W4 — the REVIEW app the capability's contract names: what she is about to sign, in the act's own shape. */}
      {reply.interaction?.review && reviewApp(reply.interaction.review, { requirement: reply.requirement, capability: reply.capability, ...(reply.parties ? { args: Object.fromEntries(reply.parties.map((p) => [p.arg, p.label ?? p.raw])) } : {}) })}
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
                      border: `1px solid ${picked ? 'var(--color-border-strong)' : 'var(--color-border)'}`,
                      background: picked ? 'var(--color-surface-sunken)' : 'transparent', boxShadow: picked ? 'inset 3px 0 0 var(--color-amber-500)' : 'none',
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
