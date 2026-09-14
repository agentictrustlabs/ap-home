'use client';
// /you?run=<runRef> — spec 397 §6. A run parked for THIS person's signature (asked through an assistant such as Claude
// via the Home MCP) is finished HERE, where the pen is: the page opens the Ask on that run, and the flyout does what it
// always does for an unfinished ask — shows the requirement and the preview, and the person signs. The assistant never
// held a signature; it held a link to this page.
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { SectionShell } from '../../../src/components/portal/SectionShell';

export default function YouPage() {
  const params = useSearchParams();
  const run = params?.get('run') ?? '';
  // The shell reads `?run=` itself and opens the Ask on it (a direct link mounts this page before the shell's event
  // listener exists); this page only says what is happening.
  useEffect(() => { /* nothing to dispatch — see PortalShell */ }, [run]);
  return (
    <SectionShell title="An assistant asked" description={run ? 'A run asked through an assistant you connected (Claude, say) is waiting on you. It opens here in the Ask; what it needs is said there, and only you can give it.' : 'Nothing is waiting: open this page from the link the assistant gave you.'}>
      {run ? <p className="muted" style={{ fontSize: '.85rem' }}>Run <code>{run}</code> — if the Ask did not open, press Ask in the top bar; the run is listed under your unfinished asks.</p> : null}
    </SectionShell>
  );
}
