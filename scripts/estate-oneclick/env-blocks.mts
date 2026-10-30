// STAMP THE FOUR WORKERS' [env.<id>] BLOCKS — from the town's first estate, renamed.
//
// The runbook's §3 says "copy faithnet's block; rename every Worker, D1 database, KV namespace and queue". This is
// that sentence as code, so the hundredth estate's blocks are the second estate's blocks and not a fresh copy-paste
// (spec 441 §1). It reads faithnet's `[env.faithnet*]` sections from each wrangler.toml and writes `[env.<id>*]`:
//
//   · Worker names           <id>-runtime · <id>-vault · <id>-edge · <id>-home-mcp · <id>-approval
//   · storage it must own    D1 / KV ids become placeholders the `cloud-resources` step fills from `wrangler … create`;
//                            queue names get the estate's id; rate-limit namespaces get numbers of their own
//   · hosts                  every faithnet ESTATE host in a value is mapped to this estate's; a value still naming
//                            faithnet's own Home, agent zone or apps after that is DROPPED and reported, never kept
//   · routes, send_email     dropped: an estate on default hosts has no custom domains and no mail rail of its own
//   · vars                   the runtime's are written by estate-new's own rule — DERIVED + POSTURE + the town's
//                            baseline from the sibling, minus the sibling's declared extras — and the other three
//                            Workers' by the same rule plus their few host vars
//
// Bindings to TOWN Workers (the discovery MCP, the skills MCP) are kept as they are: they are the town's, on the same
// account, and impact-agent bound them the same way.
//
// Pure text in, text out. The `cloud-resources` step and the deploy run against what this writes.

import { createHash } from 'node:crypto';
import { POSTURE, isTownBaseline, readDeclarations, wranglerVars } from '../estate-shape.mts';
import { loadTown, type TownProfile } from './town.mts';

export type App = 'runtime' | 'vault' | 'edge' | 'homeMcp';

export const TOML_PATHS: Record<App, string> = {
  runtime: 'apps/agent-runtime/wrangler.toml',
  vault: 'apps/vault/wrangler.toml',
  edge: 'apps/edge/wrangler.toml',
  homeMcp: 'apps/home-mcp/wrangler.toml',
};

/** The sibling estate copied from — its Worker names, its own hosts, what is its alone — from the town profile. */
type Sibling = TownProfile['sibling'];
const siblingOf = (input: StampInput): Sibling => input.sibling ?? loadTown().sibling;

export interface EstateNames { runtime: string; vault: string; edge: string; homeMcp: string; approval: string }

export interface StampInput {
  id: string;
  app: App;
  names: EstateNames;
  hosts: { runtime: string; vault: string; edge: string; homeMcp: string };
  homeOrigin: string;
  /** deriveVars(declaration) — the runtime's derived settings. */
  derived: Record<string, string>;
  /** The sibling's declared extras (faithnet.estate.json `extras`): its product choices, never copied. */
  siblingExtras: string[];
  /** The env to copy from. */
  from?: string;
  /** Runtime vars every existing estate carries (shape-level, though the shape does not name them yet). */
  commonRuntimeKeys?: string[];
  /** The new estate's own declared extras — written into the runtime, where check:estate-shape looks for them. */
  extras?: Record<string, string>;
  /** The sibling to copy from (default: the town profile's). */
  sibling?: Sibling;
  /**
   * On a DIFFERENT Cloudflare account from the town (the owner's own). A service binding reaches only Workers on the
   * same account, so every binding to a town Worker is dropped; the estate binds only its own Workers.
   */
  crossAccount?: boolean;
}

export interface StampResult { block: string; dropped: string[]; placeholders: string[] }

interface Section { header: string; name: string; double: boolean; body: string[] }

