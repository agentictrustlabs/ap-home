// Passkey (WebAuthn) flow — ported from demo-web. Registration ceremony
// (navigator.credentials.create → P-256 (x,y) + credentialIdDigest), signing
// ceremony (navigator.credentials.get → on-chain WebAuthn sig blob), localStorage
// persistence. Ceremony helpers from connect-auth/passkey; wire encoder from
// agent-account. Demo-only storage.
import { keccak256 } from 'viem';
import { parseAttestationObject, buildWebAuthnAssertion } from '@agenticprimitives/connect-auth/passkey';
import { encodeWebAuthnSignature } from '@agenticprimitives/agent-account';
import type { Hex } from '@agenticprimitives/types';
import { CENTRAL_AUTH_DOMAIN } from './domain';

const STORAGE_KEY = 'agenticprimitives:demo-sso:passkey';

/**
 * The WebAuthn RP id for every passkey ceremony: the CURRENT hostname — passkeys are SUBDOMAIN-ISOLATED
 * (spec 229 P5). Each `<label>.impact-agent.me` home scopes its ROOT passkey to its OWN subdomain, so
 * different subdomains hold (and trigger) different passkeys, the phone's consent sheet names the
 * subdomain the member is actually signing into, and one subdomain's page can never request another
 * subdomain's credential.
 *
 * DISCIPLINE this requires (the reason a 2026-07-16 pin-to-parent detour existed and was reverted):
 * a credential is findable ONLY under the exact RP it was created with, so every create() AND every
 * get() must run on the origin whose hostname IS that RP. Flows hop to the home subdomain BEFORE any
 * ceremony (`redirectForPasskey` / `redirectForEnrollName`) and never sign after hopping elsewhere.
 * The apex entry can't discover subdomain credentials — it routes by NAME, then hops.
 *
 * COUPLING (do not diverge): the on-chain verifier pins each assertion's `authenticatorData.rpIdHash` to the
 * SA's stored rpIdHash (WebAuthnLib `_checkAuthData`), and that stored value is `sha256` of whatever RP the
 * credential was created under. So `connect-client.ts derivePasskeyRpIdHash` MUST hash THIS exact value
 * (`sha256(passkeyRpId())`) — hashing a different host makes every passkey signature fail verification
 * even though the ceremony and address derivation look fine. Exported for that reason.
 */
export function passkeyRpId(): string {
  return typeof window !== 'undefined' ? window.location.hostname : CENTRAL_AUTH_DOMAIN;
}

/**
 * TEMPORARY TEST DEFAULT (2026-07-17): CHOICE MODE — no authenticator restriction on any ceremony.
 * The OS shows its full picker (Windows Hello / iPhone / security key) at create AND at sign, and
 * routes each signature to wherever the credential actually lives. Chosen after the phone-forced
 * mode (`'cross-platform'`/`['hybrid']`) proved it strands a Hello-created key: the sign step
 * jumped straight to the phone QR with no way to pick the local device.
 * Other modes, for reference:
 *  - local-device (the pre-test shipped default): 'platform' / ['internal'] / ['client-device'] —
 *    exists because Windows members stranded in the phone picker; restore once testing concludes.
 *  - phone-forced: 'cross-platform' / ['hybrid'] / ['hybrid'] — bypasses a polluted Hello store.
 * `undefined` means "omit the field" — each is conditionally spread at its use site.
 */
const PASSKEY_ATTACHMENT: AuthenticatorAttachment | undefined = undefined;
const PASSKEY_TRANSPORTS: AuthenticatorTransport[] | undefined = undefined;
const PASSKEY_HINTS: string[] | undefined = undefined;

/** One-shot "create the NEXT passkey on a phone" override (set by the UV-failure recovery UI).
 *  The Microsoft-account SYNCED passkey store on Windows can skip user verification even when
 *  `userVerification:'required'` (assertions come back with UV=0 → rejected on-chain), so the retry
 *  path steers the create() to a phone/security key (`cross-platform` + hybrid hint), whose
 *  authenticators do UV properly. Cleared on the next registerPasskey call. */
let forcePhoneNextCreate = false;
export function forcePhonePasskeyOnce(): void {
  forcePhoneNextCreate = true;
}

/** The signature both ceremony stages throw when the provider skipped user verification. */
export const UV_MISSING_MESSAGE =
  'Your passkey provider skipped user verification (no PIN/biometric attested in the signature), ' +
  'which custody-grade signing requires — this signature would be rejected on-chain. This is a ' +
  'known issue with Microsoft-account SYNCED passkeys on Windows. Use a phone passkey, or a ' +
  'device whose local authenticator (Windows Hello with PIN/biometric, Touch ID) holds the key.';

