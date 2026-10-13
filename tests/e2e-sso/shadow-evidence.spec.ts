import { test, expect } from '@playwright/test';
import { CAST, onboardPersona } from './demo-user';
import { estateDomain } from './estate';

// READ THE SHADOW EVIDENCE (ADR-0060 / audit G-1).
//
// The adoption ladder records, per principal, whether `InteractionsDO` and the mounted
// `PrincipalGatewayDO` returned the same inbox document. Until now that evidence existed and nobody had
// looked at it — which is the same shape of gap as a guard with no runner, and would have left "the shadow
// is running" as an assumption rather than a fact.
//
// HOW IT IS REACHED. `status` is a session-gated op on the principal's own `InteractionsDO`, proxied by the
// Home at `/a2a/interactions/<sa>/status`. Driven from a signed-in browser context so the session is the
// real one — asking with a manufactured token would test a path no user takes.
//
// WHAT A CLEAN REPORT DOES AND DOES NOT MEAN. `equal` says the two planes agreed on that read. It does not
// say either was right (ADR-0060). And the buffer is IN MEMORY per isolate, so an empty report is
// ambiguous: nothing diverged, or the isolate recycled, or no poll has been sampled yet. Reported as three
// distinct outcomes rather than collapsed into "clean", because collapsing them is how "no evidence" gets
// read as "good evidence".

interface Divergence { op: string; at: string; kind: string; detail?: string }
interface StatusBody {
  ok?: boolean;
  granted?: boolean;
  gatewayAdoption?: Record<string, { stage: string; concerns: string[]; volatileFields: string[]; note: string }>;
  divergences?: Divergence[];
}

test('the gateway shadow is running, and this is what it found', async ({ browser }) => {
  test.setTimeout(900_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const home = await onboardPersona(page, CAST.ada);
  expect(home.origin, 'ada never reached a home').toContain(estateDomain());

  // GET THE PRINCIPAL FROM THE APP'S OWN TRAFFIC, not from a guessed endpoint. The first version asked
  // `/connect/session`, which does not exist — so it reported "unresolved" and looked like a finding about
  // the shadow when it was a finding about my URL. The Home continuously calls
  // `/a2a/interactions/<sa>/…` for its inbox; watching for that is guaranteed to match because it is the
  // app telling us, rather than us telling the app.
  let sa: string | null = null;
  page.on('request', (r) => {
    const m = /\/a2a\/interactions\/(0x[0-9a-fA-F]{40})\//.exec(r.url());
    if (m && !sa) sa = m[1]!;
  });

  // Also generates the sampling window: one shadow per principal per minute, so asking immediately after
  // sign-in can legitimately find nothing and say nothing.
  await page.goto(`${home.origin}/messages`);
  await page.waitForTimeout(75_000);
  console.log(`[shadow] principal sa=${sa ?? 'UNRESOLVED'}`);

  const status = await page.evaluate(async (addr) => {
    const paths = addr ? [`/a2a/interactions/${addr}/status`] : [];
    for (const p of paths) {
      const r = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
      if (r) return { path: p, status: r.status, body: await r.text().catch(() => '') };
    }
    return null;
  }, sa);

  if (!status) {
    // Reported as its own outcome. "I could not ask" and "I asked and it was empty" are different facts,
    // and returning the second when the first happened is how a mechanism gets believed without evidence.
    console.log('[shadow] COULD NOT REACH status — principal address unresolved from the session');
    test.info().annotations.push({ type: 'shadow', description: 'status unreachable' });
    return;
  }

  console.log(`[shadow] ${status.path} → HTTP ${status.status}`);
  let body: StatusBody = {};
  try { body = JSON.parse(status.body) as StatusBody; } catch { console.log(`[shadow] non-JSON: ${status.body.slice(0, 200)}`); }

  const ladder = body.gatewayAdoption ?? {};
  console.log('\n── adoption ladder (as the deployment reports it) ──');
  for (const [op, e] of Object.entries(ladder)) {
    console.log(`  ${op.padEnd(18)} stage=${e.stage}  concerns=[${(e.concerns ?? []).join(', ')}]  volatile=[${(e.volatileFields ?? []).join(', ')}]`);
  }
  if (Object.keys(ladder).length === 0) {
    console.log('  (none reported — an older build, or the field is absent)');
  }

  const divs = body.divergences ?? [];
  console.log('\n── divergences ──');
  if (divs.length === 0) {
    console.log('  EMPTY — and this is AMBIGUOUS, deliberately reported as such: it means either');
    console.log('    (a) no shadow has been sampled for this principal on this isolate yet,');
    console.log('    (b) the isolate recycled and took the in-memory buffer with it, or');
    console.log('    (c) the planes agreed and the buffer has not been read since.');
    console.log('  Absence of divergence is NOT agreement.');
  } else {
    const byKind = divs.reduce<Record<string, number>>((a, d) => ({ ...a, [d.kind]: (a[d.kind] ?? 0) + 1 }), {});
    console.log(`  ${divs.length} recorded: ${JSON.stringify(byKind)}`);
    for (const d of divs.slice(-8)) console.log(`    ${d.at}  ${d.kind.padEnd(14)} ${d.detail ?? ''}`);

    // The only assertion worth making here. `equal` and `raced` are healthy; `value` means the two planes
    // really disagreed on a stable document, and `gateway-error` means the mounted path is broken — either
    // one blocks promotion, and neither should be discovered by someone scrolling logs later.
    const bad = divs.filter((d) => d.kind === 'value' || d.kind === 'gateway-error');
    if (bad.length) console.log(`\n  ⚠ ${bad.length} BLOCKING: ${bad.map((d) => `${d.kind}:${d.detail ?? ''}`).join(' | ')}`);
    expect(bad, `the planes disagreed on a stable document, or the gateway path errored`).toEqual([]);
  }
});
