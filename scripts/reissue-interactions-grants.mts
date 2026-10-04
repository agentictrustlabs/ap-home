/**
 * Re-issue the demo personas' interactions grants so they carry the CURRENT scope list.
 *
 *   NEXT_PUBLIC_CHAIN_ID=34348 NEXT_PUBLIC_CONTRACTS_JSON="$(cat packages/contracts/deployments-faithchain.json)" \
 *     npx tsx scripts/reissue-interactions-grants.mts [handle…]
 *
 * A grant's vault-record-scope caveat is fixed at signing time, so widening the scope list in code does
 * nothing for a grant already signed — those keep being denied per-record (`record_scope_denied`) until
 * their owner signs a new one. Deliberately additive rather than blanket-staling every grant, which has
 * stranded the whole interactions plane once before (see REQUIRED_SCOPES in demo-a2a).
 *
 * A real person re-issues by clicking through their Home. This is the DEMO-ESTATE equivalent: the Home
 * holds these personas' custodian keys, so the same signature can be made server-side.
 */
import { buildInteractionsGrantForScript } from '../apps/home/src/lib/delegation';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
// ANOTHER ESTATE'S HOME NEEDS ITS OWN VAULT ID AND SERVICE AGENT — the grant names the vault server and the delegate,
// and the Home's defaults are Faithnet's. Run against ap-home's estate without these, every persona's grant named
// `demo-mcp` and every record read there was refused `record_scope_denied` (2026-09-15).
if (process.env.HOME_URL && !/faithnet\.me$/.test(new URL(HOME).host) && (!process.env.NEXT_PUBLIC_VAULT_SERVER_ID || !process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA)) {
  console.error(`✗ ${HOME} is not Faithnet — set NEXT_PUBLIC_VAULT_SERVER_ID and NEXT_PUBLIC_INTERACTIONS_SERVICE_SA to that estate's (ap-home: home-vault, apps/agent-runtime/wrangler.toml INTERACTIONS_SERVICE_SA)`);
  process.exit(2);
}
const HANDLES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['alice', 'bob', 'carol', 'dave', 'elena', 'nathan', 'david', 'jpreg', 'imbreg'];

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

for (const handle of HANDLES) {
  try {
    const signin = await j(await fetch(`${HOME}/connect/demo-signin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, client_id: 'demo-jp' }),
    }));
    const token: string = signin.homeSession;
    const principal: string = String(signin.agent ?? '').toLowerCase();
    if (!token || !principal) { console.log(`${handle}: no session`); continue; }

    const sign = async (digest: string): Promise<string> => {
      const b = await j(await fetch(`${HOME}/connect/persona-sign`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ digest }),
      }));
      if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
      return b.signature;
    };

    const { grant, sessionLeaf } = await buildInteractionsGrantForScript(principal, sign, async (path) =>
      j(await fetch(`${HOME}/a2a${path}`)));

    const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
    const csrf = (await j(csrfRes)) as { token?: string };
    const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await j(await fetch(`${HOME}/a2a/interactions/${principal}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' },
      body: JSON.stringify({ delegation: grant, ...(sessionLeaf ? { sessionLeaf } : {}) }),
    }));
    const status = await j(await fetch(`${HOME}/a2a/interactions/${principal}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' },
      body: JSON.stringify({ session: token }),
    }));
    console.log(`${handle} ${principal}: grant=${JSON.stringify(res).slice(0, 120)} current=${status.current}`);
  } catch (e) {
    console.log(`${handle}: FAILED ${e instanceof Error ? e.message : String(e)}`);
  }
}
