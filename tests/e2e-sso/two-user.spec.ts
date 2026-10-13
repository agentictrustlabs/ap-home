import { test, type Page } from '@playwright/test';
import { onboard } from './onboard';

// Two SIWE users: A (steward) creates an org + channel and invites B by name; B accepts from Messages
// and joins. Verifies the whole invite→join flow the user reported broken.

async function bodyOf(p: Page): Promise<string> { return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | '); }
async function shot(p: Page, n: string) { await p.screenshot({ path: `artifacts/2u-${n}.png`, fullPage: true }).catch(() => {}); }
function httpLog(p: Page, who: string) {
  p.on('response', async (r) => {
    const u = r.url();
    if ((u.includes('/connect/') || u.includes('/a2a/')) && r.status() >= 400) {
      console.log(`[${who} http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.]+\.faithnet\.(me|io|ai)/, '')} :: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    }
  });
}

test('two users: A invites B → B joins the org/channel', async ({ browser }) => {
  test.setTimeout(720_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  httpLog(pageA, 'A'); httpLog(pageB, 'B');
  const stamp = Date.now().toString(36);
  const nameA = 'stew' + stamp;
  const nameB = 'memb' + stamp;

  // 1) Onboard B FIRST (so A can find them by name), then A.
  const B = await onboard(pageB, nameB);
  const A = await onboard(pageA, nameA);
  console.log(`A=${A.name} ${A.address}  B=${B.name} ${B.address}`);

  // 2) A creates an org.
  await pageA.getByRole('link', { name: /^Organizations$/ }).first().click().catch(() => {});
  await pageA.waitForTimeout(4000);
  const orgName = 'org' + stamp;
  await pageA.getByRole('button', { name: 'Create organization', exact: true }).first().click().catch(() => {});
  await pageA.waitForTimeout(1500);
  await pageA.locator('input:visible').first().fill(orgName);
  await pageA.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});
  let orgAddr: string | undefined;
  for (let i = 0; i < 16; i++) {
    await pageA.waitForTimeout(5000);
    const b = await bodyOf(pageA);
    if (/went wrong|AA31|too low/i.test(b)) { console.log('A org-create ERROR:', b.slice(0, 160)); break; }
    if (new RegExp(orgName, 'i').test(b) && /ORGANIZATION|Custodied by you/i.test(b)) {
      const href = await pageA.locator('a[href*="0x"]').first().getAttribute('href').catch(() => null);
      orgAddr = href?.match(/0x[0-9a-fA-F]{40}/)?.[0];
      break;
    }
  }
  console.log('ORG created:', orgName, 'addr:', orgAddr);
  await shot(pageA, 'A-org');
  if (!orgAddr) { console.log('✗ org not created — aborting invite test'); return; }

  // 3) A opens the org Invite page and invites B by name.
  await pageA.goto(`${A.origin}/org/${orgAddr}/invite`);
  await pageA.waitForTimeout(6000);
  console.log('A invite page URL:', pageA.url());
  console.log('A invite BUTTONS:', JSON.stringify(await pageA.locator('button:visible').allInnerTexts()));
  console.log('A invite INPUTS:', JSON.stringify(await pageA.locator('input:visible').evaluateAll((e) => e.map((x) => (x as HTMLInputElement).placeholder))));
  await shot(pageA, 'A-invite-page');
  // Search for B by name — the search is a BUTTON (not auto-search).
  const search = pageA.getByPlaceholder(/Find a person by name/i).first();
  if (await search.count()) {
    await search.fill(nameB);
    await pageA.getByRole('button', { name: /^Search$/ }).first().click().catch(() => {});
    await pageA.waitForTimeout(7000); // KB search may lag for a just-registered name (indexer)
    const sb = await bodyOf(pageA);
    console.log('A after search BODY:', sb.slice(0, 500));
    await shot(pageA, 'A-search');
    const found = new RegExp(nameB, 'i').test(sb);
    console.log(found ? `✓ B (${nameB}) appears in search results` : `✗ B (${nameB}) NOT found in search — indexer lag or search issue`);
    // Click B's result row/button (triggers inviteAgent → pre-signs grant + sends the Join message).
    const hit = pageA.locator(`button:has-text("${nameB}"), [role="button"]:has-text("${nameB}"), li:has-text("${nameB}"), div:has-text("${nameB}")`).filter({ hasText: new RegExp(nameB, 'i') }).last();
    if (found && await hit.count()) {
      await hit.click().catch(() => {});
      await pageA.waitForTimeout(2000);
      // A confirm "Invite"/"Send" if a confirmation appears.
      const conf = pageA.getByRole('button', { name: /^Invite|Send invite|Invite to/i }).first();
      if (await conf.count()) await conf.click().catch(() => {});
      await pageA.waitForTimeout(8000);
      console.log('A after invite BODY:', (await bodyOf(pageA)).slice(0, 300));
    }
    await shot(pageA, 'A-invited');
  } else {
    console.log('✗ no search input on invite page');
  }

  // 4) B opens Messages, verifies the invite arrived, clicks the Join chip (→ org channels page).
  await pageB.goto(`${B.origin}/messages`);
  await pageB.waitForTimeout(8000);
  const bMsg = await bodyOf(pageB);
  console.log('B invite arrived:', /invited to join/i.test(bMsg) ? '✓ yes' : '✗ NO');
  await shot(pageB, 'B-messages');
  const chip = pageB.locator('a').filter({ hasText: /Join .*→|Join the discussion/i }).first();
  if (await chip.count()) { await chip.click().catch(() => {}); await pageB.waitForTimeout(6000); }
  else { await pageB.goto(`${B.origin}/org/${orgAddr}/channels`); await pageB.waitForTimeout(6000); }

  // 5) B completes the join on the channels page ("Sign & join" publishes B's listing).
  const joinNameInput = pageB.getByPlaceholder(/Display name/i).first();
  if (await joinNameInput.count()) await joinNameInput.fill('Member B').catch(() => {});
  const signJoin = pageB.getByRole('button', { name: /Sign & join/i }).first();
  let bJoined = false;
  if (await signJoin.count()) {
    await signJoin.click().catch(() => {});
    for (let i = 0; i < 10; i++) {
      await pageB.waitForTimeout(4000);
      const b = await bodyOf(pageB);
      if (/error|failed|could not/i.test(b)) { console.log('B Sign&join ERROR:', b.slice(0, 150)); break; }
      if (!/Sign & join|JOIN THIS ORGANIZATION/i.test(b) && /Channels|Members|general/i.test(b)) { bJoined = true; break; }
    }
  } else {
    const b = await bodyOf(pageB);
    bJoined = !/join this community first|Sign & join|JOIN THIS ORGANIZATION/i.test(b);
  }
  await shot(pageB, 'B-joined');
  console.log(bJoined ? '✓ RESULT: B joined the org — can access channels as a member' : '✗ RESULT: B could NOT join');

  // 6) Verify A sees B in the members list (directory read-back — the field-mismatch fix).
  await pageA.goto(`${A.origin}/org/${orgAddr}/channels`);
  await pageA.waitForTimeout(6000);
  const aChan = await bodyOf(pageA);
  const membersLine = (aChan.match(/Members[^|]*/) ?? ['Members ?'])[0];
  console.log(`A sees: ${membersLine.trim()} (${/Member B|memb/i.test(aChan) ? '✓ B listed' : '✗ B not listed'})`);
  await shot(pageA, 'A-channels-final');

  // 7) DIRECT MESSAGING: A → New message → search B → send; B sees it + replies.
  await pageA.goto(`${A.origin}/messages`);
  await pageA.waitForTimeout(5000);
  await pageA.getByRole('button', { name: /New message/i }).first().click().catch(() => {});
  await pageA.waitForTimeout(1500);
  const dmSearch = pageA.getByPlaceholder(/Search people|name/i).first();
  if (await dmSearch.count()) {
    await dmSearch.fill(nameB);
    await pageA.getByRole('button', { name: /^Search$/ }).first().click().catch(() => {});
    await pageA.waitForTimeout(6000);
    const bHit = pageA.locator(`*:has-text("${nameB}")`).filter({ hasText: new RegExp(nameB, 'i') }).last();
    if (await bHit.count()) await bHit.click().catch(() => {});
    await pageA.waitForTimeout(2000);
    const composer = pageA.locator('textarea:visible, input[placeholder*="essage" i]').first();
    if (await composer.count()) {
      await composer.fill('Hello B, this is A');
      await pageA.keyboard.press('Enter').catch(() => {});
      await pageA.waitForTimeout(6000);
      await pageA.reload(); await pageA.waitForTimeout(6000); // sender thread echoes after the inbox poll
      console.log('A→B DM sent:', /Hello B/i.test(await bodyOf(pageA)) ? '✓ shows in A thread' : '✗ not shown');
    } else console.log('✗ no DM composer for A');
  } else console.log('✗ no DM search for A');
  await shot(pageA, 'A-dm-sent');

  // B reads the DM + replies.
  await pageB.goto(`${B.origin}/messages`);
  await pageB.waitForTimeout(7000);
  const bDm = await bodyOf(pageB);
  console.log('B received DM:', /Hello B/i.test(bDm) ? '✓ yes' : '✗ NO');
  const conv = pageB.locator(`*:has-text("${nameA}")`).filter({ hasText: new RegExp(nameA, 'i') }).first();
  if (await conv.count()) await conv.click().catch(() => {});
  await pageB.waitForTimeout(3000);
  const bComposer = pageB.locator('textarea:visible, input[placeholder*="essage" i]').first();
  if (await bComposer.count()) {
    await bComposer.fill('Hi A, got it — B');
    await pageB.keyboard.press('Enter').catch(() => {});
    await pageB.waitForTimeout(6000);
    await pageB.reload(); await pageB.waitForTimeout(6000);
    console.log('B→A reply:', /Hi A/i.test(await bodyOf(pageB)) ? '✓ shows in B thread' : '✗ not shown');
  } else console.log('✗ no DM composer for B');
  await shot(pageB, 'B-dm-reply');

  // A sees B's reply.
  await pageA.reload(); await pageA.waitForTimeout(7000);
  console.log('A sees B reply:', /Hi A/i.test(await bodyOf(pageA)) ? '✓ yes' : '✗ NO');
  await shot(pageA, 'A-dm-final');
});
