// ONE PLACE WHERE A BEARER IS VERIFIED AS A SESSION (spec 445 §8).
//
// `verifyAgentSession` checks signature, issuer, audience and time. An id_token this Home minted passes all four, so
// an endpoint that verifies under the Home's own audience would take an app's id_token for a Home session if one were
// ever issued under that audience. The registry now refuses that audience as an app id (`isHomeAudience`); this is the
// second lock, and it sits here so every endpoint has it rather than the three that checked by hand: under the Home's
// audience, only a token that names the credential behind it is a session.
//
// A verify under any OTHER audience is unchanged: some endpoints accept a relying app's token on purpose.
import { verifyAgentSession, type VerifyOpts, type VerifyResult } from '@agenticprimitives/connect';
import { isHomeAudience } from './oidc-registry';

export async function verifySession(token: string, opts: VerifyOpts): Promise<VerifyResult> {
  const v = await verifyAgentSession(token, opts);
  if (v.ok && isHomeAudience(opts.expectedAud) && !v.session.principal?.kind) return { ok: false, reason: 'not_a_home_session' };
  return v;
}
