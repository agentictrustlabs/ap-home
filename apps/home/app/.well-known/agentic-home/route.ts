export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// /.well-known/agentic-home — the personal subdomain serves its owner's signed
// HomeManifestV1 (spec 310 W2). The apex has no personal Home → 404. An
// unpublished Home → 404 (empty is an answer — ADR-0013; never an unsigned
// draft). Consumers must still gate with isManifestCurrent — serving ≠ trust.
import { readStoredManifest } from '../../../server/connect/home-manifest';
import { makeEnv } from '../../_lib/env';
import { parseAgentSubdomain } from '../../../src/lib/domain';

export const GET = async (request: Request): Promise<Response> => {
  const label = parseAgentSubdomain(new URL(request.url).hostname);
  if (!label) return new Response(JSON.stringify({ error: 'no personal home at this host' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const manifest = await readStoredManifest(makeEnv(), label);
  if (!manifest) return new Response(JSON.stringify({ error: 'home manifest not published' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  });
};
