// THE ESTATE'S KEY VAULT — the town's operator ceremonies on its key custody (AKCS), run unattended after Approve.
//
// These are the SAME commands ap-home `scripts/estate-new.mts` runs for its kms-tenant, kms-callers, kms-keys and
// kms-tokens steps (test/kms.test.mts reads that file and holds the two to the same words). They are restated here,
// rather than driven through estate-new, because for an estate on its owner's own accounts this part runs on the
// TOWN's side, in a checkout that has neither the estate's declaration nor its Worker blocks — which estate-new needs.
//
// Every step asks the CVM what already exists first, so a re-run creates nothing twice. Nothing secret is printed:
// the status line carries names and ids only, and a minted token goes from the CVM's stdout straight to its caller.

import type { TownProfile } from './town.mts';

type Kms = TownProfile['kms'];
/** Runs one shell script on the CVM and returns its output (az vm run-command … --query value[0].message -o tsv). */
export type CvmRun = (script: string, o?: { secret?: boolean }) => string;

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const operatorCmd = (k: Kms) => `akcs operator --config ${k.config}`;
const withEnv = (k: Kms, body: string) => `set -a; . ${k.envFile} 2>/dev/null; set +a\n${body}`;

/** `az` arguments that run a script on the town's CVM. */
export const azArgs = (k: Kms, script: string) => ['vm', 'run-command', 'invoke', '-g', k.resourceGroup, '-n', k.vm, '--command-id', 'RunShellScript', '--scripts', script, '--query', 'value[0].message', '-o', 'tsv'];

export function commands(k: Kms, id: string, tenant = id) {
  if (!ID_RE.test(id) || !ID_RE.test(tenant)) throw new Error(`"${id}" is not an estate id`);
  const op = operatorCmd(k);
  return {
    // One line, `KMS {json}`: does the tenant exist, which callers are ACTIVE, which keys exist (name → id).
    status: withEnv(k, `${op} status 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); t=[x for x in d.get("tenants",[]) if x["tenantId"]=="${tenant}"]; t=t[0] if t else None; print("KMS "+json.dumps({"tenant": bool(t), "callers": [c["subject"] for c in (t or {}).get("callers",[]) if c["status"]=="ACTIVE"], "keys": {x["name"]: x["keyId"] for x in (t or {}).get("keys",[])}}))'`),
    createTenant: withEnv(k, `${op} create-tenant --tenant-id ${tenant} --name "${id}" 2>&1 | tail -2`),
    bindVault: withEnv(k, `${op} bind-caller --tenant-id ${tenant} --issuer ${k.issuer} --subject ${id}-vault --name "${id} vault" --profile estate-vault 2>&1 | tail -1`),
    bindRuntime: withEnv(k, `${op} bind-caller --tenant-id ${tenant} --issuer ${k.issuer} --subject ${id}-runtime --name "${id} agent-runtime" --profile estate-runtime --signing-purposes ${k.runtimeSigningPurposes} 2>&1 | tail -1`),
    createKeys: withEnv(k, `for s in relay interactions-session; do ${op} create-key --tenant-id ${tenant} --name ${id}-$s --kind SIGNING --purpose $s 2>&1 | python3 -c 'import json,sys; t=sys.stdin.read(); i=t.find("{"); d=json.loads(t[i:t.rfind("}")+1]); print(d["purpose"],d["keyId"])' ; done`),
    mint: (subject: string) => {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(subject)) throw new Error(`"${subject}" is not a caller subject`);
      return withEnv(k, `akcs dev mint-token --signing-key ${k.signingKey} --kid ${k.kid} --issuer ${k.issuer} --audience ${k.audience} --ttl-secs ${k.tokenTtlSecs} --subject ${subject} 2>/dev/null | tail -1`);
    },
  };
}

export interface KmsState { tenant: boolean; callers: string[]; keys: Record<string, string> }

export function readStatus(run: CvmRun, k: Kms, id: string): KmsState {
  const out = run(commands(k, id).status);
  const line = /^KMS (\{.*\})\s*$/m.exec(out)?.[1];
  if (!line) throw new Error(`the key custody did not report its status:\n${out.trim().slice(-300)}`);
  return JSON.parse(line) as KmsState;
}

/** Tenant, two callers by profile, two signing keys — each only if it is not there yet. Returns the key ids. */
export function ensureKeyVault(run: CvmRun, k: Kms, id: string): { relay: string; interactions: string } {
  const c = commands(k, id);
  let st = readStatus(run, k, id);
  if (!st.tenant) run(c.createTenant);
  if (!st.callers.includes(`${id}-vault`)) run(c.bindVault);
  if (!st.callers.includes(`${id}-runtime`)) run(c.bindRuntime);
  st = readStatus(run, k, id);
  if (!st.tenant || !st.callers.includes(`${id}-vault`) || !st.callers.includes(`${id}-runtime`)) {
    throw new Error(`the key custody has no tenant ${id} with both callers after creating them — is az signed in as its operator?`);
  }
  let relay = st.keys[`${id}-relay`];
  let interactions = st.keys[`${id}-interactions-session`];
  if (!relay || !interactions) {
    const out = run(c.createKeys);
    const ids = Object.fromEntries([...out.matchAll(/(relay|interactions-session)\s+([0-9a-f-]{36})/g)].map((m) => [m[1], m[2]]));
    relay ??= ids.relay;
    interactions ??= ids['interactions-session'];
  }
  if (!relay || !interactions) throw new Error('could not read both signing key ids back from the key custody');
  return { relay, interactions };
}

/** A caller token for one Worker: minted on the CVM, returned to the caller, never printed. */
export function mintToken(run: CvmRun, k: Kms, id: string, subject: string): string {
  const out = run(commands(k, id).mint(subject), { secret: true });
  const token = /([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(out)?.[1];
  if (!token) throw new Error(`the key custody did not return a token for ${subject}`);
  return token;
}
