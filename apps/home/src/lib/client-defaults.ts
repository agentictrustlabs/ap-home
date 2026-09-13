// CLIENT DEFAULTS — what connecting to a particular relying app sets up on the person's agent, once.
//
// A card room (poker.faithnet.io) addresses the person's OWN agent at the table and expects it to consult a
// coach. A person who connected without ever visiting Settings → Coaches had an agent that advertised none of
// the card room's skills and named no coach, so every hand fell to the house and the person was asked, sheet
// by sheet, to go and set it up. Connecting from that app is the moment they said what they were here for;
// this is where the Home finishes the arrangement for them:
//
//   1. the card room's skills go on the agent (the private capability record, and `atl:capabilities` on chain
//      under the person's signature — the same act as the Capabilities page's Publish);
//   2. the person's playbook names the client's default coach as the specialist for the game;
//   3. the person signs the study grant that lets that coach read their card-room records — and nothing else.
//
// Behaviour and a bounded grant, never open authority: the coach's whole reach is the grant's scope
// (`src/lib/coaches.ts`), and the person can fire it under Settings → Coaches at any time. Run AFTER the
// site-login grant is minted and BEFORE the code is handed back, so the app's first hand already has the
// coach; a failure here is logged and never blocks the sign-in — the app's own sheet offers the Coaches page.
import type { Address } from '@agenticprimitives/types';
import { signHashFor, type Via } from '../home/onboarding';
import { SESSION_KEY } from '../context/session';
import { fetchProfile, getCapabilities, listSkillClaims, saveSkillClaims, setCapabilities, capabilityIdFor } from '../connect-client';
import { assignDefaultArchetype } from '../home/default-archetype';
import { createAgentWithBirthrights } from '../components/portal/ManagedAgents';
import { listManagedAgents } from '../connect-client';
import { GAMES, coachFor, hireCoachGrant, listStudyGrants, readSpecialists, resolveCoach, studyScopesFor, writeSpecialists, type CoachedGame } from './coaches';

export interface ClientDefaults {
  /** The coach every person connecting from this app gets, per game — a SERVICE, by typed name. One per game. */
  coaches: Array<{ game: CoachedGame['id']; service: string }>;
  /**
   * A MONEY ACCOUNT, made in the ceremony when the person has none. The card room's tables settle from a
   * person-treasury; a person who arrived without one met "Set up your stake" on the first table they opened
   * and had to be sent back here. Creating it is the same ceremony the treasuries page runs (one account
   * custodied by the person's own credential, gas sponsored), narrated as a step here. It GRANTS the app
   * nothing — the buy-in mandate is still the person's to sign, by name, before a single coin moves.
   */
  treasury?: boolean;
}

/** By OIDC client id. The card room is the one app with default coaches today: Bob for hold'em, Carol for canasta. */
export const CLIENT_DEFAULTS: Record<string, ClientDefaults> = {
  pokernight: { coaches: [{ game: 'poker', service: 'bob-coach.svc' }, { game: 'canasta', service: 'carol-coach.svc' }], treasury: true },
};

const toVia = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};

export interface DefaultsOutcome { applied: string[]; skipped: string[]; error?: string }

/**
 * Apply an app's defaults to the signed-in person's agent. Idempotent: what is already there is left alone,
 * so a person who connects every evening signs nothing after the first time. `onStep` narrates for the
 * ceremony's progress line.
 */
