/**
 * PUT AN ORGANIZATION'S ISSUER FACET — spec 444 W3. The record `credential.issue` reads to know which key-service key signs
 * for the organization, for which credential type, in which claim layout. The steward puts it, presenting the organization's
 * stewardship wire (the DO verifies it on chain); the organization's own interactions grant writes it.
 *
 *   HOME_URL=https://www.impact-agent.me A2A_URL=https://a2a.impact-agent.io \
 *     npx tsx scripts/put-issuer-facet.mts <steward-handle> <org-address> <facet-record.json>
 *
 * The facet's signature and its attestation are the issuer ceremony's (ap-federation `scripts/publish-issuer-facet.mts`);
 * the JSON given here is the vault record: { type: 'ap.issuer-facet.v1', keyId, akcsKeyId, credentialType, claimSchema,
 * vcSize, issuer, attestation }.
 */
import { readFileSync } from 'node:fs';

const HOME = (process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const A2A = (process.env.A2A_URL ?? 'https://a2a.faithnet.io').replace(/\/$/, '');
const [handle, orgArg, file] = process.argv.slice(2);
if (!handle || !/^0x[0-9a-fA-F]{40}$/.test(orgArg ?? '') || !file) throw new Error('usage: put-issuer-facet.mts <steward-handle> <org-address> <facet-record.json>');
const org = orgArg!.toLowerCase();
const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${handle}`);
const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${si.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; stewardshipDelegation?: unknown }>;
const stewardship = orgs.find((o) => o.orgAgent.toLowerCase() === org)?.stewardshipDelegation;
if (!stewardship) throw new Error(`${handle} holds no stewardship wire for ${org}`);

const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const out = await j(await fetch(`${A2A}/interactions/${org}/issuer.facet.put`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, stewardship, record }) }));
console.log(`issuer facet for ${org} → ${JSON.stringify(out).slice(0, 300)}`);
if (out.ok !== true) process.exit(1);
