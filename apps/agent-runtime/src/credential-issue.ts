// THE ORGANIZATION ISSUES A MEMBER'S CREDENTIAL — spec 444 W3, capability `credential.issue`.
//
// The ORGANIZATION's act, run at its own agent under a mandate its steward signs (the steward's credential signs as the
// organization). Five steps, each refusing in words and none falling back (ADR-0013):
//   1. STANDING   the member holds a membership in the organization's own records (`org.membership:member:<address>`);
//                 issuing never makes anybody a member — admitting is `organization.membership.invite`.
//   2. ISSUER     the organization's `credential.issuer-facet:<keyId>` record names its facet, the key service's issuing
//                 key (`issuer-key:` purpose, P-256), the credential type and the claim layout.
//   3. ISSUE      `issueOpenAcCredential` in that layout, bound to the member's DEVICE key, signed by the issuing key
//                 under issuance evidence the runtime mints over { digest, issuer_key_id, credential_type }.
//   4. RECORD     `credential.issued:<digest>` in the ORGANIZATION's vault (appc:Issuance): digest, facet, type, member,
//                 the device key's thumbprint — never the claim values.
//   5. DELIVER    the credential returns in the act's result for the member's agent to keep in HER vault.
// The claim values: `member` is the organization's own fact (the roster says so); any other claim in the layout is one
// the steward vouches for in the args and signs for with the mandate — never invented here.
import { InputRequired, type ToolSpec, type ToolInvoker } from '@agenticprimitives/orchestration';
import { issueOpenAcCredential, OpenAcIssueRefusal } from '@agenticprimitives/privacy-credentials-openac/issuer';
import { ADAPTER, CARRIES } from './adapter-declarations.js';

export const CREDENTIAL_ISSUE_CAPABILITY = 'credential.issue' as const;
/** The organization's issuer facet record (spec 444 W3), keyed by the facet's key id. */
export const ISSUER_FACET_PREFIX = 'credential.issuer-facet:' as const;
/** What the organization keeps of an issuance (`appc:Issuance`): the digest, never the claim values. */
export const ISSUED_PREFIX = 'credential.issued:' as const;
/** The organization's vouch for a credential on its live-credential row (ap-federation's projection submission record). */
export const SUBMISSION_PREFIX = 'federation.projection-submission:' as const;
/** The credential as its holder keeps it (`appc:AnonymousCredential`), in her own vault. */
export const HOLDER_CREDENTIAL_PREFIX = 'credential.anonymous:' as const;
const ADDR = /^0x[0-9a-f]{40}$/;

/** The organization's issuer record (`credential.issuer-facet:<keyId>`), as the issuer ceremony writes it. */
export interface IssuerFacetRecordV1 {
  type: 'ap.issuer-facet.v1';
  keyId: string;                              // the facet key id, `issuer-key:sd-jwt:<org>-<n>`
  akcsKeyId: string;                          // the key service's issuing key (purpose `issuer-key:…`, P-256)
  credentialType: string;                     // e.g. `membership`
  claimSchema: string[];                      // the layout the door accepts, slot = claim
  vcSize?: '1k' | '2k' | '4k' | '8k';
  issuer: string;                             // `iss` — the organization's CAIP-10 account
  attestation?: string;
}

export const CREDENTIAL_ISSUE_TOOL: ToolSpec = {
  id: CREDENTIAL_ISSUE_CAPABILITY,
  adapter: ADAPTER.sync,
  carries: CARRIES.credential,
  verbs: ['issue', 'vouch', 'certify'],
  establishes: 'authoritative',
  description:
    'Issues a MEMBER of the organization an anonymous credential the organization vouches for (membership; over-18 when '
    + 'the steward vouches for it), bound to the member\'s device key, so the member can later prove it at a door without '
    + 'saying who she is. Requires a mandate from the organization. Only to a member the organization\'s own records name — '
    + 'it never makes anybody a member (that is an invitation). Args: org (the organization, as the ask names it — whose '
    + 'authority this needs), member (the member\'s agent, as the ask names them), deviceKey (the member\'s P-256 device '
    + 'key JWK, supplied by her agent), claims (claim name → 7-digit value for any claim besides membership the steward '
    + 'vouches for, e.g. { age: "0000021" }).',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The issuing organization (a name or an address)' },
      member: { type: 'string', description: 'The member it is issued to (a name or an address)' },
      deviceKey: { type: 'object', description: 'The member\'s device key, a P-256 JWK { kty, crv, x, y }' },
      claims: { type: 'object', description: 'Claim name → 7-digit value the steward vouches for (besides membership)' },
    },
    required: ['org', 'member', 'deviceKey'],
  },
  capability: { id: CREDENTIAL_ISSUE_CAPABILITY, action: 'issue', resourceArg: 'org', authorityArg: 'org' },
  risk: 'high',
  subject: 'org',
  interaction: { navigationTarget: 'members' },
};