/** Recognize a UV-skipped failure (either ceremony stage) so recovery UIs can offer the phone path. */
export function isUvMissingError(e: unknown): boolean {
  return e instanceof Error && /skipped user verification/i.test(e.message);
}

// [pk-probe] TEMPORARY: which build is this tab actually running? A tab opened before a Vercel
// deploy keeps its OLD chunks until reload — this line in the console settles it instantly.
const PK_PROBE_BUILD = 'created-transports v2 (2026-07-17)';
try { console.log('[pk-probe] module', { build: PK_PROBE_BUILD }); } catch { /* */ }

export interface DemoPasskey {
  credentialIdDigest: Hex; // keccak256(credentialId)
  credentialIdB64: string;
  pubKeyX: bigint;
  pubKeyY: bigint;
  label: string;
  /** `getTransports()` captured at REGISTRATION — where the credential actually lives (['internal'] =
   *  this device's Hello/TouchID, incl. 'hybrid' = a phone). Replayed on every sign's allowCredentials
   *  (the WebAuthn-spec-intended use) so the platform looks in the RIGHT place: a Hello key gets a
   *  local-only lookup (fast fail → the indexing-race retry loop works), a phone key goes straight to
   *  the QR — no forcing either way. Absent on records cached from an assertion (get() can't report it). */
  transports?: string[];
}

interface StoredPasskey {
  credentialIdDigest: Hex;
  credentialIdB64: string;
  pubKeyX?: string;
  pubKeyY?: string;
  label: string;
  transports?: string[];
}

const toStored = (p: DemoPasskey): StoredPasskey => ({
  credentialIdDigest: p.credentialIdDigest,
  credentialIdB64: p.credentialIdB64,
  pubKeyX: p.pubKeyX.toString(),
  pubKeyY: p.pubKeyY.toString(),
  label: p.label,
  ...(p.transports?.length ? { transports: p.transports } : {}),
});
const fromStored = (s: StoredPasskey): DemoPasskey => ({
  credentialIdDigest: s.credentialIdDigest,
  credentialIdB64: s.credentialIdB64,
  pubKeyX: BigInt(s.pubKeyX ?? '0'),
  pubKeyY: BigInt(s.pubKeyY ?? '0'),
  label: s.label,
  ...(s.transports?.length ? { transports: s.transports } : {}),
});

