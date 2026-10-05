/**
 * Refill a demo agent's USDC through the HARNESS fund flow — the same path the Home's Fund button and
 * the Ask take: ask → authority_required → mint the mandate with the persona's key → run again.
 *
 *   npx tsx scripts/fund-demo-balance.mts [handle] [recipientAddress] [usdc]
 *
 * Defaults: alice funds Missio Nexus with 500 USDC. A faucet mint credits without debiting anyone.
 */
import { toHex, type Address, type Hex } from 'viem';
import {
  intentDigest, buildDigestBindingCaveat, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY,
  type Delegation, type MandateRequirementV1,
} from '@agenticprimitives/delegation';

registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, payment: D.payment, digestBinding: D.digestBinding } as const;

const handle = process.argv[2] ?? 'alice';
const recipient = (process.argv[3] ?? '0x3b99f2b452766de5df0dbcdfc676f27257151333').toLowerCase();
const usdc = process.argv[4] ?? '500';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error(`no session for ${handle}`);
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const ask = async (body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: token, addressee: signin.agent, ...body }) }));

const message = `fund ${recipient} with ${usdc} USDC`;
const first = await ask({ message });
if (first.reply?.kind !== 'authority_required') throw new Error(`expected authority_required: ${JSON.stringify(first).slice(0, 400)}`);
const req = first.reply.requirement as MandateRequirementV1;
const caveats = [...capabilityHandler.toCaveats(req, enforcers as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest as Hex)];
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const mandate: Delegation = { delegator: first.reply.delegator, delegate: first.reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
mandate.signature = await sign(hashDelegation(mandate, CHAIN, D.dm));
const second = await ask({ message, runRef: first.reply.runRef, presented: [{ ...mandate, salt: salt.toString() }] });
console.log(JSON.stringify(second).slice(0, 900));
