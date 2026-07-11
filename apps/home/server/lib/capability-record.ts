// spec 323 W2 — server-side client for the person's OWN-OWN capability records on their
// InteractionsDO (`record.get`/`record.put`, self-gated over the interactions grant). The
// authoritative, delegation-authorized, KEK-encrypted home for `impact-profile` / `skills.data` /
// `home.manifest`; the Home's KV copy is a rebuildable cache. App→a2a(DO)→MCP (ADR-0044): this
// helper hits a2a, never demo-mcp directly.
interface CapEnv { A2A_CUSTODY_URL?: string }
const base = (env: CapEnv): string | null => (env.A2A_CUSTODY_URL?.trim() ? env.A2A_CUSTODY_URL.replace(/\/$/, '') : null);

/** Read the person's capability record, or null (plane not enabled / not configured / never written
 *  — empty is an answer, ADR-0013; the caller may fall back to its KV cache). */
export async function readCapabilityRecord<T>(env: CapEnv, person: string, bearer: string, recordType: string): Promise<T | null> {
  const b = base(env);
  if (!b || !bearer) return null;
  try {
    const r = await fetch(`${b}/interactions/${person.toLowerCase()}/record.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: bearer, recordType }),
    });
    if (!r.ok) return null;
    const out = (await r.json()) as { ok?: boolean; record?: T | null };
    return out.ok ? (out.record ?? null) : null;
  } catch {
    return null;
  }
}

/** Write the person's capability record to the authoritative DO. Returns whether it landed (409 =
 *  interactions plane not enabled — the KV cache still holds it until the person's ceremony). */
export async function writeCapabilityRecord(env: CapEnv, person: string, bearer: string, recordType: string, record: unknown): Promise<boolean> {
  const b = base(env);
  if (!b || !bearer) return false;
  try {
    const r = await fetch(`${b}/interactions/${person.toLowerCase()}/record.put`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: bearer, recordType, record }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
