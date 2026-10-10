'use client';
// Attestations — community-wide statements you signed once at your home (spec 315 Activity band).
// One row per attestable document (`src/whitelabel/attestable-documents.ts`), with the signing date when the
// member has signed it. The WEA keeps its /wea-sign URL (relying apps link there); other documents sign at /attest/<id>.
import { useEffect, useState } from 'react';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { SettingsGroup, SettingsRow } from '../../../src/components/portal/settings/SettingsLayout';
import { useSession } from '../../../src/context/session';
import { loadImpactProfile, type StoredAttestation } from '../../../src/profile-store';
import { storedFor, type AttestableDocument } from '../../../src/attestation-docs';
import { ATTESTABLE_DOCUMENTS } from '../../../src/whitelabel/attestable-documents';
import { WEA_DOC_ID } from '../../../src/wea-doc';

function signingHref(doc: AttestableDocument): string {
  return doc.id === WEA_DOC_ID ? '/wea-sign' : `/attest/${encodeURIComponent(doc.id)}`;
}

export default function AttestationsPage() {
  const { agentAddress } = useSession();
  const [attestations, setAttestations] = useState<Record<string, StoredAttestation | undefined> | null>(null);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    // Best-effort: a locked or un-activated vault just means nothing to show as signed.
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setAttestations(p.attestations ?? {}); })
      .catch(() => { if (!cancelled) setAttestations({}); });
    return () => { cancelled = true; };
  }, [agentAddress]);

  return (
    <SectionShell title="Attestations">
      <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .8rem' }}>
        Statements you signed once at your home — shared with aligned apps, never re-signed per app.
      </p>
      <SettingsGroup>
        {ATTESTABLE_DOCUMENTS.map((doc) => {
          const signed = attestations ? storedFor(attestations, doc) : null;
          const value = signed
            ? `✓ Signed ${new Date(signed.signedAt * 1000).toLocaleDateString()} · ${doc.author}`
            : `${doc.summary} · ${doc.author}`;
          return <SettingsRow key={doc.id} icon={doc.icon} label={doc.title} value={value} href={signingHref(doc)} />;
        })}
      </SettingsGroup>
    </SectionShell>
  );
}
