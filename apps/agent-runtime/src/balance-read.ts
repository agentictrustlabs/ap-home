// THE BALANCE READ — spec 371 §2, the read that was missing.
//
// "What is my balance" was answered with a survey of receipts summed in base units because no tool
// answered a balance. The substrate already reads one — `valueHeld`, on-chain ERC-20 state, public by
// ADR-0040 — for annotating a list of accounts a person chooses between. This exposes it as a READ: the
// balance of a named treasury or organization, or of the asker's own treasuries when none is named (all
// of them, one line each — choosing one would be a guess about which the person meant).
//
// The result carries DISPLAY units only (`display`, `usdc`), never the base figure by a name a template
// could reach: the author's `answer` template renders "alice2.treasury holds 12 USDC." and cannot say
// 12,000,000. A read spends no authority: no capability, no mandate, no ceremony.
import type { Address } from 'viem';
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';

export const BALANCE_READ_CAPABILITY = 'treasury.balance.read' as const;

export const BALANCE_READ_TOOL: ToolSpec = {
  id: BALANCE_READ_CAPABILITY,
  description: 'The current balance of a treasury or organization, read on chain, in USDC. Names the account; when none is named, every treasury the person holds. A READ: no authority is spent.',
  inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'The treasury or organization — its address or its name (alice2.treasury). Omit for all of your own treasuries.' } } },
  // NOT the bare verb. `answers` words are matched as whole words anywhere in the sentence, and "holds" is
  // ordinary English — "whoever holds testimony", "the register holds a name" — so on its own it demanded a
  // treasury read of a murder-mystery character and then of a researcher in the marches, and denied every
  // run. A fact word has to be one only a money question uses.
  answers: ['balance', 'how much', 'how much money', 'funds', 'what do i hold', 'what it holds', 'holds in'],
  // Spec 366 R2 — a TREASURY is a subject: "what is alice3.treasury's balance", asked at alice.me, is
  // answered by alice3.treasury's own agent under its own realm rule (371 §2.1), not read across.
  subject: 'account',
  answer: '{{label}} holds {{display}}.',
  establishes: 'lookup',
};

export interface BalanceDeps {
  valueHeld?: (agent: string) => Promise<{ amount: bigint; display: string } | null>;
  charteredAgents?: (owner: string, type: string) => Promise<Array<{ agent: string; name?: string; primary?: boolean }>>;
  nameOf?: (agent: string) => Promise<string | null>;
}

export interface BalanceItem { treasury: string; label: string; display: string; usdc: string; primary?: boolean }

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** "12.5 USDC" → "12.5"; "empty" → "0". The display is the substrate's; the figure is for a template. */
const usdcOf = (display: string): string => display === 'empty' ? '0' : (display.match(/^([\d,.]+)/)?.[1] ?? display).replace(/,/g, '');

export function balanceReadInvoker(deps: BalanceDeps, addressee: Address, person?: Address): ToolInvoker {
  return async (_toolId, args) => {
    if (!deps.valueHeld) return { items: [], count: 0, reason: 'this agent cannot read balances — no asset is configured', interpretation: 'on-chain balance of the USDC asset' };
    const raw = String((args as { account?: unknown }).account ?? '').trim();
    if (raw && !isAddr(raw)) return { items: [], count: 0, reason: `this agent does not know an account called “${raw}” among your links`, interpretation: 'on-chain balance of the USDC asset' };
    // Named ⇒ that account. Unnamed ⇒ THE REALM YOU STAND IN is the subject (spec 371 §2.1): asked inside
    // alice3.treasury, "what is the balance" is alice3's — never hers and her other treasury's beside it.
    // Only in the person's OWN realm does "my balance" mean every treasury they hold.
    let accounts: Array<{ agent: string; name?: string; primary?: boolean }> = [];
    if (raw) accounts = [{ agent: raw.toLowerCase() }];
    else if (person && addressee.toLowerCase() !== person.toLowerCase()) accounts = [{ agent: addressee.toLowerCase() }];
    else if (person && deps.charteredAgents) accounts = await deps.charteredAgents(person.toLowerCase(), 'treasury').catch(() => []);
    if (!accounts.length) accounts = [{ agent: addressee.toLowerCase() }];
    const items: BalanceItem[] = [];
    const unreadable: string[] = [];
    for (const a of accounts) {
      const held = await deps.valueHeld(a.agent).catch(() => null);
      const label = a.name ?? (deps.nameOf ? await deps.nameOf(a.agent).catch(() => null) : null) ?? `${a.agent.slice(0, 8)}…${a.agent.slice(-4)}`;
      if (!held) { unreadable.push(label); continue; }
      items.push({ treasury: a.agent, label, display: held.display === 'empty' ? '0 USDC' : held.display, usdc: usdcOf(held.display), ...(a.primary ? { primary: true } : {}) });
    }
    return {
      items, count: items.length,
      interpretation: `on-chain USDC balance of ${items.length === 1 ? items[0]!.label : `${accounts.length} account(s)`}, as the chain holds it now`,
      ...(unreadable.length ? { reason: `could not read ${unreadable.join(', ')} on chain just now` } : {}),
      ...(items.length === 0 && !unreadable.length ? { reason: 'no treasury is chartered under you — nothing to read a balance of' } : {}),
    };
  };
}

/**
 * Spec 371 — RENDER an author's `answer` template from a tool result. `{{path}}` reads a field (dotted);
 * a result with `items[]` renders once per item, joined. Any missing field ⇒ null, and the composer takes
 * over — a template must never print "undefined" as an answer.
 */
export function renderAnswer(template: string, result: unknown): string | null {
  const one = (obj: unknown): string | null => {
    let missing = false;
    const text = template.replace(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g, (_m, path: string) => {
      const v = path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
      if (v === undefined || v === null || v === '') { missing = true; return ''; }
      return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    });
    return missing ? null : text;
  };
  const r = result as { items?: unknown[]; reason?: unknown } | null;
  if (r && Array.isArray(r.items)) {
    if (r.items.length === 0) return typeof r.reason === 'string' && r.reason ? r.reason : null;
    const lines = r.items.map(one);
    if (lines.some((l) => l === null)) return null;
    return [lines.join(' '), ...(typeof r.reason === 'string' && r.reason ? [r.reason] : [])].join(' ');
  }
  return one(result);
}
