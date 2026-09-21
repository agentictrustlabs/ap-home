// GET /published/shelf — the shelf as JSON, for the front door's fold (spec 412). The same anonymous A2A read the page
// makes; the browser never talks to the edge itself. `?name=` on the apex; the subdomain elsewhere.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { shelfOf } from '../../../src/lib/public-shelf';
import { nameLabel, parseAgentSubdomain } from '../../../src/lib/domain';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0] ?? '';
  const fromHost = parseAgentSubdomain(host);
  const q = url.searchParams.get('name');
  const label = fromHost ?? (q ? nameLabel(q) : '');
  if (!label || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(label)) return Response.json({ ok: false, error: 'whose shelf? — no name' }, { status: 400 });
  const r = await shelfOf(label);
  if (!r.ok) return Response.json({ ok: false, error: r.why, ...(r.cardUri ? { cardUri: r.cardUri } : {}) }, { status: 502 });
  const docs = r.value.files.filter((f) => !f.isFolder);
  return Response.json({ ok: true, label, owner: r.value.owner, count: docs.length, files: docs.slice(0, 20), cardUri: r.value.cardUri, endpoint: r.value.endpoint }, { headers: { 'cache-control': 'public, max-age=60' } });
}
