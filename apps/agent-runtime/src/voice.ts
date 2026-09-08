// VOICE AS A FACET OF THE ASK — spec 369. The agent HEARS and the agent DECIDES WHAT IS SAID; the browser
// only captures and plays.
//
// Four jobs, four owners. Hearing lives here because a generic recognizer mangles exactly our vocabulary
// ("alice2.treasury" → "Alice to treasury", "USDC" → "you S D C") and because audio should not leave our
// boundary for a vendor's recognizer when the asker's own agent can hear it, biased by what it knows —
// the asker's household, the agents chartered under them, the words its capabilities answer to.
//
// WHAT THIS NEVER DOES: store audio or a transcript (processed in memory, discarded), plan, or sign.
// A transcript is words; the words go through `/harness/ask` like typed ones, and a spoken "yes" does
// what a typed "yes" does — nothing authoritative (spec 350 §3.6).
//
// RING PLACEMENT: speech-to-text is a vendor binding (Workers AI Whisper) behind `TranscriberPort`, the
// way the Anthropic planner sits behind the orchestration port. Nothing here belongs in packages/*.

/** The one seam a vendor sits behind. `prompt` is the contextual bias (Whisper's `initial_prompt`). */
export interface TranscriberPort {
  transcribe(input: { audio: Uint8Array; mime: string; prompt: string; language?: string }): Promise<{ text: string }>;
}

/** The Workers AI model. Turbo takes base64 audio and an `initial_prompt`; `vad_filter` drops the silence
 *  a browser recorder leaves at both ends. */
export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

