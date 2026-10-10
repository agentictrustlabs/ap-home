// A PUBLISHED WORK, READ THE WAY A STRANGER READS IT. A `signed-release` document's commitment is the root of a
// release a publisher's agent signed. The Home holds no copy: it asks the publisher gateway over A2A with no
// credential (`publishing.work`, then `publishing.part` for the text), and asks the gateway's own verifier whether
// the release reproduces and the owner's signature holds. Server-side only (a Next route), so no browser talks to
// the gateway and its CORS allow-list is not ours to widen (ADR-0044). No fallback: when any step fails the answer
// says why, and the signing page refuses (ADR-0013).
import type { AttestationSource } from '../profile-store';

export interface PublishedPart { n: number; title: string; text: string | null }

export interface PublishedWork {
  /** The commitment the attestation stores — the work root of the signed release. */
  docHash: string;
  source: AttestationSource;
  title: string;
  url: string;
  partCount: number;
  /** The gateway verifier's verdict: `verified` is the only value the signing page accepts. */
  verdict: string;
  signatureStatus: string;
  parts: PublishedPart[];
}

export type PublishedWorkRead = { ok: true; value: PublishedWork } | { ok: false; why: string };

interface WorkAnswer {
  work?: {
    title?: string; url?: string; handle?: string; slug?: string; version?: number; author?: string;
    workRoot?: string; contentCommitment?: string; signatureStatus?: string; partCount?: number;
    manifest?: { content?: { workRoot?: string; partCount?: number; parts?: Array<{ n: number; title: string; root: string }> } };
    release?: { releaseId?: string; version?: string; owner?: string; signed?: boolean };
  };
}

interface PartAnswer { part?: { n?: number; title?: string; text?: string | null } }

/** The card is the only way to find the interface. */
async function interfaceOf(card: string): Promise<{ endpoint: string } | { why: string }> {
  let json: { url?: string; supportedInterfaces?: Array<{ url?: string; protocolBinding?: string }> };
  try {
    const r = await fetch(card, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return { why: `the publisher's agent card answered ${r.status}` };
    json = (await r.json()) as typeof json;
  } catch (e) {
    return { why: `the publisher's agent card could not be read (${e instanceof Error ? e.message : 'fetch failed'})` };
  }
  const rpc = json.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC') ?? json.supportedInterfaces?.[0];
  const endpoint = rpc?.url ?? json.url;
  if (!endpoint) return { why: "the publisher's agent card names no A2A interface" };
  return { endpoint };
}

/** One anonymous `message/send` naming a publishing skill in the message metadata; the result, or why there is none. */
async function skill<T>(endpoint: string, metadata: Record<string, unknown>): Promise<{ ok: true; result: T } | { ok: false; why: string }> {
  const body = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { metadata } } };
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch (e) {
    return { ok: false, why: `the publisher could not be reached (${e instanceof Error ? e.message : 'fetch failed'})` };
  }
  const out = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!out) return { ok: false, why: `the publisher answered ${res.status} with no JSON` };
  if (out.error) return { ok: false, why: out.error.message ?? `the publisher refused (${res.status})` };
  if (out.result === undefined) return { ok: false, why: 'the publisher answered without a result' };
  return { ok: true, result: out.result };
}

