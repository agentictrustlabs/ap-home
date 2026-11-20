// DID THIS ACCOUNT ACTUALLY GET CREATED?
//
// The four bootstrap routes (person, person + name, organization, agent) judge a deploy by this sender's own
// UserOperationEvent and EntryPoint's `AccountDeployed` for it.
// `/session/deploy/submit` filters by sender, then requires EntryPoint's `AccountDeployed`
// for that sender in the same receipt. This is that second half, shared.

/** keccak256("AccountDeployed(bytes32,address,address,address)") — EntryPoint v0.7. topics[2] is the sender. */
export const ACCOUNT_DEPLOYED_TOPIC = '0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d';

type ReceiptLogs = { logs?: ReadonlyArray<{ topics?: ReadonlyArray<string> }> };

/** True when the receipt carries EntryPoint's AccountDeployed event for exactly this sender. Pure. */
export function accountDeployedFor(receipt: ReceiptLogs, sender: string): boolean {
  const want = `0x${'0'.repeat(24)}${sender.toLowerCase().replace(/^0x/, '')}`;
  return (receipt.logs ?? []).some(
    (log) => log.topics?.[0]?.toLowerCase() === ACCOUNT_DEPLOYED_TOPIC && log.topics?.[2]?.toLowerCase() === want,
  );
}
