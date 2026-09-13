// SPEC 400 W1c — THE RUNTIME MEMBER'S CONTAINER: Node + `ap runtime serve` + the ACP agent, next to the Worker, never
// inside it. One instance per member (named by the member's agent address); it sleeps when idle and is started by
// the first wake. The Worker reaches it only as `POST /wake`; ACP stays on stdio inside the Container.
//
// What the Container is given, per member, from the Worker's secrets: the member's record WITHOUT its key
// (`AP_RUNTIME_RECORD_<NAME>`, what `ap runtime export` prints) and the wire's delegate key (`AP_RUNTIME_KEY_<NAME>`).
// Compromise the Container and you hold a revocable wire, not the agent: revoke at the Home and its next request is
// refused. The agent's own credential (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) is the operator's, not ours.
import { Container } from '@cloudflare/containers';
import type { Env } from './index.js';

/** `goose-1.svc` → `GOOSE_1_SVC` — the suffix of the per-member secrets. */
export const memberSecretSuffix = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

export class RuntimeContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '15m';
  // A wake starts a cold Container; give the first one time (the agent's own startup is inside this).
  override async fetch(req: Request): Promise<Response> {
    const secrets = this.env as unknown as Record<string, string | undefined>;
    // The instance's member is in the record; the Worker names instances by address, the secrets by typed name.
    // Every AP_RUNTIME_RECORD_* whose agent matches this instance is the one — one record per member.
    const id = this.ctx.id.name ?? '';
    for (const [k, v] of Object.entries(secrets)) {
      if (!k.startsWith('AP_RUNTIME_RECORD_') || typeof v !== 'string') continue;
      let rec: { agent?: string; name?: string } = {}; try { rec = JSON.parse(v) as typeof rec; } catch { continue; }
      if (String(rec.agent ?? '').toLowerCase() !== id.toLowerCase()) continue;
      const suffix = k.slice('AP_RUNTIME_RECORD_'.length);
      this.envVars = {
        AP_RUNTIME_RECORD: v,
        AP_RUNTIME_MEMBER: String(rec.name ?? ''),
        ...(secrets[`AP_RUNTIME_KEY_${suffix}`] ? { AP_RUNTIME_KEY: secrets[`AP_RUNTIME_KEY_${suffix}`]! } : {}),
        AP_RUNTIME_AGENT: secrets.AP_RUNTIME_AGENT ?? 'acp-stub-agent',
        ...(secrets.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY } : {}),
        ...(secrets.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN } : {}),
      };
      break;
    }
    if (!this.envVars?.AP_RUNTIME_RECORD) return new Response(JSON.stringify({ error: `no AP_RUNTIME_RECORD_* secret names the member ${id}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    return super.fetch(req);
  }
}
