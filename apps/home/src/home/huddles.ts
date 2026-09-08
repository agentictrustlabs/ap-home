// HUDDLES — spec 378. The Home's client for the governed call: every operation is a Worker route the
// caller's session is verified on and the caller's standing is derived on. The ONE credential that ever
// reaches this code — a join's `authToken` — is handed straight to the browser SDK and kept nowhere
// else: not in state that persists, not in a URL, not in a log.
import { postA2a } from './ask';

export type HuddleScopeKind = 'conversation' | 'topic' | 'org' | 'team' | 'workspace';
export interface HuddleScope { kind: HuddleScopeKind; principal: string; id?: string }
export interface HuddleRosterEntry { actor: string; represented?: string; role: 'host' | 'participant'; joined: boolean }
export interface HuddleRunView {
  runId: string; scope: HuddleScope; state: 'creating' | 'active' | 'ending' | 'ended';
  startedBy: string; startedAt: number; endedAt?: number; roster: HuddleRosterEntry[];
  provider?: { kind: 'realtimekit'; meetingId: string; deactivatedAt?: number; kickedAt?: number };
}
export type HuddleReply = { ok: true; run: HuddleRunView | null; authToken?: string; participant?: { role: 'host' | 'participant'; correlationId: string }; parks?: string } | { ok: false; error: string; parks?: boolean; notConfigured?: boolean };

const key = (op: string) => `${op}:${crypto.randomUUID()}`;

async function op(session: { token: string }, name: string, scope: HuddleScope, extra: Record<string, unknown> = {}): Promise<HuddleReply> {
  const r = await postA2a(`/a2a/huddles/${name}`, { session: session.token, scope, key: key(name), ...extra }) as Record<string, unknown>;
  if (r.ok === true) return { ok: true, run: (r.run as HuddleRunView | null) ?? null, ...(typeof r.authToken === 'string' ? { authToken: r.authToken } : {}), ...(r.participant ? { participant: r.participant as { role: 'host' | 'participant'; correlationId: string } } : {}), ...(typeof r.parks === 'string' ? { parks: r.parks } : {}) };
  const error = String(r.error ?? 'that did not go through');
  return { ok: false, error, ...(r.parks ? { parks: true } : {}), ...(error === 'huddles_not_configured' ? { notConfigured: true } : {}) };
}

export const huddles = {
  get: (session: { token: string }, scope: HuddleScope) => op(session, 'get', scope),
  start: (session: { token: string }, scope: HuddleScope, displayName: string, represented?: string) => op(session, 'start', scope, { displayName, ...(represented ? { represented } : {}) }),
  join: (session: { token: string }, scope: HuddleScope, displayName: string, represented?: string) => op(session, 'join', scope, { displayName, ...(represented ? { represented } : {}) }),
  leave: (session: { token: string }, scope: HuddleScope) => op(session, 'leave', scope),
  end: (session: { token: string }, scope: HuddleScope) => op(session, 'end', scope),
  invite: (session: { token: string }, scope: HuddleScope, invitee: string) => op(session, 'invite', scope, { invitee }),
  removeParticipant: (session: { token: string }, scope: HuddleScope, target: string) => op(session, 'removeParticipant', scope, { target }),
};

export const scopeLabel = (s: HuddleScope, name?: string): string => name ?? `${s.principal.slice(0, 8)}…`;
