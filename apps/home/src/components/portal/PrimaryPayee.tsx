// "WHEN SOMEONE PAYS ME, IT GOES HERE" — `ap:primaryPayee` (spec 355 / ADR-0061).
//
// A person can hold several treasuries, and only they know which is the one to receive. Without saying
// so, every payer either guesses or is asked — which puts the choice on the person who knows least about
// it, and makes "send alice 10 usdc" a question instead of an answer.
//
// It is a PREFERENCE. It does not stop anyone paying a different treasury of yours, does not let anyone
// spend from this one, and no gate reads it. It is recorded as a role on the PUBLIC ap:charteredUnder
// edge, which is what lets a stranger's agent honour it — and which is also why an agent you keep
// unlisted cannot carry one: for those, the preference IS the grant you signed.
import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { RELATIONSHIP_TYPE, ROLE } from '@agenticprimitives/agent-relationships';
import { BusyButton } from '../shared/BusyButton';
import { CONTRACTS } from '../../lib/chain';
import { primaryPayeeThroughHarness } from '../../home/primary-payee-harness';
import { mutedText, errorText } from './theme';

const REL_ABI = [
  { type: 'function', name: 'getEdgeByTriple', stateMutability: 'view', inputs: [
    { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' },
  ], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'addRole', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'removeRole', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [] },
] as const;
const ZERO32 = `0x${'0'.repeat(64)}`;

export function PrimaryPayee({ treasury, person, token, signHash }: {
  treasury: string; person: string; token: string;
  signHash: (digest: Hex) => Promise<Hex>;
}) {
  const [edgeId, setEdgeId] = useState<Hex | null>(null);
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const read = useCallback(async () => {
    if (!CONTRACTS.agentRelationship) return;
    const call = async (fn: 'getEdgeByTriple' | 'hasRole', args: unknown[]) => {
      const res = await fetch('/a2a/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{
          to: CONTRACTS.agentRelationship,
          data: encodeFunctionData({ abi: REL_ABI, functionName: fn, args: args as never }),
        }, 'latest'] }),
      });
      const j = (await res.json().catch(() => ({}))) as { result?: string };
      return j.result ?? '';
    };
    const id = await call('getEdgeByTriple', [treasury, person, RELATIONSHIP_TYPE.CHARTERED_UNDER]);
    if (!id || id === ZERO32 || id.length < 66) { setEdgeId(null); setIsPrimary(null); return; }
    setEdgeId(id as Hex);
    const has = await call('hasRole', [id, ROLE.PRIMARY_PAYEE]);
    setIsPrimary(/1$/.test(has));
  }, [treasury, person]);
  useEffect(() => { void read(); }, [read]);

  // NO EDGE, NO PREFERENCE — and that is not a failure to explain away. An unlisted agent has no public
  // link to hang this on, and saying so is more use than a disabled control with no reason.
  if (!edgeId) {
    return (
      <p style={{ ...mutedText, fontSize: 11 }}>
        Not in the public record, so it cannot be marked for payments — you give someone a way to reach it
        when you answer their request.
      </p>
    );
  }

  async function set(on: boolean) {
    setBusy(true); setErr('');
    try {
      // THROUGH THE HARNESS — spec 361 I4. This used to build the `addRole` call here and submit it
      // directly, which cost the same one signature but made the button an implementation the Ask could
      // not reach. Now both surfaces enter at `/harness/ask`: the click supplies its plan, the sentence
      // is interpreted, and from there it is one capability with one receipt trail. The mandate is still
      // the only prompt, and naming a new primary now clears the old one in the same act.
      const out = await primaryPayeeThroughHarness({
        treasury: treasury as Address, person: person as Address, on,
        session: { token }, signHash,
      });
      if (!out.ok) throw new Error(out.error);
      await read();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 6 }}>
      {err && <p style={errorText}>{err}</p>}
      {isPrimary ? (
        <p style={{ ...mutedText, fontSize: 11 }} data-testid={`primary-payee-on-${treasury.toLowerCase()}`}>
          Payments to you come here.{' '}
          <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '.15rem .4rem' }} disabled={busy} onClick={() => void set(false)}>
            Stop
          </button>
        </p>
      ) : (
        <BusyButton
          busy={busy} busyLabel="Setting…" className="btn-ghost" style={{ fontSize: 11, padding: '.2rem .5rem' }}
          data-testid={`primary-payee-set-${treasury.toLowerCase()}`} onClick={() => void set(true)}
        >
          Receive payments here
        </BusyButton>
      )}
    </div>
  );
}