/** Read the work answer into a source record, or say what is missing. Pure; tested. */
export function readWorkAnswer(answer: WorkAnswer, endpoint: string, sourceUrl: string | undefined, expect: { handle: string; slug: string }):
  | { ok: true; docHash: string; source: AttestationSource; title: string; url: string; partCount: number; signatureStatus: string }
  | { ok: false; why: string } {
  const w = answer.work;
  if (!w) return { ok: false, why: 'the publisher answered without a work' };
  if ((w.handle ?? '').toLowerCase() !== expect.handle.toLowerCase() || w.slug !== expect.slug) {
    return { ok: false, why: `the publisher answered for ${w.handle ?? '?'}/${w.slug ?? '?'}, not ${expect.handle}/${expect.slug}` };
  }
  if (!w.workRoot || !/^0x[0-9a-f]{64}$/i.test(w.workRoot)) return { ok: false, why: 'the work carries no root' };
  if (w.manifest?.content?.workRoot && w.manifest.content.workRoot !== w.workRoot) {
    return { ok: false, why: 'the work root does not match its manifest' };
  }
  if (!w.author || !w.contentCommitment || !w.release?.releaseId || typeof w.version !== 'number') {
    return { ok: false, why: 'the work carries no signed release' };
  }
  const partCount = w.partCount ?? w.manifest?.content?.partCount ?? 0;
  const source: AttestationSource = {
    kind: 'signed-release',
    endpoint,
    publisher: w.author.toLowerCase(),
    handle: w.handle!,
    slug: w.slug!,
    version: w.version,
    contentCommitment: w.contentCommitment,
    releaseId: w.release.releaseId,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
  return { ok: true, docHash: w.workRoot, source, title: w.title ?? expect.slug, url: w.url ?? '', partCount, signatureStatus: w.signatureStatus ?? 'unchecked' };
}

/** The gateway's own verifier lives beside its A2A interface: `<base>/public/<handle>/<slug>/verify`. */
export function verifyUrlFor(endpoint: string, handle: string, slug: string): string {
  const base = endpoint.replace(/\/a2a\/?$/, '');
  return `${base}/public/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}/verify`;
}

/** The published work behind a signed-release document — commitment, provenance, verdict and (free) text. */
export async function publishedWorkOf(
  doc: { card: string; handle: string; slug: string; sourceUrl?: string },
  opts: { withText?: boolean } = {},
): Promise<PublishedWorkRead> {
  const iface = await interfaceOf(doc.card);
  if ('why' in iface) return { ok: false, why: iface.why };
  const { endpoint } = iface;

  const work = await skill<WorkAnswer>(endpoint, { skill: 'publishing.work', handle: doc.handle, slug: doc.slug });
  if (!work.ok) return { ok: false, why: work.why };
  const read = readWorkAnswer(work.result, endpoint, doc.sourceUrl, { handle: doc.handle, slug: doc.slug });
  if (!read.ok) return { ok: false, why: read.why };

  // The gateway verifies the whole chain (manifest commitment, release reproduces, owner is publisher, parts match,
  // work root, owner signature) against its chain. We ask it rather than trusting the stored status alone.
  let verdict = 'unchecked';
  try {
    const v = await fetch(verifyUrlFor(endpoint, doc.handle, doc.slug), { headers: { accept: 'application/json' }, cache: 'no-store' });
    const vj = (await v.json().catch(() => null)) as { verdict?: string; workRoot?: string } | null;
    if (!v.ok || !vj) return { ok: false, why: `the publisher's verifier answered ${v.status}` };
    if (vj.workRoot && vj.workRoot !== read.docHash) return { ok: false, why: 'the verifier saw a different work root than the work answer' };
    verdict = vj.verdict ?? 'unchecked';
  } catch (e) {
    return { ok: false, why: `the publisher's verifier could not be reached (${e instanceof Error ? e.message : 'fetch failed'})` };
  }

  let parts: PublishedPart[] = [];
  if (opts.withText && read.partCount > 0) {
    const reads = await Promise.all(
      Array.from({ length: read.partCount }, (_, i) => skill<PartAnswer>(endpoint, { skill: 'publishing.part', handle: doc.handle, slug: doc.slug, part: i + 1 })),
    );
    for (const [i, r] of reads.entries()) {
      if (!r.ok) return { ok: false, why: `part ${i + 1} could not be read (${r.why})` };
      const p = r.result.part;
      parts.push({ n: p?.n ?? i + 1, title: p?.title ?? `Part ${i + 1}`, text: p?.text ?? null });
    }
    parts = parts.sort((a, b) => a.n - b.n);
  }

  return {
    ok: true,
    value: { docHash: read.docHash, source: read.source, title: read.title, url: read.url, partCount: read.partCount, verdict, signatureStatus: read.signatureStatus, parts },
  };
}
