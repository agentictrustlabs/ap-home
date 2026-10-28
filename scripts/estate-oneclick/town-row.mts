// THE ESTATE'S ROW IN THE TOWN — ap-town's publish-an-estate runbook §1–§2, as text.
//
// The town manifest (`towns/faithchain/town.yaml`) is commented prose as much as data, so the row is INSERTED as text
// at the end of the `estates:` list rather than round-tripped through a YAML library that would drop every comment
// in the file. The test runs ap-town's own `parseTown` over the result, so the town's validator — not ours — says
// whether it is a valid row.
//
// An estate on default hosts is on the town's own Cloudflare account, and a Worker cannot fetch a same-account
// workers.dev host (it gets a 404 page). So every host a town Worker must reach is declared as a LANE: the edge (the
// public lane) and the runtime (the heartbeat). `pnpm gen:town` turns the lanes into service bindings.

import type { Hosts } from './declaration.mts';

export interface TownRowInput {
  id: string;
  name: string;
  homeOrigin: string;
  hosts: Hosts;
  workers: { runtime: string; vault: string; edge: string; homeMcp: string; approval: string };
  vercelProject: string;
  /** `<label>.estate` — set once the town has registered it. */
  estateName?: string;
  repo?: string;
  nameRoots?: string[];
  /** On the town's own Cloudflare account (default). An estate on its OWNER's account gets no lanes: a service binding
   *  cannot cross accounts, and it needs none — the town reaches a foreign workers.dev host over the internet. */
  sameAccount?: boolean;
  /** The town's display name, for the comment. */
  townName?: string;
}

/** The name roots every estate on faithchain names agents under (the town's own list). */
export const DEFAULT_NAME_ROOTS = ['me', 'org', 'team', 'svc', 'workspace', 'treasury', 'registry', 'church', 'circle'];

const q = (s: string) => JSON.stringify(s);

export function townRow(r: TownRowInput): string {
  const host = (u: string) => new URL(u).host;
  const same = r.sameAccount !== false;
  const lines = [
    `  # ${JSON.stringify(r.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '))} — created with the one-click builder${r.townName ? ` (${r.townName})` : ''}.`,
    ...(same
      ? ['  # On the town\'s accounts, on default hosts: no zone of its own, so its agents are reached through its edge by',
        '  # name, and the town reaches its edge and runtime through the lanes below.']
      : ['  # On its OWNER\'s own accounts, on default hosts: no lanes (a binding cannot cross accounts); the town reaches',
        '  # its edge and runtime over the internet.']),
    `  - id: ${r.id}`,
    `    repo: ${r.repo ?? 'agentictrustlabs/ap-home'}`,
    `    home: ${r.homeOrigin}`,
    `    edge: ${r.hosts.edge}`,
    `    a2a: ${r.hosts.runtime}`,
    ...(same ? ['    lanes:', `      ${q(host(r.hosts.edge))}: ${r.workers.edge}`, `      ${q(host(r.hosts.runtime))}: ${r.workers.runtime}`] : []),
    `    nameRoots: [${(r.nameRoots ?? DEFAULT_NAME_ROOTS).join(', ')}]`,
    ...(r.estateName ? [`    estateName: ${r.estateName}`] : []),
    `    kms: { tenant: ${r.id} }`,
    `    workers: [${[r.workers.runtime, r.workers.vault, r.workers.edge, r.workers.homeMcp, r.workers.approval].join(', ')}]`,
    `    vercelProjects: [${r.vercelProject}]`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Insert a row at the end of `estates:` — just before the next top-level key. Refuses a second row for the same id,
 * and a file with no `estates:` list (there is nothing to add to).
 */
export function addEstateRow(townYaml: string, row: string, id: string): string {
  const lines = townYaml.split('\n');
  const start = lines.findIndex((l) => /^estates:\s*$/.test(l));
  if (start < 0) throw new Error('the town manifest has no `estates:` list');
  if (lines.some((l) => new RegExp(`^  - id: ${id}\\s*$`).test(l))) throw new Error(`the town already lists an estate "${id}"`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) { end = i; break; }
  }
  // Step back over the comment block that introduces the next key, so the row sits with the estates.
  let at = end;
  while (at > start + 1 && /^(#|\s*$)/.test(lines[at - 1]) && !/^\s{2,}#/.test(lines[at - 1])) at -= 1;
  while (at > start + 1 && /^\s*$/.test(lines[at - 1])) at -= 1;
  return [...lines.slice(0, at), '', ...row.replace(/\n$/, '').split('\n'), ...lines.slice(at)].join('\n');
}
