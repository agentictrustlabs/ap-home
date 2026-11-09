// WHICH STEPS RUN, IN WHAT ORDER, AND WHERE — the one list the builder runs and the site shows (test/agree.test.mts).
//
// HOSTED ("host it for me"): one build, in the town's GitHub, on the town's accounts.
//
// OWN ("use my own accounts"): three parts, so the owner's tokens never leave the owner's GitHub and the town's
// authority never leaves the town's:
//
//   town    the town's GitHub, after Approve — opens the estate's key vault tenant, mints its two caller tokens and a
//           chain token, and seals them to the estate's build key (only the owner's build can open them)
//   estate  the OWNER's GitHub (their copy of ap-home), run by the owner — builds everything on their Cloudflare and
//           Vercel, and seals the custody file to the owner
//   finish  the town's GitHub again, when the estate is up — registers its .estate name and lists it in the town

export type Part = 'all' | 'town' | 'estate' | 'finish';
export type Hosting = 'town' | 'own';

export const HOSTED_STEPS = [
  'home-address', 'declare', 'workers-config', 'cloud-resources', 'key-vault', 'chain-access', 'agents', 'secrets',
  'deploy', 'custody', 'home', 'estate-name', 'town', 'names', 'check', 'save', 'handover',
] as const;

export const OWN_STEPS = {
  town: ['town-access'],
  estate: [
    'home-address', 'declare', 'workers-config', 'cloud-resources', 'key-vault', 'chain-access', 'agents', 'secrets',
    'deploy', 'custody', 'home', 'estate-name', 'check', 'save', 'handover',
  ],
  finish: ['town-name', 'town', 'names'],
} as const;

/** The steps one part runs, in order ('handover' is the builder's last act, not a step in the table). */
export function stepsFor(part: Part): readonly string[] {
  if (part === 'all') return HOSTED_STEPS;
  return OWN_STEPS[part];
}

/** Every step id the site shows for an estate, in order, after Approve (and, for OWN, the owner's own run). */
export function buildStepIds(hosting: Hosting): string[] {
  return hosting === 'town' ? [...HOSTED_STEPS] : [...OWN_STEPS.town, ...OWN_STEPS.estate, ...OWN_STEPS.finish];
}

/** Which signer may report which step for an OWN estate: the town's parts, or the owner's build. */
export const TOWN_REPORTED = new Set<string>([...OWN_STEPS.town, ...OWN_STEPS.finish]);
