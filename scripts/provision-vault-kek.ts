// provision-vault-kek — gcloud-free provisioning of spec-278 per-person vault KEKs.
//
// Why this exists: the `ap-provision-gcp` CLI drives the `gcloud` binary. When gcloud isn't on
// PATH (CI, this dev box, Workers), B1 (#337) added a gcloud-free executor that talks to the
// Cloud KMS REST API via a service-account JWT. This is the repo-level runner for it (deploy/ops
// tooling — same placement rationale as deploy-secrets.ts; NOT a packages/ primitive).
//
// It mints a SYMMETRIC GOOGLE_SYMMETRIC_ENCRYPTION KEK per identity (a person SA address) and
// grants the runtime service account roles/cloudkms.cryptoKeyEncrypterDecrypter on each. The
// printed keyMap entry (the version-less cryptoKey resource) is the `kmsKeyRef` the spec-278
// VaultKeyBinding carries.
//
// Usage:
//   GCP_SA_JSON_FILE=.gcp-service-account.local.json \
//   tsx scripts/provision-vault-kek.ts \
//     --project <p> --location <l> --keyring <r> \
//     --service-account <runtime-sa-email> \
//     --identities 0xPersonSA1[,0xPersonSA2]
//
// The service-account JSON (from --sa-file / GCP_SA_JSON_FILE, or GCP_SERVICE_ACCOUNT_JSON env —
// raw JSON or base64) needs roles/cloudkms.admin on the project to create keys + set IAM. The
// value is read from a file/env, never argv (no leak). Nothing is written; it prints the keyMap.

import { readFileSync } from 'node:fs';
import { executeGcpProvision, createGcpRestStepExecutor } from '@agenticprimitives/key-custody/provision-gcp';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const project = arg('--project');
const location = arg('--location');
const keyRing = arg('--keyring');
const runtimeServiceAccount = arg('--service-account');
const identities = (arg('--identities') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const missing = Object.entries({ '--project': project, '--location': location, '--keyring': keyRing, '--service-account': runtimeServiceAccount })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length || !identities.length) {
  console.error(`provision-vault-kek: missing ${[...missing, ...(identities.length ? [] : ['--identities'])].join(', ')}`);
  console.error('usage: tsx scripts/provision-vault-kek.ts --project <p> --location <l> --keyring <r> --service-account <email> --identities 0xA[,0xB]');
  console.error('  service-account JSON via --sa-file <path> | GCP_SA_JSON_FILE | GCP_SERVICE_ACCOUNT_JSON (never argv)');
  process.exit(2);
}

// Source the SA JSON from a file or env — never argv.
const saFile = arg('--sa-file') ?? process.env.GCP_SA_JSON_FILE;
const serviceAccountJson = saFile ? readFileSync(saFile, 'utf8') : process.env.GCP_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error('provision-vault-kek: no service-account JSON — set --sa-file / GCP_SA_JSON_FILE / GCP_SERVICE_ACCOUNT_JSON');
  process.exit(2);
}

const plan = {
  project: project!,
  location: location!,
  keyRing: keyRing!,
  identities,
  runtimeServiceAccount: runtimeServiceAccount!,
  purpose: 'encrypt-decrypt' as const,
};

console.error(`# Provisioning ${identities.length} vault KEK(s) in ${project}/${location}/${keyRing} (gcloud-free, REST)…`);
executeGcpProvision(plan, createGcpRestStepExecutor({ serviceAccountJson }))
  .then((result) => {
    console.error(`# Done.${result.alreadyExisted.length ? ` Skipped (already existed): ${result.alreadyExisted.join(', ')}` : ''}`);
    console.error('# kmsKeyRef per person (paste the relevant one into the VaultKeyBinding):');
    console.log(JSON.stringify({ keyMap: result.keyMap, granted: result.granted }, null, 2));
  })
  .catch((e) => {
    console.error(`provision-vault-kek failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