interface AiLike { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

export function workersAiTranscriber(ai: AiLike): TranscriberPort {
  return {
    async transcribe({ audio, prompt, language }) {
      const out = (await ai.run(WHISPER_MODEL, {
        audio: toBase64(audio),
        task: 'transcribe',
        vad_filter: true,
        ...(prompt ? { initial_prompt: prompt } : {}),
        ...(language ? { language } : {}),
      })) as { text?: string } | null;
      return { text: String(out?.text ?? '').trim() };
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── Deterministic repair ─────────────────────────────────────────────────────────────────────────────
//
// A window of the transcript is rewritten to a KNOWN label when the two normalise to the same string —
// exact, never fuzzy. A near miss stays as heard and the person sees it; guessing would put a name in
// someone's mouth. Homophones are folded only inside the comparison ("to" → "2", "dot" → nothing), so
// "pay for the trip" is untouched unless "4thetrip" is somebody's label.

const HOMOPHONES: Record<string, string> = {
  to: '2', too: '2', two: '2', for: '4', four: '4', one: '1', won: '1', three: '3', ate: '8', eight: '8',
  dot: '', point: '', at: '@',
  // Spelled-out letters, as a recognizer writes an acronym it does not know ("you S D C" for USDC).
  you: 'u', see: 'c', sea: 'c', are: 'r', oh: 'o', why: 'y', eye: 'i', bee: 'b', tee: 't', tea: 't', dee: 'd',
  gee: 'g', jay: 'j', kay: 'k', pee: 'p', cue: 'q', queue: 'q', ex: 'x', zee: 'z', el: 'l', em: 'm', en: 'n',
};

/** Lower-case letters and digits only, with the homophones folded per token. */
export function normalizeSpoken(s: string): string {
  return s.toLowerCase().split(/[\s.\-_]+/).filter(Boolean)
    .map((t) => { const bare = t.replace(/[^a-z0-9@]/g, ''); return HOMOPHONES[bare] ?? bare; })
    .join('');
}

export interface Repair { from: string; to: string }

/**
 * Rewrite windows of `text` (1–5 words) that normalise exactly to a known label. Longest window first,
 * left to right; a token's trailing punctuation survives the rewrite. Labels are compared as given AND
 * without their typed suffix ("alice2.treasury" also matches a spoken "alice two"), because people say
 * the part that names, not the part that types.
 */
export function repairTranscript(text: string, labels: readonly string[]): { text: string; repairs: Repair[] } {
  const known = new Map<string, string>();
  for (const l of labels) {
    const label = l.trim();
    if (!label) continue;
    const n = normalizeSpoken(label);
    if (n.length >= 3 && !known.has(n)) known.set(n, label);
  }
  if (!known.size) return { text, repairs: [] };
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const repairs: Repair[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let w = Math.min(5, tokens.length - i); w >= 1; w--) {
      const window = tokens.slice(i, i + w);
      const n = normalizeSpoken(window.join(' '));
      const label = known.get(n);
      if (!label) continue;
      const from = window.join(' ');
      if (from === label) { out.push(from); i += w; matched = true; break; }
      const trail = window[window.length - 1]!.match(/[.,!?;:]+$/)?.[0] ?? '';
      out.push(label + trail);
      repairs.push({ from, to: label });
      i += w; matched = true; break;
    }
    if (!matched) { out.push(tokens[i]!); i++; }
  }
  return { text: out.join(' '), repairs };
}

// ── The ear's vocabulary ─────────────────────────────────────────────────────────────────────────────

export interface HearingVocabulary {
  /** Labels a repair may rewrite TO — names of agents and people the asker knows, asset words. */
  labels: string[];
  /** Everything worth biasing the recognizer with: labels plus the capability verbs. */
  prompt: string;
}

/** One list, deduplicated, bounded — Whisper's prompt is a hint, not a dictionary. */
export function hearingVocabulary(parts: { names: readonly string[]; verbs: readonly string[]; assets?: readonly string[] }): HearingVocabulary {
  const labels = [...new Set([...(parts.assets ?? ['USDC', 'ETH']), ...parts.names].map((s) => s.trim()).filter(Boolean))].slice(0, 120);
  const verbs = [...new Set(parts.verbs.map((s) => s.trim()).filter(Boolean))].slice(0, 60);
  // A prose-shaped prompt biases better than a bare list: Whisper conditions on it as prior text.
  // The answers a dialog asks for are in the prior too: a one-word "Granted." on a one-second clip is the
  // hardest thing the recognizer hears, and the surface takes any positive answer — but "granite" less well.
  const prompt = [
    labels.length ? `Names: ${labels.join(', ')}.` : '',
    verbs.length ? `Things people ask: ${verbs.join('; ')}.` : '',
    'Answers: yes, no, approve, approved, granted, confirm, cancel.',
  ].filter(Boolean).join(' ').slice(0, 1500);
  return { labels, prompt };
}

// ── What is said ──────────────────────────────────────────────────────────────────────────────────────
//
// A screen shows markdown and addresses; a voice reads neither. The agent renders the spoken form because
// it can name what a client cannot — the composer grounded the words, and `nameOf` knows the estate.

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/** Markdown stripped, whitespace folded. Addresses are the caller's job (`spokenFor` names them). */
export function plainSpeech(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\([^)]*\)/g, '$1').replace(/^#+\s*/gm, '').replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ').trim();
}

export interface SpeakableReply {
  kind: 'answer' | 'done' | 'refused' | 'authority_required' | 'prompt' | 'waiting';
  text?: string;
  fulfillment?: { established: string; words: string };
  outcome?: string; error?: string;
  capability?: string; summary?: string;
  prompt?: { kind: string; prompt: string; fields?: Array<{ name: string; label: string; type: string; required?: boolean; choices?: Array<{ value: string; label: string }> }> };
}

/**
 * The spoken rendering of a reply. Authority and signatures are READ, never answered: the person signs on
 * screen, and the words say so. Addresses become names where the agent knows one, else "an address".
 */
export async function spokenFor(reply: SpeakableReply, nameOf: (address: string) => Promise<string | null>, words: (capability: string) => string): Promise<string> {
  // A name is read as a name: "abc.org" is "abc dot org" to a voice, and "voice-test.team" is "voice test
  // dot team" — a typed suffix said aloud is a word, not punctuation.
  const sayable = (s: string) => s.replace(/\b([a-z0-9-]+)\.(me|org|team|svc|workspace|treasury|registry|church|circle|household|impact|agent)\b/gi, (_m, l: string, t: string) => `${l.replace(/-/g, ' ')} dot ${t}`);
  const name = async (s: string) => {
    const addrs = [...new Set(s.match(/0x[0-9a-fA-F]{40}/g) ?? [])];
    let out = s;
    for (const a of addrs) {
      const n = await nameOf(a.toLowerCase()).catch(() => null);
      out = out.split(a).join(n ?? 'an address');
    }
    return sayable(out.replace(/0x[0-9a-fA-F]{6,}/g, 'an address'));
  };
  switch (reply.kind) {
    case 'answer': return name(plainSpeech(reply.text ?? ''));
    // Spec 374 — the run waits on another agent's steward; the words say so, and nothing is asked of the listener.
    case 'waiting': return name(plainSpeech(reply.text ?? 'This is waiting on another agent.'));
    case 'done': {
      const f = reply.fulfillment;
      return name(f ? (f.established === 'submission' ? `Submitted — ${plainSpeech(f.words)}.` : `Done — ${plainSpeech(f.words)}.`) : 'Done.');
    }
    case 'refused': return name(`${reply.outcome === 'denied' ? 'Refused — the authority does not cover this' : 'That did not go through'}${reply.error ? `: ${plainSpeech(reply.error)}` : '.'}`);
    // Authority and a signature are ANSWERED by voice — "approve" does what Grant and continue does: it hands
    // the digest to the connected credential, and the credential signs (or its device asks). The word is
    // never the signature (spec 350 §3.6); it is the same click, said (spec 369 §1.1).
    case 'authority_required': return `This needs your authority to ${words(reply.capability ?? '')}. Say approve to grant it for this request, or no to cancel.`;
    case 'prompt': {
      const p = reply.prompt;
      if (!p) return '';
      if (p.kind === 'signature') return name(`${plainSpeech(p.prompt)} Say approve to sign it, or no to cancel.`);
      if (p.kind === 'confirmation') return name(`${plainSpeech(p.prompt)} Say yes to continue, or no to cancel.`);
      const choice = (p.fields ?? []).find((f) => f.type === 'choice' && f.choices?.length);
      const opts = choice?.choices ? ` Options: ${choice.choices.map((c, i) => `${ORDINALS[i] ?? i + 1}, ${c.label}`).join('; ')}.` : '';
      return name(plainSpeech(p.prompt) + opts);
    }
  }
}
