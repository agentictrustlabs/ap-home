import { test, expect, type Page } from '@playwright/test';
import { CAST, onboardPersona, type DemoPersona } from './demo-user';
import { estateDomain } from './estate';

// THE STABLE CAST, PUTTING REAL HISTORY THROUGH THE SUBSTRATE.
//
// Every other spec here onboards a throwaway identity, so every other spec tests the EMPTY case: an inbox
// with one message, a library with one item, a work surface with one request. That is the easy half. This
// one drives a fixed cast whose homes persist between runs, so what it exercises grows — which is the only
// way "does this still work when the inbox is not trivial" ever gets asked.
//
// WHY IT MATTERS NOW. The gateway adoption shadow (ADR-0060) compares two planes reading one `inbox.data`
// document and records whether they agree. Comparing two EMPTY documents proves close to nothing; the
// interesting comparisons are long envelope arrays, populated `cards`, mixed read-state. This spec is the
// traffic that produces those, and the `raced` classification only earns its keep once deliveries are
// actually landing while reads are in flight.
//
// IT IS NOT A PASS/FAIL GATE FOR THE PRODUCT. Each leg records what happened and the run reports the set;
// a library that will not load is a real finding, but it must not mask the messaging leg behind it. The
// hard assertion is the one thing that would invalidate everything after it: the cast must sign in.
//
// TESTNET, PRODUCTION HOME. Real SIWE, real Smart Agents, real vault writes on Base Sepolia.