export interface CredentialIssueDeps {
  readRecord: (subject: string, recordType: string) => Promise<unknown>;
  /** The organization's record keys (`internal.coordination.vaultSurvey`) — how its issuer facet is found. */
  survey?: (subject: string) => Promise<Array<{ recordType: string }>>;
  writeRecord: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** The issuing key's signer (the key service, `ES256_ISSUE_SHA256`), given the evidence for THIS signature. */
  issuingSign: (akcsKeyId: string, message: Uint8Array, evidence: { evidenceToken: string; audience: string }) => Promise<Uint8Array>;
  /** The issuing key's public JWK, as the key service publishes it — what a holder's prover verifies the signature with. */
  issuerPublicJwk: (akcsKeyId: string) => Promise<Record<string, unknown>>;
  /** The runtime's attestation key: a statement naming the digest, the facet and the type. */
  mintIssuanceEvidence: (subject: string, claims: { digest: string; issuer_key_id: string; credential_type: string }) => Promise<string>;
  credentialDigestOf: (jwt: string) => Promise<string>;
  thumbprintOf: (jwk: { x: string; y: string }) => string;
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
  nameOf?: (address: string) => Promise<string | null>;
}

const isP256 = (k: unknown): k is { kty: 'EC'; crv: 'P-256'; x: string; y: string } => {
  const o = k as Record<string, unknown> | null;
  return !!o && o.kty === 'EC' && o.crv === 'P-256' && typeof o.x === 'string' && typeof o.y === 'string';
};