export async function applyClientDefaults(clientId: string, onStep?: (line: string) => void): Promise<DefaultsOutcome> {
  const d = CLIENT_DEFAULTS[clientId];
  const out: DefaultsOutcome = { applied: [], skipped: [] };
  if (!d) return out;
  let token = ''; let via = '';
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = raw ? (JSON.parse(raw) as { token?: string; via?: string }) : null;
    token = s?.token ?? ''; via = s?.via ?? '';
  } catch { /* no session in this browser */ }
  if (!token) return { ...out, error: 'no home session' };
  const profile = await fetchProfile(token).catch(() => null);
  const agent = (profile?.agent ? (profile.agent.split(':').pop() as Address) : null) ?? null;
  if (!agent || !profile?.deployed) return { ...out, error: 'the agent is not deployed yet' };
  const games = d.coaches.map((c) => ({ ...c, game: GAMES.find((g) => g.id === c.game)! })).filter((c) => c.game);
  const signer = () => signHashFor(toVia(via), agent, { token });

  // 0. A money account, when the app settles and the person has none. Never a second one; never on failure
  //    a blocked sign-in — the card room's own "Set up your stake" panel remains the recovery path.
  if (d.treasury) {
    try {
      const mine = (await listManagedAgents(token).catch(() => [])).filter((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward');
      if (mine.length) out.skipped.push('treasury');
      else {
        onStep?.('Making you a money account for the tables…');
        const made = await createAgentWithBirthrights({ kind: 'person-treasury', parent: agent, person: agent, via: via || 'passkey' }, token, (line) => onStep?.(line));
        if (made.ok) out.applied.push('treasury'); else { out.error = `treasury: ${made.error}`; }
      }
    } catch (e) {
      out.error = `treasury: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 1. The card room's skills on the agent, for EVERY game it deals — one signature, only when something is missing.
  const published = await getCapabilities(agent).catch(() => [] as string[]);
  const wantClaims = games.flatMap((c) => c.game.agentCapabilities);
  const wantIds = [...new Set(wantClaims.map(capabilityIdFor))];
  if (wantIds.every((id) => published.includes(id))) out.skipped.push('skills');
  else {
    onStep?.('Putting the card room’s skills on your agent…');
    const claims = await listSkillClaims(token).catch(() => []);
    const have = new Set(claims.map((c) => capabilityIdFor(c)));
    const next = [...claims, ...wantClaims.filter((c) => !have.has(capabilityIdFor(c)))].map((c) => (wantIds.includes(capabilityIdFor(c)) ? { ...c, asserted: true } : c));
    await saveSkillClaims(token, next);
    const res = await setCapabilities(agent, profile.name ?? agent, [...new Set([...published, ...wantIds])].sort(), await signer());
    if (!res.ok) return { ...out, error: `skills: ${res.error}` };
    out.applied.push('skills');
  }

  // 2. A playbook to write the specialist into — the default one, when none is assigned yet.
  let sp = await readSpecialists(token, agent).catch(() => ({ assigned: false, specialists: [] }));
  if (!sp.assigned) {
    onStep?.('Assigning your agent its playbook…');
    const a = await assignDefaultArchetype(agent, 'person', token);
    if (!a.ok) return { ...out, error: `playbook: ${a.reason ?? 'not assigned'}` };
    sp = await readSpecialists(token, agent).catch(() => ({ assigned: true, specialists: [] }));
    out.applied.push('playbook');
  }

  // 3. The coaches, one per game: the grant (the person signs), then the lines — unless both are already in place.
  const grants = await listStudyGrants(agent).catch(() => []);
  for (const { game, service } of games) {
    const current = coachFor(sp.specialists, game);
    const live = grants.find((g) => g.coach === service && !g.revoked && g.resources.some((r) => studyScopesFor(game.id).reads.includes(r)));
    if (current === service && live) { out.skipped.push(`coach:${game.id}`); continue; }
    onStep?.(`Making ${service} your ${game.label} coach — you sign one grant…`);
    const coachSA = await resolveCoach(service);
    if (!coachSA) { out.error = `${service} does not resolve`; continue; }
    if (!live) await hireCoachGrant(agent, service, coachSA, await signer(), game.id);
    if (current !== service) { await writeSpecialists(token, agent, game, service); sp = await readSpecialists(token, agent).catch(() => sp); }
    out.applied.push(`coach:${game.id}`);
  }
  return out;
}
