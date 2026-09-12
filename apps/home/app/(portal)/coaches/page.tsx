'use client';
// Settings → Behaviour → Coaches: a coaching SERVICE per game, hired here and fired here.
//
// A card room addresses the person's OWN agent for advice; that agent generates nothing and consults the
// coach this page names, presenting the study grant this page has the person sign. Two custodial acts, both
// the person's (`src/lib/coaches.ts`): the specialist lines in their playbook, and a vault-record-scope
// delegation to the SERVICE — read their card-room records, append the coach's notes, nothing else, a year,
// revocable. Firing drops this Home's copy of the grant and clears the lines; the on-chain revoke (the
// authority kill) is under Security like every other delegation.
//
// The page also makes sure the agent ADVERTISES the card-room skills for each game (poker.advise, .record,
// .review, .coach) — the card room refuses to name an agent as an adviser without them, and the agent's own
// harness answers only the skills its card carries. Publishing them is the same act as the Capabilities
// page's Publish: the ids on chain under the person's signature; the private capability record beside it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { BusyButton } from '../../../src/components/shared/BusyButton';
import { btnSty, btnPrimarySty, cardSty, errorText, infoBannerSty, mutedText, mono } from '../../../src/components/portal/theme';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { getCapabilities, listSkillClaims, saveSkillClaims, setCapabilities, capabilityIdFor, type CapabilityClaim } from '../../../src/connect-client';
import {
  COACH_OFFERS, GAMES, coachFor, dropCoachGrant, hireCoachGrant, listStudyGrants, readSpecialists, resolveCoach, writeSpecialists,
  type CoachedGame, type StudyGrantRow,
} from '../../../src/lib/coaches';
import type { SpecialistV1 } from '@agenticprimitives/capability-claims';

const toViaForSign = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};

