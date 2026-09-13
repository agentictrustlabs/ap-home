// Spec 400 W2 (B4) — the grants screen's read: every grant an agent issued, through `access.grants.audit`. The Ask
// does what the screen does; the screen is the Ask with a supplied plan, addressed to the person's own agent (which
// audits its own grants or those of an organization they steward — never anyone else's).
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export interface GrantRow { kind: string; holder: string; holderName?: string; what: string; digest: string; issuedAt?: string; revoked: boolean; source: string }
export interface GrantsAudit { subject: string; subjectName?: string; why: 'self' | 'stewardship'; count: number; total: number; grants: GrantRow[]; note?: string }

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

export async function auditGrantsThroughHarness(input: { person: Address; session: { token: string }; subject?: string }): Promise<{ ok: true; audit: GrantsAudit } | { ok: false; error: string }> {
  await ensureCsrfToken();
  const args = input.subject ? { subject: input.subject } : {};
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: input.subject ? `what has ${input.subject} granted` : 'what have I granted', plan: { steps: [{ toolId: 'access.grants.audit', args }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'access.grants.audit')?.result as (GrantsAudit & { refused?: string }) | undefined;
    if (found?.refused) return { ok: false, error: found.refused };
    if (found) return { ok: true, audit: found };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'the grants could not be read') };
}
