// Mock EIP-1193 wallet for Playwright — a generated SIWE keypair injected as window.ethereum.
// personal_sign is forwarded to a Node-side viem signer (the private key never enters the page).
import { type Page } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export async function installMockWallet(page: Page, privateKey: Hex): Promise<{ address: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey);
  const address = account.address;

  // Node-side signer. personal_sign message is 0x-hex (raw bytes) OR a utf8 string (SIWE) — both EIP-191.
  await page.exposeFunction('__walletSign', async (message: string): Promise<string> => {
    if (typeof message === 'string' && /^0x[0-9a-fA-F]*$/.test(message)) {
      return account.signMessage({ message: { raw: message as Hex } });
    }
    return account.signMessage({ message });
  });

  await page.addInitScript((addr: string) => {
    const CHAIN = '0x14a34'; // Base Sepolia 84532
    const eth = {
      isMetaMask: true,
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [addr];
          case 'eth_chainId':
            return CHAIN;
          case 'net_version':
            return '84532';
          case 'wallet_requestPermissions':
            return [{ parentCapability: 'eth_accounts', caveats: [] }];
          case 'wallet_revokePermissions':
            return null;
          case 'wallet_switchEthereumChain':
            return null;
          case 'personal_sign': {
            const msg = (params as unknown[])[0] as string;
            return (window as unknown as { __walletSign: (m: string) => Promise<string> }).__walletSign(msg);
          }
          default:
            throw Object.assign(new Error(`mock wallet: unhandled ${method}`), { code: 4200 });
        }
      },
      on() { /* no events */ },
      removeListener() { /* no events */ },
    };
    (window as unknown as { ethereum: unknown }).ethereum = eth;
  }, address);

  return { address };
}