const results: Array<{ leg: string; ok: boolean; detail: string }> = [];
const record = (leg: string, ok: boolean, detail = ''): void => {
  results.push({ leg, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${leg}${detail ? ` — ${detail}` : ''}`);
};

async function bodyOf(p: Page): Promise<string> {
  return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ');
}
const shot = (p: Page, n: string) => p.screenshot({ path: `artifacts/cast-${n}.png`, fullPage: true }).catch(() => {});

function httpLog(p: Page, who: string): void {
  p.on('response', async (r) => {
    if (/\/(connect|a2a)\//.test(r.url()) && r.status() >= 400) {
      const t = (await r.text().catch(() => '')).slice(0, 180);
      console.log(`[${who} http-${r.status()}] ${r.url().replace(/https:\/\/[a-z0-9.-]+\.faithnet\.(me|io|ai)/, '')} :: ${t}`);
    }
  });
}

/** Give a just-claimed name time to reach the discovery KB. A send cannot proceed without a resolved
 *  recipient, and pressing on regardless reports a messaging failure for a discovery delay. */
async function findRecipient(p: Page, name: string): Promise<boolean> {
  const search = p.getByPlaceholder(/name|search|who/i).first();
  await search.fill(name).catch(() => {});
  await p.getByRole('button', { name: /^Search$/i }).first().click().catch(() => {});
  for (let i = 0; i < 8; i++) {
    await p.waitForTimeout(4000);
    if (new RegExp(name, 'i').test(await bodyOf(p))) return true;
  }
  return false;
}

test('the demo cast accumulates real chat, library and work-item history', async ({ browser }) => {
  test.setTimeout(1_800_000);
  const stamp = new Date().toISOString().slice(0, 16);

  const open = async (p: DemoPersona) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    httpLog(page, p.name);
    const home = await onboardPersona(page, p);
    return { page, home };
  };

  const ada = await open(CAST.ada);
  const bo = await open(CAST.bo);
  console.log(`ada=${CAST.ada.address} bo=${CAST.bo.address}`);

  // The ONE hard assertion. Everything below reads a signed-in home; without it every later leg would
  // fail for the same upstream reason and the report would be noise claiming to be findings.
  expect(ada.home.origin, 'ada never reached a home').toContain(estateDomain());
  expect(bo.home.origin, 'bo never reached a home').toContain(estateDomain());

  // ── CHAT: ada → bo, then bo replies ─────────────────────────────────────────────────────────────
  // Two directions, because a one-way send leaves the sender's inbox holding only sent items and the
  // recipient's only received ones — neither is the mixed document the shadow comparison cares about.
  await ada.page.goto(`${ada.home.origin}/messages`);
  await ada.page.waitForTimeout(5000);
  await ada.page.getByRole('button', { name: /Compose|New message/i }).first().click().catch(() => {});
  await ada.page.waitForTimeout(1500);

  if (await findRecipient(ada.page, CAST.bo.name)) {
    await ada.page.getByText(new RegExp(CAST.bo.name, 'i')).first().click().catch(() => {});
    await ada.page.waitForTimeout(1000);
    await ada.page.getByPlaceholder(/Write your message/i).first().fill(`ada → bo, ${stamp}`).catch(() => {});
    // THE SELECTOR THAT ACTUALLY WORKS, copied from `messaging-send.spec.ts` rather than guessed. My
    // first version matched on the accessible name and the `➤` glyph and found nothing — the control is
    // `button.chat-send-btn`. Guessing at a selector and asserting it is visible converts a wrong guess
    // into a product failure, which is the more expensive of the two mistakes.
    const send = ada.page.locator('button.chat-send-btn, button[aria-label="Send message"]').first();
    await expect(send, 'send control not found').toBeVisible({ timeout: 20_000 });
    await send.click();
    await ada.page.waitForTimeout(6000);

    // FIRST RUN ONLY. A cast member who has never messaged this counterparty holds no wire, so the agent
    // refuses and offers the one-prompt ceremony. On every LATER run the wire is already custodied and no
    // affordance appears — which is precisely the accumulation these stable identities exist for, so its
    // absence is a pass, not a miss.
    const approve = ada.page.getByRole('button', { name: /^Approve$/ }).first();
    if (await approve.count().then((c) => c > 0)) {
      console.log('[ada] no wire yet — running the approval ceremony');
      await approve.click();
      for (let i = 0; i < 24; i++) {
        await ada.page.waitForTimeout(5000);
        if (/sent|delivered/i.test(await bodyOf(ada.page))) break;
      }
    }
    const b = await bodyOf(ada.page);
    record('chat.send', /sent|delivered/i.test(b), b.slice(0, 120));
    await shot(ada.page, 'ada-sent');
  } else {
    record('chat.send', false, `bo (${CAST.bo.name}) never appeared in discovery — not a messaging fault`);
  }

  await bo.page.goto(`${bo.home.origin}/messages`);
  await bo.page.waitForTimeout(8000);
  const boInbox = await bodyOf(bo.page);
  // THE SENDER'S NAME, not /message/i — which the "Messages" NAV ITEM satisfies whether mail arrived or
  // not. That assertion has been reporting a pass for a possibly-empty inbox; `substrate-invariants`
  // caught it by finding zero envelopes for a persona this leg had just called a receiver.
  record('chat.receive', new RegExp(CAST.ada.name, 'i').test(boInbox), boInbox.slice(0, 120));
  await shot(bo.page, 'bo-inbox');

  // ── LIBRARY ─────────────────────────────────────────────────────────────────────────────────────
  await ada.page.goto(`${ada.home.origin}/library`);
  await ada.page.waitForTimeout(6000);
  const lib = await bodyOf(ada.page);
  record('library.load', !/went wrong|error|failed/i.test(lib), lib.slice(0, 120));
  await shot(ada.page, 'ada-library');

  // ── WORK ITEMS — the coordination substrate (spec 332/334) ──────────────────────────────────────
  // The most interesting leg for the interaction substrate: a request is a governed situation, not a
  // message, so it exercises the case/decision path rather than the delivery path.
  await ada.page.goto(`${ada.home.origin}/work`);
  await ada.page.waitForTimeout(6000);
  const workBefore = await bodyOf(ada.page);
  record('work.surface', !/went wrong|error/i.test(workBefore), workBefore.slice(0, 120));

  await ada.page.getByRole('button', { name: /^New request$/ }).first().click().catch(() => {});
  await ada.page.waitForTimeout(2000);
  const title = ada.page.getByPlaceholder(/title|summary|what/i).first();
  if (await title.isVisible().catch(() => false)) {
    await title.fill(`cast request ${stamp}`).catch(() => {});
    await ada.page.getByRole('button', { name: /^Send request$/ }).first().click().catch(() => {});
    await ada.page.waitForTimeout(10_000);
    const after = await bodyOf(ada.page);
    record('work.request', /Request sent|created|submitted/i.test(after), after.slice(0, 140));
  } else {
    // Reported, not skipped. "The composer needed an org I have not joined" and "the button is broken"
    // are different findings, and a silent skip renders them identical.
    record('work.request', false, 'request composer did not open — needs an org context this cast may not have');
  }
  await shot(ada.page, 'ada-work');

  // ── The shadow needs POLLS, not just writes ─────────────────────────────────────────────────────
  // Sampling is one shadow per principal per minute, so a run that writes and leaves produces at most
  // one comparison. Sitting on /messages for several minutes is what actually generates the evidence.
  for (const who of [ada, bo]) await who.page.goto(`${who.home.origin}/messages`).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await ada.page.waitForTimeout(60_000);
    console.log(`[poll] minute ${i + 1}/4 — inbox.get shadows sampling`);
  }
  record('shadow.polls', true, '~4 sampling windows per principal');

  console.log('\n── cast run ──');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.leg}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} legs passed`);
});
