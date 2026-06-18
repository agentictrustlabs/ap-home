// Minimal EIP-1193 (window.ethereum) wallet helpers — no wagmi. The EOA signs
// both the SIWE login message and the deploy userOpHash (personal_sign / EIP-191;
// AgentAccount._verifyEcdsa accepts raw-or-EIP-191 recovery).
import type { Address, Hex } from '@agenticprimitives/types';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): Eip1193 {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No Ethereum wallet found — install MetaMask (or another wallet) to connect.');
  return eth;
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { ethereum?: unknown }).ethereum;
}

/** All accounts the wallet has connected (order = wallet's, [0] = active). `forceSelect` pops MetaMask's
 *  account picker (`wallet_requestPermissions`) even when already connected, so a multi-custodian admin can
 *  expose the RIGHT account. Callers that sign FOR A SPECIFIC HOME should pick the connected account that
 *  custodies it (not just [0] — eth_requestAccounts returns the active account first, which may be another
 *  home's custodian like the platform deployer). */
export async function connectWalletAccounts(forceSelect = false, restrictTo?: Address): Promise<Address[]> {
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
  if (!hasWallet()) return;
  try {
    await provider().request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch {
    /* unsupported / nothing to revoke — ignore (no prompt is shown in either case) */
  }
}
