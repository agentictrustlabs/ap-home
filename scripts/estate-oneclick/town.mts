// THE TOWN AN ESTATE IS BUILT IN — read from towns/<town>.json beside this file.
//
// The builder knows nothing about faithnet.town in its code: the chain, the gateway, the naming service, the key
// custody, the sibling estate it copies and the town's own accounts all come from the profile. A second town is a
// second profile (and, in ap-town, a second manifest), not a fork of the builder.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TownProfile {
  town: string;
  displayName: string;
  manifest: string;
  chain: { id: number; name: string; gateway: string };
  site: string;
  townOrigin: string;
  naming: string;
  discoveryA2a: string;
  estateNameRoot: string;
  nameRoots: string[];
  hosted: { cloudflareAccount: string; workersSubdomain: string; repo: string; townWorkerEnv: string };
  sibling: {
    env: string;
    declaration: string;
    workers: Record<string, 'runtime' | 'vault' | 'edge' | 'homeMcp' | 'approval'>;
    hostMap: Record<string, 'home' | 'runtime' | 'vault' | 'edge' | 'homeMcp'>;
    estateHosts: string[];
    onlyPattern: string;
    ownWorkerPattern: string;
    townWorkerPattern: string;
    townMentions: string;
  };
  kms: {
    resourceGroup: string; vm: string; config: string; envFile: string; issuer: string; kid: string; audience: string;
    signingKey: string; tokenTtlSecs: number; runtimeSigningPurposes: string;
  };
  chainGateway: { dir: string; env: string };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TOWN_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** The profile for `town` (default: the TOWN env var, else faithchain). */
export function loadTown(town = process.env.TOWN || 'faithchain'): TownProfile {
  if (!TOWN_RE.test(town)) throw new Error(`"${town}" is not a town name`);
  const p = JSON.parse(readFileSync(join(HERE, 'towns', `${town}.json`), 'utf8')) as TownProfile;
  if (p.town !== town) throw new Error(`towns/${town}.json says it is ${p.town}`);
  return p;
}
