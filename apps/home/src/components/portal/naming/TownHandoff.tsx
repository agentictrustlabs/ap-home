'use client';
// The hand-off from the town's naming service (ap-town spec 430 N2). A visitor who finds a free name there is sent
// here to claim it, because only the owner's own account can sign a claim; the label comes along in the URL, and
// when the claim lands they are offered the way back to the name's page. The town never holds a key; this Home
// never follows a return address outside the town's naming origin (`townReturnUrl`).
import { useSearchParams } from 'next/navigation';
import { nameLabel, townReturnUrl, TOWN_NAMING_ORIGIN } from '../../../lib/domain';
import { btnSty, cardSty, mono, mutedText } from '../theme';

export interface TownHandoff { label: string; tld: string | null; returnUrl: string | null }

/** What the URL asks for, or null when nobody was sent here. Safe for a static page: it reads nothing until mounted. */
export function useTownHandoff(): TownHandoff | null {
  const params = useSearchParams();
  const claim = params?.get('claim') ?? '';
  const label = claim ? nameLabel(claim.split('.')[0] ?? '') : '';
  if (!label) return null;
  const fromClaim = claim.includes('.') ? claim.split('.')[1] ?? null : null;
  return { label, tld: (params?.get('tld') || fromClaim || null), returnUrl: townReturnUrl(params?.get('return')) };
}

/** Which agent a suffix names (ADR-0061); a person's Home can claim `.me`, an organization's agent its `.org`, … */
const OWNER_OF_TLD: Record<string, string> = { me: 'a person', org: 'an organization', team: 'a team', church: 'a church', circle: 'a circle', household: 'a household', svc: 'a service', workspace: 'a workspace', treasury: 'a treasury', registry: 'a registry' };

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
        <a style={{ ...btnSty, textDecoration: 'none', display: 'inline-block' }} href={handoff.returnUrl}>
          {claimed ? `See ${claimed} on ${host} →` : `Back to ${host}`}
        </a>
      )}
      {!handoff.returnUrl && <span style={{ ...mutedText, fontSize: '.8rem' }}>{host}</span>}
    </div>
  );
}
