// SPEC 412 — THE PUBLIC SHELF, READ THE WAY A STRANGER READS IT. A person's Home shows what she made public by asking
// her AGENT over A2A with no credential at all — the card's JSON-RPC interface, a `SendMessage` whose data part names
// `library.public.list` / `library.public.read`, a message back. The Home holds no second store and takes no
// privileged path: what these pages show IS what anyone in the world would get. Server-side (a Next route or page),
// so the page is indexable and no browser talks to the edge (ADR-0044: first-party web speaks to A2A, never MCP).
import { A2A_DOMAIN, AGENT_NAME_PARENT, AGENT_NAME_PARENTS } from './domain';
import { cardUriForName } from './studio-view';

export interface ShelfRelease { releaseId: string; version: string; signed: boolean; signature?: string; owner: string; publishedAt: string; bundleRoot?: string; canonicalId?: string }
export interface ShelfEntry { id: string; name: string; kind: string; folder: string; path: string; contentType: string | null; size: number | null; version: number | null; createdAt?: string; text: boolean; isFolder: boolean; commitment: string | null; release: ShelfRelease | null }
export interface Shelf { owner: string; agentName: string; cardUri: string; endpoint: string; count: number; files: ShelfEntry[] }
export interface ShelfDocument { file: ShelfEntry; text?: string; bytesB64?: string; contentType?: string | null; chars?: number; truncated?: boolean }

export type ShelfRead<T> = { ok: true; value: T } | { ok: false; why: string; cardUri?: string };

/** The card is the only way to find the interface: nothing here assumes where the agent listens. */
async function endpointOf(label: string): Promise<{ cardUri: string; endpoint: string; agentName: string; owner: string } | { why: string; cardUri?: string }> {
  const cardUri = cardUriForName(label, { nameParent: AGENT_NAME_PARENT, nameParents: AGENT_NAME_PARENTS, a2aDomain: A2A_DOMAIN });
  if (!cardUri) return { why: 'no agent host for this name' };
  let card: { name?: string; agentAddress?: string; supportedInterfaces?: Array<{ url?: string; protocolBinding?: string }>; url?: string };
  try {
    const r = await fetch(cardUri, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return { why: `the agent card answered ${r.status}`, cardUri };
    card = (await r.json()) as typeof card;
  } catch (e) {
    return { why: `the agent card could not be read (${e instanceof Error ? e.message : 'fetch failed'})`, cardUri };
  }
  const rpc = card.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC') ?? card.supportedInterfaces?.[0];
  const endpoint = rpc?.url ?? card.url;
  if (!endpoint) return { why: 'the agent card names no JSON-RPC interface', cardUri };
  return { cardUri, endpoint, agentName: card.name ?? label, owner: (card.agentAddress ?? '').toLowerCase() };
}

/** One anonymous `SendMessage` on the public lane; the answer's data part, or why there is none. */
async function publicLane(endpoint: string, data: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; why: string }> {
  const body = { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data }] } } };
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch (e) {
    return { ok: false, why: `the agent could not be reached (${e instanceof Error ? e.message : 'fetch failed'})` };
  }
  const out = (await res.json().catch(() => null)) as { result?: { parts?: Array<{ data?: Record<string, unknown> }> }; error?: { message?: string } } | null;
  if (!out) return { ok: false, why: `the agent answered ${res.status} with no JSON` };
  if (out.error) return { ok: false, why: out.error.message ?? `the agent refused (${res.status})` };
  const part = out.result?.parts?.find((p) => p.data && typeof p.data === 'object')?.data;
  if (!part) return { ok: false, why: 'the agent answered without a data part' };
  return { ok: true, data: part };
}

/** The shelf of the person whose Home label this is. */
export async function shelfOf(label: string, folder?: string): Promise<ShelfRead<Shelf>> {
  const ep = await endpointOf(label);
  if ('why' in ep) return { ok: false, why: ep.why, ...(ep.cardUri ? { cardUri: ep.cardUri } : {}) };
  const r = await publicLane(ep.endpoint, { skill: 'library.public.list', ...(folder ? { folder } : {}), max: 200 });
  if (!r.ok) return { ok: false, why: r.why, cardUri: ep.cardUri };
  const files = (Array.isArray(r.data.files) ? r.data.files : []) as ShelfEntry[];
  return { ok: true, value: { owner: String(r.data.owner ?? ep.owner), agentName: ep.agentName, cardUri: ep.cardUri, endpoint: ep.endpoint, count: typeof r.data.count === 'number' ? r.data.count : files.length, files } };
}

/** One public document by id — `null` when the shelf does not hold it (private and unknown are one answer). */
export async function publicDocumentOf(label: string, id: string): Promise<ShelfRead<ShelfDocument | null>> {
  const ep = await endpointOf(label);
  if ('why' in ep) return { ok: false, why: ep.why, ...(ep.cardUri ? { cardUri: ep.cardUri } : {}) };
  const r = await publicLane(ep.endpoint, { skill: 'library.public.read', id });
  if (!r.ok) return { ok: false, why: r.why, cardUri: ep.cardUri };
  if (r.data.read !== true || !r.data.file) return { ok: true, value: null };
  const d = r.data as { file: ShelfEntry; text?: string; bytesB64?: string; contentType?: string | null; chars?: number; truncated?: boolean };
  return { ok: true, value: { file: d.file, ...(typeof d.text === 'string' ? { text: d.text, chars: d.chars, truncated: d.truncated } : {}), ...(typeof d.bytesB64 === 'string' ? { bytesB64: d.bytesB64, contentType: d.contentType ?? null } : {}) } };
}

/** Markdown front matter (`---\ntitle: …\n---`) → the fields and the body; a document with none is all body. */
export function splitFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}
