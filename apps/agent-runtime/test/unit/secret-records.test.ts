// Spec 445 (audit REM-2) — the records this runtime holds as SECRETS are `role: 'secret'` in the ontology, so a
// vault question never lists, chooses, opens or returns them. The runtime still READS them, directly and by exact
// key under the person's own grant (`pairwiseSubjectPort`, the reader pass, the credential request) — the grant
// scope names them for that, and a question is a different path.
//
// This pins the agreement from the app's side: a record constant renamed here, or a binding dropped there, and the
// secret would be listed again as an "unclassified" record.
import { describe, expect, it } from 'vitest';
import { askableRecordKinds, bindingForRecordType, isSecretRecordType } from '@agenticprimitives/ontology';
import { PAIRWISE_SECRET_RECORD } from '../../src/subject-hop-credential.js';
import { DEVICE_KEY_PREFIX } from '../../src/reader-pass.js';
import { HOLDER_CREDENTIAL_PREFIX, SUBMISSION_PREFIX } from '../../src/credential-issue.js';
import { APP_CREDENTIAL_SCOPES, APP_IDENTITY_SCOPES } from '@ap-home/shared';

const SECRET_KEYS = [PAIRWISE_SECRET_RECORD, `${DEVICE_KEY_PREFIX}abc`, `${HOLDER_CREDENTIAL_PREFIX}0xabc`, `${SUBMISSION_PREFIX}live-credential:0xabc`];

describe('REM-2 — the runtime\'s secret records are never askable', () => {
  it.each(SECRET_KEYS)('%s is a held secret', (key) => {
    expect(isSecretRecordType(key)).toBe(true);
    expect(bindingForRecordType(key)?.role).toBe('secret');
  });
  it('no askable kind is one of them', () => {
    const askable = new Set(askableRecordKinds().map((k) => k.class + '|' + k.label));
    for (const key of SECRET_KEYS) { const b = bindingForRecordType(key)!; expect(askable.has(b.class + '|' + b.label)).toBe(false); }
  });
  it('the grant still names them — the direct read needs the scope; the question path does not use it', () => {
    expect(APP_IDENTITY_SCOPES).toContain(`vault:${PAIRWISE_SECRET_RECORD}`);
    expect(APP_CREDENTIAL_SCOPES).toContain(`vault:${DEVICE_KEY_PREFIX}*`);
    expect(APP_CREDENTIAL_SCOPES).toContain(`vault:${HOLDER_CREDENTIAL_PREFIX}*`);
  });
});
