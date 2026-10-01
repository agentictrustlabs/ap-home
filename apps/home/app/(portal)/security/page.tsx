'use client';
// Security → Overview (spec 422 §2.1) — how protected is this home, and what needs me?
//
// The page that was here stacked seven sections (sign-in count, devices, a "coming soon" recovery card, the vault
// link, delegations granted AND received, Google, email, phone) in three style systems. It is now the pane's front
// door: the posture, what needs the person, the recent security activity, and a row per page of the section.
// Sign-in moved to /security/sign-in; granted delegations sit with the other grants on /grants; received
// delegations are each organization's surface (/org/<sa>/grants) — not the owner's security page.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { HomeControlEventV1 } from '@agenticprimitives/home';
import { useSession } from '../../../src/context/session';
import { sessionGrade, credentialWords } from '../../../src/lib/security-grade';
import { readCredentialSet, type CredentialSet } from '../../../src/home/credentials';
import { listControlEvents } from '../../../src/home/control-plane';
import { rotationAvailability } from '../../../src/connect-client';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { FingerprintIcon, ShieldIcon, HistoryIcon, LinkIcon, LockIcon } from '../../../src/components/shared/Icons';
import { List, Row, Chip, KeyValue, Note, Meta, relativeLabel } from '../../../src/ui';
import { Panel } from '../../../src/ui/panel';

const SECURITY_EVENTS: ReadonlySet<HomeControlEventV1['eventType']> = new Set([
  'credential-added', 'credential-retired', 'channel-linked', 'channel-unlinked', 'home-rotated', 'grant-issued', 'grant-revoked', 'credential-issued', 'credential-received',
]);
const EVENT_WORDS: Partial<Record<HomeControlEventV1['eventType'], string>> = {
  'credential-added': 'A credential that signs for you was added',
  'credential-retired': 'A credential was retired',
  'channel-linked': 'An email or phone now opens this home',
  'channel-unlinked': 'An email or phone was unlinked',
  'home-rotated': 'Your Home was rotated',
  'grant-issued': 'You issued a grant',
  'grant-revoked': 'You revoked a grant',
  'credential-issued': 'A credential was issued',
  'credential-received': 'A credential was received',
};

