// AN OUTSIDE AGENT, FOR REAL — spec 379's live twin. This is a standards-only A2A 1.0 agent served from
// the Home's own origin (Vercel), which the faithnet Worker reaches over the public network like any
// foreign agent: no session, no marker, no mandate — the card at ./card, one JSON-RPC endpoint here. It
// answers questions about the time. Nothing it says is a record of anyone's; that is the point.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { createStandardA2aServer, createMemoryTaskStore, type AgentCardV1 } from '@agenticprimitives/a2a/standard';
import { clockCard } from './card/card';

const tasks = createMemoryTaskStore();
const server = createStandardA2aServer({
  card: clockCard() as AgentCardV1,
  tasks,
  executor: {
    execute: async (ctx) => {
      const text = ctx.message.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' ').trim();
      const now = new Date();
      const said = /time|clock|hour|date|day/i.test(text)
        ? `It is ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC (${now.toLocaleString('en-US', { weekday: 'long', timeZone: 'UTC' })}).`
        : `clock.external answers questions about the time; you asked “${text.slice(0, 120)}”. It is ${now.toISOString().slice(11, 19)} UTC.`;
      await ctx.complete([{ text: said }]);
    },
  },
});

export const POST = (request: Request) => server.handle(request);
export const OPTIONS = () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, a2a-version' } });
