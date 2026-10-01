'use client';
// Developer tools → Overview (owner, 2026-10-01: "totally redo that page to break it up with left menu and support
// evals and other stuff"). One row per page in the pane, in words a person can read: what the page is for and what
// it will show. The kit's entrances are links to things that exist; nothing here is a promise.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { CodeIcon, GlobeIcon, DatabaseIcon, BotIcon, ShieldIcon, LinkIcon } from '../../../src/components/shared/Icons';
import { List, Row } from '../../../src/ui';
import { Panel } from '../../../src/ui/panel';

export default function DeveloperOverviewPage() {
  return (
    <SectionShell title="Developer tools" description="For the person building on this Home: the apps you register, the evals that say what the agent actually did, and the kit a coding agent starts from.">
      <Panel title="What is here" icon={<CodeIcon size={18} />} state="ready" testId="developer-overview">
        <List>
          <Row href="/developer/apps" title="Your apps" meta="Register an app you are building so it can send people to this Home to sign in. Each registration is yours to edit or remove." side={<GlobeIcon size={16} />} />
          <Row href="/developer/evals" title="Skill selection" meta="Did the agent choose the right skill for what people asked? Per intent: expected versus chosen, per skill: the results, and comparisons between playbooks." side={<DatabaseIcon size={16} />} />
          <Row href="/developer/evals/acts" title="Acts" meta="Did the Home reach the act that was asked for, under the domain's principles? Every Ask and every button as a case, judged on the act reached." side={<BotIcon size={16} />} />
          <Row href="/developer/evals/techniques" title="Techniques" meta="The technique ledger: a default changes only on a paired, pre-registered comparison with no regression on the panel." side={<DatabaseIcon size={16} />} />
          <Row href="/developer/evals/gates" title="Live gates" meta="What the nightly live gates said, night by night — each one a script against the running estate, with its twin that must fail." side={<ShieldIcon size={16} />} />
          <Row href="/developer/evals/run" title="Run a comparison" meta="Start a comparison from here: pick an organization you steward, upload a replay set and its gold, build the arms, watch it run, read the scores." side={<CodeIcon size={16} />} />
        </List>
      </Panel>
      <Panel title="The kit" icon={<LinkIcon size={18} />} state="ready">
        <List>
          <Row href="/llms.txt" title="/llms.txt" meta="The coding agent's entrance to this estate: what it is, which packages, how to ask the agent, how to add a capability." side={<LinkIcon size={16} />} />
          <Row href="/registry" title="Component registry" meta="Installable components with their contracts. Installing a component never installs authority." side={<LinkIcon size={16} />} />
        </List>
        <div className="ui-panel-body">
          <p style={{ margin: 0 }}><b>From a clean machine:</b> <code>npx @agenticprimitives/create-app</code> generates a starter, <code>ap doctor</code> checks it, and the two reference acts run live against this Home. The Developer MCP (<code>ap mcp</code>) answers package and ontology questions from the install.</p>
        </div>
      </Panel>
    </SectionShell>
  );
}