export function loadPasskey(): DemoPasskey | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return fromStored(JSON.parse(raw) as StoredPasskey);
  } catch {
    return null;
  }
}
export function clearPasskey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((2 - (s.length & 3)) & 3);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cacheAssertionCredential(rawId: ArrayBuffer, label = ''): Hex {
  const bytes = new Uint8Array(rawId);
  const credentialIdB64 = b64uEncode(bytes);
  const credentialIdDigest = keccak256(bytesToHex(bytes));
  // Same credential already cached (e.g. from registration)? Keep that record — it carries the
  // pubkey + created-transports an assertion response can't provide; overwriting would lose them.
  const existing = loadPasskey();
  if (existing?.credentialIdB64 === credentialIdB64) return credentialIdDigest;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      credentialIdDigest,
      credentialIdB64,
      label,
    } satisfies StoredPasskey),
  );
  return credentialIdDigest;
}
function hexToBytes(hex: Hex): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): Hex {
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** Register a new passkey (TouchID/FaceID/etc.) + persist (x,y) + digest. */
export async function registerPasskey(label: string): Promise<DemoPasskey> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  // The WebAuthn userHandle (`user.id`) MUST be STABLE for a given identity, NOT random. An
  // authenticator keys resident (discoverable) credentials by (rpId, userHandle): registering
  // with a userHandle that already exists REPLACES that passkey, but a fresh random handle each
  // time stacks a brand-new credential — so the OS picker lists the SAME name (e.g. `gco-v1.impact`)
  // once per signup attempt. Deriving the handle deterministically from (rpId, label) means a repeat
  // signup of the same identity overwrites its passkey instead of duplicating it.
  //
  // This is independent of the Smart Agent address: the SA derives from the passkey PUBLIC KEY
  // (credentialIdDigest / x,y) per ADR-0010 — the userHandle NEVER feeds the CREATE2 salt — so a
  // stable handle changes only the OS's credential bookkeeping, not the identity.
  const rpId = passkeyRpId();
  const userId = hexToBytes(keccak256(new TextEncoder().encode(`${rpId}|${label}`))).slice(0, 16);

  // One-shot phone override (the UV-failure recovery path): steer this create to a phone/security
  // key — those authenticators attest UV properly, unlike the Windows Microsoft-synced store.
  const phoneForced = forcePhoneNextCreate;
  forcePhoneNextCreate = false;
  const attachment = phoneForced ? ('cross-platform' as AuthenticatorAttachment) : PASSKEY_ATTACHMENT;
  const hints = phoneForced ? ['hybrid', 'security-key'] : PASSKEY_HINTS;

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'Agentic Connect' },
      user: { id: userId, name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256 ONLY (custody needs it; F9)
      // userVerification REQUIRED: the ROOT/primary passkey is custody-grade (security audit F9).
      // residentKey REQUIRED: the passkey must be discoverable so (a) the stable-userHandle overwrite
      // applies (a repeat signup REPLACES this identity's passkey instead of stacking a duplicate),
      // and (b) name-only / cross-device sign-in can find it (spec 233). We deliberately do NOT set
      // excludeCredentials: that would make a repeat registration throw InvalidStateError instead of
      // cleanly overwriting — the stable userHandle is what dedupes.
      // Attachment/hints come from the PASSKEY_* test constants above (currently CHOICE MODE —
      // both omitted, the OS offers every authenticator; see that comment block for the modes),
      // unless the one-shot phone override is armed.
      authenticatorSelection: { ...(attachment && { authenticatorAttachment: attachment }), residentKey: 'required', userVerification: 'required' },
      ...(hints ? ({ hints } as Record<string, unknown>) : {}),
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey registration cancelled');

  const response = credential.response as AuthenticatorAttestationResponse;
  const parsed = parseAttestationObject(new Uint8Array(response.attestationObject));
  // EARLY UV GATE (mirror of the sign-time check below): if the provider skipped user verification
  // AT CREATION, its assertions will come back UV=0 too and every custody signature will be rejected
  // on-chain. Fail HERE — before the credential is cached, the SA address derived, or a deploy
  // attempted — so the recovery UI can steer the user to a phone passkey with nothing lost.
  try { console.log('[pk-probe] created flags', { uv: parsed.flagUserVerified, up: parsed.flagUserPresent }); } catch { /* */ }
  if (!parsed.flagUserVerified) {
    throw new Error(UV_MISSING_MESSAGE);
  }
  const createdTransports = response.getTransports?.() ?? [];
  const passkey: DemoPasskey = {
    credentialIdDigest: keccak256(bytesToHex(parsed.credentialId)),
    credentialIdB64: parsed.credentialIdBase64Url,
    pubKeyX: parsed.pubKeyX,
    pubKeyY: parsed.pubKeyY,
    label,
    ...(createdTransports.length ? { transports: createdTransports } : {}),
  };
  // [pk-probe] TEMPORARY: where did the credential actually land? attachment='cross-platform' or
  // transports incl. 'hybrid' ⇒ it was saved to a PHONE/security key, so the platform-only deploy get()
  // can never find it → "No passkeys available". 'platform'/'internal' ⇒ Windows Hello (expected).
  try { console.log('[pk-probe] created', { attachment: credential.authenticatorAttachment, transports: (response as AuthenticatorAttestationResponse).getTransports?.() ?? null, rpId, host: window.location.hostname, credId: passkey.credentialIdB64.slice(0, 16) }); } catch { /* */ }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored(passkey)));
  return passkey;
}

/** Sign a 32-byte digest via WebAuthn → on-chain sig blob (0x01 || assertion).
 *  Uses the localStorage-cached credential (allowCredentials). Kept for flows
 *  that already hold the local passkey; prefer the discoverable variant for
 *  cross-device sign-in (spec 233). */
export async function signWithPasskey(digest: Hex, opts: SignAssertionOpts = {}): Promise<Hex> {
  const passkey = loadPasskey();
  if (!passkey) throw new Error('signWithPasskey: no registered passkey');
  return signAssertion(digest, b64uDecode(passkey.credentialIdB64), { transports: passkey.transports, ...opts });
}

