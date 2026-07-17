// Minimal EIP-1193 (window.ethereum) wallet helpers — no wagmi. The EOA signs
// both the SIWE login message and the deploy userOpHash (personal_sign / EIP-191;
// AgentAccount._verifyEcdsa accepts raw-or-EIP-191 recovery).
import type { Address, Hex } from '@agenticprimitives/types';
import { remoteSignerActive, remoteSigner, isRemotePersonaSession, clearRemotePersonaMarker } from './remote-signer';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): Eip1193 {
  // Remote-persona mode (uupg tracker demo): route EVERY wallet touch to the opener's signer — never the
  // injected wallet, which would pop MetaMask and sign as the wrong identity. After a reload severed the
  // bridge, fail with a return-to-tracker message instead of silently falling back.
  if (remoteSignerActive()) return remoteSigner;
  if (isRemotePersonaSession()) throw new Error('This tab was signed in from the tracker — return to the tracker and reopen your Home.');
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No Ethereum wallet found — install MetaMask (or another wallet) to connect.');
  return eth;
}

export function hasWallet(): boolean {
  if (typeof window === 'undefined') return false;
  if (remoteSignerActive()) return true;
  return !!(window as unknown as { ethereum?: unknown }).ethereum;
}

/** All accounts the wallet has connected (order = wallet's, [0] = active). `forceSelect` pops MetaMask's
 *  account picker (`wallet_requestPermissions`) even when already connected, so a multi-custodian admin can
 *  expose the RIGHT account. Callers that sign FOR A SPECIFIC HOME should pick the connected account that
 *  custodies it (not just [0] — eth_requestAccounts returns the active account first, which may be another
 *  home's custodian like the platform deployer). */
/** Fast, UI-less liveness probe of the injected provider. A healthy wallet answers `eth_chainId`
 *  instantly even when locked. A ZOMBIE provider — the extension's inpage.js is injected but its
 *  background is unreachable (disabled, mid-update, crashed; MetaMask logs 'Failed to connect to
 *  MetaMask' internally) — hangs or rejects. Without this, the awaited `eth_requestAccounts` never
 *  settles and the securing screen spins forever (live Edge finding 2026-07-17). Not a fallback
 *  (ADR-0013): a failed probe REJECTS the connect with the real reason; nothing else is tried. */
async function assertProviderResponsive(eth: Eip1193): Promise<void> {
  try {
    await Promise.race([
      eth.request({ method: 'eth_chainId' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wallet-probe-timeout')), 3000)),
    ]);
  } catch {
    throw new Error(
      "Your wallet extension isn't responding — it may be disabled, mid-update, or crashed. " +
        'Check that MetaMask (or your wallet) is enabled in this browser, restart the browser, and try again.',
    );
  }
}

export async function connectWalletAccounts(forceSelect = false, restrictTo?: Address): Promise<Address[]> {
  // Probe only the real injected provider — the remote-persona signer is an opener bridge with its
  // own failure story (and may not serve eth_chainId).
  if (!remoteSignerActive()) await assertProviderResponsive(provider());
  if (forceSelect) {
    // restrictTo (EIP-2255 caveat): when we KNOW the account that custodies this home (remembered from a
    // prior sign-in — see remember/recallHomeEoa), ask MetaMask to default the picker to JUST that account
    // so the member doesn't have to hunt for it (esp. after a disconnect cleared MetaMask's memory). MetaMask
    // versions vary in honoring this; it's a best-effort hint — connectCustodianWallet still validates
    // on-chain. Falls back to the plain account picker.
    const eth_accounts = restrictTo ? { restrictReturnedAccounts: [restrictTo] } : {};
    try { await provider().request({ method: 'wallet_requestPermissions', params: [{ eth_accounts }] }); }
    catch { /* user cancelled or wallet lacks the method → fall through to the normal request */ }
  }
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as Address[];
  if (!accounts?.length) throw new Error('No wallet account selected.');
  return accounts;
}

// Per-home memory of the EOA that custodies a given name. AgentAccount has no `owner()` getter (it's a
// multi-credential custodian SET — only count + isCustodian(addr)), so we can't read the custodian address
// FROM the chain; instead the home remembers the EOA it used on a successful by-name sign-in, and defaults
// the picker to it next time. Survives the wallet-disconnect revoke (this is the home's own localStorage).
const EOA_KEY = (name: string): string => `agenticprimitives:demo-sso:home-eoa:${name.toLowerCase()}`;

export function rememberHomeEoa(name: string, address: Address): void {
  try { localStorage.setItem(EOA_KEY(name), address); } catch { /* storage blocked — fine */ }
}

export function recallHomeEoa(name: string): Address | undefined {
  try {
    const v = localStorage.getItem(EOA_KEY(name));
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
  } catch {
    return undefined;
  }
}

export async function connectWallet(forceSelect = false): Promise<Address> {
  return (await connectWalletAccounts(forceSelect))[0]!;
}

/** The accounts already permitted to this dApp — a SILENT read (`eth_accounts`, no popup, no picker).
 *  `[]` when the wallet is locked or the dApp isn't connected. Used by the session custodian cache (B5) to
 *  confirm a remembered custodian is still connected before reusing it WITHOUT re-popping the picker. */
export async function connectedAccountsSilent(): Promise<Address[]> {
  if (!hasWallet()) return [];
  try { return ((await provider().request({ method: 'eth_accounts' })) as Address[]) ?? []; }
  catch { return []; }
}

// B5 — per-browser-session cache of the custodian EOA chosen for a given home SA. The picker
// (`wallet_requestPermissions`) is the "choose your custodian" moment (spec 266); it should fire ONCE per
// session per home, not on every `signHashFor`. Seeded from the SIWE/bootstrap pick; reused (after a silent
// `eth_accounts` liveness check) for all later ceremonies in the flow. Module-scoped ⇒ resets on reload/tab
// (the safe default) and is cleared on disconnect. Distinct from `rememberHomeEoa` (durable localStorage hint
// that still pops the picker) — this SKIPS the picker.
const sessionCustodians = new Map<string, Address>();
export function rememberSessionCustodian(sa: Address, custodian: Address): void {
  sessionCustodians.set(sa.toLowerCase(), custodian);
}
export function recallSessionCustodian(sa: Address): Address | undefined {
  return sessionCustodians.get(sa.toLowerCase());
}
export function clearSessionCustodians(): void {
  sessionCustodians.clear();
}

/** personal_sign(message, address) — EIP-191. `message` may be utf8 or 0x-hex. */
export async function personalSign(address: Address, message: string): Promise<Hex> {
  return (await provider().request({ method: 'personal_sign', params: [message, address] })) as Hex;
}

/** Revoke this dApp's wallet connection (EIP-2255 `wallet_revokePermissions`) so it disappears from
 *  MetaMask's "Connected sites" on sign-out. A dApp disconnect otherwise only clears LOCAL state — the
 *  wallet keeps the `eth_accounts` permission. Best-effort + silent: no wallet, a wallet without the
 *  method (older MetaMask / other wallets), or no permission to revoke (the dApp was never
 *  wallet-connected — e.g. a Google/passkey session) all no-op without prompting the user. */
export async function disconnectWallet(): Promise<void> {
  clearSessionCustodians(); // B5 — drop the cached custodian(s) so a fresh sign-in re-picks (choose-once per session)
  clearRemotePersonaMarker(); // a real disconnect ends the tracker remote-persona session; a later real-wallet login must not be blocked
  if (!hasWallet()) return;
  try {
    await provider().request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch {
    /* unsupported / nothing to revoke — ignore (no prompt is shown in either case) */
  }
}
