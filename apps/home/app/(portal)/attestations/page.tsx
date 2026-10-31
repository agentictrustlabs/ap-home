'use client';
// Attestations — community-wide statements you signed once at your home (spec 315 Activity band).
// One row per attestable document (`src/whitelabel/attestable-documents.ts`), with the signing date when the
// member has signed it. The WEA keeps its /wea-sign URL (relying apps link there); other documents sign at /attest/<id>.
// Below them, "Agreements with apps": the terms a member accepted INSIDE a relying app, signed with a DEL-001 session
// leaf and filed by the app in the member's own vault (`agreement-acceptance:<releaseId>`); read here over the
// interactions grant (`src/attestations/agreement-rows.ts`). Read-only here: an acceptance ends at the app, or when the
// app's grant is revoked on /grants.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@agenticprimitives/types';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { SettingsGroup, SettingsRow } from '../../../src/components/portal/settings/SettingsLayout';
import { BusyButton } from '../../../src/components/shared/BusyButton';
import { useSession } from '../../../src/context/session';
import { activateInteractionsIfNeeded, resolveVia } from '../../../src/home/onboarding';
import {
  loadImpactProfile,
  listPersonRecords,
  readPersonRecord,
  VaultKeyUnauthorizedError,
  InteractionsNotEnabledError,
  type StoredAttestation,
} from '../../../src/profile-store';
import { storedFor, type AttestableDocument } from '../../../src/attestation-docs';
import { ATTESTABLE_DOCUMENTS } from '../../../src/whitelabel/attestable-documents';
import { WEA_DOC_ID } from '../../../src/wea-doc';
import { List, Row, Empty, Meta, Unknown } from '../../../src/ui';
import { agreementRows, isAgreementRecordType, releaseUrl, type AgreementRow } from '../../../src/attestations/agreement-rows';

/** The estate's publishing site, where a release's public page lives (`/@<handle>/<slug>`). */
const PUBLISHING_SITE = 'https://publishing.faithnet.io';

function signingHref(doc: AttestableDocument): string {
  return doc.id === WEA_DOC_ID ? '/wea-sign' : `/attest/${encodeURIComponent(doc.id)}`;
}

export default function AttestationsPage() {
  const { session, agentAddress, profile } = useSession();
  const [attestations, setAttestations] = useState<Record<string, StoredAttestation | undefined> | null>(null);

  // Agreements with apps — read from the member's own vault over the interactions grant.
  const [agreements, setAgreements] = useState<AgreementRow[] | null>(null);
  const [gate, setGate] = useState<'vault-key' | 'interactions' | null>(null);
  const [agreementsErr, setAgreementsErr] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableErr, setEnableErr] = useState<string | null>(null);

  const readAgreements = useCallback(async (addr: Address) => {
    const refs = await listPersonRecords(addr);
    const mine = refs.filter((r) => isAgreementRecordType(r.record_type));
    const records = await Promise.all(mine.map(async (r) => ({ recordType: r.record_type, record: await readPersonRecord(addr, r.record_type) })));
    return agreementRows(records);
  }, []);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setAgreements(null); setGate(null); setAgreementsErr(null);
    readAgreements(agentAddress)
      .then((rows) => { if (!cancelled) setAgreements(rows); })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof VaultKeyUnauthorizedError) setGate('vault-key');
        else if (e instanceof InteractionsNotEnabledError) setGate('interactions');
        else setAgreementsErr(String((e as Error)?.message ?? e));
        setAgreements([]);
      });
    return () => { cancelled = true; };
  }, [agentAddress, readAgreements]);

  /** Re-issue the interactions grant + DEL-001 session leaf, then re-read (as PersonVaultReader does). `force`
   *  because a STALE grant — one signed before a scope this page needs — still reports as granted. */
  const enableInteractions = useCallback(async () => {
    if (!agentAddress || !session?.token) return;
    setEnabling(true); setEnableErr(null);
    try {
      const via = resolveVia(profile?.credential as string | undefined, session.via);
      const res = await activateInteractionsIfNeeded(agentAddress, via, { token: session.token }, true);
      if (!res.ok) { setEnableErr(res.error); return; }
      window.location.reload();
    } catch (e) {
      setEnableErr(String((e as Error)?.message ?? e));
    } finally {
      setEnabling(false);
    }
  }, [agentAddress, session?.token, session?.via, profile?.credential]);

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
      <SettingsGroup label="Agreements with apps">
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .8rem' }}>
          Terms you accepted inside an app, signed with a key your agent authorized. Each links to the published release you accepted.
        </p>
        {agreements === null ? (
          <Meta>Reading your vault…</Meta>
        ) : gate === 'vault-key' ? (
          <Empty title="Your vault key isn't active yet"><Link href="/vault-key">Activate your vault key</Link> to read your agreements.</Empty>
        ) : gate === 'interactions' ? (
          // The same action PersonVaultReader offers: it re-issues the grant, which is also how a grant signed before
          // this record family was named gains it.
          <Empty title="Your interactions plane isn't enabled" action={<BusyButton busy={enabling} busyLabel="Enabling…" className="ui-btn ui-btn--primary" onClick={() => void enableInteractions()}>Enable interactions</BusyButton>}>
            That is what holds your agreements. Enabling it signs one grant from your agent; nothing else changes.
            {enableErr && <div className="ui-error" style={{ marginTop: 8 }}>{enableErr}</div>}
          </Empty>
        ) : agreementsErr ? (
          <Unknown read={<>your agreements could not be read ({agreementsErr})</>} />
        ) : agreements.length === 0 ? (
          <Empty>No app agreements yet.</Empty>
        ) : (
          <List>
            {agreements.map((r) => (
              <Row
                key={r.recordType}
                title={`${r.title} v${r.agreementVersion} · ${r.app}`}
                titleHref={releaseUrl(PUBLISHING_SITE, r) ?? undefined}
                meta={r.withdrawnAt
                  ? `withdrawn ${new Date(r.withdrawnAt).toLocaleDateString()}`
                  : `accepted ${r.signedAt !== null ? new Date(r.signedAt * 1000).toLocaleDateString() : '—'} · published by ${r.publisher}`}
              />
            ))}
          </List>
        )}
      </SettingsGroup>
    </SectionShell>
  );
}
