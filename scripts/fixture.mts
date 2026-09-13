/**
 * THE GATE FIXTURE — the roster a live gate runs against, as DATA (spec 392 / spec 399 §5.5).
 *
 * Every verify script proves a property of the runtime ("a canceled run is kept and marked canceled — never failed");
 * none of them is about alice. But 65 of 72 were written with Faithnet's roster in their text, so the ap-home estate —
 * mara, theo, priya, jonas, naomi, samuel, no Missio Nexus — could never run them green. This module is the one place
 * a gate reads WHO plays each role; the roles are the gate's vocabulary and the names are the deployment's.
 *
 *   import { fixture as fx, HOME, skipUnless } from './fixture.mts';
 *   const si = await signIn(fx.people.steward);   // 'alice' on Faithnet, 'mara' on the estate
 *
 * Resolution, in order: Faithnet's defaults (below) ← `FIXTURE_JSON` (a path to a JSON file with the same shape; the
 * ledger's `fixture` names it and the runner exports it) ← the environment knobs the scripts already honoured
 * (`HOME_URL`, `A2A_URL`, `HOME_MCP_URL`, `HANDLE`). A role a deployment does not hold is `null` in its file, and a gate
 * that needs it says `⊘ skipped: …` and exits 0 — the runner shows it WAITING, never green (`skipUnless`).
 *
 * The fixture names agents; it holds no key and grants nothing — the demo personas sign through the Home's own
 * persona-sign, exactly as the gates always did.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface GateFixtureV1 {
  /** The Home the gates run against (HOME_URL). */
  home: string;
  /** The agent runtime (A2A_URL) and the Home MCP (HOME_MCP_URL) of the same deployment. */
  a2a: string;
  homeMcp: string;
  /** The vault's resource-server id every grant the Home issues names (`VAULT_SERVER_ID`). */
  vaultServerId: string;
  people: {
    /** The asker in most gates: stewards `org`, custodies `treasuries.own`. */
    steward: string;
    /** A member of `org` who is not its steward. */
    member: string;
    /** A second member — the approver in the decision gates. */
    member2: string;
    /** Someone with NO standing at `org`. */
    outsider: string;
    /** The person whose treasury is `treasuries.payee` (their sign-in revokes the grant in verify-grant-revocation). */
    payeeOwner: string;
    /** Someone the steward may invite to `org` through the one-prompt path — their typed name is `<handle>.me`. */
    invitee: string;
  };
  /** The organization the steward stewards; `agent` is optional — resolved from the steward's own links by name. */
  org: { name: string; handle: string; agent?: string };
  /** Where the steward asks for a team to be chartered (a workspace or organization they steward) — the run gates' addressee. */
  workspace: { handle: string; agent?: string };
  /** A SECOND organization the steward stewards, for the routed (hop) gates. */
  peerOrg: { handle: string; agent?: string } | null;
  treasuries: {
    /** The steward's own treasury (the payer in a standing instruction) and another of theirs (the spoken twin). */
    own: string;
    ownOther: string;
    /** A treasury custodied by `people.payeeOwner` — the payee in every parked payment. */
    payee: string;
  };
  /** A service agent the steward's playbook hands payments to (the handoff gates). */
  specialist: { handle: string; agent?: string } | null;
  /** A ministry in the PUBLIC registry with a content-catalog playbook (the Home-MCP discovery gates). */
  ministry: { name: string; svc: string; org: string } | null;
  /** A team the steward stewards (under `org`), for the one-prompt invitation gate. */
  team: { handle: string; agent?: string } | null;
  /** A second team under `org` whose name shares a word with `team`'s — so the word names two agents, neither the room. */
  team2: { handle: string; agent?: string } | null;
  /** Words TWO of the steward's org-class agents answer to (neither the room) — the confirmation-memory gates need a "which one?". */
  ambiguousWords: string[];
  /** An agent the steward stewards whose playbook declares a SCHEDULE row (the routine gates pause and resume it). */
  routineAgent: { handle: string; playbook: string } | null;
  /** The skills registry the playbooks are read from (the `~/skills` deployment). */
  skillsRegistry: string;
  /** An outside ACP runtime as a member (spec 400 W1): its `.svc` (chartered by the steward) and the workspace it joined. */
  acpRuntime: { member: string; workspace: string } | null;
  /** The deployment's hosts the runtime member speaks to: the standard surface (edge) and the runtime. */
  edge: string;
  /** Names that resolve NOWHERE — the twins that must be refused by name. */
  absent: { org: string; svc: string };
}

