import { type Page } from '@playwright/test';
import { keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './wallet';
import { onboardWithKey, signInOrOnboard } from './onboard';

// A STABLE demo SIWE user for auto-testing everything (the mid-2026-07 ask: "a demo user with a SIWE account
// Playwright can auto-test against"). Unlike `onboard()` (random key each run), this identity is DETERMINISTIC:
// same EOA → same Smart Agent → same home, run after run, so specs can rely on a known address + name.
//
// The private key is DERIVED from a public seed string via keccak256 — it is NOT a secret and there is no hex
// key literal in the repo (so it never trips secret-scanning / push protection). Override with a funded testnet
// account by exporting E2E_DEMO_PRIVATE_KEY. This is TESTNET ONLY (Base Sepolia); never fund it on mainnet.

const SEED = process.env.E2E_DEMO_SEED ?? 'agenticprimitives-e2e-demo-user-v1';

/** The stable demo user's private key: env override, else keccak256 of the public seed (deterministic, testnet). */
export const DEMO_PRIVATE_KEY: Hex = (process.env.E2E_DEMO_PRIVATE_KEY as Hex | undefined) ?? keccak256(toBytes(SEED));

const demoAccount = privateKeyToAccount(DEMO_PRIVATE_KEY);

/** Stable name claimed by the demo user (override with E2E_DEMO_NAME). Kept short + label-safe. */
export const DEMO_NAME = process.env.E2E_DEMO_NAME ?? 'demoe2e';

/** The reusable demo user identity — same values every run. */
export const demoUser = {
  address: demoAccount.address,
  name: DEMO_NAME,
  privateKey: DEMO_PRIVATE_KEY,
} as const;

/** Inject the demo user's mock SIWE wallet (same EOA every run) without running onboarding. */
export async function installDemoWallet(page: Page): Promise<{ address: `0x${string}` }> {
  return installMockWallet(page, DEMO_PRIVATE_KEY);
}

/** Onboard the stable demo user through the full SIWE flow — the known identity to auto-test everything as. */
export async function onboardDemoUser(page: Page, log = (s: string) => console.log(s)): Promise<{ address: `0x${string}`; origin: string; name: string }> {
  return onboardWithKey(page, DEMO_NAME, DEMO_PRIVATE_KEY, log);
}


// ── THE STABLE CAST ───────────────────────────────────────────────────────────────────────────────────
//
// `demoUser` above is one identity, and until now NOTHING imported it — every spec onboarded a random
// throwaway instead. That is a facility nobody exercised, and it cost more than tidiness: a fresh user has
// an empty inbox, an empty library and no discussion history, so a suite built on throwaways can only ever
// test the empty case. Chat needs a counterparty; "does a busy inbox still work" needs a busy inbox.
//
// So: a small cast of DETERMINISTIC users who accumulate real history across runs. Same seeds → same EOAs →
// same Smart Agents → same homes, so today's run adds to what yesterday's left behind. That accumulation is
// the point — it is what makes them useful for the gateway-adoption shadow (ADR-0060), which compares two
// planes reading one inbox document and learns nothing interesting from comparing two empty ones.
//
// TESTNET ONLY (Base Sepolia). Keys are keccak256 of a PUBLIC seed string — not secrets, no hex literal in
// the repo, nothing for secret-scanning to trip on.

export interface DemoPersona {
  /** Short, label-safe: it becomes a `<name>.impact` handle and a real subdomain home. */
  name: string;
  address: `0x${string}`;
  privateKey: Hex;
  /** What this persona is FOR — so a spec picks the right one instead of grabbing whichever is first. */
  role: string;
}

function persona(name: string, seed: string, role: string): DemoPersona {
  const key = keccak256(toBytes(`agenticprimitives-e2e-${seed}-v1`)) as Hex;
  return { name, address: privateKeyToAccount(key).address, privateKey: key, role };
}

/**
 * Two is the minimum that proves anything: one party can write to their own vault, but delivery, receipts,
 * approval and read-state all need someone on the other side. A third exists so an org has a member who is
 * neither the steward nor the counterparty — the case where "everyone involved is an admin" hides bugs.
 */
export const CAST = {
  ada: persona('demoada', 'demo-cast-ada', 'primary — the account every solo-feature test drives'),
  bo: persona('demobo', 'demo-cast-bo', 'counterparty — receives 1:1 mail, replies, approves'),
  cy: persona('democy', 'demo-cast-cy', 'connector — relying-app connects; org member, never steward'),
  dee: persona('demodee', 'demo-cast-dee', 'steward — creates and runs the organizations'),
  eli: persona('demoeli', 'demo-cast-eli', 'outsider — applies, is refused, tests the gates from outside'),
} as const;

/**
 * WHY FIVE, and not two.
 *
 * Each role exists because some feature is UNREACHABLE without it, not for realism:
 *
 *  · 1:1 messaging needs a counterparty who is not you (`ada` ↔ `bo`) — a send to yourself exercises
 *    neither the wire nor the recipient's gate.
 *  · Discussions need a steward AND a member who is not the steward (`dee` + `cy`). When everyone is an
 *    admin, every permission check passes and none of them is tested.
 *  · Gates need somebody OUTSIDE (`eli`). "Non-members cannot see this" is unfalsifiable with only
 *    members; the refusal is the assertion.
 *  · Work items need a requester and a reviewer who can decline (`ada` → `dee`).
 *
 * They are DETERMINISTIC and they ACCUMULATE. Same seed → same EOA → same Smart Agent → same home, so
 * today's run adds to what yesterday left. That matters more than it sounds: a fresh identity can only
 * ever test the empty case, and the empty case is the half that already works.
 *
 * Keys are keccak256 of a PUBLIC seed string. There is no private key literal in this repo and nothing
 * for secret-scanning to trip on — and nothing worth stealing: TESTNET ONLY (Base Sepolia).
 */
export const CAST_ROLES: ReadonlyArray<DemoPersona> = [CAST.ada, CAST.bo, CAST.cy, CAST.dee, CAST.eli];

/** Enter a cast member's home — signs in if it exists, onboards if it does not. IDEMPOTENT, which is the
 *  whole point of a stable cast: run two is the normal case, not the exception. */
export async function onboardPersona(page: Page, p: DemoPersona, log = (s: string) => console.log(s)) {
  return signInOrOnboard(page, p.name, p.privateKey, log);
}
