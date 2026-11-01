// SLICE S5 — THE WORKSPACE SENDS ITS GRANTED READ, over the delegated-task rail that already exists (`consult-rail.ts`:
// `submitDelegatedTask` → `readDelegatedTask` → `readTaskArtifact`, the client the consult fan-out and the archetype dispatch
// use). Nothing here is a new transport; this file only decides WHICH signing wire the message is signed under and turns
// the task's outcome into the answer `library.granted.fetch` returns.
//
// WHY THE AGENT'S OWN SIGNING WIRE, AND NOT ITS SESSION LEAF. The publisher's gate (`authorizeA2aMessage` in
// a2a-task-do.ts, #74) verifies the message as signed BY THE SENDER: plain ERC-1271, or — for a runtime that holds no key
// for the identity it acts as — a SESSION-WRAPPED signature (`0x51`), checked by `verifySessionWrappedSignature`, whose
// shape check (`checkSessionWireShape`) requires the wrapping wire to carry an allowedMethods caveat NAMING THE SKILL. The
// DEL-001 session leaf (`signAsAgent`, the release/offer signer) is `buildSessionDelegation`'s leaf: timestamp + value +
// session-audience, no allowedMethods — so a message signed under it is refused at every A2A gate ("session wire must
// carry an allowedMethods caveat"). The wire that DOES verify is the one the rail already signs with: the agent's own
// A2A signing wire (agent → this runtime's interactions-session key, allowedMethods enumerated, signed by the agent's
// custodian, held in the agent's InteractionsDO — `orgConsultWire`). Exactly as the archetype dispatch does
// (a2a-task-do.ts, "DOES THE WIRE ACTUALLY COVER THIS METHOD?"), the wire's coverage of `library.granted.read` is checked
// HERE first, with the same membership check the publisher will apply, so a ceremony gap is said in words instead of
// becoming a refusal on the publisher's agent.
//
// WHERE THE PUBLISHER IS. The rail reaches the publisher's task object IN-WORKER (a Worker cannot fetch its own account's
// hostnames); a publisher served by another deployment is refused by name — the same line the hand-off and the routed
// delivery draw (`where`).
import { checkSessionWireShape } from '@agenticprimitives/a2a';
import type { Hex } from 'viem';
import { orgConsultWire, readDelegatedTask, readTaskArtifact, submitDelegatedTask, type RawSigner } from './consult-rail.js';
import { LIBRARY_GRANTED_READ, type GrantedReadSender, type GrantedReadSent } from './library-tools.js';
import type { Env, IncomingDelegation } from './index.js';

/** How long the publisher's agent gets to answer one granted read inside a run (the skill is one catalog + one record read). */
export const GRANTED_FETCH_DEADLINE_MS = 20_000;

export interface GrantedReadSenderDeps {
  /** Is the publisher served by THIS deployment? `{ here: false, refused }` names why not. Absent ⇒ every agent is treated as here. */
  where?: (publisher: string) => Promise<{ here: true } | { here: false; refused: string }>;
  /** The sender's own A2A signing wire (tests inject; the Worker reads the agent's InteractionsDO — `orgConsultWire`). */
  signingWire?: (agent: string) => Promise<IncomingDelegation | null>;
  /** The interactions-session raw signer (tests only; the Worker uses the KMS session key). */
  signRaw?: RawSigner;
  deadlineMs?: number;
  everyMs?: number;
}

const TERMINAL_FAILED = new Set(['failed', 'rejected', 'canceled']);

/** The outbound half of library.granted.fetch, bound to this deployment's rail. */
export function grantedReadSender(env: Env, deps: GrantedReadSenderDeps = {}): GrantedReadSender {
  return async ({ sender, publisher, grant, input }): Promise<GrantedReadSent> => {
    const s = sender.toLowerCase();
    const p = publisher.toLowerCase();
    if (deps.where) {
      const at = await deps.where(p).catch((e: unknown) => ({ here: false as const, refused: `where it is served could not be read (${e instanceof Error ? e.message : String(e)})` }));
      if (!at.here) return { ok: false, refused: `the publisher ${p} cannot be asked from here: ${at.refused}` };
    }
    let wire: IncomingDelegation | null;
    try { wire = await (deps.signingWire ? deps.signingWire(s) : orgConsultWire(env, s)); } catch (e) {
      return { ok: false, refused: `this workspace's signing wire could not be read (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!wire) return { ok: false, refused: `this workspace (${s}) holds no signing wire of its own — the A2A message must be signed as the workspace, and this runtime does that only under a wire the workspace's custodian signed (workspace → the interactions-session key) naming ${LIBRARY_GRANTED_READ}` };
    const tsEnf = (env.TIMESTAMP_ENFORCER ?? '').toLowerCase();
    const amEnf = (env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
    const shapeErr = [tsEnf, amEnf].every((a) => /^0x[0-9a-f]{40}$/.test(a))
      ? checkSessionWireShape(wire as never, { timestamp: tsEnf, allowedMethods: amEnf }, Math.floor(Date.now() / 1000), { skill: LIBRARY_GRANTED_READ })
      : 'the timestamp / allowedMethods enforcers are not configured, so the signing wire cannot be checked';
    if (shapeErr) return { ok: false, refused: `this workspace's signing wire cannot sign a granted read (${shapeErr}) — its custodian re-signs the wire with ${LIBRARY_GRANTED_READ} among its methods` };

    let taskId: Hex;
    try {
      ({ taskId } = await submitDelegatedTask(env, {
        org: s, orgWire: wire, grant: grant as unknown as IncomingDelegation, target: p, skill: LIBRARY_GRANTED_READ, input,
        ...(deps.signRaw ? { signRaw: deps.signRaw } : {}),
      }));
    } catch (e) {
      return { ok: false, refused: `the publisher's agent did not take the request: ${e instanceof Error ? e.message : String(e)}` };
    }

    const until = Date.now() + (deps.deadlineMs ?? GRANTED_FETCH_DEADLINE_MS);
    const every = deps.everyMs ?? 500;
    let state = 'submitted';
    for (;;) {
      let read: Awaited<ReturnType<typeof readDelegatedTask>>;
      try { read = await readDelegatedTask(env, { org: s, target: p, taskId }); } catch (e) {
        return { ok: false, taskId, refused: e instanceof Error ? e.message : String(e) };
      }
      state = read.state;
      // The publisher's refusal, in its words: the skill fails the task with `refused` as the status message.
      if (TERMINAL_FAILED.has(state)) return { ok: false, taskId, refused: read.error || `the publisher's agent ${state} the read` };
      if (state === 'completed') {
        const artifactId = read.artifactIds[0];
        if (!artifactId) return { ok: false, taskId, refused: 'the publisher\'s agent completed the read with no artifact' };
        let body: unknown;
        try { body = await readTaskArtifact(env, p, taskId, s, artifactId); } catch (e) {
          return { ok: false, taskId, refused: `the publisher's answer could not be read (${e instanceof Error ? e.message : String(e)})` };
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, taskId, refused: 'the publisher\'s answer was not a granted read' };
        return { ok: true, taskId, body: body as Record<string, unknown> };
      }
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, every));
    }
    return { ok: false, taskId, pending: true, refused: `the publisher's agent had not answered within ${Math.round((deps.deadlineMs ?? GRANTED_FETCH_DEADLINE_MS) / 1000)}s (task ${state})` };
  };
}
