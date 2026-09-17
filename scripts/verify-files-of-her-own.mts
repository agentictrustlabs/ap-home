/**
 * Spec 405 — FILES OF HER OWN, AND THE WORKSPACE'S DOCUMENTS, read by the owner's agent (supplied plans; no model).
 *
 *   npx tsx scripts/verify-files-of-her-own.mts        (FIXTURE_JSON=… for another estate; roles `steward`, `org`)
 *
 *   1. alice saves a markdown note to HER Library through the Home's own route (the way an attach in the Ask does);
 *      "what does <it> say" at her agent answers FROM the file: the text in the result, marked untrusted, LibraryFileCard;
 *   2. a PNG saved beside it is NAMED, not read — no guess at its content;
 *   3. `library.files.list` lists both, bodies stripped;
 *   4. the steward saves a document to MISSIO NEXUS's Library and asks AT the organization → its agent reads its own;
 *   5. the TWIN: alice's note asked for at the organization is not there — the organization's Library is not hers.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const nameInfo = async (n: string): Promise<string> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve`); return String(r.agent).toLowerCase(); };
const org = await nameInfo(fx.org.handle);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const ask = async (addressee: string, message: string, toolId: string, args: Record<string, unknown>) => {
  const r = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, addressee, message, plan: { steps: [{ toolId, args }] } }) }));
  const rep = (r.reply ?? {}) as { kind?: string; results?: Array<{ toolId: string; result: unknown }>; interaction?: { result?: string }; text?: string };
  return { rep, result: (rep.results?.find((x) => x.toolId === toolId)?.result ?? {}) as Record<string, unknown> };
};
const save = async (artifact: Record<string, unknown>, orgSa?: string) => {
  const r = await j(await fetch(`${HOME}/connect/library${orgSa ? `?org=${orgSa}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.bearer}` }, body: JSON.stringify({ action: 'save', ...(orgSa ? { org: orgSa } : {}), artifact }) }));
  if (!r.ok || !r.artifact) fail(`the Library did not save ${String(artifact.name)}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.artifact as { id: string; name: string };
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const nonce = Date.now().toString(36);
console.log(`── files of her own · ${fx.people.steward} ${me.agent} · ${fx.org.handle} ${org} ──`);

// ── 1. her note, read from her Library ──
const noteName = `Retreat budget ${nonce}.md`;
const noteText = `# Retreat budget (${nonce})\n\n- venue: 1200\n- food: 800\n- the secret word is pomegranate-${nonce}\n`;
await save({ name: noteName, kind: 'md', source: 'blob', folder: 'attached', bytesB64: b64(noteText), contentType: 'text/markdown', size: noteText.length });
const read = await ask(me.agent, `what does ${noteName} say`, 'library.file.read', { name: `retreat budget ${nonce}` });
const rr = read.result as { read?: boolean; text?: string; untrusted?: boolean; file?: { path: string } };
if (read.rep.kind !== 'answer' || !rr.read || !String(rr.text).includes(`pomegranate-${nonce}`) || rr.untrusted !== true) fail(`her note was not read from her Library: ${JSON.stringify(read.rep).slice(0, 400)}`);
if (read.rep.interaction?.result && read.rep.interaction.result !== 'LibraryFileCard') fail(`binding is ${read.rep.interaction.result}`);
console.log(`  her note: read from ${rr.file?.path} · untrusted evidence · binding ${read.rep.interaction?.result ?? '(none)'}`);

// ── 2. an image is named, not read ──
const pngName = `bulletin-${nonce}.png`;
await save({ name: pngName, kind: 'image', source: 'blob', folder: 'attached', bytesB64: b64('PNG not really'), contentType: 'image/png', size: 16 });
const named = await ask(me.agent, `what is in ${pngName}`, 'library.file.read', { name: `bulletin-${nonce}` });
const nr = named.result as { read?: boolean; named?: boolean; text?: string; note?: string };
if (nr.read !== false || nr.named !== true || nr.text !== undefined || !/named, not read/.test(String(nr.note))) fail(`the image was not named-not-read: ${JSON.stringify(named.result).slice(0, 300)}`);
console.log('  an image: named, not read — no guess');

// ── 3. the list, bodies stripped ──
const list = await ask(me.agent, 'what files do I have', 'library.files.list', { folder: 'attached' });
const lr = list.result as { files?: Array<{ path: string; text: boolean }> };
if (!lr.files?.some((f) => f.path === `attached/${noteName}`) || !lr.files.some((f) => f.path === `attached/${pngName}` && f.text === false)) fail(`the list misses the two: ${JSON.stringify(lr).slice(0, 300)}`);
if (JSON.stringify(list.rep).includes('bytesB64') || JSON.stringify(list.rep).includes('pomegranate')) fail('the list carried bodies');
console.log(`  listed ${lr.files.length} in attached/ — bodies stripped`);

// ── 4. the organization's document, read by the organization's agent ──
const docName = `Venue contract ${nonce}.md`;
await save({ name: docName, kind: 'md', source: 'blob', folder: 'retreat', bytesB64: b64(`# Venue contract (${nonce})\n\ndeposit due 2026-10-01; capacity 120\n`), contentType: 'text/markdown', size: 60 }, org);
const orgRead = await ask(org, 'what does the venue contract say', 'library.file.read', { name: `venue contract ${nonce}` });
const orr = orgRead.result as { read?: boolean; text?: string; owner?: string };
if (orgRead.rep.kind !== 'answer' || !orr.read || !String(orr.text).includes('capacity 120') || orr.owner !== org) fail(`the organization's document was not read by its agent: ${JSON.stringify(orgRead.rep).slice(0, 400)}`);
console.log(`  ${fx.org.handle}'s document: read by its own agent (owner ${orr.owner})`);

// ── 5. twin: her note is not the organization's ──
const twin = await ask(org, `what does ${noteName} say`, 'library.file.read', { name: `retreat budget ${nonce}` });
const tr = twin.result as { read?: boolean; refused?: string; text?: string };
if (tr.read !== false || String(tr.text ?? '').includes('pomegranate')) fail(`her note was read at the organization: ${JSON.stringify(twin.result).slice(0, 300)}`);
console.log(`  twin: her note asked for at ${fx.org.handle} → not there (${(tr.refused ?? '').slice(0, 60)}…)`);

console.log(`\n✓ spec 405: her file read by her agent from her Library as evidence; an image named, not read; the list without bodies; the organization's document read by the organization's agent; her note not the organization's.`);
