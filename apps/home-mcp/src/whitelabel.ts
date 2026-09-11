// WHITE-LABEL — every deployment literal of the Home MCP lives here (ADR-0021): its name and what an MCP host is
// told at initialize. The Home's origin, the a2a origin and the client id are wrangler vars.
export const SERVER = {
  name: 'Home MCP',
  version: '0.1.0',
  /** What an assistant is told at initialize. */
  instructions:
    'This connector is the person\'s OWN agent, reached as them: `ask` puts their words to it (their records, their organizations, their playbook), and the reply says what it read and from which tier. An act the person\'s agent would need authority for does not happen here — the reply says `authority_required` and `grant_link` gives the page on their Home where THEY sign; after that, `continue` on the same run finishes it. Never present a reply as the assistant\'s own knowledge; it is their agent\'s answer, with its evidence. Nothing here authorizes anything: the person\'s delegation lets you ask, the person\'s signature lets an act happen.',
} as const;

export const SCOPES = ['ask'] as const;
