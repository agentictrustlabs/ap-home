'use client';
// WEA Statement of Faith signing at the member's home — the first attestable document, kept at its own URL
// because relying apps (e.g. JP Adopt) link here and read `wea_*` on return. The page is the shared
// `AttestDocument` with the WEA entry from `src/whitelabel/attestable-documents.ts`; the canonical bytes, the
// `wea` storage key and the return params are unchanged.
import { AttestDocument } from '../../../src/components/portal/AttestDocument';
import { findDocument } from '../../../src/attestation-docs';
import { ATTESTABLE_DOCUMENTS } from '../../../src/whitelabel/attestable-documents';
import { WEA_DOC_ID } from '../../../src/wea-doc';

export default function WeaSignPage() {
  const doc = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID);
  if (!doc) throw new Error('the WEA document is missing from the attestable documents');
  return <AttestDocument doc={doc} />;
}
