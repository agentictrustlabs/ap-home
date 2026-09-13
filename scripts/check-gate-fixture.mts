/**
 * THE LEDGER'S GATES READ THEIR ROSTER FROM THE FIXTURE — spec 392 / 399 §5.5.
 *
 *   pnpm check:gate-fixture
 *
 * Every script the live-gates ledger names must take WHO plays each role from `scripts/fixture.mts`, never from its own
 * text: a deployment with another roster (the ap-home estate: mara, theo, priya …) runs the same gates green or red on
 * the runtime's behaviour, not on whether alice exists there. This scans the ledger's scripts for Faithnet's names in
 * CODE (comment lines are prose and may name the story) and fails on any. A script that is deployment-bound by nature
 * is WAIVED here by name with its reason — a waiver is a sentence, never a silent skip.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ledger = JSON.parse(readFileSync(resolve(ROOT, 'scripts/live-gates.json'), 'utf8')) as { gates: Array<{ id: string; script: string }> };

/** Deployment-bound by nature — said, not skipped. */
const WAIVED: Record<string, string> = {
  'scripts/verify-cross-deployment.mts': "the cross-Home leg (CROSS=1): dave's Home on A, dave-s-table.org placed on B — two deployments faithnet holds and the estate does not (399: stays faithnet's until a second estate exists)",
  'scripts/verify-ap-gateway.mts': 'the AP Gateway MCP (spec 387) is the faithnet deployment\'s outside-in flow; advisory here',
  'scripts/trace-ap-gateway.mts': 'prints the tree of one live gateway run against the faithnet Workers; advisory',
};

// Faithnet's roster and its names, as they appear in code. A `.me` / `.treasury` / `.org` handle, a persona in
// quotes, the hostname, the organization, the ministry.
// Faithnet's persona and fixture ADDRESSES — a bare address in a gate is a roster literal with the name filed off.
const FAITHNET_ADDRESSES = /0x(1dba4a27c53d7babda99513080223fb3bfc4bad1|3b99f2b452766de5df0dbcdfc676f27257151333|309b2a566e93cc77aabe895d0ec2702c36856ebd|fC1C328c26505d1AEAb1EAd4a46b3F74981F07a4|0daC3e3C83486D334627fbA18fD0Fe730139eC|ee11DFB02e4a02630bE512886305DF5C68Fd682c)/i;
const LITERAL = /'(alice|bob|carol|dave|david|elena|nathan|frank|pete|jill)'|"(alice|bob|carol|dave|david|nathan)"|\b(alice[0-9]?|nathan|bob|carol|david)\.(me|treasury)\b|missio[- ]nexus|[Mm]issio Nexus|\bligonier\b|globalchurch\.org|runtime-c3s0|faithnet\.(me|io|ai)|richardpedersen3\.workers\.dev/;

let bad = 0;
const seen = new Set<string>();
for (const g of ledger.gates) {
  if (seen.has(g.script)) continue;
  seen.add(g.script);
  if (WAIVED[g.script]) { console.log(`· ${g.script} — waived: ${WAIVED[g.script]}`); continue; }
  const src = readFileSync(resolve(ROOT, g.script), 'utf8');
  if (!/from '\.\/fixture\.mts'/.test(src)) { console.error(`✗ ${g.script} does not read scripts/fixture.mts`); bad++; continue; }
  const hits: string[] = [];
  let inBlock = false;
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (t.startsWith('//') || t.startsWith('*')) return;
    // prose in a console.log / fail() sentence is fine when it names a ROLE; a name that is code is not
    const code = line.replace(/\/\/.*$/, '');
    const m = LITERAL.exec(code) ?? FAITHNET_ADDRESSES.exec(code);
    if (m) hits.push(`${i + 1}: ${m[0]}`);
  });
  if (hits.length) { console.error(`✗ ${g.script} names Faithnet's roster in code: ${hits.slice(0, 4).join(' · ')}${hits.length > 4 ? ` (+${hits.length - 4})` : ''}`); bad++; }
  else console.log(`✓ ${g.script}`);
}
if (bad) { console.error(`\n✗ check:gate-fixture — ${bad} ledger script(s) carry a deployment's roster; read it from scripts/fixture.mts`); process.exit(1); }
console.log(`\n✓ check:gate-fixture — ${seen.size} ledger script(s): roles from the fixture, ${Object.keys(WAIVED).length} waived by name`);
