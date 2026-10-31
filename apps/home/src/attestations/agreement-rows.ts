// Agreements with apps — the person's own copies of the terms she accepted inside a relying app. The app writes
// one record per accepted release under its self-vault grant (`agreement-acceptance:<releaseId>`); the Home reads
// them over the interactions grant, read-only. A record may carry `withdrawnAt` (an acceptance the app ended); the row
// shows it. Pure: nothing here touches the vault.

export const AGREEMENT_RECORD_PREFIX = 'agreement-acceptance:';

/** The record as the app writes it. Every field is optional on read — a row renders from whatever is there. */
export interface AgreementAcceptanceRecord {
  app?: string;
  agreementId?: string;
  agreementVersion?: string;
  title?: string;
  release?: { publisher?: string; handle?: string; slug?: string; releaseId?: string; workRoot?: string; sha256?: string };
  /** Unix SECONDS, as the signed message carries it. */
  signedAt?: number;
  /** ISO timestamp when the acceptance was ended; absent while it stands. */
  withdrawnAt?: string;
  [k: string]: unknown;
}

export interface AgreementRow {
  recordType: string;
  app: string;
  title: string;
  agreementVersion: string;
  /** The publisher's handle when the record names one, else its address, else ''. */
  publisher: string;
  releaseId: string;
  signedAt: number | null;
  withdrawnAt: string | null;
  record: AgreementAcceptanceRecord;
}

export function isAgreementRecordType(t: string): boolean {
  return t.startsWith(AGREEMENT_RECORD_PREFIX);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Rows for the page: one per agreement record, newest acceptance first. A record that is not an object is skipped;
 *  a missing field renders as '' / null rather than failing the whole list. */
export function agreementRows(records: Array<{ recordType: string; record: unknown }>): AgreementRow[] {
  const rows: AgreementRow[] = [];
  for (const { recordType, record } of records) {
    if (!isAgreementRecordType(recordType)) continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const r = record as AgreementAcceptanceRecord;
    const release = r.release && typeof r.release === 'object' ? r.release : {};
    rows.push({
      recordType,
      app: str(r.app),
      title: str(r.title),
      agreementVersion: str(r.agreementVersion),
      publisher: str(release.handle) || str(release.publisher),
      releaseId: str(release.releaseId) || recordType.slice(AGREEMENT_RECORD_PREFIX.length),
      signedAt: typeof r.signedAt === 'number' && Number.isFinite(r.signedAt) ? r.signedAt : null,
      withdrawnAt: str(r.withdrawnAt) || null,
      record: r,
    });
  }
  rows.sort((a, b) => (b.signedAt ?? 0) - (a.signedAt ?? 0));
  return rows;
}

/** The release's public page on the publishing site — `<site>/@<handle>/<slug>` — or null when the record does not
 *  name both. */
export function releaseUrl(gatewaySite: string, r: AgreementRow): string | null {
  const handle = str(r.record.release?.handle);
  const slug = str(r.record.release?.slug);
  if (!handle || !slug) return null;
  return `${gatewaySite.replace(/\/+$/, '')}/@${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
}
