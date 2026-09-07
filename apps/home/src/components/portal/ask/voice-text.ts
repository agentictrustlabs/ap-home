// Spec 369 — the SURFACE's half of a voice dialog, pure and tested: how a spoken answer meets a pending
// prompt, and after which replies the mic may open again. What is SAID comes from the agent
// (`reply.spoken`); nothing here composes words about the world.
import type { AskReply } from '../../../home/ask';

/** A yes or a no, or neither (then we ask again rather than guess). */
export function yesNo(t: string): 'yes' | 'no' | null {
  const s = ` ${t.toLowerCase().replace(/[^a-z'\s]/g, ' ')} `;
  if (/\b(no|nope|cancel|stop|don't|do not|never mind|nevermind)\b/.test(s)) return 'no';
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|confirm|continue|do it|proceed|approve|approved|grant|granted|sign|agree|agreed)\b/.test(s)) return 'yes';
  return null;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/**
 * Match a spoken answer to ONE offered choice — by ordinal ("the second one", "number 2"), by the whole
 * label, or by a distinctive word of it. Two hits = no match: the surface asks again, never picks.
 */
export function matchChoice(t: string, choices: ReadonlyArray<{ value: string; label: string }>): string | null {
  const s = ` ${t.toLowerCase().replace(/[^\w\s.@-]/g, ' ').replace(/\s+/g, ' ')} `;
  for (let i = 0; i < choices.length; i++) {
    if (new RegExp(`\\b(${ORDINALS[i] ?? `zzz${i}`}|number ${i + 1}|${i + 1})\\b`).test(s)) return choices[i]!.value;
  }
  // The WHOLE label said aloud wins outright ("nathan.me" is not ambiguous because "nathan.org" exists).
  const whole = choices.filter((c) => s.includes(` ${c.label.toLowerCase()} `));
  if (whole.length === 1) return whole[0]!.value;
  const hits = choices.filter((c) =>
    c.label.toLowerCase().split(/[\s.]+/).some((w) => w.length > 2 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)));
  return hits.length === 1 ? hits[0]!.value : null;
}

/**
 * May the mic reopen after this reply? After a question, yes — that is what makes it a dialog. After an
 * authority card or a signature prompt, ALSO yes: "approve" is listened for, and does what the button does —
 * hands the digest to the connected credential, which signs (or whose device asks). The word is never the
 * signature (spec 350 §3.6; spec 369 §1.1); the surface only relays it to the same signer a click reaches.
 * Every reply kind listens; the function stays so the policy has one name and one test.
 */
export function listenAfter(reply: AskReply): boolean {
  void reply;
  return true;
}

/** A local text line (the surface's own note) read aloud: markdown stripped, addresses not read out. */
export function plainSpeech(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[(.+?)\]\([^)]*\)/g, '$1')
    .replace(/0x[0-9a-fA-F]{6,}/g, 'an address').replace(/\s+/g, ' ').trim();
}

// ── Moving between the agents you can ask (a SURFACE act: the same as the workspace switcher) ─────────
//
// "Switch to missio nexus", "go to my organization", "open the somali corridor team", "back to me". The
// flyout stays up; the addressee follows, as it does when the switcher is tapped. Nothing is asked of an
// agent, so nothing here is authority — it is which room the person is standing in.

/** Words that name a KIND of agent, not one agent — the typed suffixes and their long forms. */
const KIND_WORDS = new Set(['me', 'person', 'people', 'org', 'orgs', 'team', 'teams', 'workspace', 'workspaces', 'treasury', 'treasuries', 'svc', 'service', 'services', 'registry', 'church', 'churches', 'circle', 'circles', 'household', 'households', 'organization', 'organisation', 'organizations', 'organisations', 'agent', 'agents', 'account']);
const LEADING = new Set(['the', 'a', 'an', 'my', 'our']);

/** The words that name a thing: lowercased, split, a leading article and the kind words dropped. */
export function nameWords(said: string): string[] {
  const s = said.trim().toLowerCase().replace(/[’']/g, '');
  const label = s.includes('.') && !/\s/.test(s) ? (s.split('.')[0] ?? s) : s;
  const words = label.split(/[^a-z0-9]+/).filter(Boolean);
  const body = words.filter((w, i) => !(i === 0 && LEADING.has(w)));
  const named = body.filter((w) => !KIND_WORDS.has(w));
  return named.length ? named : body;
}

/** "switch to X" / "go to X" / "open X" / "change to X" / "back to me" → X; null when it is not that. */
export function navigationTarget(said: string): string | null {
  // "please", "can you", "let's", "I want to", "now" — the ways a sentence starts before it says what.
  const s = said.trim().replace(/^(?:(?:please|now|ok|okay|hey)[,\s]+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?|let'?s\s+|i(?:'d| would)?\s+(?:want|like)\s+to\s+|please\s+)?/i, '');
  const m = /^(?:switch|change|go|move|jump|take\s+(?:me|us)|back|get\s+(?:me|us))\s+(?:me\s+|us\s+)?(?:over\s+|back\s+)?(?:to|into)\s+(.+?)\s*[.!?]*$/i.exec(s)
    ?? /^(?:open|ask|address|talk\s+to|speak\s+to|switch)\s+(.+?)\s*[.!?]*$/i.exec(s);
  if (!m) return null;
  const target = m[1]!.trim().replace(/^(?:the\s+)?(?:workspace|realm|room)\s+(?:of|for)\s+/i, '');
  return target ? target : null;
}

const bigrams = (s: string): string[] => { const out: string[] = []; for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2)); return out; };
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const B = new Map<string, number>();
  for (const g of bigrams(b)) B.set(g, (B.get(g) ?? 0) + 1);
  let shared = 0;
  const A = bigrams(a);
  for (const g of A) { const n = B.get(g) ?? 0; if (n > 0) { shared++; B.set(g, n - 1); } }
  return (2 * shared) / (A.length + bigrams(b).length);
}

/**
 * The ONE option the words name, by closeness: the joined name words equal, every said word beginning a
 * word of the option, or bigram similarity ≥ 0.8. Two options equally close = null (ask, never pick).
 * "me", "myself", "my home", "you" name the person's own realm — the option flagged `self`.
 */
export function closestOption<T extends { label: string; self?: boolean; aliases?: readonly string[] }>(said: string, options: readonly T[]): T | null {
  const t = said.trim().toLowerCase();
  if (/^(me|myself|my ?home|my ?self|you|home|person|my own|my own realm|my person)$/.test(t.replace(/[.!?]/g, '').trim())) return options.find((o) => o.self) ?? null;
  const saidWords = nameWords(t);
  const joined = saidWords.join('');
  if (!joined) return null;
  const grade = (name: string): number => {
    const words = nameWords(name);
    const j = words.join('');
    if (!j) return 0;
    if (j === joined) return 3;
    if (saidWords.every((w) => w.length >= 3 && words.some((x) => x.startsWith(w)))) return 2;
    if (similarity(joined, j) >= 0.8) return 1;
    return 0;
  };
  // An option answers to its label AND its aliases (a handle beside a display name: "alice" is Alice Okoro).
  const graded = options.map((o) => ({ o, g: Math.max(grade(o.label), ...(o.aliases ?? []).map(grade)) })).filter((x) => x.g > 0);
  if (!graded.length) return null;
  const best = Math.max(...graded.map((x) => x.g));
  const top = graded.filter((x) => x.g === best);
  return top.length === 1 ? top[0]!.o : null;
}