/** Sign a 32-byte digest via a DISCOVERABLE passkey (spec 233, Mechanism A) —
 *  empty `allowCredentials`, no localStorage. The platform offers any passkey for
 *  this RP (including platform-synced ones on other devices); we read the chosen
 *  credentialId from `rawId`. The returned blob carries the credentialIdDigest,
 *  so the server verifies it on-chain via `getPasskey`/`isValidSignature` against
 *  the (name-resolved) agent SA — no client-supplied pubkey, no device cache.
 *
 *  SEC-015: when the caller knows which passkey SHOULD sign (e.g. an active session
 *  has a known custodian), pass `expectedCredentialIdDigest` and we'll reject any
 *  assertion whose rawId hash doesn't match. Catches the "platform offered a
 *  different passkey" UX confusion BEFORE the server round-trip + chain check. */
export async function signWithDiscoverablePasskey(
  digest: Hex,
  expectedCredentialIdDigest?: Hex,
  opts: { preferLocalDevice?: boolean } = {},
): Promise<Hex> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  let credential: PublicKeyCredential | null = null;
  for (let uvAttempt = 0; uvAttempt < 2; uvAttempt++) {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: hexToBytes(digest) as BufferSource,
        rpId: passkeyRpId(), // subdomain-isolated (spec 229 P5): this origin IS the credential's RP — never hop mid-ceremony
        allowCredentials: [], // discoverable: let the platform offer any passkey for this RP
        ...(opts.preferLocalDevice && PASSKEY_HINTS ? ({ hints: PASSKEY_HINTS } as Record<string, unknown>) : {}),
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!credential || assertionHasUv(credential) || uvAttempt > 0) break;
    // UV skipped (Windows synced-store bug) — one fresh prompt after a pause forces collection.
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!credential) throw new Error('no passkey available on this device');
  if (expectedCredentialIdDigest) {
    const offered = await sha256Hex(new Uint8Array(credential.rawId));
    if (offered.toLowerCase() !== expectedCredentialIdDigest.toLowerCase()) {
      throw new Error('passkey offered by the platform does not match the expected credential (SEC-015)');
    }
  }
  // The platform tells us which credential signed — use its rawId, not a cache.
  cacheAssertionCredential(credential.rawId);
  return signAssertionFromCredential(credential);
}

/** UV bit (0x04) of an assertion's authenticatorData flags — the custody gate's requirement. */
function assertionHasUv(credential: PublicKeyCredential): boolean {
  const authData = new Uint8Array((credential.response as AuthenticatorAssertionResponse).authenticatorData);
  return authData.length > 32 && ((authData[32] ?? 0) & 0x04) !== 0;
}

/** Named-CONNECT assertion (spec 233, Mechanism A): a single `get` that returns BOTH the on-chain
 *  signature blob AND the `credentialIdDigest` the server needs to resolve which custodian signed
 *  (keccak256 of the credentialId — matches registration). The server verifies the digest is an on-chain
 *  custodian of the name-resolved SA, so an unrelated passkey the platform might offer is rejected — no
 *  client-supplied pubkey.
 *
 *  LOCAL-FIRST HINT: when THIS browser cached the credential id, pass it as `allowCredentials` so the
 *  platform uses the LOCAL authenticator directly (Windows Hello / Touch ID) instead of the cross-device
 *  "use a phone" picker an EMPTY list triggers on Windows. Do NOT set `transports`: including `hybrid`
 *  invites the phone flow. A browser with no cache passes `[]` (discoverable — the cross-browser/synced
 *  path 9fd8c03 added), so named sign-in still works anywhere the platform can surface the passkey. One
 *  `get`, one server verify — not a second mechanism/fallback (ADR-0013); the allowCredentials hint only
 *  biases the platform's chooser. */
export async function connectAssertionDiscoverable(
  digest: Hex,
  opts: { preferLocalDevice?: boolean } = {},
): Promise<{ signature: Hex; credentialIdDigest: Hex }> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  const cached = loadPasskey();
  // Descriptor transports: the credential's registration-time getTransports when the cache carries it
  // (targets the store the credential actually lives in), else the PASSKEY_* fallback (choice mode:
  // omitted — the platform routes freely and offers the full chooser when unsure).
  const cachedTransports = (cached?.transports?.length ? cached.transports : PASSKEY_TRANSPORTS) as AuthenticatorTransport[] | undefined;
  const allowCredentials: PublicKeyCredentialDescriptor[] = cached?.credentialIdB64
    ? [{ id: b64uDecode(cached.credentialIdB64) as BufferSource, type: 'public-key', ...(cachedTransports?.length ? { transports: cachedTransports } : {}) }]
    : []; // no local cache → discoverable (let the platform offer any passkey for this RP, incl. synced)
  let credential: PublicKeyCredential | null = null;
  for (let uvAttempt = 0; uvAttempt < 2; uvAttempt++) {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: hexToBytes(digest) as BufferSource,
        rpId: passkeyRpId(), // subdomain-isolated (spec 229 P5): this origin IS the credential's RP — never hop mid-ceremony
        allowCredentials,
        ...(!cached && opts.preferLocalDevice && PASSKEY_HINTS ? ({ hints: PASSKEY_HINTS } as Record<string, unknown>) : {}),
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!credential || assertionHasUv(credential) || uvAttempt > 0) break;
    // UV skipped (Windows synced-store bug) — one fresh prompt after a pause forces collection.
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!credential) throw new Error('no passkey available on this device');
  const credentialIdDigest = cacheAssertionCredential(credential.rawId);
  return { signature: signAssertionFromCredential(credential), credentialIdDigest };
}

