// THE ONE-CLICK ESTATE'S DECLARATION — spec 441's five inputs, chosen for a developer who pressed one button.
//
// The builder (`scripts/estate-new.mts`) asks a human for five inputs. The button asks for one — a name — and
// derives the other four the same way every time, on the platforms' free default hosts so nobody has to buy or
// point a domain before they have an estate:
//
//   id          from the name: lowercase letters, digits, hyphens (the builder's own rule)
//   homeHost    <id>-home.vercel.app, or whatever Vercel actually assigned the project (step `home-address`)
//   zone        the runtime's own workers.dev host, which is where its agents answer (impact-agent's precedent:
//               its altZones carried `imb-runtime.<sub>.workers.dev` for the same reason)
//   town        faithchain — faithnet.town
//   kmsTenant   the id: one tenant per estate, always
//
// plus `hosts`, which tells `deriveVars` where each Worker answers when the estate has no zone of its own to
// put `mcp.` and `edge.` under (see estate-shape.patch).
//
// THE ONE INPUT THAT CANNOT CHANGE LATER is homeHost: it is the rpId every resident's passkey is bound to. An
// estate that later moves its Home to its own domain moves its residents' passkeys with it, which means each of
// them enrolls again. The site says so before the button is pressed.

export const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** The ids that are never an estate's: the town's own words, and the two estates that already exist. */
export const RESERVED_IDS = new Set([
  'faithnet', 'impact-agent', 'imbnet', 'faithchain', 'hopenet', 'hopechain', 'town', 'estate', 'home', 'admin',
  'operator', 'naming', 'registry', 'discovery', 'skills', 'inference', 'rpc', 'kms', 'akcs', 'federation',
]);

/** One line of plain text: the name ends up in YAML, TOML and JSON, so no control characters or line breaks. */
export const cleanName = (s: string): string => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** "Grace Chapel Network" → "grace-chapel-network". Throws when nothing usable is left. */
export function idFromName(name: string): string {
  const id = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[0-9-]+/, '')
    .slice(0, 31)
    .replace(/-+$/, '');
  if (!ID_RE.test(id)) throw new Error(`"${name}" does not make a usable estate id — use letters, and start with one`);
  return id;
}

export interface OneClickInputs {
  /** What people call it: "Grace Chapel Network". */
  name: string;
  /** The short name the person chose (derived from the name when absent). It is also their `<id>.estate`. */
  id?: string;
  /** The Smart Agent that asked for it (the id_token `sub`), lowercased. Recorded, never trusted for authority. */
  requestedBy: string;
  /** The workers.dev subdomain of the town's Cloudflare account, e.g. `richardpedersen3`. */
  workersSubdomain: string;
  /** The Home's host once Vercel has assigned it; defaults to the name we ask Vercel for. */
  homeHost?: string;
  town?: string;
  /** The site that asked for it (the town profile's), recorded in the declaration. */
  createdBy?: string;
}

export interface Hosts { runtime: string; vault: string; edge: string; homeMcp: string }

/** Worker names: `<id>-<job>`, never another estate's (they are storage — DO and KV bind to a Worker's name). */
export function workerNames(id: string) {
  return {
    runtime: `${id}-runtime`,
    vault: `${id}-vault`,
    edge: `${id}-edge`,
    homeMcp: `${id}-home-mcp`,
    approval: `${id}-approval`,
    home: `${id}-home`, // the Vercel project
  };
}

export function defaultHosts(id: string, workersSubdomain: string): Hosts {
  const w = workerNames(id);
  const at = (worker: string) => `https://${worker}.${workersSubdomain}.workers.dev`;
  return { runtime: at(w.runtime), vault: at(w.vault), edge: at(w.edge), homeMcp: at(w.homeMcp) };
}

export function buildDeclaration(input: OneClickInputs) {
  const id = input.id ?? idFromName(input.name);
  if (!ID_RE.test(id)) throw new Error(`the id ${id} must be 2–31 lowercase letters, digits and hyphens, starting with a letter`);
  if (RESERVED_IDS.has(id)) throw new Error(`"${id}" is reserved — choose another name`);
  if (!/^[a-z0-9-]{1,63}$/.test(input.workersSubdomain)) throw new Error('workersSubdomain must be the account\'s workers.dev subdomain');
  if (!/^0x[0-9a-f]{40}$/.test(input.requestedBy)) throw new Error('requestedBy must be a lowercased Smart Agent address');
  const hosts = defaultHosts(id, input.workersSubdomain);
  const homeHost = input.homeHost ?? `${workerNames(id).home}.vercel.app`;
  return {
    _: 'spec 441 — THE ESTATE\'S DECLARATION, written by the one-click builder (scripts/estate-oneclick). Its five inputs were derived from one: the name. Everything else is DERIVED (scripts/estate-shape.mts) or the town\'s.',
    id,
    name: cleanName(input.name),
    homeHost,
    _homeHost: 'The rpId of every resident\'s passkey. It cannot change later without every resident enrolling again.',
    zone: new URL(hosts.runtime).host,
    _zone: 'No zone of its own: the runtime\'s workers.dev host is where its agents answer, so it is the zone (impact-agent\'s altZones precedent).',
    town: input.town ?? 'faithchain',
    kmsTenant: id,
    estateName: `${id}.estate`,
    _estateName: 'The agent that IS this estate on faithchain, as faithnet.estate is faithnet\'s. Chosen by the person who asked for it.',
    hosts,
    _hosts: 'Where each Worker answers when there is no zone to put mcp./edge. under. deriveVars reads these (estate-shape.patch).',
    altZones: [],
    extraOrigins: [],
    agents: {},
    _extras: 'This estate\'s own product choices. ORCHESTRATION_LLM is impact-agent\'s: the model the harness plans with, paid through the GEMINI_API_KEY the build installs.',
    extras: {
      ORCHESTRATION_LLM: 'gemini',
    },
    requestedBy: input.requestedBy,
    createdBy: input.createdBy ?? 'createestate.faithnet.town',
  };
}
