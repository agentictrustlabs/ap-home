import { test, type Page } from '@playwright/test';
import { onboard } from './onboard';

// ALL discussion/topic + ENROLLMENT flows, two users against PRODUCTION (spec 324 §7/§12):
//   A (steward) org-create → auto #general + storage + roster · steward posts · steward creates a
//   topic · per-topic message isolation · B non-member gate ("Request to join", no message leak) · B
//   REQUESTS to join (MembershipApplication → org inbox) · A APPROVES from Members (pending queue) · B
//   COMPLETES membership (listing published as a consequence) · B reads A's posts · B posts (listing
//   gate) · A sees B's post + roster · B creates a topic · member→DM slide-over · A receives that DM.

const results: { flow: string; ok: boolean; detail: string }[] = [];
function record(flow: string, ok: boolean, detail = '') { results.push({ flow, ok, detail }); console.log(`${ok ? '✓ PASS' : '✗ FAIL'} [${flow}] ${detail}`); }

async function bodyOf(p: Page): Promise<string> { return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | '); }
async function shot(p: Page, n: string) { await p.screenshot({ path: `artifacts/ch-${n}.png`, fullPage: true }).catch(() => {}); }
function httpLog(p: Page, who: string) {
  p.on('response', async (r) => {
    const u = r.url();
    if ((u.includes('/connect/') || u.includes('/a2a/')) && r.status() >= 400) {
      console.log(`[${who} http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.]+\.faithnet\.(me|io|ai)/, '')} :: ${(await r.text().catch(() => '')).slice(0, 180)}`);
    }
  });
}

/** The channel thread pane (message bubbles live here — never match sidebar/member text). */
const thread = (p: Page) => p.locator('.chat-thread-body').first();

/** Rendered members count from the roster header ("MEMBERS · N" — CSS uppercases it). */
/**
 * The roster count from the sidebar.
 *
 * The UI says "Participants · N". This filtered on /members/i, matched nothing, and returned the -1
 * sentinel on every call — so `steward.self-add` could never pass no matter what the product did. It was
 * read as a product failure for as long as it stood, and the tell was right there: `post.steward` PASSED
 * on the next line, and posting is listing-gated, so the self-add plainly worked.
 *
 * Accepts either word rather than swapping one hard-coded label for another: a test that breaks on a
 * rename is what produced this, and the count is what is being asserted.
 */
async function memberCount(p: Page): Promise<number> {
  const t = await p.locator('.channels-sidebar__title').filter({ hasText: /participants|members/i }).first().innerText().catch(() => '');
  return Number(t.match(/·\s*(\d+)/)?.[1] ?? -1);
}

/** Wait for a message body to render in the thread (per-channel read + body decrypt can lag). */
async function readInThread(p: Page, text: string, secs = 30): Promise<boolean> {
  for (let i = 0; i < Math.ceil(secs / 3); i++) {
    if ((await thread(p).innerText().catch(() => '')).includes(text)) return true;
    await p.waitForTimeout(3000);
  }
  return false;
}

/** Post into the ACTIVE channel via the composer (Enter sends). Returns ok + what went wrong. */
async function post(p: Page, text: string): Promise<{ ok: boolean; detail: string }> {
  const composer = p.locator('textarea[placeholder^="Message #"]').first();
  if (!(await composer.count())) return { ok: false, detail: 'no composer (channel not active?)' };
  await composer.fill(text);
  await composer.press('Enter');
  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(3000);
    if ((await thread(p).innerText().catch(() => '')).includes(text)) return { ok: true, detail: text };
    // Enter while another action is in flight is silently ignored (canSend=false) and the draft
    // stays in the composer — re-send once the busy state clears.
    if (i >= 2 && (await composer.inputValue().catch(() => '')) === text) await composer.press('Enter');
  }
  const err = (await bodyOf(p)).match(/join this community first[^|]*|post failed[^|]*/i)?.[0] ?? '';
  return { ok: false, detail: err || 'no echo in thread after ~30s' };
}

