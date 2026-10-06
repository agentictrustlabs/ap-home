// POST /connect/naming/ticket — the estate's NAMING GATE (ap-town spec 431 §4, step 4). A signed-in person asks for a
// ticket to buy `<label>.<tld>` for `owner`, paid by `payer` (their treasury). The gate:
//   1. prices the name with the package's function (the chain checks the same number);
//   2. applies the DOMAIN RULE: if `<label>.com` or `<label>.org` exists in DNS, the label is somebody's and the
//      person must name a verified email at that domain on THIS Home (the email facet points at their agent);
//   3. signs a ClaimTicketV1 (EIP-712, under the priced subregistry's domain) with the gate key.
// The ticket carries the label, the owner, the payer, the price and the DOMAIN (as a hash) — never the email. The
// chain enforces the ticket; the gate decides nothing about authority, only whether this Home vouches for the claim.
import { CLAIM_TICKET_TYPES, claimTicketDomain, priceOf, toCoinUnits, namehash, type ClaimTicketV1 } from '@agenticprimitives/agent-naming';
import { keccak256, toBytes, zeroHash, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readEmailFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, PRICED_SUBREGISTRIES } from '../../src/lib/chain';
import { verifyStewardship } from '../_lib/verify-stewardship';
import type { IncomingDelegation } from '../_lib/verify-delegation';
import { demoPersonaFor } from '../_lib/demo-custody';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });
export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const TICKET_TTL_S = 15 * 60;
/** The endings a label is checked against (spec 431 §3 — the owner's choice: .com and .org). */
const PROTECTING_TLDS = ['com', 'org'] as const;

/** Does `host` exist in DNS (A, AAAA, MX or NS)? A public fact, read over DNS-over-HTTPS. `null` = could not ask. */
export async function dnsExists(host: string, fetchFn: typeof fetch = fetch): Promise<boolean | null> {
  try {
    for (const type of ['A', 'AAAA', 'MX', 'NS']) {
      const r = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
      if (!r.ok) return null;
      const b = (await r.json()) as { Status?: number; Answer?: unknown[] };
      if (b.Status === 0 && Array.isArray(b.Answer) && b.Answer.length > 0) return true;
    }
    return false;
  } catch { return null; }
}

/** The domain that protects `label`, if any: the first of `<label>.com`, `<label>.org` that exists. */
export async function protectingDomain(label: string, fetchFn: typeof fetch = fetch): Promise<{ domain: string | null; unknown: boolean }> {
  let unknown = false;
  for (const tld of PROTECTING_TLDS) {
    const host = `${label}.${tld}`;
    const r = await dnsExists(host, fetchFn);
    if (r === true) return { domain: host, unknown: false };
    if (r === null) unknown = true;
  }
  return { domain: null, unknown };
}

/** `nathan@mail.ibm.com` is at `ibm.com`; `nathan@ibm.com.evil` is not. */
export const emailAtDomain = (email: string, domain: string): boolean => {
  const at = email.toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
};

