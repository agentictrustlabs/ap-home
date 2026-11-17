import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

/** The key is estate custody material: create once, checkpoint it, then install it in that Home only. */
export function ensureNamingGate(file: string): { key: Hex; address: string } {
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const entry = /^NAMING_GATE_PRIVATE_KEY=(.*)$/m.exec(raw)?.[1]?.trim();
  let key = entry?.replace(/^['"]|['"]$/g, '') as Hex | undefined;
  if (entry && !/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('the stored naming gate key is malformed');
  if (!key) {
    key = generatePrivateKey();
    writeFileSync(file, `${raw.replace(/\n?$/, '\n')}NAMING_GATE_PRIVATE_KEY='${key}'\n`, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return { key, address: privateKeyToAccount(key).address };
}