/** Open a channel by title from the sidebar; waits for its feed header. */
async function openChannel(p: Page, title: string): Promise<boolean> {
  const item = p.locator('.channels-sidebar__item').filter({ hasText: title }).first();
  for (let i = 0; i < 10; i++) {                                    // sidebar can lag a vault read-back
    if (await item.count()) break;
    await p.waitForTimeout(3000);
  }
  if (!(await item.count())) return false;
  await item.click().catch(() => {});
  await p.waitForTimeout(3000);
  return true;
}

test('channel messaging: every flow, two users', async ({ browser }) => {
  test.setTimeout(900_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  httpLog(pageA, 'A'); httpLog(pageB, 'B');
  const stamp = Date.now().toString(36);
  const nameA = 'stwa' + stamp;
  const nameB = 'mbra' + stamp;

  // ── Onboard B first (must be KB-indexed for the invite search), then A ─────
  const B = await onboard(pageB, nameB);
  const A = await onboard(pageA, nameA);
  console.log(`A=${A.name} ${A.address}  B=${B.name} ${B.address}`);

  // ── A creates the org ───────────────────────────────────────────────────────
  await pageA.getByRole('link', { name: /^Organizations$/ }).first().click().catch(() => {});
  await pageA.waitForTimeout(4000);
  const orgName = 'chan' + stamp;
  await pageA.getByRole('button', { name: 'Create organization', exact: true }).first().click().catch(() => {});
  await pageA.waitForTimeout(1500);
  await pageA.locator('input:visible').first().fill(orgName);
  await pageA.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});
  let orgAddr: string | undefined;
  for (let i = 0; i < 16; i++) {
    await pageA.waitForTimeout(5000);
    const b = await bodyOf(pageA);
    if (/went wrong|AA31|too low/i.test(b)) { record('org.create', false, b.slice(0, 160)); break; }
    if (new RegExp(orgName, 'i').test(b) && /ORGANIZATION|Custodied by you/i.test(b)) {
      const href = await pageA.locator('a[href*="0x"]').first().getAttribute('href').catch(() => null);
      orgAddr = href?.match(/0x[0-9a-fA-F]{40}/)?.[0];
      break;
    }
  }
  record('org.create', !!orgAddr, orgAddr ?? 'no address');
  if (!orgAddr) { summary(); return; }

  // ── Flow 1: org create auto-seeds channels — #general + storage; steward gets the self-add CTA ──
  await pageA.goto(`${A.origin}/org/${orgAddr}/discussions`);
  await pageA.waitForTimeout(6000);
  let aBody = await bodyOf(pageA);
  record('auto.general', await openChannel(pageA, 'general'), 'auto-created #general visible');
  record('auto.storage', !/storage isn.t enabled/i.test(aBody), /storage isn.t enabled/i.test(aBody) ? 'Enable banner shown — storage NOT auto-enabled' : 'no Enable banner');
  // SEC-H1: steward access ≠ listing — the steward lands UNLISTED with an explicit self-add CTA.
  record('steward.self-add-cta', /steward this organization but aren.t listed/i.test(aBody), 'CTA shown');
  await shot(pageA, '10-A-channels');

  // ── Flow 2: posting is LISTING-gated — the unlisted steward's post is refused ──
  const gated = await post(pageA, 'too early — A is not listed yet');
  record('gate.steward-post-unlisted', !gated.ok && /join this community first/i.test(gated.detail), gated.detail);

  // ── Flow 3: steward self-add ("Add yourself as member", display name prefilled) ──
  await pageA.getByRole('button', { name: /Add yourself as member/i }).first().click().catch(() => {});
  let aListed = false;
  for (let i = 0; i < 10; i++) {
    await pageA.waitForTimeout(4000);
    if ((await memberCount(pageA)) >= 1) { aListed = true; break; }
  }
  record('steward.self-add', aListed, `members after self-add: ${await memberCount(pageA)}`);
  await shot(pageA, '11-A-selfadd');

  // ── Flow 4: steward posts in #general (now listed) ──────────────────────────
  const msg1 = 'welcome to general — A';
  const p1 = await post(pageA, msg1);
  record('post.steward', p1.ok, p1.detail);
  await shot(pageA, '12-A-posted');

  // ── Flow 5: steward creates a channel (＋ → topic → Create; sidebar may lag the read-back) ──
  await pageA.locator('button[title="New topic"]').first().click().catch(() => {});
  await pageA.waitForTimeout(1000);
  const topic = pageA.getByPlaceholder(/Topic, e\.g\./).first();
  if (await topic.count()) {
    await topic.fill('announcements');
    await pageA.getByRole('button', { name: 'Create', exact: true }).first().click().catch(() => {});
    record('channel.create.steward', await openChannel(pageA, 'announcements'), 'announcements in sidebar (waited for read-back)');
  } else record('channel.create.steward', false, 'no topic input after ＋');
  await shot(pageA, '13-A-new-channel');

  // ── Flow 6: per-channel isolation — post lands only in its channel ──────────
  const msg2 = 'first announcement — A';
  const p2 = await post(pageA, msg2);              // announcements opened above
  record('post.second-channel', p2.ok, p2.detail);
  await openChannel(pageA, 'general');
  const sawMsg1 = await readInThread(pageA, msg1);   // wait for the per-channel read to land first
  const generalThread = await thread(pageA).innerText().catch(() => '');
  record('channel.isolation', sawMsg1 && !generalThread.includes(msg2), '#general holds msg1 only');
  await shot(pageA, '14-A-isolation');

  // ── Flow 7: non-member gate — B sees "Request to join", not the messages (spec §12) ──
  await pageB.goto(`${B.origin}/org/${orgAddr}/discussions`);
  await pageB.waitForTimeout(6000);
  const bGate = await bodyOf(pageB);
  record('gate.request-card', /Request to join/i.test(bGate), 'request-to-join card shown (Sign & join is gone)');
  record('gate.no-leak', !bGate.includes(msg1), 'topic messages hidden from non-member');
  await shot(pageB, '15-B-gate');

  // ── Flow 8: B requests to join — a MembershipApplication delivered to the org's inbox (spec §7) ──
  await pageB.getByRole('button', { name: /^Request to join$/i }).first().click().catch(() => {});
  let requested = false; let requestDetail = 'no "Application sent" confirmation';
  for (let i = 0; i < 12; i++) {
    await pageB.waitForTimeout(3000);
    const b = await bodyOf(pageB);
    if (/Application sent/i.test(b)) { requested = true; break; }
    // THE WIRE CEREMONY. Applying rides the messaging wire (spec 341 §5.5a), so a first-time applicant is
    // refused with `wire_absent` and offered a one-signature approval — exactly as a first message is.
    // This test predated that change and only waited for the confirmation, so it read a RESOLVABLE refusal
    // as a failure. (The product half was worse: the affordance was not rendered at all, and the 403 poll
    // wiped the error, so a real applicant saw a button that did nothing. Fixed separately.)
    const approve = pageB.getByRole('button', { name: /^Approve$/ }).first();
    if (await approve.count().catch(() => 0)) {
      console.log('[B] wire approval offered — signing it, then re-requesting');
      await approve.click().catch(() => {});
      await pageB.waitForTimeout(6000);
      // Re-press: the refused request was never delivered, so approving alone sends nothing.
      await pageB.getByRole('button', { name: /^Request to join$/i }).first().click().catch(() => {});
      continue;
    }
    if (/error|failed/i.test(b) && !/Request to join/i.test(b)) { requestDetail = b.slice(0, 180); break; }
  }
  record('apply.requested', requested, requested ? 'application sent to the org' : requestDetail);

  // DIAGNOSTIC, not an assertion. `apply.requested` only proves the A2A message was ACCEPTED — the skill
  // runs asynchronously on the org's side, so a failure there is invisible to the sender. Whether the org's
  // applications doc actually received the row separates "the append never landed" from "the panel did not
  // render it": the two explanations for an empty Members queue, and they lead in opposite directions.
  //
  // CAPTURED FROM THE PAGE'S OWN REQUEST, not manufactured. `applications.get` is steward-facing and needs a
  // stewardship delegation in the body; a hand-built `fetch({})` earned a `401 bridge envelope missing`,
  // which said nothing about the append and everything about my request. The Members page already makes
  // this call correctly, so listening is both easier and more truthful than reconstructing it.
  pageA.on('response', async (r) => {
    if (!/applications\.get/.test(r.url())) return;
    console.log(`[probe] applications.get → ${r.status()} :: ${(await r.text().catch(() => '')).slice(0, 240)}`);
  });

  await shot(pageB, '16-B-requested');

  // ── Flow 9: A (steward) approves the pending request from Members (delivery to org inbox can lag) ──
  let approved = false; let approveDetail = 'no pending request appeared in Members';
  for (let attempt = 0; attempt < 8 && !approved; attempt++) {
    await pageA.goto(`${A.origin}/org/${orgAddr}/members`);
    // WAIT FOR THE CONTROL, do not sleep at it. The panel needs TWO sequential fetches before it can
    // render: `useManagedAgents` (to find the org's stewardship delegation) and only then
    // `applications.get`. A flat 5s regularly expired between them — the instrumented run showed the
    // successful 200 arriving AFTER the leg had already been recorded as failed, which is a race in the
    // test reported as a missing queue in the product.
    const approveBtn = pageA.getByRole('button', { name: 'Approve', exact: true }).first();
    await approveBtn.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
    if (await approveBtn.count()) {
      await approveBtn.click().catch(() => {});
      // 30s WAS TOO SHORT, and the evidence says the approval SUCCEEDS meanwhile. `decide` signs the
      // member-access grant, then sends the Join-link notice — which for an org with no messaging wire
      // is itself a ceremony — and only then sets the note. Probing the org's applications doc showed the
      // row DROPPED (which only `decide` does, after the decision) on runs the test recorded as failed.
      // So the old window was reporting a slow success as a failure, and the "the doc mysteriously goes
      // empty" finding I reported earlier was this: the drop working exactly as designed.
      for (let i = 0; i < 30; i++) {
        await pageA.waitForTimeout(3000);
        const b = await bodyOf(pageA);
        if (/Approved — the applicant was sent a Join link/i.test(b)) { approved = true; break; }
        // The queue emptying is the same fact from the other side — `dropOrgApplication` runs only after
        // the decision, so an empty panel means the approval landed even if the note is still pending.
        if (!/Pending join requests/i.test(b) && i > 2) { approved = true; break; }
        if (/error|failed/i.test(b) && !/Approve/.test(b)) { approveDetail = b.slice(0, 180); break; }
      }
      break;
    }
    console.log(`[A] approve attempt ${attempt + 1}: pending request not delivered yet`);
  }
  record('steward.approve', approved, approved ? 'steward approved the request' : approveDetail);
  await shot(pageA, '17-A-approved');

  // OPEN — `join.member`, with the evidence narrowed but the cause NOT found (2026-08-05).
  //
  // Ruled out by a verification run against the deployed hardening: the member-access grant is NOT failing
  // to sign. `OrgApplicationsPanel.decide` now THROWS when the sign fails, and that error never appeared —
  // so the grant was signed and posted to `/connect/org-decide`, which returned no error either.
  //
  // What still happens:
  //   [B http-403] /connect/directory :: {"error":"this organization has not authorized you to join —
  //                 an invite (member-access grant) or stewardship is required"}
  //
  // So the grant is signed and accepted on the A side, and invisible to the gate on the B side. The next
  // place to look is what `/connect/org-decide` PERSISTS versus what `/connect/directory` publish READS —
  // a mismatch there fits every observation. Do not assume the sign is at fault; that hypothesis has been
  // tested and is wrong.
  // ── Flow 10: B completes membership — publishes the listing over the granted access (as a consequence) ──
  await pageB.goto(`${B.origin}/org/${orgAddr}/discussions`);
  await pageB.waitForTimeout(6000);
  const joinInput = pageB.getByPlaceholder(/Display name/i).first();
  if (await joinInput.count()) await joinInput.fill('Member B').catch(() => {});
  // WAIT FOR THE CONTROL, and do NOT swallow the click. The same defect that hid `steward.approve`: a
  // flat sleep, then a `.catch(() => {})` that turns "the button was not there" into silence. B's page
  // must first see the member-access grant the steward just signed, which arrives on its own schedule.
  const completeBtn = pageB.getByRole('button', { name: /Sign & complete membership/i }).first();
  await completeBtn.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
  if (await completeBtn.count()) {
    await completeBtn.click();
  } else {
    // Recorded, not swallowed: "the CTA never appeared" and "the join failed" are different findings.
    console.log(`[B] no "Sign & complete membership" control after 45s :: ${(await bodyOf(pageB)).slice(0, 160)}`);
  }
  let bJoined = false; let joinDetail = '';
  for (let i = 0; i < 12; i++) {
    await pageB.waitForTimeout(4000);
    const b = await bodyOf(pageB);
    if (/error|failed/i.test(b) && !/(Participants|Members) · /.test(b) && !/Request to join/i.test(b)) { joinDetail = b.slice(0, 200); break; }
    if (!/Request to join/i.test(b) && /general/i.test(b)) { bJoined = true; break; }
  }
  record('join.member', bJoined, bJoined ? 'B is in — topics visible' : joinDetail);
  await shot(pageB, '17-B-joined');

  // ── Flow 11: B reads the steward's messages (bodies decrypt over the org vault) ──
  await openChannel(pageB, 'general');
  record('read.member', await readInThread(pageB, msg1), 'B sees A\'s #general post');
  await openChannel(pageB, 'announcements');
  record('read.second-channel', await readInThread(pageB, msg2), 'B sees announcements post');
  await shot(pageB, '18-B-reads');

  // ── Flow 12: B posts (posting is listing-gated — B now holds a current listing) ──
  await openChannel(pageB, 'general');
  const msg3 = 'thanks for the invite — B';
  const p3 = await post(pageB, msg3);
  record('post.member', p3.ok, p3.detail);
  await shot(pageB, '19-B-posted');

  // ── Flow 13: cross-user read-back + roster ──────────────────────────────────
  await pageA.reload();
  await pageA.waitForTimeout(8000);
  await openChannel(pageA, 'general');
  aBody = await bodyOf(pageA);
  record('read.cross-user', await readInThread(pageA, msg3), 'A sees B\'s post');
  record('roster.two-members', (await memberCount(pageA)) === 2 && /Member B/i.test(aBody), `members=${await memberCount(pageA)}`);
  await shot(pageA, '20-A-crossread');

  // ── Flow 14: a LISTED MEMBER may create a channel (create is listing-or-steward) ──
  await pageB.locator('button[title="New topic"]').first().click().catch(() => {});
  await pageB.waitForTimeout(1000);
  const topicB = pageB.getByPlaceholder(/Topic, e\.g\./).first();
  if (await topicB.count()) {
    await topicB.fill('member-corner');
    await pageB.getByRole('button', { name: 'Create', exact: true }).first().click().catch(() => {});
    record('channel.create.member', await openChannel(pageB, 'member-corner'), 'member-created channel appears (waited for read-back)');
  } else record('channel.create.member', false, 'no topic input for B');
  await shot(pageB, '21-B-channel');

  // ── Flow 14b: PRIVATE topic (spec §10) — A creates one WITHOUT B; A sees it, B must NOT ──
  await pageA.goto(`${A.origin}/org/${orgAddr}/discussions`);
  await pageA.waitForTimeout(4000);
  await pageA.locator('button[title="New topic"]').first().click().catch(() => {});
  await pageA.waitForTimeout(1000);
  const topicP = pageA.getByPlaceholder(/Topic, e\.g\./).first();
  let privateCreated = false;
  if (await topicP.count()) {
    await topicP.fill('founders-only');
    // Toggle Private (don't check B in the member list → B is excluded), then create.
    await pageA.getByRole('checkbox', { name: /Private/i }).first().check().catch(() => {});
    await pageA.waitForTimeout(500);
    await pageA.getByRole('button', { name: /Create private topic/i }).first().click().catch(() => {});
    privateCreated = await openChannel(pageA, 'founders-only');
  }
  record('private.create', privateCreated, privateCreated ? 'A created + sees the private topic' : 'private topic not created/visible to A');
  await shot(pageA, '21a-A-private');

  await pageB.goto(`${B.origin}/org/${orgAddr}/discussions`);
  await pageB.waitForTimeout(6000);
  const bSeesPrivate = await pageB.locator('.channels-sidebar__item').filter({ hasText: 'founders-only' }).count();
  record('private.hidden-from-nonmember', bSeesPrivate === 0, bSeesPrivate === 0 ? 'B does not see the private topic' : 'LEAK: B sees the private topic');
  await shot(pageB, '21b-B-private-hidden');

  // ── Flow 15: member→DM slide-over from the channel roster (Telegram pattern) ──
  // A's roster displayName may be the name label or a profile name — prefer the label match, else
  // any row that isn't B's own ("(you)").
  let aRow = pageB.locator('.channels-member-row__main').filter({ hasText: new RegExp(nameA, 'i') }).first();
  if (!(await aRow.count())) aRow = pageB.locator('.channels-member-row__main').filter({ hasNotText: '(you)' }).first();
  const dmText = 'DM from the channel — B';
  let dmSent = false; let dmDetail = 'no roster row for A';
  if (await aRow.count()) {
    await aRow.click().catch(() => {});
    await pageB.waitForTimeout(2000);
    const dialog = pageB.getByRole('dialog').first();
    if (await dialog.count()) {
      // recipient resolves via KB — retry if the lookup raced
      for (let i = 0; i < 5; i++) {
        const retry = dialog.getByRole('button', { name: /Try again/i }).first();
        if (await retry.count()) { await retry.click().catch(() => {}); await pageB.waitForTimeout(3000); continue; }
        break;
      }
      const dmComposer = dialog.locator('textarea').first();
      if (await dmComposer.count() && !(await dmComposer.isDisabled().catch(() => true))) {
        await dmComposer.fill(dmText);
        await dmComposer.press('Enter');
        dmSent = true; // send accepted; the echo below is informational, delivery is Flow 14
        let echoed = false;
        for (let i = 0; i < 8; i++) {  // slide-over thread refreshes on the 5s inbox poll
          await pageB.waitForTimeout(4000);
          if ((await dialog.innerText().catch(() => '')).includes(dmText)) { echoed = true; break; }
        }
        dmDetail = echoed ? 'sent + echoed in slide-over thread' : 'sent (no echo in slide-over yet)';
      } else dmDetail = 'DM composer missing or disabled (recipient unresolved)';
    } else dmDetail = 'slide-over dialog did not open';
  }
  record('dm.slide-over', dmSent, dmDetail);
  await shot(pageB, '22-B-dm');

  // ── Flow 16: the channel-originated DM actually reaches A's inbox ───────────
  await pageA.goto(`${A.origin}/messages`);
  let dmArrived = false;
  for (let i = 0; i < 6; i++) {
    await pageA.waitForTimeout(6000);
    if ((await bodyOf(pageA)).includes(dmText)) { dmArrived = true; break; }
    await pageA.reload();
  }
  record('dm.delivered', dmArrived, dmArrived ? 'A sees the DM in Messages' : 'DM not in A inbox after ~40s');
  await shot(pageA, '23-A-dm-inbox');

  summary();
});

function summary() {
  console.log('\n========== CHANNEL FLOW RESULTS ==========');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.flow} — ${r.detail}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} channel flows passed`);
}
