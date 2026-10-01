'use client';
// Connected → Overview (spec 422 §8; owner 2026-10-01: "a non-technical person needs to be able to read and understand
// this"). One row per question the pane answers, each with a count read from where the fact lives, and three sentences
// that say how connection works here: signing in proves who you are; letting something read your records is a second
// yes; letting it act is a third — and every yes can be taken back.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { listConnectedApps } from '../../../src/lib/connected-apps';
import { listAppGrants } from '../../../src/lib/app-grants';
import { listReadGrants } from '../../../src/lib/read-grants';
import { mcpConnectors } from '../../../src/home/ask';
import { connectorClient, type ConnectorName } from '../../../src/components/portal/CalendarConnectCard';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { UserIcon, CodeIcon, GlobeIcon, BotIcon, DatabaseIcon, LinkIcon } from '../../../src/components/shared/Icons';
import { List, Row, Chip, Note } from '../../../src/ui';
import { Panel } from '../../../src/ui/panel';

type Counts = { accounts: number | null; tools: number | null; signedIn: number | null; assistants: number | null; readers: number | null };
const NAMES: ConnectorName[] = ['calendar', 'gmail', 'drive'];

export default function ConnectedOverviewPage() {
  const { session, agentAddress } = useSession();
  const [c, setC] = useState<Counts>({ accounts: null, tools: null, signedIn: null, assistants: null, readers: null });
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    if (!session?.token || !agentAddress) return;
    let live = true;
    const token = session.token;
    const fail = (what: string) => { if (live) setFailed((f) => (f.includes(what) ? f : [...f, what])); };
    void Promise.all(NAMES.map((n) => connectorClient(token, n).status().then((s) => (s.connected ? 1 : 0)).catch(() => { fail('your accounts'); return 0; })))
      .then((xs) => live && setC((p) => ({ ...p, accounts: xs.reduce((a, b) => a + b, 0) })));
    void mcpConnectors({ token }, 'list').then((r) => live && setC((p) => ({ ...p, tools: r.ok ? r.connectors.length : 0 }))).catch(() => fail('your tools'));
    if (live) setC((p) => ({ ...p, signedIn: listConnectedApps(agentAddress as Address).length }));
    void listAppGrants(token).then((g) => live && setC((p) => ({ ...p, assistants: g.filter((x) => x.template === 'ask-as-me').length }))).catch(() => fail('your assistants'));
    void listReadGrants(agentAddress as Address).then((g) => live && setC((p) => ({ ...p, readers: g.filter((x) => !x.revoked).length }))).catch(() => fail('who can read your records'));
    return () => { live = false; };
  }, [session?.token, agentAddress]);

  const count = (n: number | null, one: string, many: string) => (n === null ? <Chip>reading…</Chip> : n === 0 ? <Chip>none</Chip> : <Chip tone="ok">{n} {n === 1 ? one : many}</Chip>);

  return (
    <SectionShell title="Connected" description="What is connected to you — the accounts and tools your agent can use, and the apps and assistants you have let act as you.">
      <Panel title="What is connected to you" icon={<LinkIcon size={18} />} state="ready" testId="connected-overview">
        <List>
          <Row href="/apps/accounts" title="Your accounts" meta="Google Calendar, Gmail, Google Drive, YouVersion — accounts of yours your agent may read through, and the one or two things each lets it do for you." side={<><UserIcon size={16} />{count(c.accounts, 'connected', 'connected')}</>} />
          <Row href="/apps/tools" title="Tools" meta="Tool servers you attached — each tool becomes something your agent can do. Reads it does on its own; anything that changes something waits for your signature." side={<><CodeIcon size={16} />{count(c.tools, 'server', 'servers')}</>} />
          <Row href="/apps/signed-in" title="Apps you signed into" meta="Apps that used this home to sign you in. Signing in proves who you are to them; it gives them no standing access to your records." side={<><GlobeIcon size={16} />{count(c.signedIn, 'app', 'apps')}</>} />
          <Row href="/apps/assistants" title="Assistants" meta="Assistants (Claude, for one) you let put questions to your agent as you. They can ask; they can never sign." side={<><BotIcon size={16} />{count(c.assistants, 'assistant', 'assistants')}</>} />
          <Row href="/apps/readers" title="Who can read your records" meta="Apps you let read a part of your records — which app, which records. Remove any one without touching the others." side={<><DatabaseIcon size={16} />{count(c.readers, 'app', 'apps')}</>} />
        </List>
        {failed.length > 0 && <Note>Could not read {failed.join(', ')} just now — the pages themselves will say what they find.</Note>}
      </Panel>
      <Panel title="How connection works here" icon={<LinkIcon size={18} />} state="ready">
        <div className="ui-panel-body">
          <p style={{ margin: '0 0 var(--sp-2)' }}><b>Three separate yeses.</b> Signing in proves who you are to an app. Letting it read your records is a second yes, for one app and one kind of record at a time. Letting it do something for you is a third, and each act still waits for your signature.</p>
          <p style={{ margin: '0 0 var(--sp-2)' }}><b>Every yes can be taken back.</b> Removing one stops that app everywhere it is checked, not only on this screen. Nothing you connected can bring itself back; only you can.</p>
          <p style={{ margin: 0 }}><b>Nothing here signs for you.</b> Your sign-in credentials are under Security. Connected things ask, read or act within what you allowed; they never hold your keys.</p>
        </div>
      </Panel>
    </SectionShell>
  );
}
