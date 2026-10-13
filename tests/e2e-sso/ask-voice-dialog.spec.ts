/**
 * THE VOICE DIALOG, END TO END IN THE BROWSER (spec 369).
 *
 * What is asserted is the LOOP, which is the thing that broke: a word spoken → the agent hears it → the
 * agent's reply is READ ALOUD (`reply.spoken`) → the mic reopens on its own → the next word goes the same
 * way — through a question, an authority card and a signature, to a done. The agent's ear is exercised live
 * elsewhere (a tone yields "" with ok:true); here the hear route is answered with the next scripted line, so
 * a synthetic microphone (an oscillator that "speaks" for 1.5 s then falls silent — built in the page,
 * because headless Chromium's fake capture device delivers silence) can drive real `/harness/ask` turns
 * against alice's live agent. The browser's speech engine is replaced by a recorder that finishes each
 * utterance after a short delay — headless Chromium has no voices, and a page whose `onend` never fires is
 * exactly the failure being hunted.
 *
 * The org-creation leg is the report that started this: "abc organization" was refused as a name, and the
 * approval had to be clicked. Now the label is derived from what was said, and "approve" is the click.
 */
import { test, expect, chromium } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const SUFFIX = Date.now().toString(36).slice(-5);

test('a spoken ask is answered aloud, the mic reopens, and an organization is created by saying approve', async ({ request }) => {
  test.setTimeout(420_000);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[browser]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.addInitScript(() => {
    // A speech engine that records and finishes. `window.__spoken` is what the page tried to say.
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    const queue: SpeechSynthesisUtterance[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [], // a plain object is not a SpeechSynthesisVoice; `pickVoice` has its own unit test
      addEventListener: () => undefined, removeEventListener: () => undefined,
      cancel() {
        if (timer) clearTimeout(timer); timer = null;
        const all = queue.splice(0); synth.speaking = false; synth.pending = false;
        for (const u of all) { const e = new Event('error') as Event & { error?: string }; e.error = 'interrupted'; u.dispatchEvent(e); }
      },
      next() {
        const u = queue[0];
        if (!u) { synth.speaking = false; synth.pending = false; return; }
        synth.speaking = true; synth.pending = queue.length > 1;
        u.dispatchEvent(new Event('start'));
        timer = setTimeout(() => { queue.shift(); timer = null; u.dispatchEvent(new Event('end')); synth.next(); }, Math.min(1_500, 100 + u.text.length * 5));
      },
      speak(u: SpeechSynthesisUtterance) {
        if (u.text) spoken.push(u.text);
        queue.push(u);
        if (!timer) synth.next(); else synth.pending = true;
      },
      pause() {}, resume() {},
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    // A microphone that speaks: 1.5 s of tone, then silence — one utterance per mic opening.
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      await ac.resume();
      const osc = ac.createOscillator(); osc.frequency.value = 220;
      const gain = ac.createGain(); gain.gain.value = 0.3;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest); osc.start();
      setTimeout(() => { gain.gain.value = 0; }, 1_500);
      return dest.stream;
    };
  });
  // The agent's ear, answered by the test: each recording is "heard" as the next scripted line.
  const lines = ['what teams am I a part of', `create an organization called voice test ${SUFFIX} organization`, 'Granted.', 'sure, go ahead', 'switch to the somali corridor team', 'can you switch me to missio nexus organization', 'switch to xyz m8iq', 'back to alice'];
  let heard = 0;
  await page.route('**/harness/hear', async (route) => {
    const body = route.request().postDataJSON() as { warm?: boolean };
    if (body?.warm) return route.fulfill({ json: { ok: true, warmed: true } });
    const transcript = lines[heard] ?? '';
    heard++;
    console.log('[hear]', JSON.stringify(transcript));
    return route.fulfill({ json: { ok: true, transcript, heard: transcript, repairs: [], timings: { vocabularyMs: 0, transcribeMs: 0 } } });
  });

  // What the agent answered, as it answered it — the diagnostic when a reply is not read aloud.
  page.on('response', async (r) => {
    if (!/\/harness\/ask/.test(r.url())) return;
    const j = await r.json().catch(() => null) as { reply?: { kind?: string; spoken?: string } } | null;
    console.log('[ask]', r.status(), j?.reply?.kind, JSON.stringify(j?.reply?.spoken ?? '').slice(0, 160));
  });
  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(signin.ok(), 'demo-signin').toBeTruthy();
  const { homeSession } = (await signin.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);
  await page.getByTestId('ask-toggle').click();
  await expect(page.getByTestId('ask-flyout')).toBeVisible();

  const spokenSoFar = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
  const status = page.getByTestId('ask-voice-status');
  const saidSince = async (n: number, re: RegExp, timeout: number) => {
    try {
      await expect.poll(async () => (await spokenSoFar()).slice(n).some((s) => re.test(s)), { timeout }).toBe(true);
    } catch (e) {
      console.log('[spoken so far]', JSON.stringify(await spokenSoFar()));
      console.log('[status]', await status.textContent().catch(() => '(none)'));
      console.log('[flyout]', (await page.getByTestId('ask-flyout').innerText()).slice(-900));
      throw e;
    }
    return (await spokenSoFar()).length;
  };

  // 1. Tap the mic once. That is the whole gesture: a word of welcome, the question, and the ear opens.
  await page.getByTestId('ask-mic').click();
  let n = await saidSince(0, /^hi.*what do you need\?$/i, 10_000);
  expect((await spokenSoFar())[0]).not.toMatch(/create|invite|send|you can/i); // no tour unless asked
  await expect(status).toContainText('Listening', { timeout: 10_000 });
  // 2. The mic "speaks"; the recording is heard; the ask runs; the answer is read aloud.
  n = await saidSince(n, /team/i, 120_000);
  console.log('[spoken 1]', JSON.stringify(await spokenSoFar()));
  // 3. The mic reopens on its own; the next line asks for an organization; the authority card is READ and
  //    asks for "approve"; the mic reopens for it.
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  n = await saidSince(n, /needs your authority to create organizations.*say approve/i, 120_000);
  await expect(page.getByTestId('ask-authority')).toBeVisible();
  // 4. "approve" is heard → granted (alice's key is Home-held) → the genesis signature prompt is read.
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  n = await saidSince(n, /sign the genesis of voice test \S+ dot org.*say approve/i, 180_000);
  console.log('[spoken 2]', JSON.stringify((await spokenSoFar()).slice(-3)));
  // 5. "approve" again → signed → submitted → done, said aloud. The label came from the words: the kind word
  //    "organization" dropped, the spaces hyphens. Spec 370 P2: while the acting turn runs, the agent SAYS
  //    what it is doing — the step's own words, not "one moment".
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await saidSince(n, /done|submitted|is live|in your agents/i, 240_000);
  const progress = (await spokenSoFar()).filter((s) => /checking your authority to create organizations|create organizations — done|authority confirmed/i.test(s));
  expect(progress.length, 'the run narrated at least one step aloud').toBeGreaterThan(0);
  // Each turn narrates its own steps once: a line never repeats inside one breath.
  for (const s of progress) expect(s, 'no line said twice in one breath').not.toMatch(/(Checking your authority to create organizations…)[\s\S]*\1/);
  console.log('[progress heard]', JSON.stringify(progress));
  console.log('[spoken 3]', JSON.stringify((await spokenSoFar()).slice(-3)));
  const flyout = await page.getByTestId('ask-flyout').innerText();
  expect(flyout, 'the organization is named from the spoken words').toContain(`voice-test-${SUFFIX}.org`);
  expect(flyout).not.toMatch(/not a valid organization name/i);
  // 6. "switch to …" moves the Ask — a surface act: the flyout stays up, the addressee follows, nothing
  //    reaches an agent. Alice stewards TWO teams answering to "somali corridor", so that one is a question;
  //    "xyz m8iq" names one team; "back to me" returns to her own realm.
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
  n = await saidSince(n, /which one — .*somali/i, 30_000);
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
  n = await saidSince(n, /now asking missio nexus/i, 30_000);
  await expect(page.getByTestId('ask-flyout')).toContainText(/Asking missio nexus/i, { timeout: 30_000 });
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(7);
  n = await saidSince(n, /now asking xyz-m8iq/i, 30_000);
  await expect(page.getByTestId('ask-flyout')).toContainText(/Asking xyz-m8iq/i, { timeout: 30_000 });
  await expect.poll(() => heard, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
  await saidSince(n, /now asking (alice|george)/i, 30_000);
  await expect(page.getByTestId('ask-flyout')).toContainText(/Asking (alice|george)/i, { timeout: 30_000 });
  // 7. The script is over: the ear hears nothing twice, says so once, and pauses rather than looping.
  await expect(status).toContainText(/tap 🎙 when you’re ready/, { timeout: 60_000 });
  await page.waitForTimeout(3_000);
  expect((await spokenSoFar()).filter((s) => /didn’t catch anything/.test(s)).length).toBe(1);
  await browser.close();
});