const HEADER = /^(\[\[?)([A-Za-z0-9_.\-"]+)(\]\]?)\s*(#.*)?$/;

/** Split a wrangler.toml into its sections. Lines before the first header are section "" (the top). */
export function sections(toml: string): Section[] {
  const out: Section[] = [{ header: '', name: '', double: false, body: [] }];
  for (const line of toml.split('\n')) {
    const m = HEADER.exec(line);
    if (m && m[1].length === m[3].length) out.push({ header: line, name: m[2], double: m[1] === '[[', body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out;
}

const tomlValue = (v: string): string => (v.includes('"') ? `'${v}'` : `"${v}"`);

/** A small number of its own for a rate-limit namespace — deterministic, so re-running writes the same one. */
export function namespaceIdFor(id: string, name: string): string {
  const n = parseInt(createHash('sha256').update(`${id}:${name}`).digest('hex').slice(0, 8), 16);
  return String(20000 + (n % 70000));
}

function parseVars(body: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of body) {
    const m = /^([A-Z_0-9]+)\s*=\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const raw = m[2].replace(/\s+#.*$/, '').trim();
    out.push([m[1], /^(".*"|'.*')$/.test(raw) ? raw.slice(1, -1) : raw]);
  }
  return out;
}

function mapHosts(value: string, input: StampInput): string {
  const sib = siblingOf(input);
  const target = (job: string) => (job === 'home' ? input.homeOrigin : input.hosts[job as keyof StampInput['hosts']]);
  let v = value;
  for (const [from, job] of Object.entries(sib.hostMap)) v = v.split(from).join(target(job));
  // A bare sibling estate host, not one that merely ends the same way (`discovery-a2a.faithnet.io` is the town's).
  for (const h of sib.estateHosts) v = v.replace(new RegExp(`(?<![\\w.-])${h.replace(/\./g, '\\.')}(?![\\w-])`, 'g'), '__FAITHNET_ESTATE_HOST__');
  return v;
}

/** The settings a Worker gets whatever faithnet's block says, because they are about WHERE this estate is. */
function overridesFor(input: StampInput): Record<string, string> {
  const { app, hosts, derived, homeOrigin, id } = input;
  if (app === 'runtime') {
    return { ...derived, ...Object.fromEntries(Object.entries(POSTURE).map(([k, v]) => [k, v.value])), ...(input.extras ?? {}) };
  }
  if (app === 'vault') {
    return {
      AKCS_TENANT_ID: derived.AKCS_TENANT_ID ?? id,
      AKCS_ACCEPTED_PROTECTION_LEVELS: POSTURE.AKCS_ACCEPTED_PROTECTION_LEVELS.value,
      MCP_AUDIENCE: 'urn:mcp:server:person',
      ESTATE_ID: id,
    };
  }
  if (app === 'edge') return { EDGE_ALLOWED_ORIGINS: derived.ALLOWED_ORIGINS };
  return {
    HOME_ORIGIN: homeOrigin,
    BROKER_JWKS_URL: `${homeOrigin}/jwks`,
    A2A_ORIGIN: hosts.runtime,
    // AGENT_HOST_PATTERN is deliberately NOT set. Without a wildcard zone there are no per-agent card hosts
    // (runbook §0), and the edge serves a card only at its root (`/.well-known/agent-card.json`), so no
    // `<edge>/…/{label}` form works. Unset, home-mcp's public-shelf tool and agent-card resource say so plainly;
    // faithnet's `{label}.faithnet.ai` value is dropped by the faithnet-only rule. Set it when the estate gets a zone.
  };
}

/** Never copied from the sibling: they are this estate's own and are written by a later step. */
const LATER = new Set(['AKCS_RELAY_KEY_ID', 'AKCS_INTERACTIONS_KEY_ID', 'HARNESS_AGENT_SA', 'INTERACTIONS_SERVICE_SA']);

function stampVars(body: string[], input: StampInput, dropped: string[]): string[] {
  const overrides = overridesFor(input);
  const kept: Array<[string, string]> = [];
  for (const [k, v] of parseVars(body)) {
    if (k in overrides || LATER.has(k)) continue;
    if (input.siblingExtras.includes(k)) { dropped.push(`${k} — faithnet's product choice (an extra)`); continue; }
    // The runtime is what check:estate-shape reads, and it flags anything it cannot classify. So the runtime takes
    // only what is the TOWN's (the baseline) or what EVERY estate carries; the sibling's other settings stay its own.
    if (input.app === 'runtime' && !isTownBaseline(k) && !(input.commonRuntimeKeys ?? []).includes(k) && !k.startsWith('AKCS_BASE')) {
      dropped.push(`${k} — faithnet's alone (neither the town's baseline nor carried by every estate)`);
      continue;
    }
    const mapped = mapHosts(v, input);
    if (mapped.includes('__FAITHNET_ESTATE_HOST__') || new RegExp(siblingOf(input).onlyPattern).test(mapped)) {
      dropped.push(`${k} — names faithnet's own hosts`);
      continue;
    }
    kept.push([k, mapped]);
  }
  const lines = [...Object.entries(overrides), ...kept].map(([k, v]) => `${k} = ${tomlValue(v)}`);
  return [...lines, ''];
}

function renameWorkers(line: string, names: EstateNames, sib: Sibling): string {
  let out = line;
  for (const [from, job] of Object.entries(sib.workers)) out = out.split(`"${from}"`).join(`"${names[job]}"`);
  return out;
}

/**
 * The `[env.<id>*]` sections for one app's wrangler.toml, copied from `[env.<from>*]`.
 * Throws when the source env is absent: there is nothing honest to stamp from.
 */
export function stampEnvBlock(toml: string, input: StampInput): StampResult {
  const sib = siblingOf(input);
  const from = input.from ?? sib.env;
  const dropped: string[] = [];
  const placeholders: string[] = [];
  const own = sections(toml).filter((s) => s.name === `env.${from}` || s.name.startsWith(`env.${from}.`));
  if (!own.length) throw new Error(`no [env.${from}] in ${TOML_PATHS[input.app]} to stamp from`);
  if (sections(toml).some((s) => s.name === `env.${input.id}`)) throw new Error(`${TOML_PATHS[input.app]} already has [env.${input.id}]`);

  // Containers and cron are faithnet's choices, not the estate's shape: impact-agent has neither, and the runtime
  // runs without them (RUNTIME / PROVER are optional bindings). Their Durable Object bindings go with them; the
  // migrations are top-level and shared, so they stay. Decided with Ryan 2026-10-27.
  const containerClasses = new Set(own.filter((s) => s.name === `env.${from}.containers`)
    .map((s) => /class_name\s*=\s*"([^"]+)"/.exec(s.body.join('\n'))?.[1]).filter(Boolean) as string[]);

  let routes = 0;
  const out: string[] = [
    `# ── ${input.id} (spec 441) — stamped by scripts/estate-oneclick from [env.${from}]. Worker names, storage ids and`,
    '# hosts are this estate\'s own; the town baseline is the sibling\'s. Do not hand-edit the derived vars.',
  ];
  for (const s of own) {
    const suffix = s.name.slice(`env.${from}`.length); // '' | '.vars' | '.routes' | …
    const header = s.header.replace(`env.${from}`, `env.${input.id}`);
    const body = s.body.filter((l) => !/^\s*#/.test(l)); // the sibling's commentary is about the sibling

    if (suffix === '.routes') { routes += 1; continue; }
    if (suffix === '.send_email') { dropped.push(`[${s.name}] — mail rail (no zone of its own)`); continue; }
    if (suffix === '.containers') { dropped.push(`[${s.name}] — container (faithnet's choice; costs money, needs an image)`); continue; }
    if (suffix === '.triggers') { dropped.push(`[${s.name}] — cron (faithnet's cache warmer)`); continue; }

    if (suffix === '.vars') { out.push(header, ...stampVars(body, input, dropped)); continue; }

    let lines = body.map((l) => renameWorkers(l, input.names, sib));
    if (suffix === '.durable_objects' && containerClasses.size) {
      lines = lines.filter((l) => {
        const cls = /class_name\s*=\s*"([^"]+)"/.exec(l)?.[1];
        if (cls && containerClasses.has(cls)) { dropped.push(`${cls} binding — its container is not copied`); return false; }
        return true;
      });
    }
    if (suffix === '') {
      const jobName = input.app === 'homeMcp' ? input.names.homeMcp : input.names[input.app];
      lines = lines.filter((l) => !/^\s*(name|workers_dev|routes|route)\s*=/.test(l));
      lines.unshift(`name = "${jobName}"`, 'workers_dev = true');
    }
    if (suffix === '.d1_databases') {
      const binding = /binding\s*=\s*"([^"]+)"/.exec(body.join('\n'))?.[1] ?? 'DB';
      const ph = `__D1_${binding}__`;
      placeholders.push(ph);
      lines = lines.map((l) => l
        .replace(/^(\s*database_name\s*=\s*)".*"/, `$1"${input.id}-${binding.toLowerCase().replace(/_/g, '-')}"`)
        .replace(/^(\s*database_id\s*=\s*)".*"/, `$1"${ph}"`));
    }
    if (suffix === '.kv_namespaces') {
      const binding = /binding\s*=\s*"([^"]+)"/.exec(body.join('\n'))?.[1] ?? 'KV';
      const ph = `__KV_${binding}__`;
      placeholders.push(ph);
      lines = lines.filter((l) => !/^\s*preview_id\s*=/.test(l)).map((l) => l.replace(/^(\s*id\s*=\s*)".*"/, `$1"${ph}"`));
    }
    if (suffix.startsWith('.queues')) {
      lines = lines.map((l) => l.replace(/^(\s*queue\s*=\s*)"([^"]*?)-?faithnet"/, `$1"$2-${input.id}"`));
    }
    if (suffix === '.ratelimits' || suffix === '.unsafe.bindings') {
      const name = /name\s*=\s*"([^"]+)"/.exec(body.join('\n'))?.[1] ?? 'LIMIT';
      lines = lines.map((l) => l.replace(/^(\s*namespace_id\s*=\s*)"\d+"/, `$1"${namespaceIdFor(input.id, name)}"`));
    }
    if (suffix === '.services') {
      const svc = /service\s*=\s*"([^"]+)"/.exec(lines.join('\n'))?.[1] ?? '';
      if (new RegExp(sib.ownWorkerPattern).test(svc) && !new RegExp(sib.townWorkerPattern).test(svc)) {
        dropped.push(`[${s.name}] binding to ${svc} — ${sib.env}'s own Worker`);
        continue;
      }
      if (input.crossAccount && !Object.values(input.names).includes(svc)) {
        dropped.push(`[${s.name}] binding to ${svc} — a town Worker, on another Cloudflare account`);
        continue;
      }
    }
    out.push(header, ...lines);
  }
  if (routes) dropped.push(`${routes} custom-domain route(s) — this estate is on default hosts`);
  const block = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  const ownPat = sib.ownWorkerPattern;
  if (new RegExp(`"[^"]*${ownPat}[^"]*"`).test(block.replace(new RegExp(sib.townMentions, 'g'), ''))) {
    const left = [...block.matchAll(new RegExp(`^[^#\\n]*${ownPat}.*$`, 'gm'))].map((m) => m[0].trim())
      .filter((l) => !new RegExp(sib.townMentions).test(l));
    if (left.length) dropped.push(...left.map((l) => `REVIEW: still mentions faithnet → ${l}`));
  }
  return { block, dropped, placeholders };
}

/** Append a stamped block to the end of a wrangler.toml. */
export function appendBlock(toml: string, block: string): string {
  return `${toml.replace(/\s*$/, '')}\n\n${block}`;
}

/** Fill the `__D1_X__` / `__KV_X__` placeholders once the resources exist. */
export function fillPlaceholders(toml: string, ids: Record<string, string>): string {
  let out = toml;
  for (const [ph, value] of Object.entries(ids)) out = out.split(ph).join(value);
  const left = /__(D1|KV)_[A-Z_0-9]+__/.exec(out);
  if (left) throw new Error(`placeholder ${left[0]} was not filled`);
  return out;
}

/** Runtime vars EVERY declared estate carries — shape-level in practice. Run from the ap-home root. */
export function commonRuntimeKeys(): string[] {
  const sets = readDeclarations().map((d) => new Set(Object.keys(wranglerVars(TOML_PATHS.runtime, d.id))));
  if (!sets.length) return [];
  return [...sets[0]].filter((k) => sets.every((s) => s.has(k)));
}
