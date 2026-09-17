// SPEC 406 W2 — THE RECEIPT ANCHOR ON CHAIN. A finished run's PROV bundle (the JSON-LD `run.provenance:<runRef>`
// record) is digested canonically and anchored in the `ReceiptAnchorRegistry` from the runtime's harness agent — the
// same account that redeems mandates — with the intent digest the run was asked under and the mandate it presented.
// A run that left no transaction of its own (a read, a message, a build) is anchored too. What reaches the chain:
// three digests and the agent's address; never a word. A counterparty who holds the bundle recomputes the digest and
// reads `anchorOf` with `readContract` (ADR-0012) — no runtime, no vault, no vendor between them and the proof.
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';

export const ANCHOR_ABI = [
  { type: 'function', name: 'anchor', stateMutability: 'nonpayable', inputs: [{ name: 'receiptDigest', type: 'bytes32' }, { name: 'intentDigest', type: 'bytes32' }, { name: 'mandateRef', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'anchorOf', stateMutability: 'view', inputs: [{ name: 'receiptDigest', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'anchoredBy', type: 'address' }, { name: 'at', type: 'uint64' }, { name: 'intentDigest', type: 'bytes32' }, { name: 'mandateRef', type: 'bytes32' }] }] },
  { type: 'function', name: 'isAnchored', stateMutability: 'view', inputs: [{ name: 'receiptDigest', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;

/** Deterministic JSON: keys sorted at every level, no whitespace — the same bytes from any holder of the same document. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
/** The bundle's digest: keccak256 over its stable JSON (bytes32 — what the registry keys on). */
export const bundleDigest = (bundle: unknown): Hex => keccak256(toBytes(stableStringify(bundle)));

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** The harness agent's call: `execute(registry, 0, anchor(digest, intent, mandate))`. */
export function anchorCallData(registry: Address, digest: Hex, intentDigest: Hex, mandateRef: Hex): Hex {
  const inner = encodeFunctionData({ abi: ANCHOR_ABI, functionName: 'anchor', args: [digest, intentDigest, mandateRef] });
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [registry, 0n, inner] });
}

export interface AnchorReport { digest: Hex; registry: Address; anchoredBy: Address; txHash?: Hex; chainId?: number; error?: string }
