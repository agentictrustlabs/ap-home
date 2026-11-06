#!/usr/bin/env bash
# Builds the Home for the local end-to-end suite, with the rollout flag these tests need:
#   skills-app 'shadow', which no committed app is. Everything else is as committed: the reader, gc-engage and gc-platform 'on'.
# The flag edit lives only for the build: the file is restored whatever happens, and the suite refuses a dirty tree first.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
CONFIG="$ROOT/apps/home/src/whitelabel/config.ts"
git diff --quiet -- "$CONFIG" || { echo "refusing: $CONFIG has uncommitted changes"; exit 1; }
trap 'git -C "$ROOT" checkout -- "$CONFIG"; git -C "$ROOT" diff --quiet -- "$CONFIG" && echo "flags restored"' EXIT
python3 - "$CONFIG" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
a = "client_id: 'skills-app',\n      remembered_consent: 'on',"; assert s.count(a) == 1; s = s.replace(a, "client_id: 'skills-app',\n      remembered_consent: 'shadow',")
a = "client_id: 'town-app',\n      remembered_consent: 'on',"; assert s.count(a) == 1; s = s.replace(a, "client_id: 'town-app',")
open(p, 'w', encoding='utf-8').write(s)
PY
mkdir -p tests/e2e-local/artifacts
node apps/home/scripts/gen-broker-key.mjs | sed -n 3p > tests/e2e-local/artifacts/broker.jwk
cd apps/home
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_CHAIN_ID=34348 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8799/rpc NEXT_PUBLIC_CONNECT_DOMAIN=faithnet.me pnpm exec next build > ../../tests/e2e-local/artifacts/build.log 2>&1
echo built
