/**
 * LINK AN AGENT TO ITS HOLDER, PRIVATELY — in the holder's own relationship records (ADR-0025), with no public name and no
 * on-chain edge. The holder's own agent finds it there (`ownAgentsOfType` reads `relationships.data` and knows an UNNAMED
 * agent by its kind), so "pay from my treasury" resolves to it. Nothing about the link is published: nameless stays
 * unlisted (spec 338 / ADR-0056), and a public `ap:charteredUnder` edge stays a separate choice of the owner.
 *
 * Written under the holder's own session (`/connect/related-orgs`, bearer path), which writes through to her vault.
 *
 *   HOME_URL=https://www.impact-agent.me npx tsx scripts/link-own-agent.mts <handle> <agent-address> [kind]
 *     kind: person-treasury (default) · org-treasury · service · household …
 */
const HOME = (process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const [handle, agentArg, kindArg] = process.argv.slice(2);
if (!handle || !/^0x[0-9a-fA-F]{40}$/.test(agentArg ?? '')) throw new Error('usage: link-own-agent.mts <handle> <agent-address> [kind]');
const agent = agentArg!.toLowerCase(); const kind = kindArg ?? 'person-treasury';
const j = async (x: Response) => { const t = await x.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: x.status }; } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${handle} at ${HOME}`);
const me = String(si.agent).toLowerCase();
const out = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ person: me, orgAgent: agent, orgName: '', kind, parent: me, relationship: 'steward', purpose: kind }) }));
const tree = await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${si.homeSession}` } }));
const row = (tree.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === agent);
console.log(`${handle} (${me}) → ${agent} as ${kind}: ${JSON.stringify(out).slice(0, 120)} · in her tree: ${row ? `${row.kind}/${row.relationship}` : 'NO'}`);
if (out.ok !== true || !row) process.exit(1);
