// GET /connect/client-info?client_id=… — the PUBLIC projection of a registered OIDC client.
//
// The Home's sign-in UI runs in the browser, and it has to answer one question before it renders
// anything: is the app that sent this person here a registered client, and what is it called?
// Curated clients are compiled into the bundle; member-registered ones live in KV, which the
// browser cannot read. This route is the missing lookup.
//
// PUBLIC, and safe to be. Everything returned is already in the URL the person arrived with, or
// is the app's own published identity: its id, its display name, its redirect URIs and the
// delegate it asks grants to be scoped to. There is no owner address, no member data, and no way
// to enumerate — you must already know the client_id to ask about it.
//
// WHAT IT IS NOT: an authorization. The browser uses this to decide whether to show a sign-in or
// a "request blocked" screen; the AUTHORITATIVE checks still run server-side at
// `/oidc/authorize-grant` and `/token`, against the same registry, on every request.

import { json, type FnContext } from '../_lib/server-broker';
import { resolveClient } from '../_lib/oidc-registry';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const clientId = (new URL(request.url).searchParams.get('client_id') ?? '').trim();
  if (!clientId) return json({ ok: false, error: 'client_id required' }, 400);

  const client = await resolveClient(env, clientId);
  // An unknown client and a disabled one answer identically — to a caller they mean the same
  // thing, and distinguishing them would let anyone probe which ids exist.
  if (!client) return json({ ok: false, error: 'unknown client' }, 404);

  return new Response(
    JSON.stringify({
      ok: true,
      client: {
        client_id: client.client_id,
        name: client.name ?? null,
        redirect_uris: client.redirect_uris,
        allowed_delegation_templates: client.allowed_delegation_templates,
        allowed_scopes: client.allowed_scopes,
        delegate: client.delegate,
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Public, non-personal, and read on every sign-in page load. A short cache keeps a
        // registration edit visible within the minute while sparing KV the repeat reads.
        'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*',
      },
    },
  );
};

export const onRequestOptions = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' },
  });