export const FAITHNET_FIXTURE: GateFixtureV1 = {
  home: 'https://www.faithnet.me',
  a2a: 'https://a2a.faithnet.io',
  homeMcp: 'https://home-mcp-faithnet.richardpedersen3.workers.dev',
  vaultServerId: 'demo-mcp',
  people: { steward: 'alice', member: 'bob', member2: 'carol', outsider: 'dave', payeeOwner: 'nathan', invitee: 'david' },
  org: { name: 'Missio Nexus', handle: 'missio-nexus.org', agent: '0x3b99f2b452766de5df0dbcdfc676f27257151333' },
  workspace: { handle: 'alicefield.impact', agent: '0xee11DFB02e4a02630bE512886305DF5C68Fd682c' },
  peerOrg: { handle: 'globalchurch.org' },
  treasuries: { own: 'alice3.treasury', ownOther: 'alice2.treasury', payee: 'nathan.treasury' },
  specialist: { handle: 'runtime-c3s0.svc', agent: '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' },
  ministry: { name: 'Ligonier', svc: 'ligonier.svc', org: 'ligonier.org' },
  team: { handle: 'rich-big-thompson-team.org', agent: '0xfC1C328c26505d1AEAb1EAd4a46b3F74981F07a4' },
  team2: { handle: 'big-thompson-team.org', agent: '0x0daC3e3C83486D334627fbA18fD0Fe730139eC' },
  ambiguousWords: ['thompson', 'rich', 'somali corridor team', 'xyz', 'voice test'],
  routineAgent: { handle: 'playwright-demo-team.impact', playbook: 'agentic-trust/coordinator' },
  skillsRegistry: 'https://skills-a2a-production.richardpedersen3.workers.dev',
  acpRuntime: { member: 'goose-1.svc', workspace: 'missio-nexus.org' },
  edge: 'https://edge.faithnet.io',
  absent: { org: 'nobody-here-zz.org', svc: 'nobody-here-zz.svc' },
};

/** The file's blocks REPLACE the defaults — an organization named without an address must not inherit Faithnet's
 *  address; the string maps (`people`, `treasuries`, `absent`) merge per key so a file may name only what differs. */
const PER_KEY = new Set(['people', 'treasuries', 'absent']);
function merge(base: GateFixtureV1, over: Record<string, unknown>): GateFixtureV1 {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue;
    out[k] = PER_KEY.has(k) && v && typeof v === 'object' ? { ...(base as unknown as Record<string, Record<string, string>>)[k], ...(v as Record<string, string>) } : v;
  }
  return out as unknown as GateFixtureV1;
}

function load(): GateFixtureV1 {
  let fx = FAITHNET_FIXTURE;
  const path = process.env.FIXTURE_JSON;
  if (path) {
    if (!existsSync(path)) { console.error(`✗ FIXTURE_JSON names ${path}, which does not exist`); process.exit(1); }
    fx = merge(fx, JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
  }
  // the knobs the scripts always honoured, above the file
  if (process.env.HOME_URL) fx = { ...fx, home: process.env.HOME_URL };
  if (process.env.A2A_URL) fx = { ...fx, a2a: process.env.A2A_URL };
  if (process.env.HOME_MCP_URL) fx = { ...fx, homeMcp: process.env.HOME_MCP_URL };
  if (process.env.HANDLE) fx = { ...fx, people: { ...fx.people, steward: process.env.HANDLE } };
  return fx;
}

export const fixture: GateFixtureV1 = load();
export const HOME = fixture.home;
export const A2A = fixture.a2a;
export const HOME_MCP = fixture.homeMcp;

/** A regexp that matches the organization by its first word (`/missio/i`), or any of the members' handles. */
export const orgWord = (): RegExp => new RegExp(fixture.org.name.split(/\s+/)[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
export const memberWord = (): RegExp => new RegExp([fixture.people.member, fixture.people.member2, fixture.people.payeeOwner, 'member'].join('|'), 'i');

/** A gate that needs a role this deployment does not hold says so and exits 0 — SKIPPED, its own status, never a pass. */
export function skipUnless<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) { console.log(`⊘ skipped: the fixture holds no ${what} (${process.env.FIXTURE_JSON ?? 'Faithnet defaults'})`); process.exit(0); }
  return value;
}

/** The organization's address: the fixture's, or the one the steward's own links give that name. */
export async function resolveOrgAgent(token: string, org: { name?: string; handle?: string; agent?: string } = fixture.org): Promise<string> {
  if (org.agent) return org.agent.toLowerCase();
  const r = await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${token}` } });
  const orgs = ((await r.json()) as { orgs?: Array<{ orgAgent: string; orgName?: string }> }).orgs ?? [];
  // a link's orgName is the display name when the organization has one, else its typed name
  const hit = orgs.find((o) => [org.name, org.handle].some((n) => n && (o.orgName ?? '').toLowerCase() === n.toLowerCase()));
  if (!hit) { console.error(`✗ ${org.name ?? org.handle} is not among the steward's organizations at ${HOME}`); process.exit(1); }
  return hit.orgAgent.toLowerCase();
}
