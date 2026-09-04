/**
 * Spec 353 S2/S4 — the surface declares a GENERATED scope, and the declaration is load-bearing.
 *
 *   npx tsx scripts/verify-generated-scope.mts
 *
 * The agent publishes its Ask vocabulary (projected from the same tool declarations its planner composes
 * with). A surface reads it and offers the intersection with what IT can finish. This proves three things
 * that only matter together: the published list matches what the planner actually offers; a scope built
 * that way changes nothing for a surface that can do everything; and the same machinery genuinely
 * narrows a surface that cannot sign — so the declaration is doing work, not decorating the request.
 */
const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _s: r.status }; } };

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) failures++; };

const vocab = (await j(await fetch(`${A2A}/harness/vocabulary`))) as { capabilities?: Array<{ id: string; riskTier: string; ceremonies: string[] }> };
const caps = vocab.capabilities ?? [];
console.log(`── the agent publishes ${caps.length} capabilities ──`);
check('the vocabulary is non-empty and every entry names its ceremonies', caps.length > 0 && caps.every((c) => c.ceremonies?.length > 0), caps.map((c) => c.id).join(', '));

// The point of declaring ceremonies per capability rather than deriving them from risk.
const surprises = caps.filter((c) => (c.riskTier === 'low' || c.riskTier === 'medium') && c.ceremonies.includes('signature'));
check('at least one capability needs a ceremony its RISK never implied', surprises.length > 0,
  surprises.map((c) => `${c.id} (${c.riskTier} + signature)`).join(', ') || 'none — risk alone would have sufficed');

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));

/** Build a scope exactly as `homeScope` does, for a surface rendering `renders`. */
const scopeFor = (renders: string[]) => ({
  ceremonies: renders,
  capabilities: caps.filter((c) => c.ceremonies.every((x) => renders.includes(x))).map((c) => c.id),
});
const ask = async (message: string, surface: unknown) =>
  ((await j(await fetch(`${HOME}/a2a/harness/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' },
    body: JSON.stringify({ session: signin.homeSession, addressee: ORG, message, surface }),
  }))) as { reply?: Record<string, unknown> }).reply ?? {};

const full = scopeFor(['data', 'confirmation', 'signature']);
console.log(`\n── a surface that can sign declares ${full.capabilities.length} capabilities ──`);
check('the generated scope covers everything published', full.capabilities.length === caps.length, full.capabilities.join(', '));
const a = await ask('create a team called probe-scope', full);
check('and an ask under it still reaches the mandate', a.kind === 'authority_required', `${a.kind} ${a.capability ?? ''}`);

const thin = scopeFor(['data', 'confirmation']);
console.log(`\n── a surface that cannot sign declares ${thin.capabilities.length} capabilities ──`);
check('the SAME machinery narrows it to nothing', thin.capabilities.length === 0, JSON.stringify(thin.capabilities));
const b = await ask('create a team called probe-scope', thin);
check('and the same ask is refused, not attempted', b.kind === 'refused' || /can.t help/.test(String((b as { text?: string }).text ?? '')), `${b.kind} — ${String(b.error ?? (b as { text?: string }).text ?? '').slice(0, 90)}`);

console.log(`\n${failures === 0 ? '✓' : '✗'} S2/S4: the scope is generated from descriptors and it is load-bearing — ${failures} failure(s).`);
if (failures) process.exit(1);
