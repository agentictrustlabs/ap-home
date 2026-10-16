// WHAT A ROUTED ASK CARRIES OVER THE WIRE — spec 397 §11.5 (Ring 0 PR "pairwise routed asks"): a Home session token never
// leaves this estate's own runtime. In-process asks (`here`) keep it: the receiver is this Worker. An ask carried over the
// wire to ANOTHER host — a self-hosted service agent, another estate — carries the app delegation it was admitted under,
// or the session only to a PEER deployment this one names (`A2A_TRUSTED_ORIGINS`: the same estate's other deployment,
// which verifies the session with the same secrets). Anything else is refused in words, never sent with the session:
// a forwarded session is a bearer credential for the person's whole Home at a host that does not need one (2026-10-16:
// scripture-resolver.svc received Home sessions on every routed ask). The pairwise asker (spec 442 §4.1) replaces this
// refusal for services that declare it, once that release is pinned.
import { derivePairwiseSubject } from '@agenticprimitives/key-custody';

/** Spec 442 §4.1 — the person's pairwise secret, her own vault record (`identity.pairwise-secret`, `ap:PairwiseSubject`). */
export const PAIRWISE_SECRET_RECORD = 'identity.pairwise-secret';
export interface PairwiseSecretRecordV1 { type: 'ap.pairwise-secret.v1'; secret: string; rotation: number; createdAt: string }

/** THE PAIRWISE SUBJECT this person is known by at ONE audience: derived from her secret, never from her address. The
 *  secret is minted on first need and kept in HER vault by her own grant — initialising her own key material, not a
 *  fallback between mechanisms: a vault that will not keep it refuses the hop in words. No person on the run ⇒ no subject. */
export function pairwiseSubjectPort(deps: { readSubjectRecord?: (s: string, rt: string) => Promise<unknown>; writeSubjectRecord?: (s: string, rt: string, r: unknown) => Promise<{ ok: boolean; error?: string }> }, person: string | undefined, random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32))): (audience: string) => Promise<string> {
  return async (audience) => {
    if (!person) throw new Error('a pairwise asker is a person\'s pseudonym, and there is no person on this run');
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('this runtime cannot reach the person\'s vault for her pairwise secret');
    const me = person.toLowerCase();
    let rec = (await deps.readSubjectRecord(me, PAIRWISE_SECRET_RECORD).catch(() => null)) as PairwiseSecretRecordV1 | null;
    if (!rec || rec.type !== 'ap.pairwise-secret.v1' || !/^0x[0-9a-f]{64}$/.test(rec.secret ?? '')) {
      const secret = `0x${[...random()].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      rec = { type: 'ap.pairwise-secret.v1', secret, rotation: 0, createdAt: new Date().toISOString() };
      const w = await deps.writeSubjectRecord(me, PAIRWISE_SECRET_RECORD, rec);
      if (!w.ok) throw new Error(`her vault would not keep a pairwise secret (${w.error ?? 'refused'}) — re-enable storage at her Home`);
    }
    const bytes = new Uint8Array(rec.secret.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    return derivePairwiseSubject({ personSecret: bytes, issuer: audience, rotation: rec.rotation ?? 0 });
  };
}

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
