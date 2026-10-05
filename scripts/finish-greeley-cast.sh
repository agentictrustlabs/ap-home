#!/usr/bin/env bash
# THE REST OF THE ROAD FOR THURSDAY IN GREELEY'S CAST — everything after the charter.
#
#   scripts/finish-greeley-cast.sh
#
# The same road `finish-commission-cast.sh` walks, pointed at the Greeley note and the `greeley-*` archetypes,
# plus the two things that road predates: the messaging rail each part speaks on, and the KV note the card room
# reads it from. Every step is idempotent, so a re-run repairs rather than duplicates.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTE=demo/greeley-cast.faithnet.json
export NOTE

echo "── vaults, skills, archetypes, wires ──"
NOTE="$NOTE" ARCH_PREFIX=greeley WIRES=demo/greeley-cast-wires.faithnet.json scripts/finish-commission-cast.sh

echo
echo "── the messaging rail: the ask wire and the standing grant, per part ──"
npx tsx scripts/equip-cast-messaging.mts --note "$NOTE" 2>&1 | grep -v "npm warn" | grep -E "──|rail:|standing grant|✓"

echo
echo "── the card room's note: both casts, one key ──"
node -e "
const fs=require('fs');
const parts={};
for (const f of ['demo/commission-cast-messaging.faithnet.json','demo/cast-messaging.faithnet.json','demo/greeley-cast-messaging.faithnet.json']) {
  if (!fs.existsSync(f)) continue;
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  Object.assign(parts, d.parts);
  var head=d;
}
const out={ purpose:'every cast agent as its own runtime at the card room (an operator note, not a persona)', sessionKey:head.sessionKey, chainId:head.chainId, edge:head.edge, parts };
fs.writeFileSync('/tmp/cast-messaging.json', JSON.stringify(out));
console.log(Object.keys(parts).length+' parts → /tmp/cast-messaging.json');
"
echo "  then: cd ~/pokernight/apps/tables && pnpm exec wrangler kv key put cast-messaging --path /tmp/cast-messaging.json --binding CLUB_WIRES --env faithnet --remote   # --remote: wrangler 4 writes LOCAL state without it"
