'use client';
// Connected → Your accounts (spec 422 §8). Accounts of hers that her agent may read through: a Google calendar, mail,
// files, YouVersion. Connecting is her act (an authorization she gives Google); disconnecting deletes the credential.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { ConnectorCard } from '../../../../src/components/portal/CalendarConnectCard';
import { YouVersionData } from '../../../../src/components/portal/YouVersionData';
import { Note } from '../../../../src/ui';

export default function ConnectedAccountsPage() {
  return (
    <SectionShell title="Your accounts" description="Accounts of yours your agent may read through — what each one lets it do, and the button that disconnects it.">
      <Note>Connecting an account gives your agent a way to read it <b>for you</b> — "what's on today", "any mail from the elders", "find the retreat budget". Where an account also lets it write (add an event, draft a mail), that is a separate choice on the card, and every write still waits for your signature. Disconnecting deletes the credential; the next read says "not connected".</Note>
      <ConnectorCard name="calendar" returnTo="/apps/accounts" />
      <ConnectorCard name="gmail" returnTo="/apps/accounts" />
      <ConnectorCard name="drive" returnTo="/apps/accounts" />
      <YouVersionData />
    </SectionShell>
  );
}
