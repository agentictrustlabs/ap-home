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

export async function connectWallet(): Promise<Address> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as Address[];
  const account = accounts?.[0];
  if (!account) throw new Error('No wallet account selected.');
  return account;
}

/** personal_sign(message, address) — EIP-191. `message` may be utf8 or 0x-hex. */
export async function personalSign(address: Address, message: string): Promise<Hex> {
  return (await provider().request({ method: 'personal_sign', params: [message, address] })) as Hex;
}
