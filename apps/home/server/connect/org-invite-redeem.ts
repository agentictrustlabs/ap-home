// POST /connect/org-invite/redeem — magic-link onboarding (spec 315 invite).
//
//   body: { token }  → { ok, status:'issued', token(session), org }  |  { status:'needs-otp' }
//
// Clicking the unique token WE emailed to the invitee's inbox proves inbox possession — the standard
// magic-link signal, equivalent in strength to an emailed OTP. So we treat the invited email as VALIDATED
// and bootstrap their KMS-custodied home straight from the invite (email-bootstrap, spec 235 §5), with no
// OTP round-trip and no re-typing. Blast-zone (spec 315): the raw email was never stored — we bootstrap
// from the SHA-256 the org vault holds against this token (sub = emailHash), so no PII is needed or exposed.
//
// The home is minted custody-grade (kind:'oidc', id='email#<hash>') exactly as the OTP path — the email
// FACET stays login-grade; C_sub (KMS), not the email, is the on-chain custodian. If the org didn't enable
// vault tracking (no stored emailHash), we return `needs-otp` and the client falls back to the OTP card.
import { mintAgentSession } from '@agenticprimitives/connect';
import { oidcFacetId } from '@agenticprimitives/connect-auth/google';
import type { CredentialPrincipal } from '@agenticprimitives/types';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { resolveKmsAgent } from '../_lib/kms-resolve';
import { recordEmailFacetByHash, readRotation } from '../../src/lib/kv-indexer';
import { orgVault } from '../lib/org-vault';

const EMAIL_ISS = 'email'; // matches email-verify.ts — the issuer namespace for email-subject KMS custody

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { token?: string } | null;
  const token = (body?.token ?? '').trim();
  if (!/^[a-f0-9]{40,80}$/.test(token)) return json({ error: 'invalid token' }, 400);

  const raw = await env.AUTH_CODES.get(`orginvite:${token}`);
  if (!raw) return json({ error: 'this invitation has expired or was already used' }, 404);
  const { org } = JSON.parse(raw) as { org: string };

  // The invited email's hash lives in the ORG vault (delegation-gated, encrypted) — never in KV. Without it
  // we can't bind the bootstrap to the invited address, so the invitee verifies via the OTP card instead.
  let emailHash: string | null = null;
  let memberAccessDelegation: unknown = null; // spec 321 W2 — the steward's pre-signed org→invitee grant
  try {
    const vault = await orgVault(env, org);
    if (vault) {
      const rec = (await vault.get(`org.invite:${token}`)) as { emailHash?: string; status?: string; memberAccessDelegation?: unknown } | null;
      emailHash = rec?.emailHash ?? null;
      memberAccessDelegation = rec?.memberAccessDelegation ?? null;
    }
  } catch { /* vault unreachable — fall through to needs-otp */ }
  if (!emailHash) return json({ status: 'needs-otp', org });

  // email-bootstrap: derive the per-subject KMS home (iss='email', sub=emailHash) and mint a custody session.
  const rotation = await readRotation(env.AUTH_CODES, EMAIL_ISS, emailHash);
  const kms = await resolveKmsAgent(env, EMAIL_ISS, emailHash, rotation);
  if (!kms.ok) return json({ status: 'needs-otp', org, detail: kms.reason });

  await recordEmailFacetByHash(env.AUTH_CODES, emailHash, kms.agentId);

  const { signer } = await getServer(env);
  const principal: CredentialPrincipal = {
    kind: 'oidc',
    id: oidcFacetId(EMAIL_ISS, emailHash),
    assurance: 'onchain-confirmed',
    role: 'custody-grade',
  };
  const sessionToken = await mintAgentSession(
    {
      sub: kms.agentId,
      principal,
      assurance: 'onchain-confirmed',
      aud: env.DEMO_SSO_AUD ?? 'demo-sso',
      iss: resolveOrigin(request, env),
      ttlSeconds: 3600,
      rotation,
    },
    signer,
  );

  // Best-effort: mark the org's tracking record redeemed (who accepted). The invite is deterministic +
  // idempotent — re-clicking derives the SAME home — so we DON'T consume the KV token here.
  try {
    const vault = await orgVault(env, org);
    if (vault) await vault.set(`org.invite:${token}`, { emailHash, status: 'redeemed', agent: kms.agentId, redeemedAt: Date.now() });
  } catch { /* tracking is best-effort */ }

  // spec 321 W2: hand the invitee the steward's pre-signed member-access grant. Counterfactual by
  // construction — its delegate is the address derived from this SAME (iss='email', sub) pair, so it
  // matches the home just resolved; the client still checks delegate == its person before recording.
  return json({ ok: true, status: 'issued', token: sessionToken, org, memberAccessDelegation });
};
