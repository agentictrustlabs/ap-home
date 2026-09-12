// A SCREEN RUNS A COMMAND THROUGH THE ASK — spec 361 I4 (execution parity), 398 G1.
//
// A button on a screen and a sentence in the Ask must reach the same boundary: `/harness/ask`, with the
// same standing, the same mandate ceremony, the same receipt. Before this the Work screen's buttons went
// to the Home's own `/connect/work` route and on to the organization's object by session RPC — a second
// execution path with its own authority shape, and the count spec 341's ratchet exists to drive to zero.
//
// So a screen does not execute. It hands the Ask a SUPPLIED PLAN — the one command it knows, with the
// person's choices as arguments (exactly what the command picker does) — and the Ask runs it: the agent
// verifies the step, asks for the mandate it needs, the person signs THERE, and the receipt lands where
// every other receipt lands. The screen's job ends at naming the act.
//
// Carried on the `ap:ask` window event the shell already listens for (a seed sentence, a parked run);
// this is its third shape. The plan is never words: the tool id and its arguments are what the screen
// knows for certain, and a sentence would only ask the planner to guess them back.
export interface AskCommand {
  /** The capability's tool id — the screen names the act exactly. */
  toolId: string;
  args: Record<string, unknown>;
  /** What the thread shows as the person's turn: the act in words, with the choices. */
  message: string;
}

export function askCommand(cmd: AskCommand): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ap:ask', { detail: { command: cmd } }));
}
