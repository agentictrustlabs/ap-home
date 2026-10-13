import { test, expect, type Page } from '@playwright/test';
import { onboard } from './onboard';

// Coordination Work surface (spec 334) against PRODUCTION — the reported flow:
//   steward org-create → My Work "New request" (goal → org target) → request lands (no
//   record_scope_denied / 409) → steward triage sees it → "Accept as endeavor" → the
//   endeavor appears on the org Work board.
// Fresh orgs get an interactions grant that already carries the vault:coordination.*
// scopes (delegation.ts), so this validates the end-to-end path the 409 was blocking.
// The stale-grant path (a pre-coordination grant) surfaces the amber "Re-enable storage"
// banner instead — asserted only if it appears.

const results: { flow: string; ok: boolean; detail: string }[] = [];
function record(flow: string, ok: boolean, detail = '') { results.push({ flow, ok, detail }); console.log(`${ok ? '✓ PASS' : '✗ FAIL'} [${flow}] ${detail}`); }
function summary() {
  console.log('\n── work-requests summary ──');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.flow}${r.detail ? ` — ${r.detail}` : ''}`);
  expect(results.filter((r) => !r.ok).map((r) => `${r.flow}: ${r.detail}`)).toEqual([]);
}

async function bodyOf(p: Page): Promise<string> { return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | '); }
async function shot(p: Page, n: string) { await p.screenshot({ path: `artifacts/work-${n}.png`, fullPage: true }).catch(() => {}); }

test('coordination: home request → steward triage → endeavor', async ({ browser }) => {
  test.setTimeout(720_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const scopeDenials: string[] = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/connect/work') && r.status() >= 400) {
      const t = (await r.text().catch(() => '')).slice(0, 200);
      console.log(`[work http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.-]+/, '')} :: ${t}`);
      if (/record_scope_denied|record_scope/.test(t)) scopeDenials.push(`${r.status()} ${t}`);
    }
  });

  const stamp = Date.now().toString(36);
  const A = await onboard(page, 'wrk' + stamp);
  console.log(`steward=${A.name} ${A.address}`);

  // ── Org create (the steward's fresh org — its interactions grant includes coordination scopes) ──
  await page.goto(`${A.origin}/organizations`);
  await page.waitForTimeout(4000);
  const orgName = 'wrkorg' + stamp;
  await page.getByRole('button', { name: 'Create organization', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator('input:visible').first().fill(orgName);
  await page.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});
  let orgAddr: string | undefined;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(5000);
    const b = await bodyOf(page);
    if (/went wrong|AA31|too low/i.test(b)) { record('org.create', false, b.slice(0, 160)); break; }
    if (new RegExp(orgName, 'i').test(b) && /ORGANIZATION|Custodied by you/i.test(b)) {
      const href = await page.locator('a[href*="0x"]').first().getAttribute('href').catch(() => null);
      orgAddr = href?.match(/0x[0-9a-fA-F]{40}/)?.[0];
      break;
    }
  }
  record('org.create', !!orgAddr, orgAddr ?? 'no address');
  if (!orgAddr) { summary(); return; }
  const org = orgAddr.toLowerCase();

  // The steward must be LISTED for endeavor.request's member gate; the discussions page
  // has the self-add CTA (same precondition as posting).
  await page.goto(`${A.origin}/org/${org}/discussions`);
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /Add yourself as member/i }).first().click().catch(() => {});
  await page.waitForTimeout(8000);

  // ── My Work → New request → goal + org target → Send ──────────────────────────
  const goal = `Organize trip to Munich for vacation week — e2e ${stamp}`;
  await page.goto(`${A.origin}/work`);
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: /^New request$/ }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  const goalBox = page.locator('textarea[placeholder^="What should be accomplished"]').first();
  record('composer.open', (await goalBox.count()) > 0, 'goal textarea visible');
  await goalBox.fill(goal);
  // Target: the org chip from useRelatedOrgs (related-orgs read can lag org-create).
  let chipOk = false;
  for (let i = 0; i < 10; i++) {
    // MATCH WHAT THE CHIP CAN ACTUALLY SAY. Its label is `orgName ?? <address prefix>`, and `orgName`
    // self-heals by `reverseResolve`, which returns null while a just-claimed name is still propagating.
    // So the chip legitimately renders `0x1234ab…` for a while — and a test accepting only the name was
    // asserting something the UI never promised, then reporting the mismatch as "org chip never appeared".
    const chip = page
      .getByRole('button', { name: new RegExp(`${orgName}|${orgAddr.slice(0, 8)}`, 'i') })
      .first();
    if (await chip.count()) { await chip.click().catch(() => {}); chipOk = true; break; }
    await page.waitForTimeout(4000);
    await page.reload().catch(() => {});
    await page.getByRole('button', { name: /^New request$/ }).first().click().catch(() => {});
    await page.locator('textarea[placeholder^="What should be accomplished"]').first().fill(goal).catch(() => {});
  }
  // FINDING (2026-08-05) — this is NOT a lag, and widening the matcher did not help: the chip is absent
  // because `useRelatedOrgs` returns an EMPTY list for an org the person just created.
  //
  // There are TWO notions of "your organizations" and the work composer reads the one that does not know
  // about org-create:
  //   · `useManagedAgents`  — the agent tree / stewardship. Works: the AgentSwitcher lists the new org
  //                            under "Organizations you steward" immediately.
  //   · `useRelatedOrgs`    — reconciled from the person's VAULT `relationships.data` doc
  //                            (`related-orgs.ts` → `readRelationshipsDoc`). Empty, because nothing
  //                            writes a steward link there on org-create.
  //
  // So the coordination request path is UNREACHABLE from the UI for an org you created — the composer
  // opens, and has no target to offer. Everything downstream (`request.sent`, `triage.pending`) has
  // therefore never run.
  //
  // Which source is correct is a product decision, not a test fix: either org-create records the
  // stewardship in `relationships.data`, or the composer targets from managed agents. Recorded here
  // rather than worked around, because a test that manufactured a target would hide the gap.
  record('composer.target', chipOk, chipOk ? `target=${orgName}` : 'org chip absent — useRelatedOrgs empty after org-create (see comment)');
  await shot(page, '1-composer');
  await page.getByRole('button', { name: /^Send request$/ }).first().click().catch(() => {});

  let sent = false; let sendDetail = '';
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(3000);
    const b = await bodyOf(page);
    if (/Request sent to/i.test(b)) { sent = true; break; }
    // The stale-grant path (should NOT hit a fresh org): the steward re-enable CTA.
    if (/Re-enable storage and resend/i.test(b)) {
      sendDetail = 'stale-grant path surfaced — clicking steward re-enable';
      await page.getByRole('button', { name: /Re-enable storage and resend/i }).first().click().catch(() => {});
      continue;
    }
    const err = b.match(/record_scope[^|]*|grant is stale[^|]*|work op failed[^|]*/i)?.[0];
    if (err) sendDetail = err;
  }
  record('request.sent', sent, sent ? goal : (sendDetail || 'no "Request sent" confirmation'));
  await shot(page, '2-sent');

  // ── Steward triage: the request is pending → Accept as endeavor ───────────────
  await page.goto(`${A.origin}/org/${org}/work/requests`);
  await page.waitForTimeout(5000);
  let pendingSeen = false;
  for (let i = 0; i < 8; i++) {
    if ((await bodyOf(page)).includes(goal)) { pendingSeen = true; break; }
    await page.waitForTimeout(4000);
  }
  record('triage.pending', pendingSeen, pendingSeen ? 'request visible in triage' : 'request never appeared in Requests');
  await shot(page, '3-triage');

  if (pendingSeen) {
    await page.getByRole('button', { name: /Accept — start an endeavor|Accept as endeavor/i }).first().click().catch(() => {});
    let adopted = false;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(4000);
      const b = await bodyOf(page);
      if (/Accepted —|adopted as an endeavor|No requests waiting|No pending requests/i.test(b)) { adopted = true; break; }
    }
    record('triage.adopt', adopted, adopted ? 'request adopted' : 'adopt gave no confirmation');
    await shot(page, '4-adopted');

    // ── The endeavor appears on the org Work board ───────────────────────────────
    await page.goto(`${A.origin}/org/${org}/work`);
    let onBoard = false;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(4000);
      if ((await bodyOf(page)).includes(goal)) { onBoard = true; break; }
    }
    record('work.endeavor-listed', onBoard, onBoard ? 'endeavor card on Work' : 'endeavor not on Work list');
    await shot(page, '5-work');

    // ── My Work shows the requester's own request as adopted ────────────────────
    await page.goto(`${A.origin}/work`);
    let mineSeen = false;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(4000);
      const b = await bodyOf(page);
      if (b.includes(goal) && /adopted/i.test(b)) { mineSeen = true; break; }
    }
    record('mywork.request-adopted', mineSeen, mineSeen ? 'Your requests shows the adopted request' : 'request missing from My Work');
    await shot(page, '6-mywork');

    // ── Endeavor detail: the org agent should have DRAFTED a suggested plan on adoption;
    //    the steward reviews + adopts it (or drafts manually when the suggestion is absent). ──
    await page.goto(`${A.origin}/org/${org}/work`);
    await page.waitForTimeout(4000);
    await page.locator(`a.manage-card:has-text("${goal.slice(0, 30)}")`).first().click().catch(() => {});
    await page.waitForTimeout(4000);

    let suggested = false;
    for (let i = 0; i < 8; i++) {
      const b = await bodyOf(page);
      if (/Suggested by the organization/i.test(b) || /Draft by /i.test(b)) { suggested = true; break; }
      if (/Revision \d+ · adopted/i.test(b)) break; // already adopted somehow
      await page.waitForTimeout(4000);
    }
    record('plan.agent-draft', suggested, suggested ? "org agent's suggested plan visible" : 'no agent draft (composer fallback)');
    await shot(page, '7-suggested');

    let adoptedPlan = false;
    if (suggested) {
      await page.getByRole('button', { name: /Adopt this plan/ }).first().click().catch(() => {});
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(4000);
        if (/Revision \d+ · adopted/i.test(await bodyOf(page))) { adoptedPlan = true; break; }
      }
    } else {
      const stepBox = page.locator('input[placeholder^="Step 1"]').first();
      if (await stepBox.count()) {
        await stepBox.fill('Book hotel and transportation');
        await page.getByRole('button', { name: /Propose \+ adopt plan|Propose plan/ }).first().click().catch(() => {});
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(4000);
          if (/Revision \d+ · adopted/i.test(await bodyOf(page))) { adoptedPlan = true; break; }
        }
      }
    }
    record('plan.adopted', adoptedPlan, adoptedPlan ? 'plan revision adopted' : 'plan not adopted');
    await shot(page, '8-plan');

    if (adoptedPlan) {
      // ── Offer → steward assigns → participant commits ─────────────────────────
      await page.locator('input[type="checkbox"]').first().check().catch(() => {});
      await page.getByRole('button', { name: /Offer to help/ }).first().click().catch(() => {});
      let assignBtn = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(4000);
        if (await page.getByRole('button', { name: /Assign to/ }).first().count()) { assignBtn = true; break; }
      }
      record('plan.offer', assignBtn, assignBtn ? 'offer listed for assignment' : 'no Assign action after offer');
      if (assignBtn) {
        await page.getByRole('button', { name: /Assign to/ }).first().click().catch(() => {});
        let commitBtn = false;
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(4000);
          if (await page.getByRole('button', { name: /Commit to this work/ }).first().count()) { commitBtn = true; break; }
        }
        record('plan.assigned', commitBtn, commitBtn ? 'assignment awaits commitment' : 'no Commit CTA');
        if (commitBtn) {
          await page.getByRole('button', { name: /Commit to this work/ }).first().click().catch(() => {});
          let committed = false;
          for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(4000);
            if (/committed/.test(await bodyOf(page))) { committed = true; break; }
          }
          record('plan.committed', committed, committed ? 'commitment signed' : 'commitment not recorded');
          await shot(page, '9-committed');

          // ── EXECUTION: mark every open step done with evidence, then complete ──
          if (committed) {
            let doneSteps = 0;
            for (let guard = 0; guard < 10; guard++) {
              const markBtn = page.getByRole('button', { name: /^Mark done$/ }).first();
              if (!(await markBtn.count())) break;
              await markBtn.click().catch(() => {});
              await page.waitForTimeout(800);
              await page.locator('input[placeholder^="What was done"]').first().fill(`e2e completion evidence ${stamp}`).catch(() => {});
              await page.getByRole('button', { name: /^Done$/ }).first().click().catch(() => {});
              await page.waitForTimeout(5000);
              doneSteps++;
            }
            record('exec.steps-done', doneSteps > 0, `${doneSteps} step(s) marked done`);
            await shot(page, '10-steps-done');

            let completeSeen = false;
            for (let i = 0; i < 8; i++) {
              if (await page.getByRole('button', { name: /^Mark complete$/ }).first().count()) { completeSeen = true; break; }
              await page.waitForTimeout(4000);
            }
            record('exec.complete-cta', completeSeen, completeSeen ? 'Mark complete offered once all steps done' : 'no Mark complete CTA');
            if (completeSeen) {
              await page.getByRole('button', { name: /^Mark complete$/ }).first().click().catch(() => {});
              let completed = false;
              for (let i = 0; i < 8; i++) {
                await page.waitForTimeout(4000);
                if (/Completed/.test(await bodyOf(page))) { completed = true; break; }
              }
              record('exec.completed', completed, completed ? 'endeavor marked Completed' : 'lifecycle never showed Completed');
              await shot(page, '11-completed');
            }
          }
        }
      }
    }
  }

  record('no.scope-denials', scopeDenials.length === 0, scopeDenials.join(' ; ') || 'no record_scope_denied responses');
  summary();
});
