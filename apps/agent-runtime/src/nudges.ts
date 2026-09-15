// A NUDGE WHEN SHE IS AWAY — spec 403 W2. A reminder at its hour, an act her agent parked for her signature, a routine's
// answer (only if she said so): one short mail from the estate to the address on her own profile, with a link back to
// the Home — so what her agent did unattended is not invisible until she opens the app. ChatGPT pushes; we mail on the
// rail the deployment has (spec 365), as SYSTEM mail, under a preference she holds (`person.preferences`).
//
// NEVER THE EVIDENCE. A nudge says that something happened and where to look; the answer, the mail thread, the record
// stay in her vault and her Messages. Mail is not her vault. Never authority: a link to a parked act is a link to the
// place she signs, not a signature.
import type { Address } from 'viem';
import { preferencesOf, mayNudge, PREFERENCES_RECORD, type PersonPreferencesV1 } from '@agenticprimitives/context';
import { emailSender, type EmailEnv } from './email-channel.js';

export interface NudgeDeps {
  env: EmailEnv & { ALLOWED_ORIGINS?: string };
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
}
export type NudgeKind = 'reminder' | 'parked' | 'routine';
export interface NudgeInput { agent: Address; kind: NudgeKind; subject: string; text: string; link?: string }
export type NudgeOutcome = { sent: true; to: string } | { sent: false; why: 'no_email_rail' | 'no_address' | 'declined' | 'no_private_tier' | 'failed'; detail?: string };

/** The address on her own profile — the only place her agent takes it from. */
export async function emailOf(deps: NudgeDeps, agent: Address): Promise<string | null> {
  if (!deps.readSubjectRecord) return null;
  const prof = (await deps.readSubjectRecord(agent.toLowerCase(), 'impact-profile').catch(() => null)) as { contact?: { email?: unknown } } | null;
  const e = String(prof?.contact?.email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export async function preferencesFor(deps: NudgeDeps, agent: Address): Promise<PersonPreferencesV1 | null> {
  if (!deps.readSubjectRecord) return null;
  return preferencesOf(await deps.readSubjectRecord(agent.toLowerCase(), PREFERENCES_RECORD).catch(() => null));
}

/** Send one nudge, or say precisely why not. Never throws. */
export async function nudge(deps: NudgeDeps, input: NudgeInput): Promise<NudgeOutcome> {
  // HER PREFERENCE FIRST: a person who turned nudges off is told nothing about mail, whatever the deployment has
  // (a rail-less estate answered "not emailed (no_email_rail)" on a reminder she had asked to keep quiet).
  if (!deps.readSubjectRecord) return { sent: false, why: 'no_private_tier' };
  const prefs = await preferencesFor(deps, input.agent);
  if (!mayNudge(prefs, input.kind)) return { sent: false, why: 'declined' };
  const sender = emailSender(deps.env);
  if (!sender) return { sent: false, why: 'no_email_rail' };
  const to = await emailOf(deps, input.agent);
  if (!to) return { sent: false, why: 'no_address' };
  const home = (deps.env.ALLOWED_ORIGINS?.split(',')[0] ?? 'https://www.faithnet.me').trim();
  const link = input.link ?? `${home}/`;
  const text = `${input.text.trim()}\n\n${link}\n\n— your agent, via ${new URL(home).host}. Turn these off on your Home under Settings → Your agent.`;
  const r = await sender.send({ to, subject: input.subject.slice(0, 120), text }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return r.ok ? { sent: true, to } : { sent: false, why: 'failed', ...(r.error ? { detail: r.error } : {}) };
}