async function sha256Hex(bytes: Uint8Array): Promise<Hex> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

export interface SignAssertionOpts {
  /** The credential was created moments ago (onboarding deploy sign). Widens the Windows Hello
   *  indexing-race handling: longer fast-retry budget, ONE patient retry after a user-dismissed
   *  "No passkeys available" sheet, and a guided (retry-and-it-works) message on final failure. */
  justCreated?: boolean;
  /** Surface retry progress to the UI (e.g. the onboarding busy line). */
  onRetry?: (msg: string) => void;
  /** The credential's REGISTRATION-time `getTransports()` (see DemoPasskey.transports). When present
   *  the lookup targets where the credential actually lives; when absent the PASSKEY_* fallback applies. */
  transports?: string[];
}

const JUST_CREATED_GUIDANCE =
  "Your device didn't offer your new key — Windows can take a few seconds to finish saving a " +
  'just-created passkey. Your key was created and nothing was lost. Press Try again, then ' +
  'Approve — after this short wait the key is offered. (If you cancelled the prompt on purpose, ' +
  'just continue when ready.)';

async function signAssertion(digest: Hex, credentialIdBytes: Uint8Array, opts: SignAssertionOpts = {}): Promise<Hex> {
  // Windows Hello post-create indexing race (the top cause of "No passkeys available" on the onboarding
  // "Approve my setup" step): this cached-id get() runs seconds after create(), and the platform can fail
  // with NotAllowedError before it has indexed the just-made credential. Live-confirmed 2026-07-16: the
  // SAME get() succeeds when manually retried a few moments later, so the credential IS retained — this is
  // purely a settle-time race. Two failure shapes:
  //   • FAST NotAllowedError (<900ms, no UI shown) — unambiguous race; retried with backoff.
  //   • SLOW NotAllowedError — EITHER the user dismissed Windows' own "No passkeys available" sheet
  //     (the race, surfaced as OS UI) OR a deliberate cancel of the verification prompt. The two are
  //     indistinguishable (privacy-uniform error). Outside onboarding we honor it as a cancel at once.
  //     In the `justCreated` window a cancel is unlikely (the user pressed Approve a second earlier), so
  //     we re-prompt ONCE after a pause, then stop and explain — never an endless prompt loop.
  const { justCreated = false, onRetry } = opts;
  const fastDelays = justCreated ? [500, 1000, 2000, 3000, 4000, 5000] : [350, 700, 1050]; // ms before retry N+1
  let slowRetried = false;
  // UV-skip retry budget (Windows synced-store bug, live 2026-07-20): when the get() runs moments
  // after the user verified (e.g. right after create), Windows can SKIP re-collecting the PIN and
  // (buggily) report UV=0 — observed as create uv:true, assertion uv:false seconds later. A fresh
  // prompt after a pause forces collection, so a UV-less assertion is retried before failing.
  let uvRetries = 0;
  const UV_RETRY_DELAYS = [2000, 4000];
  // Target the lookup at where the credential LIVES (registration-time getTransports) — a Hello key
  // stays a local-only search (fast fail → retries ride out the indexing race instead of Windows
  // re-routing to the phone QR), a phone key goes straight to hybrid. PASSKEY_* is only the fallback
  // for records cached from an assertion (no transport info).
  const transports = (opts.transports?.length ? opts.transports : PASSKEY_TRANSPORTS) as AuthenticatorTransport[] | undefined;
  // [pk-probe] TEMPORARY: what is the deploy get() asking for? reqCredId must equal the [pk-probe] created
  // credId (else loadPasskey returned a STALE cache); rpId must equal the create rpId.
  try { console.log('[pk-probe] signAssertion get()', { rpId: passkeyRpId(), host: window.location.hostname, reqCredId: bytesToHex(credentialIdBytes).slice(0, 18), justCreated, transports }); } catch { /* */ }
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.get({
        publicKey: {
          challenge: hexToBytes(digest) as BufferSource,
          rpId: passkeyRpId(), // subdomain-isolated (spec 229 P5): this origin IS the credential's RP — never hop mid-ceremony
          allowCredentials: [{ id: credentialIdBytes as BufferSource, type: 'public-key', ...(transports?.length ? { transports } : {}) }],
          ...(PASSKEY_HINTS ? ({ hints: PASSKEY_HINTS } as Record<string, unknown>) : {}),
          userVerification: 'required', // custody-grade signing — demand verification (F9)
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
    } catch (e) {
      // [pk-probe] TEMPORARY: exact failure shape. errName='NotAllowedError' + fast elapsed ⇒ indexing race
      // (retried); + slow elapsed ⇒ the OS sheet was shown and dismissed (retried once when justCreated).
      try { console.log('[pk-probe] signAssertion FAIL', { attempt, errName: e instanceof Error ? e.name : String(e), errMsg: e instanceof Error ? e.message.slice(0, 90) : '', elapsedMs: Date.now() - startedAt, justCreated, slowRetried }); } catch { /* */ }
      const notAllowed = e instanceof DOMException && e.name === 'NotAllowedError';
      if (notAllowed && Date.now() - startedAt < 900 && attempt < fastDelays.length) {
        await new Promise((r) => setTimeout(r, fastDelays[attempt]));
        continue;
      }
      if (notAllowed && justCreated && !slowRetried) {
        slowRetried = true;
        onRetry?.('Your device is still saving your new key — asking again in a moment…');
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (notAllowed && justCreated) throw new Error(JUST_CREATED_GUIDANCE);
      throw e;
    }
    if (!credential) throw new Error('passkey signing cancelled');
    // SEC-015 defensive: even with allowCredentials, verify the rawId matches what we
    // asked for. Catches a platform that would (incorrectly) ignore the allowlist.
    const offered = new Uint8Array(credential.rawId);
    if (offered.length !== credentialIdBytes.length || !offered.every((b, i) => b === credentialIdBytes[i])) {
      throw new Error('passkey offered by the platform does not match the registered credential (SEC-015)');
    }
    // UV skipped (see UV_RETRY_DELAYS note): re-prompt after a pause — the fresh dialog collects the
    // PIN/biometric properly on providers that only skip when the user verified moments earlier.
    if (!assertionHasUv(credential) && uvRetries < UV_RETRY_DELAYS.length) {
      const delay = UV_RETRY_DELAYS[uvRetries]!;
      uvRetries += 1;
      try { console.log('[pk-probe] UV missing — re-prompting', { uvRetries, delay }); } catch { /* */ }
      onRetry?.('Your device skipped the PIN/biometric check — asking again to verify properly…');
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return signAssertionFromCredential(credential);
  }
}

function signAssertionFromCredential(credential: PublicKeyCredential): Hex {
  const credentialIdBytes = new Uint8Array(credential.rawId);
  const response = credential.response as AuthenticatorAssertionResponse;
  const authenticatorData = new Uint8Array(response.authenticatorData);
  // PRE-FLIGHT the on-chain UV gate (WebAuthnLib `requireUv`, audit F9): every custody signature
  // must carry the User-Verified flag (bit 0x04 of authData[32]). Some passkey providers violate the
  // spec and return UV=0 despite `userVerification:'required'` (seen live 2026-07-17: the Windows
  // Microsoft-account SYNCED passkey store via Edge, flags 0x19 = UP+BE+BS, no UV) — the chain would
  // reject that as an opaque AA24 after gas estimation, so fail HERE with the real reason instead.
  // This is an early mirror of the contract's check, not a second mechanism — the chain still enforces.
  const flags = authenticatorData.length > 32 ? (authenticatorData[32] ?? 0) : 0;
  try { console.log('[pk-probe] assertion flags', { flags: `0x${flags.toString(16)}`, uv: (flags & 0x04) !== 0, backedUp: (flags & 0x10) !== 0 }); } catch { /* */ }
  if ((flags & 0x04) === 0) {
    throw new Error(UV_MISSING_MESSAGE);
  }
  const assertion = buildWebAuthnAssertion({
    credentialIdBytes,
    authenticatorData,
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    derSignature: new Uint8Array(response.signature),
  });
  return encodeWebAuthnSignature(assertion);
}
