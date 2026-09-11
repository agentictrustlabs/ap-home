/**
 * THE CROSS-HOME PREREQUISITES, checked before a cross-Home gate runs (priorities §3.2 G4–G6; spec 366 R5).
 *
 * The second deployment (`a2a-b.faithnet.io`) is live and idle. Every cross-Home proof needs two things the
 * estate does not yet hold: (1) an AKCS caller token for B (the pilot operator binds callers on the CVM — an
 * operator action, not code), so B can read the shared vault; (2) for the hand-off and the bilateral chain, the
 * parent agent's own session wire held by the Worker (372 S3c — a ceremony the custodian performs). Until both,
 * a `--cross` gate SAYS what is missing (`⊘ skipped: …`) and exits 0; the nightly shows it waiting, never green.
 *
 * Imported by the cross-Home gates; runnable alone:  npx tsx scripts/cross-home-preflight.mts
 */
const B_A2A = process.env.B_A2A_URL ?? 'https://a2a-b.faithnet.io';
const B_AGENT = process.env.B_AGENT_NAME ?? 'dave-s-table.org';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

export interface CrossHomeReadiness { ok: boolean; missing: string[]; notes: string[] }

/** What B can do today, from the outside: reachable; a name placed on it; a vault read that does not answer "could not be read". */
export async function crossHomeReadiness(opts: { needsParentWire?: boolean } = {}): Promise<CrossHomeReadiness> {
  const missing: string[] = []; const notes: string[] = [];
  // 1. B answers at all
  const card = await fetch(`${B_A2A}/.well-known/agent-card.json`, { headers: { 'user-agent': 'Mozilla/5.0 (cross-home-preflight)' } }).then((r) => r.status).catch(() => 0);
  if (card !== 200) missing.push(`B (${B_A2A}) is not answering its card (${card || 'unreachable'})`); else notes.push(`B answers at ${B_A2A}`);
  // 2. a name is PLACED on B by its records — its card is served from B's host for that name (never a subdomain
  //    convention: the host is what `atl:cardUri` says, and `place-on-deployment.mts` wrote it)
  const host = `${B_AGENT.replace(/\./g, '-')}.b.faithnet.io`;
  const placed = await j(await fetch(`https://${host}/.well-known/agent-card.json`, { headers: { 'user-agent': 'Mozilla/5.0 (cross-home-preflight)' } }).catch(() => new Response('{}', { status: 599 })));
  if (!placed?.agentAddress && !placed?.name) missing.push(`no agent is placed on B — ${B_AGENT}'s card is not served at ${host} (place-on-deployment.mts, after B holds its token)`); else notes.push(`${B_AGENT} is placed on B (${host})`);
  // 3. the caller token: B's vault reads answer, not "could not be read" — only checkable through a placed agent
  if (missing.length === 0) notes.push('B\'s vault access (the AKCS caller token) is judged by the gate\'s first routed read');
  if (opts.needsParentWire && !process.env.PARENT_SESSION_WIRE) missing.push('no parent-agent session wire is provided to this run (PARENT_SESSION_WIRE — the 372 S3c ceremony: the custodian mints the parent SA → the Worker\'s session key, pinned to the hand-off selector)');
  return { ok: missing.length === 0, missing, notes };
}

/** For a gate: print the readiness; when something is missing, say it in the runner's skip form and exit 0. */
export async function requireCrossHome(gate: string, opts: { needsParentWire?: boolean; legWritten?: boolean } = {}): Promise<void> {
  const r = await crossHomeReadiness(opts);
  for (const n of r.notes) console.log(`  preflight: ${n}`);
  if (!r.ok) { console.log(`⊘ skipped: ${gate} (cross-Home) waits on ${r.missing.length} prerequisite(s): ${r.missing.join('; ')}`); process.exit(0); }
  if (!opts.legWritten) { console.log(`⊘ skipped: ${gate} (cross-Home) — the prerequisites hold but the B leg is not written yet (docs/runbooks/cross-home-wave-faithnet-b.md)`); process.exit(0); }
}

if (process.argv[1] && /cross-home-preflight\.mts$/.test(process.argv[1])) {
  const r = await crossHomeReadiness({ needsParentWire: true });
  console.log(JSON.stringify(r, null, 2));
}
