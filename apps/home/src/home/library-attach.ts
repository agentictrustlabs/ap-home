// ATTACH A FILE IN THE ASK — spec 405 §1.1: the Library IS the store. A file the person hands her agent in the
// conversation is saved to the Library of the realm she stands in (her own, or an organization she stewards) exactly as
// a drag-and-drop is (`/connect/library` save), and the ask then NAMES it — her agent reads it as evidence from its own
// records (`library.file.read`). No upload path of the Ask's own; no second record.
export const ATTACH_MAX_BYTES = 1_400_000;
export type AttachKind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';

export function attachKindFor(name: string, type: string): AttachKind {
  const n = name.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (n.endsWith('.ttl')) return 'ttl';
  if (n.endsWith('.jsonld') || n.endsWith('.json')) return 'json-ld';
  if (n === 'skill.md' || n.includes('skill')) return 'skill';
  return 'md';
}
/** Whether her agent will READ it (text) or only NAME it (an image, a PDF) — said before she sends. */
export function attachReadable(name: string, type: string): boolean {
  const k = attachKindFor(name, type);
  return k !== 'image' && !/^application\/pdf$/.test(type) && !/\.pdf$/i.test(name);
}
const toBase64 = (file: File): Promise<string> =>
  new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)); }; r.onerror = () => rej(r.error); r.readAsDataURL(file); });

export async function attachToLibrary(token: string, file: File, org?: string): Promise<{ ok: true; name: string; id: string; readable: boolean } | { ok: false; error: string }> {
  if (file.size > ATTACH_MAX_BYTES) return { ok: false, error: `${file.name} is larger than ${Math.round(ATTACH_MAX_BYTES / 1_000_000)} MB — the Library takes smaller files here` };
  try {
    const artifact = { name: file.name, kind: attachKindFor(file.name, file.type), source: 'blob', folder: 'attached', bytesB64: await toBase64(file), contentType: file.type || undefined, size: file.size };
    const r = await fetch(`/connect/library${org ? `?org=${org}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'save', ...(org ? { org } : {}), artifact }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; artifact?: { id: string; name: string } };
    if (!r.ok || !j.ok || !j.artifact) return { ok: false, error: j.error ?? `the Library refused (${r.status})` };
    return { ok: true, name: j.artifact.name, id: j.artifact.id, readable: attachReadable(file.name, file.type) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
