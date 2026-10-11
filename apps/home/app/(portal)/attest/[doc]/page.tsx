'use client';
// /attest/<docId> — sign any attestable document at the member's home (`src/whitelabel/attestable-documents.ts`).
// Same two modes as /wea-sign (self-sign, or a relying-app handoff with `?app=&return=&state=`).
import { useParams } from 'next/navigation';
import { AttestDocument } from '../../../../src/components/portal/AttestDocument';
import { findDocument } from '../../../../src/attestation-docs';
import { ATTESTABLE_DOCUMENTS } from '../../../../src/whitelabel/attestable-documents';
import { SectionShell } from '../../../../src/components/portal/SectionShell';

export default function AttestPage() {
  const params = useParams<{ doc: string }>();
  const id = typeof params?.doc === 'string' ? decodeURIComponent(params.doc) : '';
  const doc = findDocument(ATTESTABLE_DOCUMENTS, id);
  if (!doc) {
    return (
      <SectionShell title="Attestations" description="No such document.">
        <p style={{ fontSize: '.9rem', color: 'var(--c-g600, #475569)' }}>
          There is no attestable document called <code>{id || '(none)'}</code>. <a href="/attestations">See the documents you can sign.</a>
        </p>
      </SectionShell>
    );
  }
  return <AttestDocument doc={doc} />;
}
