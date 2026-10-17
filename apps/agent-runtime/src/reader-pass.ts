// A READER'S PASS, BOUGHT WITHOUT A NAME — the private-scripture build (verifiable-content-demo
// `docs/private-scripture-spec.md`, W3). Three pieces, each with its own authority:
//
//   · THE PURSE — a treasury whose custodian is derived from her login on its OWN path (`sub#purse:<n>`), so its address
//     shares nothing with her person account on chain: no common custodian, no stewardship hash, no name. A plain unnamed
//     treasury is deployed with her person custodian and is linkable by anyone reading the chain; that is why this exists.
//     Only her custody session can make it sign (the routes in index.ts gate on it), the way her person account is signed.
//   · HER DEVICE KEY — a fresh P-256 key in her estate's key service, made by the runtime's HOLDER caller (key-create,
//     ES256_SHA256 only; the main runtime caller cannot create keys). Its purpose names no one. The credential binds it.
//   · THE VEND — lbsb.svc's act: given a settlement and a claim signed by the account that paid, it checks the transfer on
//     chain, spends the settlement once, and issues an OpenAC "lbsb reader" credential bound to the device key. It is
//     handed no asker: nothing in its input or its records names who holds the key.
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from 'viem';
import { createAkcsEs256Signer, createAkcsP256Key, p256JwkThumbprint, type AgenticKmsConfig } from '@agenticprimitives/key-custody';
import { issueOpenAcCredential, OpenAcIssueRefusal } from '@agenticprimitives/privacy-credentials-openac/issuer';
import { HOLDER_CREDENTIAL_PREFIX, ISSUED_PREFIX, ISSUER_FACET_PREFIX, type CredentialIssueDeps, type IssuerFacetRecordV1 } from './credential-issue.js';

/** The derivation path of purse `n` — her login's subject with a suffix no identity provider issues. */
export const purseSubject = (sub: string, n: number): string => {
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('purse number must be an integer 1..1000');
  return `${sub}#purse:${n}`;
};

/** `credential.device-key:<thumbprint>` — the holder's record of a key the key service keeps for her. */
export const DEVICE_KEY_PREFIX = 'credential.device-key:' as const;
export interface DeviceKeyRecordV1 {
  type: 'ap.device-key.v1';
  thumbprint: string;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  managed: { backend: 'akcs'; keyId: string; baseUrl: string; tenantId: string };
  createdAt: string;
}

/** Make her a device key with the HOLDER caller and keep its public half in her vault. The purpose is random: the key
 *  service's metadata names no person, and nothing ties two of her keys together. */
export async function createHolderDeviceKey(
  cfg: AgenticKmsConfig,
  write: (recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>,
  now: () => Date = () => new Date(),
): Promise<{ thumbprint: string; publicJwk: DeviceKeyRecordV1['publicJwk']; keyId: string }> {
  const tag = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const made = await createAkcsP256Key(cfg, { purpose: `device-key:${tag}`, externalName: `device-key-${tag}` });
  if (!made.keyId) throw new Error('the key service made no device key');
  const jwk = (await createAkcsEs256Signer(cfg, { keyId: made.keyId, signingPurpose: 'ES256_SHA256' })).publicJwk();
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y };
  const thumbprint = p256JwkThumbprint(publicJwk);
  const rec: DeviceKeyRecordV1 = { type: 'ap.device-key.v1', thumbprint, publicJwk, managed: { backend: 'akcs', keyId: made.keyId, baseUrl: cfg.baseUrl, tenantId: cfg.tenantId }, createdAt: now().toISOString() };
  const w = await write(`${DEVICE_KEY_PREFIX}${thumbprint}`, rec);
  if (!w.ok) throw new Error(`her vault would not keep the device key (${w.error ?? 'refused'})`);
  return { thumbprint, publicJwk, keyId: made.keyId };
}

// ── the vend ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the paying account signs: this settlement, for this device key, at this issuer. Domain-separated and ABI-encoded,
 *  so a claim cannot be replayed for another key, another issuer, or as any other kind of signature. */
export function readerClaimDigest(settlementHash: Hex, deviceKeyThumbprint: string, audience: string): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes32' }, { type: 'string' }, { type: 'string' }],
    ['ap.reader-pass.claim.v1', settlementHash, deviceKeyThumbprint, audience],
  ));
}

