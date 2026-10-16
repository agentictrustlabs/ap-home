// WHAT A ROUTED ASK CARRIES OVER THE WIRE — spec 397 §11.5 (Ring 0 PR "pairwise routed asks"): a Home session token never
// leaves this estate's own runtime. In-process asks (`here`) keep it: the receiver is this Worker. An ask carried over the
// wire to ANOTHER host — a self-hosted service agent, another estate — carries the app delegation it was admitted under,
// or the session only to a PEER deployment this one names (`A2A_TRUSTED_ORIGINS`: the same estate's other deployment,
// which verifies the session with the same secrets). Anything else is refused in words, never sent with the session:
// a forwarded session is a bearer credential for the person's whole Home at a host that does not need one (2026-10-16:
// scripture-resolver.svc received Home sessions on every routed ask). The pairwise asker (spec 442 §4.1) replaces this
// refusal for services that declare it, once that release is pinned.
export type WireCredential =
  | { ok: true; credential: { kind: 'home-session'; token: string } | ({ kind: 'app-delegation' } & Record<string, unknown>); session?: string }
  | { ok: false; refused: string };

export function wireCredentialFor(i: { cardUrl: string; session?: string | undefined; appCredential?: Record<string, unknown> | undefined; trustedOrigins?: string | undefined; name: string }): WireCredential {
  let host = '';
  try { host = new URL(i.cardUrl).hostname.toLowerCase(); } catch { return { ok: false, refused: `${i.name} publishes no card URL this runtime can read` }; }
  const peers = String(i.trustedOrigins ?? '').split(',').map((x) => x.trim()).filter(Boolean).flatMap((p) => { try { return [new URL(p).hostname.toLowerCase()]; } catch { return []; } });
  const isPeer = peers.some((h) => host === h || host.endsWith(`.${h}`));
  if (i.session && isPeer) return { ok: true, credential: { kind: 'home-session', token: i.session }, session: i.session };
  if (i.appCredential) return { ok: true, credential: { kind: 'app-delegation', ...i.appCredential } };
  if (i.session) return { ok: false, refused: `${i.name} is served at ${host}, outside this estate's runtime — your Home session is not sent there. Ask it through an app connected to it, or once it accepts pairwise asks.` };
  return { ok: false, refused: 'a routed ask carries the asker’s credential, and this run has none' };
}