export function credentialIssueInvoker(deps: CredentialIssueDeps, mandateDelegator: string, steward: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const org = String(args.org ?? '').toLowerCase();
    const member = String(args.member ?? '').toLowerCase();
    if (org !== mandateDelegator.toLowerCase()) throw new Error(`a credential is issued by the mandate's delegator (${mandateDelegator}); the plan named ${org || 'no organization'}`);
    if (!steward) return { refused: 'issuing a credential is a steward\'s act, and there is no signed-in person on this run' };
    if (!ADDR.test(member)) throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Issue to whom? Give the member\'s agent address.', fields: [{ name: 'member', label: 'Member', type: 'address', required: true }] } as never);
    if (!isP256(args.deviceKey)) throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'The member\'s device key (a P-256 JWK) — her agent supplies it.', fields: [{ name: 'deviceKey', label: 'Device key', type: 'json', required: true }] } as never);

    // 1. STANDING — the roster is the organization's own record.
    const membership = await deps.readRecord(org, `org.membership:member:${member}`);
    const who = (deps.nameOf ? await deps.nameOf(member).catch(() => null) : null) ?? member;
    if (!membership) return { refused: `${who} is not a member in this organization's records — issuing never admits anyone (that is an invitation)`, code: 'not_a_member' };

    // 2. ISSUER — the organization's facet record.
    const facetTypes = deps.survey ? (await deps.survey(org)).map((r) => r.recordType).filter((t) => t.startsWith(ISSUER_FACET_PREFIX)).sort() : [];
    const facet = facetTypes.length ? (await deps.readRecord(org, facetTypes[0]!)) as IssuerFacetRecordV1 | null : null;
    if (!facet || facet.type !== 'ap.issuer-facet.v1' || !facet.akcsKeyId || !Array.isArray(facet.claimSchema)) return { refused: 'this organization has no issuer facet — its steward publishes one before it can issue', code: 'no_issuer_facet' };

    // 3. ISSUE — the layout's claims: `member` from the roster, the rest from the steward's vouching args.
    const vouched = (args.claims ?? {}) as Record<string, unknown>;
    const claims: Array<{ key: string; value: string }> = [];
    for (const key of facet.claimSchema) {
      if (key === 'member') { claims.push({ key, value: '0000001' }); continue; }
      const v = vouched[key];
      if (typeof v !== 'string' || !/^\d{7}$/.test(v)) throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: `The organization vouches for "${key}" in this credential — what value (7 digits)?`, fields: [{ name: `claims.${key}`, label: key, type: 'text', required: true }] } as never);
      claims.push({ key, value: v });
    }
    let issued;
    try {
      issued = await issueOpenAcCredential({
        issuer: facet.issuer, claims, holderDeviceKey: { kty: 'EC', crv: 'P-256', x: (args.deviceKey as { x: string }).x, y: (args.deviceKey as { y: string }).y }, size: facet.vcSize ?? '1k',
        sign: async (message) => {
          const digest = `0x${await deps.sha256Hex(message)}`;
          const evidenceToken = await deps.mintIssuanceEvidence(org, { digest, issuer_key_id: facet.keyId, credential_type: facet.credentialType });
          return deps.issuingSign(facet.akcsKeyId, message, { evidenceToken, audience: facet.keyId });
        },
      });
    } catch (e) {
      if (e instanceof OpenAcIssueRefusal) return { refused: `the credential was not issued — ${e.message}`, code: e.code };
      throw e;
    }
    const digest = await deps.credentialDigestOf(issued.jwt);

    // 4. RECORD — what was issued, in the ORGANIZATION's vault; never the claim values.
    const w = await deps.writeRecord(org, `${ISSUED_PREFIX}${digest}`, {
      type: 'ap.issuance.v1', digest, issuerKeyId: facet.keyId, credentialType: facet.credentialType, issuedTo: member,
      deviceKeyThumbprint: deps.thumbprintOf(args.deviceKey as { x: string; y: string }), claimSchema: facet.claimSchema, issuedAt: new Date().toISOString(), by: steward.toLowerCase(),
    });
    if (!w.ok) return { refused: `the credential was signed but the organization could not record it (${w.error ?? 'vault refused'}) — it is not delivered`, code: 'record_failed' };

    // 4b. VOUCH — the organization's submission to its live-credential row (spec 444 W3 §4), in ITS vault, the record the
    //     federation projector reads and anchors from (ap-federation `vault-ledger.ts`, `apest:ProjectionSubmission`). The
    //     blind is random and held here and by the holder's status presentation only; the leaf names no subject.
    const blind = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const vouch = await deps.writeRecord(org, `${SUBMISSION_PREFIX}live-credential:${digest.toLowerCase()}`, {
      type: 'ap.federation-submission.v1', estate: org, set: 'live-credential', digest: digest.toLowerCase(), blind,
      subject: `0x${'00'.repeat(20)}`, submittedBy: steward.toLowerCase(), source: CREDENTIAL_ISSUE_CAPABILITY, submittedAt: new Date().toISOString(),
    });
    if (!vouch.ok) return { refused: `the credential was issued and recorded, but the organization could not vouch for it on its live-credential row (${vouch.error ?? 'vault refused'}) — it is not delivered, because a door would refuse its status`, code: 'vouch_failed' };

    // 5. DELIVER — into the MEMBER's vault, written by HER OWN grant in her own object (the payee's-receipt pattern, spec 360
    //    E5): the organization holds no authority over her vault and needs none to hand her what is hers. Delivered, the
    //    act's result carries the digest and not the credential, so the steward's transcript never holds her claims.
    const credential = {
      type: 'ap.anonymous-credential.v1', issuerKeyId: facet.keyId, jwt: issued.jwt, disclosures: issued.disclosures,
      issuerPublicKeyJwk: await deps.issuerPublicJwk(facet.akcsKeyId), digest, claimSchema: facet.claimSchema,
      deviceKeyThumbprint: deps.thumbprintOf(args.deviceKey as { x: string; y: string }), issuedAt: new Date().toISOString(),
    };
    const kept = await deps.writeRecord(member, `${HOLDER_CREDENTIAL_PREFIX}${digest.toLowerCase()}`, credential);
    if (!kept.ok) {
      // NOT a fallback: the credential is issued and vouched for, and it must reach her by some hand, so the steward gets it
      // to pass on — said in words, with the reason her vault refused.
      return {
        issued: true, delivered: false, org, member, digest, issuerKeyId: facet.keyId, credentialType: facet.credentialType, credential,
        answer: `${who}'s credential was issued and vouched for, but her vault did not take it (${kept.error ?? 'refused'}) — she enables storage at her Home; until then it is here for you to pass on.`,
      };
    }
    return {
      issued: true, delivered: true, org, member, digest, issuerKeyId: facet.keyId, credentialType: facet.credentialType,
      answer: `${who} has a ${facet.credentialType} credential from this organization, issued under ${facet.keyId}, now in her own vault. The organization keeps the record and the vouch; the claims are hers.`,
    };
  };
}