/** Days since 1970-01-01 (UTC) — the `valid_until` claim, compared by a `gte` predicate against today's day number. */
export const dayNumber = (d: Date): number => Math.floor(d.getTime() / 86_400_000);
const sevenDigits = (n: number): string => String(n).padStart(7, '0');

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));
const topicAddr = (t: Hex | undefined): string => (t ? `0x${t.slice(-40)}`.toLowerCase() : '');

/** `credential.issued:settlement:<hash>` — the settlement spent by a vend, in the ISSUER's vault. One per settlement. */
export const SETTLEMENT_SPENT_PREFIX = `${ISSUED_PREFIX}settlement:` as const;

export interface VendConfig {
  /** lbsb.svc — the issuer whose vault holds the facet and the records. */
  issuerAgent: Address;
  /** Where a pass must have been paid. */
  treasury: Address;
  asset: Address;
  /** Smallest units (6 decimals for USDC). */
  priceUnits: bigint;
  /** How long a pass lasts. */
  passDays: number;
  /** The audience a claim names — this issuer's identifier. */
  audience: string;
}

export interface VendDeps {
  receiptOf: (hash: Hex) => Promise<{ status: 'success' | 'reverted'; logs: Array<{ address: string; topics: Hex[]; data: Hex }> } | null>;
  /** ERC-1271 / ERC-6492 / EOA through the chain's universal validator. */
  isValidSig: (signer: Address, digest: Hex, signature: Hex) => Promise<boolean>;
  readRecord: (subject: string, recordType: string) => Promise<unknown>;
  writeRecord: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  survey: (subject: string) => Promise<Array<{ recordType: string }>>;
  issuer: Pick<CredentialIssueDeps, 'issuingSign' | 'issuerPublicJwk' | 'mintIssuanceEvidence' | 'credentialDigestOf' | 'thumbprintOf' | 'sha256Hex'>;
  now?: () => Date;
}

export interface VendInput {
  settlementHash: Hex;
  payer: Address;
  deviceKey: { x: string; y: string };
  claimSig: Hex;
}

export type VendResult =
  | { ok: true; credential: Record<string, unknown>; digest: string; validUntil: number }
  | { ok: false; code: string; refused: string };

