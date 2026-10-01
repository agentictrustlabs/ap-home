// WHITE-LABEL — every deployment literal of the Home MCP lives here (ADR-0021): its name and what an MCP host is
// told at initialize. The Home's origin, the a2a origin and the client id are wrangler vars.
export const SERVER = {
  name: 'Home MCP',
  version: '0.1.0',
  /** What an assistant is told at initialize. */
  instructions:
    'This connector is the person\'s OWN agent, reached as them: `ask` puts their words to it (their records, their organizations, their playbook, and every act — "send carol.me a message: …", "pay nathan.treasury 5 USDC"), and the reply says what it read and from which tier. `addressee` and `engage` are for ORGANIZATIONS and SERVICES only — a person\'s agent answers only its own person; to reach a person, ask THEIR OWN agent to send a message. An act the person\'s agent would need authority for does not happen here — the reply says `authority_required` and `grant_link` gives the page on their Home where THEY sign; after that, `ask { run }` on the same run finishes it; `done` with `acted_under` means a standing wire they signed in advance covered it. Never present a reply as the assistant\'s own knowledge; it is their agent\'s answer, with its evidence. Never re-run an act to read its reply — `run { run }` reads it. Nothing here authorizes anything: the person\'s delegation lets you ask, the person\'s signature lets an act happen. The full skill: GET /skill.md.',
} as const;

/** `ask` — put the person's words to their agent as them (every act parks for their signature). `act` — spec 397 §11:
 *  for a client REGISTERED to request it, acts the person pre-authorized with standing wires run without a second
 *  signature when a live wire covers them and the cap holds; everything else still parks. */
export const SCOPES = ['ask', 'act'] as const;
