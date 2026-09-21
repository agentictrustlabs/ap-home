// WHICH SOCIAL WAYS IN A NAMED HOME'S DOOR OFFERS (`<label>.<connect-domain>`, returning member).
//
// A social (OIDC/KMS) custodian — Google, YouVersion — signs via the KMS path; its published connection kind
// (spec 280) is the authoritative signer signal, so a home whose kind IS one of them gets that provider as its
// primary button, whether or not this deployment still opens that door for NEW members: it is the credential that
// opens this home, and hiding it would lock the member out.
//
// When the kind is UNPUBLISHED (faithnet publishes it best-effort) and the home looks like a plain EOA home
// (hasEoa, no passkey), the social sign-ins are offered as a secondary fallback — they resolve THIS home via its
// OIDC facet. That fallback is bounded by the deployment's own ways in: a door that opens Google · email must not
// grow a YouVersion button on every named home because the fallback listed every provider it knew
// (carol.faithnet.me, 2026-09-21).
export type SocialProvider = 'google' | 'youversion';

export interface NamedHomeDoorInput {
  /** The published connection-bootstrap kind, if any. */
  connectionKind: string | null | undefined;
  hasEoa: boolean | undefined;
  hasPasskey: boolean | undefined;
  /** `whitelabel.onboarding.credentialMethods` — the ways in this deployment opens. */
  methods: readonly string[];
}

export function socialButtonsForNamedHome(i: NamedHomeDoorInput): ReadonlyArray<{ provider: SocialProvider; primary: boolean }> {
  const kind: SocialProvider | null = i.connectionKind === 'google' || i.connectionKind === 'youversion' ? i.connectionKind : null;
  if (kind) return [{ provider: kind, primary: true }];
  const isSocialKind = i.connectionKind === 'email' || i.connectionKind === 'phone';
  const fallback = !isSocialKind && !!i.hasEoa && !i.hasPasskey;
  if (!fallback) return [];
  return (['youversion', 'google'] as const).filter((p) => i.methods.includes(p)).map((provider) => ({ provider, primary: false }));
}
