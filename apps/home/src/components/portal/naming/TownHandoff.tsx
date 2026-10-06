'use client';
// The hand-off from the town's naming service (ap-town spec 430 N2). A visitor who finds a free name there is sent
// here to claim it, because only the owner's own account can sign a claim; the label comes along in the URL, and
// when the claim lands they are offered the way back to the name's page. The town never holds a key; this Home
// never follows a return address outside the town's naming origin (`townReturnUrl`).
import { useSearchParams } from 'next/navigation';
import { nameLabel, townReturnUrl, TOWN_NAMING_ORIGIN } from '../../../lib/domain';
import { btnSty, cardSty, mono, mutedText } from '../theme';

export interface TownHandoff { label: string; tld: string | null; returnUrl: string | null; popup: boolean; /** 430 N6a — a line about the agent, to write with the name. */ about?: string }

/** What the URL asks for, or null when nobody was sent here. Safe for a static page: it reads nothing until mounted. */
export function useTownHandoff(): TownHandoff | null {
  const params = useSearchParams();
  const ret = useTownReturn();
  const claim = params?.get('claim') ?? '';
  const label = claim ? nameLabel(claim.split('.')[0] ?? '') : '';
  if (!label) return null;
  const fromClaim = claim.includes('.') ? claim.split('.')[1] ?? null : null;
  const about = params?.get('about')?.slice(0, 280);
  return { label, tld: (params?.get('tld') || fromClaim || null), ...ret, ...(about ? { about } : {}) };
}

export interface TownReturn { returnUrl: string | null; popup: boolean }

/**
 * The way back to the town's naming service, and HOW: `popup=1` means the naming service opened this Home in a
 * popup (ap-town spec 431 §5.1 — the hop is meant to feel like connecting), so when the ceremony lands this window
 * navigates to the return address carrying the result, and the naming service's page in the popup relays it to
 * the opener and closes. Without `popup`, the page offers the link and stays.
 */
export function useTownReturn(): TownReturn {
  const params = useSearchParams();
  return { returnUrl: townReturnUrl(params?.get('return')), popup: params?.get('popup') === '1' };
}

/** The return address with the result on it, when there is one. */
export function townResultUrl(ret: TownReturn, result: { name: string; agent?: string | null; /** A record or presentation change, not a registration (430 N6c). */ changed?: boolean }): string | null {
  if (!ret.returnUrl) return null;
  try {
    const u = new URL(ret.returnUrl);
    u.searchParams.set(result.changed ? 'changed' : 'registered', result.name);
    if (result.agent) u.searchParams.set('agent', result.agent);
    if (ret.popup) u.searchParams.set('popup', '1');
    return u.toString();
  } catch { return ret.returnUrl; }
}

/** In popup mode, go back now with the result; otherwise do nothing (the page shows the link). */
export function finishTownHandoff(ret: TownReturn, result: { name: string; agent?: string | null; changed?: boolean }): void {
  if (!ret.popup) return;
  const u = townResultUrl(ret, result);
  if (u) window.location.assign(u);
}

/** Which agent a suffix names (ADR-0061); a person's Home can claim `.me`, an organization's agent its `.org`, … */
const OWNER_OF_TLD: Record<string, string> = { me: 'a person', org: 'an organization', team: 'a team', church: 'a church', circle: 'a circle', household: 'a household', svc: 'a service', workspace: 'a workspace', treasury: 'a treasury', registry: 'a registry' };

/**
 * EDIT AT YOUR HOME (430 N6c): the naming service opened this page in a popup for a name's records; nothing here has
 * a single "done" moment, so the note offers one — back to the name's page, which re-reads it.
 */
export function TownDoneNote({ ret, name }: { ret: TownReturn; name: string }) {
  if (!ret.popup || !ret.returnUrl) return null;
  const host = new URL(TOWN_NAMING_ORIGIN).host;
  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
      <div style={{ fontSize: '.7rem', letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-faint)' }}>From the town's naming service</div>
      <p style={{ margin: '.3rem 0 .6rem' }}>Change what you need below — every write is signed by your own account, here. When you are done, go back and <span style={mono as React.CSSProperties}>{host}</span> shows the name as it is now.</p>
      <a style={{ ...btnSty, textDecoration: 'none', display: 'inline-block' }} href={townResultUrl(ret, { name, changed: true }) ?? ret.returnUrl}>Done · back to {host} →</a>
    </div>
  );
}

export function TownHandoffNote({ handoff, claimed, kind }: { handoff: TownHandoff; claimed: string | null; kind?: string }) {
  const host = new URL(TOWN_NAMING_ORIGIN).host;
  const want = `${handoff.label}${handoff.tld ? `.${handoff.tld}` : ''}`;
  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
      <div style={{ fontSize: '.7rem', letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-faint)' }}>From the town's naming service</div>
      {claimed ? (
        <p style={{ margin: '.3rem 0 .6rem' }}>
          <strong style={mono as React.CSSProperties}>{claimed}</strong> is yours. It was signed here, by your own account; the town only reads.
        </p>
      ) : (
        <p style={{ margin: '.3rem 0 .6rem' }}>
          You came from <span style={mono as React.CSSProperties}>{host}</span> to claim <strong style={mono as React.CSSProperties}>{want}</strong>.
          A claim is signed by your own account, here — the town cannot do it for you.{' '}
          {kind === 'person' && handoff.tld && handoff.tld !== 'me' && OWNER_OF_TLD[handoff.tld]
            ? <>A <span style={mono as React.CSSProperties}>.{handoff.tld}</span> name belongs to {OWNER_OF_TLD[handoff.tld]}'s agent, not to you as a person: open that agent under <strong>Stewardship</strong>, then its <strong>Naming</strong> page, and claim it there with the same label.</>
            : 'The name is filled in below.'}
        </p>
      )}
      {handoff.returnUrl && (
        <a style={{ ...btnSty, textDecoration: 'none', display: 'inline-block' }} href={claimed ? townResultUrl(handoff, { name: claimed }) ?? handoff.returnUrl : handoff.returnUrl}>
          {claimed ? `See ${claimed} on ${host} →` : `Back to ${host}`}
        </a>
      )}
      {!handoff.returnUrl && <span style={{ ...mutedText, fontSize: '.8rem' }}>{host}</span>}
    </div>
  );
}