export default function SecurityOverviewPage() {
  const { session, profile, agentAddress } = useSession();
  const personAgent = agentAddress as Address | null;
  const via = session?.via ?? '';
  const grade = sessionGrade(profile);
  const [set, setSet] = useState<CredentialSet | null>(null);
  const [setError, setSetError] = useState<string | null>(null);
  const [events, setEvents] = useState<HomeControlEventV1[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  useEffect(() => {
    if (!personAgent) return;
    let live = true;
    readCredentialSet(personAgent, { sessionCredential: profile?.credential, via }).then((s) => live && setSet(s)).catch((e) => live && setSetError(e instanceof Error ? e.message : 'read failed'));
    return () => { live = false; };
  }, [personAgent, profile?.credential, via]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    listControlEvents(session.token).then((ev) => live && setEvents(ev.filter((e) => SECURITY_EVENTS.has(e.eventType)).slice(0, 12))).catch((e) => live && setEventsError(e instanceof Error ? e.message : 'read failed'));
    return () => { live = false; };
  }, [session]);

  const custody = (set?.rows ?? []).filter((r) => r.grade === 'custody-grade' && r.state === 'active');
  const channels = (set?.rows ?? []).filter((r) => r.grade === 'login-grade');
  const kinds = new Set(custody.map((r) => r.kind));
  const total = set ? set.counts.passkeys + set.counts.custodians : null;
  // The posture ladder (spec 422 §4.1 / 207 §4), from the chain: one credential · backups of two kinds · trustees.
  const rung = !set ? null
    : set.custodyMode > 0 ? 'trustees'
    : total != null && total >= 2 && (kinds.size >= 2 || set.counts.passkeys >= 2) ? 'backups'
    : 'just-you';
  const rotationOk = rotationAvailability();

  return (
    <SectionShell title="Security" description="How this home is protected, what needs you, and what changed — one row per page of the section.">
      <Panel
        title="How this home is protected"
        icon={<ShieldIcon size={18} />}
        state={setError ? 'unknown' : !set ? 'loading' : 'ready'}
        unknown={{ read: setError ?? 'your credentials' }}
        testId="sec-posture"
      >
        {set && (
          <div className="ui-panel-body">
            <KeyValue rows={[
              ['Signs for you', <span key="c">{custody.length > 0 ? custody.map((r) => r.label).join(' · ') : (total ? `${total} on chain, unlabelled` : 'nothing')}{set.unlabelled.passkeys + set.unlabelled.custodians > 0 && custody.length > 0 ? ` · ${set.unlabelled.passkeys + set.unlabelled.custodians} unlabelled` : ''}</span>],
              ['Opens this home', channels.length > 0 ? channels.map((r) => `${r.label} ${r.sub}`).join(' · ') : 'no email or phone linked', { absent: channels.length === 0 }],
              ['This session', <span key="s">{credentialWords(profile?.credential, via)} · <Chip tone={grade === 'custody-grade' ? 'ok' : 'warn'}>{grade === 'custody-grade' ? 'signs for you' : 'opens only'}</Chip></span>],
              ['Custody', set.custodyMode === 0 ? 'self-governed — your own credentials sign every change' : `custody-governed (mode ${set.custodyMode}) — changes go through your trustees' quorum`],
              ['Recovery', rung === 'trustees' ? 'trustees named' : rung === 'backups' ? 'a second credential: lose one, sign in with the other and replace it' : 'none — one credential opens this home; lose it and nothing can bring it back', { absent: rung !== 'trustees' }],
            ]} />
            <div style={{ height: 'var(--sp-3)' }} />
            {rung === 'just-you' && <Note>Next step: add a passkey on a second device or a wallet, so a lost device is survivable. Naming recovery trustees arrives with this section&rsquo;s recovery wave (spec 422 W2).</Note>}
            {rung === 'backups' && <Note>Next step: recovery trustees — people you choose who can restore your access after a delay. Arrives with this section&rsquo;s recovery wave (spec 422 W2).</Note>}
            {!rotationOk.ok && <Note>{rotationOk.reason} — until then, adding a credential works and nothing here removes one quietly.</Note>}
          </div>
        )}
      </Panel>

      <Panel title="This section" icon={<LockIcon size={18} />} state="ready" testId="sec-pages">
        <List>
          <Row href="/security/sign-in" title="Sign-in" meta="Which credentials open and sign for this home, on which devices; the emails and phones we tell." side={<FingerprintIcon size={16} />} />
          <Row href="/grants" title="Grants" meta="Every grant you issued — apps, assistants, organizations, contacts, runtimes — one list, one Revoke each." side={<ShieldIcon size={16} />} />
          <Row href="/apps" title="Connected" meta="Accounts your agent reads through and apps that are clients of you." side={<LinkIcon size={16} />} />
          <Row href="/vault-key" title="Vault key" meta="The key your records are sealed under, and the authorization that lets the vault server use it." side={<LockIcon size={16} />} />
        </List>
      </Panel>

      <Panel
        title="Recent security activity"
        icon={<HistoryIcon size={18} />}
        count={events?.length}
        state={eventsError ? 'unknown' : !events ? 'loading' : events.length === 0 ? 'empty' : 'ready'}
        unknown={{ read: eventsError ?? 'your activity timeline' }}
        empty={{ title: 'Nothing yet', hint: 'Credential, channel and grant changes land here as they happen.' }}
        aside={<Meta><a href="/activities">All activity →</a></Meta>}
        testId="sec-activity"
      >
        <List>
          {(events ?? []).map((e, i) => (
            <Row key={`${e.at}-${i}`} title={EVENT_WORDS[e.eventType] ?? e.eventType} meta={<span>{relativeLabel(e.at)}{e.refs.length ? ` · ${e.refs.length} ref${e.refs.length === 1 ? '' : 's'}` : ''}</span>} />
          ))}
        </List>
      </Panel>
    </SectionShell>
  );
}
