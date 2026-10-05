/**
 * A PERSON'S HOLD'EM STYLE, in their own words, into their own vault — `cardroom.style`, the record their coach
 * service reads under the study grant and is bound to respect (`apps/agent-runtime/src/card-room.ts`).
 *
 *   npx tsx scripts/seed-cardroom-style.mts alice "raise or fold before the flop, never limp" "tell me the price first"
 *   npx tsx scripts/seed-cardroom-style.mts alice --read "Sharkbot" "his turn bet is always real"
 *   npx tsx scripts/seed-cardroom-style.mts alice --clear-notes        (drop the coach's notes from her cabinet)
 *
 * Written the way the person would write it: their own session, their own record (`record.put`, self-access
 * only). The style outranks the coach's craft; a read is the person's own note on a player. Neither is
 * authority, and neither is ever copied to the coach — it reads them at her vault.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const argvAll = process.argv.slice(2);
// ONE CABINET PER GAME: `--game canasta` seeds `cardroom.canasta.style` (and .read/.note); the default is hold'em's bare names.
const GAME = argvAll.includes('--game') ? String(argvAll[argvAll.indexOf('--game') + 1]).toLowerCase() : 'poker';
const argv = argvAll.filter((a, i, all) => a !== '--game' && all[i - 1] !== '--game' && a !== '--profile' && all[i - 1] !== '--profile');
const REC = (name: string) => `cardroom.${GAME === 'poker' ? '' : `${GAME}.`}${name}`;
const handle = argv[0];
/** `--profile '<json>'` writes the person's PLAYER PROFILE (cardroom.profile, one across games): {coachingStyle, experience, goals, about}. */
const profileJson = argvAll.includes('--profile') ? argvAll[argvAll.indexOf('--profile') + 1] : undefined;
const isRead = argv.includes('--read');
const clearNotes = argv.includes('--clear-notes');
if (!handle || (argv.length < 2 && !clearNotes && !profileJson)) { console.error('usage: seed-cardroom-style.mts <handle> "rule"… | <handle> --read "<player>" "<note>"'); process.exit(2); }
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const token: string = si.homeSession; const ME = String(si.agent ?? '').toLowerCase();
if (!token || !ME) throw new Error(`no session for ${handle}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const op = async (name: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a/interactions/${ME}/${name}`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, ...body }) }));
const now = new Date().toISOString();

if (profileJson) {
  const body = JSON.parse(profileJson) as Record<string, unknown>;
  const r = await op('record.put', { recordType: 'cardroom.profile', record: { type: 'ap.cardroom-profile.v1', ...body, updatedAt: now } });
  console.log(`${handle}.me cardroom.profile ← ${JSON.stringify(r).slice(0, 120)}`);
  const back = await op('record.get', { recordType: 'cardroom.profile' });
  console.log('  read back:', JSON.stringify(back).slice(0, 400));
} else if (clearNotes) {
  // The coach's notes are in HER cabinet and hers to clear — after a coach is fired, or after notes written
  // against probe hands rather than real ones (2026-09-12: a dozen notes about one synthetic hand).
  const r = await op('record.put', { recordType: REC('note'), record: { type: 'ap.cardroom-note.v1', entries: [], updatedAt: now } });
  console.log(`${handle}.me ${REC('note')} ← cleared: ${JSON.stringify(r).slice(0, 120)}`);
} else if (isRead) {
  const [about, note] = argv.filter((a) => a !== handle && a !== '--read');
  if (!about || !note) throw new Error('--read needs "<player>" "<note>"');
  const prev = (await op('record.get', { recordType: REC('read') })) as { record?: { reads?: Array<{ about: string; note: string; at: string }> } };
  const reads = [...(prev.record?.reads ?? []).filter((r) => r.about !== about), { about, note, at: now }];
  const r = await op('record.put', { recordType: REC('read'), record: { type: 'ap.cardroom-read.v1', reads, updatedAt: now } });
  console.log(`${handle}.me ${REC('read')} ← ${reads.length} read(s): ${JSON.stringify(r).slice(0, 120)}`);
} else {
  const rules = argv.slice(1);
  const r = await op('record.put', { recordType: REC('style'), record: { type: 'ap.cardroom-style.v1', rules, updatedAt: now } });
  console.log(`${handle}.me ${REC('style')} ← ${rules.length} rule(s): ${JSON.stringify(r).slice(0, 120)}`);
  const back = await op('record.get', { recordType: REC('style') });
  console.log(`  read back: ${JSON.stringify(back.record ?? back).slice(0, 300)}`);
}
