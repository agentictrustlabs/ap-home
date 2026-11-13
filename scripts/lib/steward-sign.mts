// The steward's custodian signature for a SCRIPTED ceremony — a demo persona or a REAL steward (2026-11-12).
//
//   --by <handle>              a demo persona: /connect/demo-signin, then /connect/persona-sign (the Home holds its seeded key)
//   --session-file <path>      a real steward: their own Home session (an agent-session JWT copied from their signed-in Home),
//                              signed through /a2a/custody/oidc/sign — the route their browser uses for every ceremony (the
//                              Home's KMS custodian for a Google/email home), with the Home's CSRF handshake. The session never
//                              leaves this process except to the Home that issued it.
import { readFileSync } from 'node:fs';

type Hex = `0x${string}`;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

export async function stewardSigner(home: string, by: string | undefined, sessionFile: string | undefined): Promise<{ token: string; sub: string; sign: (digest: string) => Promise<Hex> }> {
  if (sessionFile) {
    const token = readFileSync(sessionFile, 'utf8').trim();
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string; exp?: number };
    if (!claims.sub) throw new Error(`${sessionFile} holds no session`);
    if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error(`the session in ${sessionFile} has expired: sign in again and copy a fresh one`);
    const sender = claims.sub.split(':').pop() as Hex;
    // the CSRF handshake the browser does (src/csrf.ts): a token, sent back as a cookie AND the X-CSRF-Token header
    const csrf = await fetch(`${home}/a2a/auth/csrf`, { method: 'GET', headers: { origin: home } });
    const csrfToken = ((await j(csrf)) as { token?: string }).token;
    if (!csrfToken) throw new Error(`the Home's csrf handshake failed (${csrf.status})`);
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] || `agentic-csrf=${csrfToken}`;
    const sign = async (digest: string): Promise<Hex> => {
      const b = await j(await fetch(`${home}/a2a/custody/oidc/sign`, { method: 'POST', headers: { 'content-type': 'application/json', origin: home, cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ session: token, hash: digest, sender }) }));
      if (!b.signature) throw new Error(`the custodian signature was refused: ${b.error ?? ''} ${b.detail ?? ''} ${b._raw ?? ''}`.trim());
      return b.signature as Hex;
    };
    return { token, sub: claims.sub, sign };
  }
  if (!by) throw new Error('--by <steward handle> (a demo persona) or --session-file <path> (a real steward\'s Home session) is required');
  const signin = await j(await fetch(`${home}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
  const token: string = signin.homeSession;
  if (!token) throw new Error(`no session for ${by}`);
  const sign = async (digest: string): Promise<Hex> => {
    const b = await j(await fetch(`${home}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
    if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
    return b.signature as Hex;
  };
  return { token, sub: String(signin.sub ?? ''), sign };
}
