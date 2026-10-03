// GET /connect/demo-selves?handle=<h>  → { selves: [{ sa, name }] }
//
// The person-class agents a demo account STEERS — its personas (persona.ttl pn:PersonaAgent: a trail name,
// a professional name, a character in a play), recorded in the account's own Home as `kind: person,
// relationship: self` by the charter ceremony and custodied by the same seeded key. This is exactly the set
// `POST /connect/demo-signin { handle, as }` validates its `as` against (demo-accounts.ts), so an app can
// offer a custodian the personas they may come in AS and never show one the sign-in would refuse.
//
// Public, like /connect/demo-personas: naming an account's selves discloses no key and authorizes nothing —
// coming in AS one still goes through demo-signin, which re-checks the same `related:` record.
import { demoPersonaFor } from '../_lib/demo-custody';
import type { FnContext } from '../_lib/server-broker';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const handle = (new URL(request.url).searchParams.get('handle') ?? '').trim();
  if (!handle) return json({ error: 'handle required' }, 400);
  const persona = demoPersonaFor(env, handle);
  if (!persona) return json({ error: 'unknown demo account' }, 404);

  const prefix = `related:${persona.sa.toLowerCase()}:`;
  const selves: { sa: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.AUTH_CODES.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const raw = await env.AUTH_CODES.get(key.name);
      if (!raw) continue;
      let link: { kind?: string; relationship?: string; orgName?: string; status?: string };
      try {
        link = JSON.parse(raw);
      } catch {
        continue;
      }
      if ((link.kind ?? '').toLowerCase() !== 'person' || (link.relationship ?? '').toLowerCase() !== 'self') continue;
      if (link.status === 'deleted' || link.status === 'inactive') continue;
      const sa = key.name.slice(prefix.length);
      if (/^0x[0-9a-f]{40}$/.test(sa)) selves.push({ sa, name: link.orgName || `${sa.slice(0, 6)}…${sa.slice(-4)}` });
    }
    cursor = 'list_complete' in page && page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);

  return json({ selves });
};