/** lbsb.svc issues a reader's credential for ONE settlement. No asker is an input, and none is recorded. */
export async function vendReaderCredential(deps: VendDeps, cfg: VendConfig, input: VendInput): Promise<VendResult> {
  const now = (deps.now ?? (() => new Date()))();
  const no = (code: string, refused: string): VendResult => ({ ok: false, code, refused });
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.settlementHash)) return no('bad_settlement', 'the settlement must be a transaction hash');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payer)) return no('bad_payer', 'the payer must be an account address');
  const issuer = cfg.issuerAgent.toLowerCase();
  const hash = input.settlementHash.toLowerCase() as Hex;
  const payer = input.payer.toLowerCase();

  // 1. PAID — a successful transfer of at least the price, from the payer to the treasury, in this asset.
  const receipt = await deps.receiptOf(hash);
  if (!receipt) return no('settlement_unknown', 'no such settlement on chain (yet)');
  if (receipt.status !== 'success') return no('settlement_reverted', 'that settlement reverted');
  const paid = receipt.logs.some((l) => l.address.toLowerCase() === cfg.asset.toLowerCase() && l.topics[0] === TRANSFER_TOPIC
    && topicAddr(l.topics[1]) === payer && topicAddr(l.topics[2]) === cfg.treasury.toLowerCase() && BigInt(l.data) >= cfg.priceUnits);
  if (!paid) return no('not_paid', `that settlement does not pay the pass price to ${cfg.treasury} from ${input.payer}`);

  // 2. CLAIMED BY WHOEVER PAID — the paying account's signature over (settlement, this key, this issuer). Someone who only
  //    saw the public settlement cannot claim it.
  const thumbprint = deps.issuer.thumbprintOf(input.deviceKey);
  const digest = readerClaimDigest(hash, thumbprint, cfg.audience);
  if (!(await deps.isValidSig(input.payer, digest, input.claimSig))) return no('claim_not_signed_by_payer', 'the claim is not signed by the account that paid');

  // 3. ONCE — the settlement is spent before anything is issued; a failure after this point says so and is retryable.
  const spentKey = `${SETTLEMENT_SPENT_PREFIX}${hash}`;
  const spent = (await deps.readRecord(issuer, spentKey).catch(() => null)) as { status?: string } | null;
  if (spent && spent.status !== 'failed') return no('settlement_spent', 'that settlement has already bought a pass');
  const mark = await deps.writeRecord(issuer, spentKey, { type: 'ap.settlement-spent.v1', settlementHash: hash, deviceKeyThumbprint: thumbprint, status: 'claiming', at: now.toISOString() });
  if (!mark.ok) return no('issuer_storage', `the issuer could not record the claim (${mark.error ?? 'vault refused'})`);
  const fail = async (code: string, refused: string): Promise<VendResult> => {
    await deps.writeRecord(issuer, spentKey, { type: 'ap.settlement-spent.v1', settlementHash: hash, deviceKeyThumbprint: thumbprint, status: 'failed', reason: code, at: now.toISOString() }).catch(() => undefined);
    return no(code, refused);
  };

  // 4. ISSUE — the facet the steward put; claims in its layout.
  const facetTypes = (await deps.survey(issuer)).map((r) => r.recordType).filter((t) => t.startsWith(ISSUER_FACET_PREFIX)).sort();
  const facet = facetTypes.length ? (await deps.readRecord(issuer, facetTypes[0]!)) as IssuerFacetRecordV1 | null : null;
  if (!facet || facet.type !== 'ap.issuer-facet.v1' || !facet.akcsKeyId) return fail('no_issuer_facet', 'the issuer has published no facet');
  const validUntil = dayNumber(now) + cfg.passDays;
  const values: Record<string, string> = { reader: '0000001', valid_until: sevenDigits(validUntil) };
  const claims: Array<{ key: string; value: string }> = [];
  for (const key of facet.claimSchema) {
    const v = values[key];
    if (!v) return fail('layout_unknown', `the facet's layout names a claim this pass does not carry: ${key}`);
    claims.push({ key, value: v });
  }
  let issued;
  try {
    issued = await issueOpenAcCredential({
      issuer: facet.issuer, claims, holderDeviceKey: { kty: 'EC', crv: 'P-256', x: input.deviceKey.x, y: input.deviceKey.y }, size: facet.vcSize ?? '1k',
      expiresAt: (validUntil + 1) * 86_400,
      sign: async (message) => {
        const d = `0x${await deps.issuer.sha256Hex(message)}`;
        const evidenceToken = await deps.issuer.mintIssuanceEvidence(issuer, { digest: d, issuer_key_id: facet.keyId, credential_type: facet.credentialType });
        return deps.issuer.issuingSign(facet.akcsKeyId, message, { evidenceToken, audience: facet.keyId });
      },
    });
  } catch (e) {
    if (e instanceof OpenAcIssueRefusal) return fail(e.code, `the credential was not issued — ${e.message}`);
    return fail('issue_failed', `the credential was not issued — ${e instanceof Error ? e.message : String(e)}`);
  }
  const credDigest = (await deps.issuer.credentialDigestOf(issued.jwt)).toLowerCase();

  // 5. RECORD — what was issued, never to whom (there is no whom here) and never the claim values.
  await deps.writeRecord(issuer, `${ISSUED_PREFIX}${credDigest}`, {
    type: 'ap.issuance.v1', digest: credDigest, issuerKeyId: facet.keyId, credentialType: facet.credentialType,
    deviceKeyThumbprint: thumbprint, claimSchema: facet.claimSchema, issuedAt: now.toISOString(), settlementHash: hash,
  });
  await deps.writeRecord(issuer, spentKey, { type: 'ap.settlement-spent.v1', settlementHash: hash, deviceKeyThumbprint: thumbprint, status: 'issued', digest: credDigest, at: now.toISOString() });

  const credential = {
    type: 'ap.anonymous-credential.v1', issuerKeyId: facet.keyId, jwt: issued.jwt, disclosures: issued.disclosures,
    issuerPublicKeyJwk: await deps.issuer.issuerPublicJwk(facet.akcsKeyId), digest: credDigest, claimSchema: facet.claimSchema,
    deviceKeyThumbprint: thumbprint, credentialType: facet.credentialType, validUntil, issuedAt: now.toISOString(),
  };
  return { ok: true, credential, digest: credDigest, validUntil };
}

/** The holder keeps it in her own vault, by her own grant. */
export const holderCredentialRecordType = (digest: string): string => `${HOLDER_CREDENTIAL_PREFIX}${digest.toLowerCase()}`;
