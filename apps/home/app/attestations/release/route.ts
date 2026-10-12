// GET /attestations/release?doc=<docId> — the signed release behind a `signed-release` document, as JSON for the
// signing page: commitment (work root), provenance, the gateway verifier's verdict, and the text. The same anonymous
// A2A read anyone could make; the browser never talks to the publisher gateway itself (ADR-0044).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { ATTESTABLE_DOCUMENTS } from '../../../src/whitelabel/attestable-documents';
import { findDocument } from '../../../src/attestation-docs';
import { publishedWorkOf } from '../../../src/lib/published-work';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('doc') ?? '';
  const doc = findDocument(ATTESTABLE_DOCUMENTS, id);
  if (!doc) return Response.json({ ok: false, error: 'no such document' }, { status: 404 });
  if (doc.commitment.kind !== 'signed-release') return Response.json({ ok: false, error: 'this document is not read from a publisher' }, { status: 400 });
  const r = await publishedWorkOf({ ...doc.commitment, sourceUrl: doc.sourceUrl }, { withText: url.searchParams.get('text') !== '0' });
  if (!r.ok) return Response.json({ ok: false, error: r.why }, { status: 502 });
  return Response.json({ ok: true, docId: doc.id, ...r.value }, { headers: { 'cache-control': 'public, max-age=60' } });
}
