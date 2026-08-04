// spec 323 W3.2 — generic ORG-vault access is now FULLY DO-mediated: the org's invite records
// (`org.invite:*`) read/written through the org's InteractionsDO (`invite.get`/`invite.put`, which
// wield the DO-held write-only delivery wire). The Home holds NO org wire. Returns null when the org
// hasn't enabled storage (its DO has no delivery grant — `status.deliveryGranted` is false); callers
// decide whether that's fatal (invites) or best-effort (tracking). Blast-zone unchanged (spec 315):
// invitee email hash + status live encrypted in the org vault, never in KV.
import type { ServerVaultTransport } from './delegated-vault';
import { interactionsBridgeConfigured, type InteractionsBridgeEnv } from './interactions-bridge';
import { callInteractions } from '../connect/channels';

type OrgVaultEnv = InteractionsBridgeEnv;

/** A vault transport bound to the ORG over its DO-held delivery wire, or null when the org hasn't
 *  enabled storage. The transport's get/set bridge to the org's InteractionsDO invite ops. */
export async function orgVault(
  env: OrgVaultEnv,
  orgSA: string,
  /** The caller's session + the org's stewardship delegation, for the AGENT-KEYED records. Absent is
   *  legitimate on the token path, whose caller has neither by definition; absent on an agent-keyed
   *  record simply fails closed at the agent. */
  session?: string,
  stewardship?: unknown,
): Promise<ServerVaultTransport | null> {
  if (!interactionsBridgeConfigured(env)) return null;
  // Probe the DO: no delivery grant ⇒ storage not enabled ⇒ null (status is an open read).
  try {
    const st = await fetch(`${env.A2A_CUSTODY_URL!.replace(/\/$/, '')}/interactions/${orgSA.toLowerCase()}/status`).then((r) => r.json()) as { deliveryGranted?: boolean };
    if (!st?.deliveryGranted) return null;
  } catch {
    return null;
  }
    // spec 341 §5.5b — TWO record families, TWO authorities, chosen by the KEY SHAPE and never by a
    // failure. `org.invite:<token>` is the EMAIL invite: its redeemer has no agent yet, which is the
    // whole reason it exists, so the org-minted single-use token is the capability. Agent-keyed records
    // ride the caller's session; `org.invite:agent:<sa>` specifically rides `invite.claim`, where the
    // agent DERIVES the key from the session — so "read my invite" cannot become "read anyone's".
    //
    // The shared bridge secret is gone from both. It authorized every interactions op for every
    // principal; a per-invite token authorizes one record the org minted and can destroy.
    //
    // ONE dispatch, so there is exactly one place that decides which authority a record type takes.
    const route = (recordType: string, data?: unknown): { op: string; payload: Record<string, unknown> } => {
      const tok = /^org\.invite:(?!agent:)(.+)$/.exec(recordType);
      if (tok) return { op: 'invite.token', payload: { token: tok[1], ...(data !== undefined ? { data } : {}) } };
      const mine = /^org\.invite:agent:(.+)$/.exec(recordType);
      // The key is IGNORED on a self-claim: the agent derives it. Passing it would re-open exactly the
      // hole `invite.claim` closes.
      if (mine && data === undefined) return { op: 'invite.claim', payload: { session } };
      return {
        op: data === undefined ? 'invite.get' : 'invite.put',
        payload: { resource: recordType, ...(data !== undefined ? { data } : {}), session, ...(stewardship ? { stewardship } : {}) },
      };
    };
    return {
      async get(recordType: string) {
        const { op, payload } = route(recordType);
        const r = await callInteractions(env as never, orgSA, op, payload);
        return r.status < 400 ? ((r.body.record ?? r.body.invite ?? null) as unknown) : null;
      },
      async set(recordType: string, data: unknown) {
        const { op, payload } = route(recordType, data);
        const r = await callInteractions(env as never, orgSA, op, payload);
        if (r.status >= 400 || r.body.ok === false) throw new Error(String(r.body.error ?? `${op} failed (${r.status})`));
      },
    } as ServerVaultTransport;

}
