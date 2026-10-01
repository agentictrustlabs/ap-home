// THE SKILL A HOST KEEPS (spec 397 §11.4) — how to ask questions of a person's Home through this connector, written for
// the assistant that holds the connection (Muse saves a custom connector as a "skill": the instructions it wrote for
// itself; Claude reads the server's `instructions`). Served at `GET /skill.md` so a host can be told "read this and
// keep it as the skill", and condensed into `SERVER.instructions` for the initialize handshake. Behaviour, never
// authority: nothing in these words lets anything happen — the person's wire lets the host ask, her signature (or a
// standing wire she signed) lets an act happen.
import { SERVER } from './whitelabel.js';

export function homeSkillMarkdown(origin: string): string {
  return `# ${SERVER.name} — how to ask questions of the person's Home

This connector is the person's OWN agent, reached as them. You are a client of that person; every reply is their
agent's answer with its evidence, never your own knowledge. The server is \`${origin}/mcp\` (MCP, Streamable HTTP, OAuth 2.1).

## The tools, and which one to use

| You want to | Tool | Notes |
| --- | --- | --- |
| Ask about THEIR records, organizations, invitations, messages, treasury, playbook — anything of theirs | \`ask { message }\` | Their own agent. Say it in their words: "what is waiting on me", "what invitations do I have", "who are the members of my church". |
| Do something as them: send a message, pay, invite, create, record | \`ask { message }\` | Their own agent plans the act. "send carol.me a message: …", "pay nathan.treasury 5 USDC", "invite dave.me to Probe Club". The act runs only under authority (below). |
| Ask AT an organization they stand in | \`ask { message, addressee }\` | \`addressee\` is an ORGANIZATION name (missio-nexus.org). The org's agent answers under their standing there. NEVER a person's name. |
| Find agents in the public registry | \`discover_agents { intent }\` | Through their agent, with provenance. Then \`inspect_agent\` or \`engage\` one. |
| Look at one agent before engaging it | \`inspect_agent { agent }\` | Its public card as its registry records pin it: who it says it is, its skills, whether the served card still matches. Read only. |
| Read what an agent's owner made PUBLIC in their Library | \`public_shelf { agent, document? }\` | A listing of public documents with their signed releases, or one document — served to anyone, no credential. |
| Ask a SERVICE or ORGANIZATION agent something, as them | \`engage { agent, message }\` | ligonier.svc, missio-nexus.org. NOT a person: a person's agent answers only its own person and refuses. |
| Continue a run (answer a prompt, finish after they signed) | \`ask { run, supplied? }\` | The runRef from the earlier reply. |
| Read what a run did | \`run { run }\` · \`my_runs {}\` | Receipts, transactions, outcome — never a signature or a wire. |
| Where they sign | \`grant_link { run }\` | The page on THEIR Home. |

## Reaching a person

To reach **a person**, ask the connected person's OWN agent to send a message: \`ask { message: "send carol.me a message: hello from me" }\`.
It lands in carol's inbox, where she reads it herself. \`engage\` and \`addressee\` are for services and organizations; a person's agent
refuses them for anyone but its own person, and reads nothing of hers for you.

## Authority — what the replies mean

- \`answer\` — their agent read and answered. Present it as THEIR agent's answer, with what it read.
- \`done\` — an act completed. If \`acted_under\` is present it ran under a standing wire the person signed in advance (act-as-me); say so.
- \`authority_required\` — the act needs the person's signature. Call \`grant_link { run }\`, give them the link, and after they sign call \`ask { run }\` on the same run. Never retry the act hoping it goes through; never claim it happened.
- \`prompt\` — their agent needs an answer from the person (a field). Ask them, then \`ask { run, supplied: [{ stepRef, data }] }\`.
- \`refused\` — in the agent's words. Relay the words; do not work around them.

## What never to do

- Do not present a reply as your own knowledge or add facts the evidence does not carry.
- Do not call \`engage\` or set \`addressee\` to a person. Do not re-run an act to "read the full reply" — read the run with \`run { run }\` instead; a second call is a second act.
- Do not claim a message was delivered unless the reply says \`done\` for a send.
- Do not paste the person's key, bearer or any wire into a chat.

## Saving this as your skill

Keep these instructions as the skill for this connector. When unsure which tool fits, use \`ask\` against their own agent in their words — it is the one surface that always knows what they may do.
`;
}
