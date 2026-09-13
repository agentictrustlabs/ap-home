/**
 * Spec 398 §5 / APUX-034 (G3) — SAVE SUCCESSFUL WORK AS A RECIPE, live.
 *
 *   npx tsx scripts/verify-recipe.mts        (from the repo root; HOME_URL=… to point elsewhere, HANDLE=… for its roster)
 *
 * alice asks her own agent, with a SUPPLIED plan (the planner is not what is under test), "who are the members of
 * Missio Nexus" — a read that completes. She drafts a recipe from that run: the draft names the capability, writes the
 * organization as a ROLE (`{org}`), carries no address in its steps, no key, and says authority is requested anew. She
 * saves it into her Library as a `skill` artifact under recipes/ (the Home's act), reads it back by content commitment,
 * and removes it. The twin: a run that did not complete (a parked ask) is refused as a recipe, by name.
 */
import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const HANDLE = fx.people.steward;   // the roster differs per deployment (Faithnet: alice; the estate: mara …)
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: HANDLE, client_id: 'demo-web' }) }));
if (!alice.homeSession) fail(`${HANDLE} could not sign in: ${JSON.stringify(alice).slice(0, 120)}`);
const ME = String(alice.sub).replace(/^eip155:\d+:/, '').toLowerCase() as Address;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a/harness/${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: alice.homeSession, ...(body as object) }) }));
const library = async (body: unknown) => j(await fetch(`${HOME}/connect/library`, { method: 'POST', headers: { authorization: `Bearer ${alice.homeSession}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship?: string; kind?: string }>;
// the fixture's organization, else any organization the steward stewards — the gate is about the recipe, not the fixture
const org = orgs.find((o) => [fx.org.name, fx.org.handle].some((n) => n.toLowerCase() === (o.orgName ?? '').toLowerCase())) ?? orgs.find((o) => o.relationship === 'steward' && !/treasury/.test(o.kind ?? '') && o.orgName);
if (!org) fail(`${HANDLE} stewards no organization here`);
const ORG = org!.orgAgent.toLowerCase();
console.log(`── ${HANDLE} ${ME} · ${org!.orgName} ${ORG} ──`);

// 1. a read that completes, with a supplied plan
const runRef = `recipe-${Date.now().toString(36)}`;
const done = await post('ask', { addressee: ME, runRef, message: `who are the members of ${org!.orgName}`, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: ORG } }] } });
console.log(`  the run → ${done.reply?.kind} (${String(done.reply?.runRef ?? runRef).slice(0, 24)})`);
if (done.reply?.kind !== 'answer') fail(`the read did not complete: ${JSON.stringify(done).slice(0, 300)}`);
const ref = String(done.reply?.runRef ?? runRef);

// 2. the draft
const drafted = await post('recipe', { addressee: ME, runRef: ref });
if (drafted.ok !== true) fail(`no draft: ${JSON.stringify(drafted).slice(0, 300)}`);
const r = drafted.recipe as { name: string; fileName: string; capabilities: string[]; roles: Array<{ role: string; from: string; firstBoundTo?: string }>; steps: Array<{ capability: string; args: Record<string, unknown> }>; skillMd: string; notes: string[] };
console.log(`  draft ${r.fileName} · tools [${r.capabilities.join(', ')}] · roles [${r.roles.map((x) => `{${x.role}} ← ${x.from}`).join(', ')}] · playbook read: ${drafted.playbookRead}`);
if (!r.capabilities.includes('organization.membership.list')) fail('the draft does not name the capability the run used');
if (r.steps[0]?.args.org !== '{org}') fail(`the organization was not written as a role: ${JSON.stringify(r.steps[0]?.args)}`);
if (/0x[0-9a-fA-F]{40}/.test(r.skillMd.split('\n## Roles')[0]!.replace(/from: \{[^}]*\}/, ''))) fail('an address reached the draft\'s steps');
if (!/authority: requested-anew/.test(r.skillMd) || !/This recipe grants nothing/.test(r.skillMd)) fail('the draft does not say authority is requested anew');
// no credential VALUE: her session token, a JWT, a 32-byte hex, a signature — the draft may SAY it holds none (it does).
const sansDigest = r.skillMd.replace(/digest: 0x[0-9a-fA-F]{64}/g, 'digest: …');   // the playbook's digest is the one 32-byte hex the draft may carry
if (r.skillMd.includes(String(alice.homeSession)) || /eyJ[A-Za-z0-9_-]{20,}\.|0x[0-9a-fA-F]{64,}/.test(sansDigest)) fail('a credential value reached the draft');

// 3. saved into her Library as a skill artifact under recipes/ — the person's act, at the Home
const bytesB64 = Buffer.from(r.skillMd, 'utf8').toString('base64');
const saved = await library({ action: 'save', artifact: { name: r.fileName, kind: 'skill', source: 'blob', folder: 'recipes', contentType: 'text/markdown', bytesB64 } });
if (!saved.ok || !saved.artifact?.id) fail(`the Library refused the recipe: ${JSON.stringify(saved).slice(0, 300)}`);
const art = saved.artifact as { id: string; name: string; kind: string; folder: string; contentCommitment?: string; version?: number };
const commitment = `0x${createHash('sha256').update(Buffer.from(r.skillMd, 'utf8')).digest('hex')}`;   // the Library commits to the BYTES
console.log(`  saved → ${art.id} · ${art.kind} · ${art.folder}/${art.name} · v${art.version} · commitment ${String(art.contentCommitment).slice(0, 12)}… ${art.contentCommitment === commitment ? '(matches the draft)' : '(MISMATCH)'}`);
if (art.kind !== 'skill' || art.folder !== 'recipes' || art.contentCommitment !== commitment) fail('the saved artifact is not the draft, as a skill, under recipes/');
const listed = ((await j(await fetch(`${HOME}/connect/library`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))).artifacts ?? []) as Array<{ id: string }>;
if (!listed.some((a) => a.id === art.id)) fail('the saved recipe is not listed in her Library');
await library({ action: 'delete', id: art.id });
console.log('  removed again (the gate leaves no artifact behind)');

// twin: a run that did not complete is not a recipe
const parked = await post('ask', { addressee: ME, message: `send 1 usdc to ${fx.treasuries.payee}`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: fx.treasuries.payee, usdc: '1' } }] } });
const parkedRef = String(parked.reply?.runRef ?? '');
const refused = await post('recipe', { addressee: ME, runRef: parkedRef });
console.log(`  twin: a ${parked.reply?.kind} run → ${refused.ok === false ? `refused: ${refused.error}` : 'DRAFTED'}`);
if (refused.ok !== false || !/only a completed run/.test(String(refused.error))) fail('a run that did not complete must not become a recipe');
if (parkedRef) await post('cancel', { addressee: ME, runRef: parkedRef, note: 'verify-recipe twin' });

console.log('\n✓ spec 398 §5 (G3): a completed run became a draft recipe — capability named, the party a role, no address in its steps, no credential, authority requested anew — saved to and removed from her Library; a parked run was refused.');