export default function CoachesPage() {
  const { session, agentAddress, agentName } = useSession();
  const [specialists, setSpecialists] = useState<SpecialistV1[]>([]);
  const [assigned, setAssigned] = useState<boolean | null>(null);
  const [grants, setGrants] = useState<StudyGrantRow[]>([]);
  const [published, setPublished] = useState<string[]>([]);
  const [claims, setClaims] = useState<CapabilityClaim[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The game in the address (`/coaches?game=poker`, as the card room's "want a coach?" sheet sends people)
  // is opened first; every game is on the page.
  const wanted = useMemo(() => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('game') : null), []);

  const reload = useCallback(async () => {
    if (!session?.token || !agentAddress) return;
    setLoading(true);
    try {
      const [sp, gs, pub, cl] = await Promise.all([
        readSpecialists(session.token, agentAddress).catch(() => ({ assigned: false, specialists: [] as SpecialistV1[] })),
        listStudyGrants(agentAddress).catch(() => [] as StudyGrantRow[]),
        getCapabilities(agentAddress).catch(() => [] as string[]),
        listSkillClaims(session.token).catch(() => [] as CapabilityClaim[]),
      ]);
      setAssigned(sp.assigned); setSpecialists(sp.specialists); setGrants(gs); setPublished(pub); setClaims(cl);
    } finally {
      setLoading(false);
    }
  }, [session?.token, agentAddress]);
  useEffect(() => { void reload(); }, [reload]);

  if (!session || !agentAddress) {
    return <SectionShell title="Coaches"><p className="manage-card-blurb">Sign in to choose a coach for your agent.</p></SectionShell>;
  }

  const signer = () => signHashFor(toViaForSign(session.via), agentAddress, { token: session.token });

  /** The card-room skills for a game, on chain — so the card room may name this agent, and the agent answers them. */
  const enableSkills = async (game: CoachedGame) => {
    setBusy(`skills:${game.id}`); setErr(null); setMsg(null);
    try {
      const want = game.agentCapabilities;
      const have = new Set(claims.map((c) => capabilityIdFor(c)));
      const nextClaims = [...claims, ...want.filter((c) => !have.has(capabilityIdFor(c)))].map((c) => (want.some((w) => capabilityIdFor(w) === capabilityIdFor(c)) ? { ...c, asserted: true } : c));
      await saveSkillClaims(session.token, nextClaims);
      const ids = [...new Set([...published, ...want.map(capabilityIdFor)])].sort();
      const res = await setCapabilities(agentAddress, agentName || agentAddress, ids, await signer());
      if (!res.ok) { setErr(res.error); return; }
      setMsg(`${game.label}: your agent now advertises ${want.map(capabilityIdFor).join(', ')}. A card you released earlier in Card Studio keeps its old skills until you release it again.`);
      await reload();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(null); }
  };

  /** Hire: the grant first (the person signs), then the playbook lines. */
  const hire = async (game: CoachedGame, coach: string) => {
    setBusy(`hire:${coach}`); setErr(null); setMsg(null);
    try {
      const coachSA = await resolveCoach(coach);
      if (!coachSA) { setErr(`${coach} does not resolve to a deployed agent.`); return; }
      const { hash } = await hireCoachGrant(agentAddress, coach, coachSA, await signer());
      await writeSpecialists(session.token, agentAddress, game, coach);
      setMsg(`${coach} is your ${game.label} coach. It reads your recorded hands under the grant you just signed (${hash.slice(0, 12)}…) and advises through your own agent at the table.`);
      await reload();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(null); }
  };

  /** Fire: the lines cleared, this Home's copy of the grant dropped. */
  const fire = async (game: CoachedGame, coach: string) => {
    setBusy(`fire:${coach}`); setErr(null); setMsg(null);
    try {
      await writeSpecialists(session.token, agentAddress, game, null);
      await dropCoachGrant(agentAddress, coach).catch(() => undefined);
      setMsg(`${coach} no longer coaches you at ${game.label}. Your agent stops consulting it at the next hand; to kill its grant on chain as well, revoke it under Security.`);
      await reload();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(null); }
  };

  const ordered = [...GAMES].sort((a, b) => (a.id === wanted ? -1 : b.id === wanted ? 1 : 0));

  return (
    <SectionShell
      title="Coaches"
      description="A coach is a service somebody runs. Your own agent consults it at the table and records every hand to your vault; the coach reads those records under a grant you sign, and nothing else. One coach per game. Its tokens, never yours."
    >
      {assigned === false ? (
        <div style={infoBannerSty}>Your agent has no playbook assigned yet, so it cannot name a coach. Assign one under <a href="/playbook">Behaviour → Playbook</a>, then come back.</div>
      ) : null}
      {err ? <p style={errorText} role="alert">{err}</p> : null}
      {msg ? <p role="status">{msg}</p> : null}
      {ordered.map((game) => {
        const current = coachFor(specialists, game);
        const grant = current ? grants.find((g) => g.coach === current) : undefined;
        const offers = COACH_OFFERS.filter((o) => o.game === game.id);
        const skillsOn = game.agentCapabilities.every((c) => published.includes(capabilityIdFor(c)));
        return (
          <section key={game.id} style={{ ...cardSty, display: 'grid', gap: '0.6rem' }} aria-labelledby={`coach-${game.id}`}>
            <h3 id={`coach-${game.id}`} style={{ margin: 0 }}>{game.label}</h3>
            {/* STEP ONE — the agent's card: what the card room asks it for this game. */}
            <div>
              <strong>Your agent's card-room skills</strong>{' '}
              {loading ? <span style={mutedText}>…</span> : skillsOn ? <span style={mutedText}>— on: {game.agentCapabilities.map(capabilityIdFor).join(', ')}</span> : (
                <span style={mutedText}>— not yet. The card room refuses to name an agent as your adviser until its card carries {game.agentCapabilities.map(capabilityIdFor).join(', ')}.</span>
              )}
              {!loading && !skillsOn ? (
                <div style={{ marginTop: '0.4rem' }}>
                  <BusyButton busy={busy === `skills:${game.id}`} busyLabel="Publishing…" style={btnPrimarySty} onClick={() => void enableSkills(game)} disabled={busy != null}>
                    Put them on my agent (one signature)
                  </BusyButton>
                </div>
              ) : null}
            </div>
            {/* STEP TWO — the coach. */}
            <div>
              <strong>Coach</strong>{' '}
              {loading ? <span style={mutedText}>…</span> : current ? (
                <>
                  <span style={mono}>{current}</span>
                  <span style={mutedText}>{grant ? (grant.revoked ? ' — grant REVOKED on chain; your agent will say so and the house answers' : ` — grant ${grant.hash.slice(0, 10)}… stored ${grant.storedAt.slice(0, 10)}`) : ' — no study grant stored; the coach cannot read your hands. Hire it again to sign one.'}</span>
                  <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {!grant || grant.revoked ? (
                      <BusyButton busy={busy === `hire:${current}`} busyLabel="Signing…" style={btnPrimarySty} onClick={() => void hire(game, current)} disabled={busy != null}>Sign the study grant</BusyButton>
                    ) : null}
                    <BusyButton busy={busy === `fire:${current}`} busyLabel="Firing…" style={btnSty} onClick={() => void fire(game, current)} disabled={busy != null}>Fire this coach</BusyButton>
                  </div>
                </>
              ) : <span style={mutedText}>— none. Your agent says so at the table and the house coach answers.</span>}
            </div>
            {!current && offers.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' }}>
                {offers.map((o) => (
                  <li key={o.name} style={{ ...cardSty, display: 'grid', gap: '0.3rem' }}>
                    <div><strong>{o.displayName}</strong> <span style={{ ...mono, ...mutedText }}>{o.name}</span></div>
                    <p style={{ margin: 0, ...mutedText }}>{o.blurb}</p>
                    <div>
                      <BusyButton busy={busy === `hire:${o.name}`} busyLabel="Signing the grant…" style={btnPrimarySty} onClick={() => void hire(game, o.name)} disabled={busy != null || assigned === false}>
                        Hire {o.displayName}
                      </BusyButton>
                      <span style={{ ...mutedText, marginLeft: '0.5rem' }}>You sign one grant: read your hands, style, reads and notes; write only its notes; a year; revocable.</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {!current && !offers.length ? <p style={{ margin: 0, ...mutedText }}>No coaching service is on offer for {game.label} yet.</p> : null}
          </section>
        );
      })}
      <p style={mutedText}>
        What the coach sees and does is bounded by the grant, not by its manners: the vault refuses your records on a service's own principal, the
        card room never learns the coach's address, and a note it leaves goes into your cabinet, where you can clear it.
      </p>
    </SectionShell>
  );
}
