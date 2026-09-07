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
