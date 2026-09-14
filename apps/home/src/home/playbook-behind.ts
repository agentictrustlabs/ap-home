// A PLAYBOOK THAT PREDATES A CAPABILITY. The harness offers a tool only when the person's assigned playbook carries its
// contract (one capability model, spec 354/361); a person whose agent still runs the digest it was born with gets
// `unknown_tool: plan selected a tool not exposed by this agent: <id>` for anything the registry added since. That is
// not a broken read and not an empty one: it is a version behind, and the fix is hers to take on the Playbook page
// (K3 — never a silent upgrade). Every screen that reads through the harness says exactly that, with the way there.
export function playbookBehind(error: string | null | undefined): { toolId: string } | null {
  const m = /unknown_tool[^:]*:.*?not exposed by this agent:\s*([a-z0-9.]+)/i.exec(error ?? '');
  return m ? { toolId: m[1]! } : null;
}

/** The sentence a screen says, with the capability it wanted. */
export const playbookBehindWords = (toolId: string): string =>
  `your playbook predates ${toolId} — take the newer version on the Playbook page (Review the update)`;
