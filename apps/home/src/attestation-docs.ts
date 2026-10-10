// Attestable documents — statements a member affirms once at their Home and re-uses across relying apps
// (the WEA Statement of Faith was the first; the Lausanne Covenant is the second). The person is the only
// attester: the record says "this member affirmed this exact text at their Home". The document's author is
// never a party to it.
//
// A document's content commitment is one of two kinds:
//
//   • inline-text     — the Home holds the canonical bytes and the commitment is their SHA-256. Changing the
//                       bytes is a breaking change (prior signatures stay anchored to the old hash).
//   • signed-release  — the commitment is the root of a release a publisher's agent signed. The Home holds no
//                       copy of the text; it reads the release from the publisher over A2A (server-side, see
//                       `lib/published-work.ts`) and will not sign unless the publisher's verification passes.
//                       Re-publishing changes the root, which is the same "changed bytes → re-sign" rule the
//                       inline kind gets by construction. The root covers the text alone, so the stored record
//                       also binds who published it (`AttestationSource`).
//
// Kind names describe the mechanism, never a product.
import type { AttestationSource, StoredAttestation } from './profile-store';

export type DocumentCommitment =
  | { kind: 'inline-text'; text: string }
  | {
      /** The publisher gateway's agent card; the only way to find its A2A interface (nothing assumes where it listens). */
      kind: 'signed-release'; card: string; handle: string; slug: string;
    };

export interface AttestableDocument {
  /** Stable document id — what a relying app matches on (`docId` in the stored record and the return params). */
  id: string;
  /** Key under `profile.attestations`. The WEA keeps `wea`, the key relying apps already read. */
  storageKey: string;
  /** Query-param prefix on the relying-app return. The WEA keeps `wea` (`wea_docHash=…`), the existing wire contract. */
  returnPrefix: string;
  icon: string;
  title: string;
  /** Who wrote the words. Attribution only — not an attester, not a party. */
  author: string;
  /** Where the words came from, for the reader. Omitted when the author publishes no canonical page. */
  sourceUrl?: string;
  /** One line for the list row. */
  summary: string;
  /** The sentence beside the checkbox. */
  affirmation: string;
  commitment: DocumentCommitment;
}

/** What the signing page needs to build the record, once the commitment is known. */
export interface ResolvedCommitment {
  docHash: string;
  source?: AttestationSource;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** The commitment of an inline-text document: SHA-256 of its canonical bytes. */
export function inlineTextHash(text: string): Promise<string> {
  return sha256Hex(text);
}

/** The consent-binding seed — a hash of the active session token (revoke the session and the attestation is
 *  consent-voided for that app, per ADR-0019). Same derivation the WEA record has always used. */
export function consentBinding(sessionToken: string): Promise<string> {
  return sha256Hex(sessionToken.slice(0, 64));
}

export function buildAttestation(
  doc: AttestableDocument,
  resolved: ResolvedCommitment,
  consentBoundTo: string,
  now: number = Date.now(),
): StoredAttestation {
  const att: StoredAttestation = {
    docHash: resolved.docHash,
    docId: doc.id,
    signedAt: Math.floor(now / 1000),
    consentBoundTo,
  };
  if (resolved.source) att.source = resolved.source;
  return att;
}

/** The query parameters a relying app receives on return. `wea_*` for the WEA (unchanged); `<prefix>_*` otherwise.
 *  A signed-release record also names its publisher, handle, slug, version and release id, so the app can read the
 *  same release and compare roots. */
export function returnParams(doc: AttestableDocument, att: StoredAttestation): Record<string, string> {
  const p = doc.returnPrefix;
  const out: Record<string, string> = {
    [`${p}_docHash`]: att.docHash,
    [`${p}_docId`]: att.docId,
    [`${p}_signedAt`]: String(att.signedAt),
    [`${p}_consentBoundTo`]: att.consentBoundTo,
  };
  if (att.source) {
    out[`${p}_kind`] = att.source.kind;
    out[`${p}_publisher`] = att.source.publisher;
    out[`${p}_handle`] = att.source.handle;
    out[`${p}_slug`] = att.source.slug;
    out[`${p}_version`] = String(att.source.version);
    out[`${p}_releaseId`] = att.source.releaseId;
  }
  return out;
}

export function findDocument(docs: readonly AttestableDocument[], id: string): AttestableDocument | null {
  return docs.find((d) => d.id === id) ?? null;
}

/** The stored record for a document, if the member has signed it. */
export function storedFor(
  attestations: Record<string, StoredAttestation | undefined> | undefined,
  doc: AttestableDocument,
): StoredAttestation | null {
  return attestations?.[doc.storageKey] ?? null;
}
