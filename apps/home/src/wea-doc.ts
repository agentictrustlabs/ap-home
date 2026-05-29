// The WEA Statement of Faith — the canonical bytes the member affirms at their Impact
// home and a relying app (e.g. JP Adopt) receives as a hash attestation. Same bytes
// must be used by every app verifying the attestation, so JP keeps its own copy and
// recomputes the hash; if they match, the attestation is valid for JP's purposes.
// The WEA text itself is publicly shareable; only the signature/attestation is private.

export const WEA_DOC_ID = 'wea-statement-of-faith-v1';

export const WEA_AFFIRMATIONS = [
  'The Holy Scriptures as originally given by God, divinely inspired, infallible, entirely trustworthy; and the supreme authority in all matters of faith and conduct.',
  'One God, eternally existent in three persons, Father, Son and Holy Spirit.',
  'Our Lord Jesus Christ, God manifest in the flesh, His virgin birth, His sinless human life, His divine miracles, His vicarious and atoning death, His bodily resurrection, His ascension, His mediatorial work, and His personal return in power and glory.',
  'The Salvation of lost and sinful man through the shed blood of the Lord Jesus Christ by faith apart from works, and regeneration by the Holy Spirit.',
  'The Holy Spirit by whose indwelling the believer is enabled to live a holy life, to witness and work for the Lord Jesus Christ.',
  'The Unity of the Spirit of all true believers, the Church, the Body of Christ.',
  'The Resurrection of both the saved and the lost; they that are saved unto the resurrection of life, they that are lost unto the resurrection of damnation.',
] as const;

/** Canonical bytes. Affirmations numbered 1..N + a trailing newline — the SAME bytes
 *  any app must hash to verify the attestation. Changing this is a breaking change
 *  (prior signatures stay anchored to the old hash; you'd ask members to resign). */
export const WEA_TEXT = [
  'World Evangelical Alliance Statement of Faith',
  '',
  'We believe in:',
  '',
  ...WEA_AFFIRMATIONS.map((a, i) => `${i + 1}. ${a}`),
].join('\n') + '\n';

let _weaHash: string | null = null;
export async function weaDocHash(): Promise<string> {
  if (_weaHash) return _weaHash;
  const bytes = new TextEncoder().encode(WEA_TEXT);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  _weaHash = hex;
  return _weaHash;
}

/** Build a consent-bound WEA attestation — docHash + a hash of the active session
 *  token (the consent-binding seed; revoke the session and the attestation is
 *  consent-voided for that app, per ADR-0019). */
export async function buildWeaAttestation(opts: {
  sessionToken: string;
}): Promise<{ docHash: string; docId: string; signedAt: number; consentBoundTo: string }> {
  const docHash = await weaDocHash();
  const bound = await sha256Hex(opts.sessionToken.slice(0, 64));
  return { docHash, docId: WEA_DOC_ID, signedAt: Math.floor(Date.now() / 1000), consentBoundTo: bound };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}
