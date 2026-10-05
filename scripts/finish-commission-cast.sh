#!/usr/bin/env bash
# THE REST OF THE ROAD FOR THE COMMISSION'S CAST — everything after the charter, for every part on record.
#   scripts/finish-commission-cast.sh
# Vaults, then the game's skills on each card, then the part's own archetype, then the session wires the card
# room carries their words on. Each step is idempotent, so a re-run repairs rather than duplicates.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTE=${NOTE:-demo/commission-cast.faithnet.json}
export NOTE
echo "── vaults ──"
npx tsx scripts/activate-cast-vaults.mts 2>&1 | grep -v "npm warn"
echo "── skills and archetypes ──"
node -e "const n=require('./$NOTE'); for (const c of n.cast) console.log(c.role, c.name, c.custodian, c.sa)" | while read -r role name handle sa; do
  echo "· $name ($role) — $handle"
  npx tsx scripts/add-mystery-skills.mts --game commission --as "$name" --by "$handle" 2>&1 | grep -v "npm warn" | grep -E "atl:capabilities|advertises|✗" | sed 's/^/    /'
  CONTEXT=great-commission ARCHETYPE="${ARCH_PREFIX:-commission}-$role" npx tsx scripts/assign-org-archetype.mts "$handle" "$sa" 2>&1 | grep -v "npm warn" | grep -E "→|digest" | sed 's/^/    /'
done
echo "── wires ──"
OUT=${WIRES:-demo/commission-cast-wires.faithnet.json} npx tsx scripts/mint-cast-wires.mts 2>&1 | grep -v "npm warn" | grep -E "wire signed|✓"
echo "── config ──"
node -e "const n=require('./$NOTE'); console.log('COMMISSION_CAST = \"' + n.cast.map(c=>c.role+'='+c.name+'@'+c.custodian).join(',') + '\"')"
