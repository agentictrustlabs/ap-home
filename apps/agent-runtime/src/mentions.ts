// SPEC 400 W2 (B3) — MENTIONS INTO WORK. `@goose-2` in a topic is not a new Ask typed at an agent; it is a turn PUT
// TO that agent in the thread where the work is. Every member agent of the organization hears its mention (today
// only the org's own assistant did): the mention is ADMITTED into the mentioned member's inbox as a message from the
// poster, on a conversation that IS the topic (`conv_topic-<org>-<channelId>`), carrying a `topic` context ref — the same
// admission a DM gets, so what already listens to admissions listens to mentions: the member's `message` triggers
// (profile `mention`, spec 375) and its runtime wake (W1c). The reply goes back INTO THE TOPIC as the member
// (`messaging.topic.post`), and a mention on a thread where the member has an OPEN run (a run parked for data on
// that thread) supplies the turn to that run instead of opening another (spec 370 P1 — the run is the agent's to
// remember). A runtime member keeps one ACP session per conversation, so a topic is one session there too.
//
// A mention grants nothing: the member is told; what it may do about it is its grant, judged when it acts.
import type { Address } from 'viem';

export const MENTION_RE = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,62})(?:\.(svc|org|team|workspace|me|treasury|household|church|circle))?\b/gi;

export interface MentionRef { label: string; suffix?: string }

/** The `@label` / `@label.svc` handles a post names — each once, in order; case folded. */
export function mentionsIn(bodyText: string): MentionRef[] {
  const seen = new Set<string>(); const out: MentionRef[] = [];
  for (const m of bodyText.matchAll(MENTION_RE)) {
    const label = m[2]!.toLowerCase(); const suffix = m[3]?.toLowerCase();
    const key = `${label}.${suffix ?? '*'}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ label, ...(suffix ? { suffix } : {}) });
  }
  return out;
}

/** The typed names a bare `@label` may mean, in the order an organization's roster makes likely. */
export const MENTION_SUFFIXES = ['svc', 'team', 'org', 'workspace', 'me'] as const;

export interface ResolvedMention { label: string; name: string; agent: Address }

/** Resolve mentions to MEMBER agents: a typed name resolves (`@goose-2` tries `goose-2.svc` … `goose-2.me`), and the
 *  agent is a member of the organization. Unknown handles resolve to nothing — a mention of nobody tells nobody. */
export async function resolveMentions(refs: MentionRef[], io: { resolveName: (name: string) => Promise<Address | null>; isMember: (agent: Address) => Promise<boolean>; exclude?: Address[] }): Promise<ResolvedMention[]> {
  const out: ResolvedMention[] = []; const seen = new Set<string>();
  const excluded = new Set((io.exclude ?? []).map((a) => a.toLowerCase()));
  for (const r of refs) {
    const candidates = r.suffix ? [`${r.label}.${r.suffix}`] : MENTION_SUFFIXES.map((s) => `${r.label}.${s}`);
    for (const name of candidates) {
      const agent = (await io.resolveName(name).catch(() => null))?.toLowerCase() as Address | undefined;
      if (!agent || excluded.has(agent) || seen.has(agent)) { if (agent) break; continue; }
      if (!(await io.isMember(agent).catch(() => false))) break;
      seen.add(agent); out.push({ label: r.label, name, agent }); break;
    }
  }
  return out;
}

/** The conversation a topic IS, for every member that hears it: one thread id shared by the org, the poster and the
 *  mentioned agents — so a runtime keeps one session for it and a harness run can be found by it. */
export const topicThreadId = (org: string, channelId: string): `conv_${string}` => `conv_topic-${org.toLowerCase()}-${channelId}`;

export function parseTopicThread(conversationId: string | undefined): { org: Address; channelId: string } | null {
  const m = /^conv_topic-(0x[0-9a-f]{40})-(.+)$/i.exec(conversationId ?? '');
  return m ? { org: m[1]!.toLowerCase() as Address, channelId: m[2]! } : null;
}

/** The `topic` context ref a mention carries: id `<org>:<channelId>`, label the topic's title. */
export const topicContextRef = (org: string, channelId: string, title?: string): { kind: 'topic'; id: string; label?: string } => ({ kind: 'topic', id: `${org.toLowerCase()}:${channelId}`, ...(title ? { label: title.slice(0, 120) } : {}) });
