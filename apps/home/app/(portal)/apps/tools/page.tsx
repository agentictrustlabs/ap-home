'use client';
// Connected → Tools (spec 404 / 422 §8). Tool servers she attached: each tool becomes something her agent can do.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { McpConnectorsCard } from '../../../../src/components/portal/McpConnectorsCard';
import { Note } from '../../../../src/ui';

export default function ConnectedToolsPage() {
  return (
    <SectionShell title="Tools" description="Tool servers you attached — each tool becomes something your agent can do for you.">
      <Note>A tool that only <b>reads</b> (a search, a lookup) your agent uses on its own, under your standing. A tool that <b>changes</b> something waits for your signature every time, like any act. The credential a server needs stays with your agent's runtime and is never shown again; what a server returns is treated as information, never as instructions. (These are MCP servers, if you know the term.)</Note>
      <McpConnectorsCard />
    </SectionShell>
  );
}