export interface TicketEnv { AUTH_CODES: Parameters<typeof readEmailFacet>[0]; NAMING_GATE_PRIVATE_KEY?: string; DEMO_SSO_AUD?: string }

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const e = env as unknown as TicketEnv;
  const key = (e.NAMING_GATE_PRIVATE_KEY ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return json({ error: 'gate_unconfigured', detail: 'This Home has no naming gate key, so it cannot vouch for a purchase.' }, 503);
  // The priced subregistries and the chain come from the deployment this Home is built against (NEXT_PUBLIC_CONTRACTS_JSON).
  const subregistries = PRICED_SUBREGISTRIES as Record<string, string | undefined>;
  const chainId = CHAIN_ID;

  // Who is asking: a signed-in agent (the person).
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'unauthorized' }, 401);
  const { jwks } = await getServer(env);
  const v = await verifyAgentSession(token, { keys: await importJwks(jwks), expectedAud: e.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'unauthorized' }, 401);
  const person = (v.session.sub as string).split(':').pop()!.toLowerCase() as Address;

  const body = (await request.json().catch(() => ({}))) as { label?: string; tld?: string; owner?: string; payer?: string; email?: string; preview?: boolean; stewardship?: IncomingDelegation };
  const label = (body.label ?? '').trim().toLowerCase();
  const tld = (body.tld ?? '').trim().toLowerCase();
  const owner = (body.owner ?? '').toLowerCase() as Address;
  const payer = (body.payer ?? '').toLowerCase() as Address;
  if (!LABEL_RE.test(label) || label.length < 3) return json({ error: 'bad_label', detail: 'A label is three or more of a–z, 0–9 and hyphens, not at the ends.' }, 400);
  const subregistry = subregistries[tld] as Address | undefined;
  if (!subregistry) return json({ error: 'not_priced', detail: `.${tld} is not a purchased ending on this chain.` }, 400);
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^0x[0-9a-f]{40}$/.test(payer)) return json({ error: 'bad_party' }, 400);
  // The owner is the signed-in person, or an agent that person STEWARDS: proven by a live owner→person stewardship
  // wire (ERC-1271 by the owner, unrevoked — SEC-H2), or, for a demo persona, by the roster the Home itself holds
  // the keys for (the same source `persona-sign` trusts). Never by a claim in the request alone.
  let yours = owner === person;
  if (!yours && body.stewardship) yours = await verifyStewardship(env, owner, person, body.stewardship);
  if (!yours) {
    const persona = demoPersonaFor(env, person);
    yours = !!persona?.custodies?.some((c) => c.sa.toLowerCase() === owner);
  }
  if (!yours) return json({ error: 'not_yours', detail: 'A ticket is issued to the agent you are signed in as, or to one you steward.' }, 403);

  let price: number;
  try { price = priceOf(label, tld)!; } catch (err) { return json({ error: 'bad_label', detail: String((err as Error).message) }, 400); }

  // The domain rule.
  const { domain, unknown } = await protectingDomain(label);
  if (unknown && !domain) return json({ error: 'dns_unavailable', detail: 'The domain check could not run just now; try again in a moment.' }, 503);
  if (domain) {
    const email = (body.email ?? '').trim();
    if (!email) return json({ error: 'domain_protected', domain, detail: `${label} is a domain. To claim ${label}.${tld} you need a verified email at ${domain} on this Home.`, need: 'email' }, 402);
    if (!emailAtDomain(email, domain)) return json({ error: 'domain_protected', domain, detail: `${email} is not an address at ${domain}.`, need: 'email' }, 402);
    const facet = await readEmailFacet(e.AUTH_CODES, email);
    const facetAgent = (facet ?? '').split(':').pop()?.toLowerCase();
    if (!facetAgent || (facetAgent !== person && facetAgent !== owner)) {
      return json({ error: 'domain_protected', domain, detail: `${email} is not a verified email on this Home. Add it under Security, verify the code, then come back.`, need: 'verify' }, 402);
    }
  }

  // A preview runs every check and signs nothing — what the purchase card shows before the person presses Buy.
  if (body.preview) return json({ ok: true, preview: true, subregistry, price, domain });

  const gate = privateKeyToAccount(key as Hex);
  const ticket: ClaimTicketV1 = {
    parentNode: namehash(tld) as Hex, label, owner, payer,
    price: toCoinUnits(price), domain: domain ? keccak256(toBytes(domain)) : zeroHash,
    expiry: BigInt(Math.floor(Date.now() / 1000) + TICKET_TTL_S),
    nonce: keccak256(toBytes(`${subregistry}:${label}:${owner}:${Date.now()}:${crypto.randomUUID()}`)),
  };
  const signature = await gate.signTypedData({ domain: claimTicketDomain(chainId, subregistry), types: CLAIM_TICKET_TYPES, primaryType: 'ClaimTicket', message: ticket });
  return json({
    ok: true, subregistry, gate: gate.address, price, domain,
    ticket: { ...ticket, price: ticket.price.toString(), expiry: ticket.expiry.toString() },
    signature,
  });
};
