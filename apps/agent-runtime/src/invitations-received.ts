// WHAT I HAVE BEEN INVITED TO — spec 397, the invitee's half of spec 341 §5.1b. An organization's invitation to an agent
// reaches the invitee as a message from the inviter's own agent carrying a `org-channels` context reference (the Join
// chip the Home renders). That message sits in the invitee's OWN inbox record, so their agent can answer "what have I
// been invited to" from their own vault: the organizations named by those references, and whether they already belong.
// A read of the asker's own records (self-acting, no mandate); never another person's inbox.
import { InputRequired, type ToolSpec, type ToolInvoker } from '@agenticprimitives/orchestration';
import { ADAPTER } from './adapter-declarations.js';
import { relationshipRows } from '@agenticprimitives/context';

export const INVITATIONS_RECEIVED_CAPABILITY = 'person.invitations.list' as const;

export const INVITATIONS_RECEIVED_TOOL: ToolSpec = {
  id: INVITATIONS_RECEIVED_CAPABILITY,
  answers: ['my invitations', 'what invitations do i have', 'invited to', 'who invited me', 'pending invitations'],
  description:
    'THE INVITATIONS THE PERSON HAS RECEIVED — organizations, teams, circles that invited them to join, read from their own '
    + 'inbox (the Join message the inviter\'s agent sent), with whether they have already joined. Use it for "what invitations '
    + 'do I have", "who invited me". Their own records only; it never reads an organization\'s vault. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

interface ContextRef { kind: string; id: string; label?: string }
/** `inbox.data` (fabric `InboxDataV1`): the message envelopes carry the reference (the Join chip's), the conversation descriptors mirror it. */
interface InboxDoc { envelopes?: Array<{ id?: string; from?: string; createdAt?: string; contextRefs?: ContextRef[] }>; conversations?: Array<{ id?: string; participants?: string[]; contextRefs?: ContextRef[]; createdAt?: string; archived?: boolean }> }

export interface InvitationsDeps {
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  nameOf?: (address: string) => Promise<string | null>;
}

export interface ReceivedInvitationV1 { org: string; name: string | null; label?: string; from: string[]; invitedAt?: string; joined: boolean }

export function invitationsReceivedInvoker(deps: InvitationsDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'a person\'s invitations are read from their own inbox, and there is no signed-in person on this run' };
    if (!deps.readSubjectRecord) return { refused: 'this agent cannot read its person\'s inbox here' };
    const { invitations, messages } = await invitationsOf(deps, person);
    return {
      count: invitations.length,
      invitations,
      pending: invitations.filter((i) => !i.joined).length,
      interpretation: `read the person's own inbox (${messages} message(s)) for organizations that invited them`,
      note: invitations.length ? NOTE_FOUND : NOTE_NONE,
    };
  };
}

/** The invitations that reached this person, from their OWN inbox — the one reading both the list and the accept use. */
export async function invitationsOf(deps: InvitationsDeps, person: string): Promise<{ invitations: ReceivedInvitationV1[]; messages: number }> {
  const read = deps.readSubjectRecord;
  if (!read) return { invitations: [], messages: 0 };
  {
    const inbox = (await read(person.toLowerCase(), 'inbox.data').catch(() => null)) as InboxDoc | null;
    // The ENVELOPES are the record (each message carries its references); the descriptors are this side's mirror.
    const descriptors = [
      ...(inbox?.envelopes ?? []).map((e) => ({ participants: e.from ? [e.from] : [], contextRefs: e.contextRefs, createdAt: e.createdAt })),
      ...(inbox?.conversations ?? []).filter((c) => !c.archived).map((c) => ({ participants: c.participants ?? [], contextRefs: c.contextRefs, createdAt: c.createdAt })),
    ];
    const rels = await read(person.toLowerCase(), 'relationships.data').catch(() => null);
    // ONE PARSER for relationships.data (`{ orgs: { <address>: entry } }` — a map, in several entry shapes). This read
    // `rels.data`, which the record does not have, so `joined` was false for everyone: an invitation listed as pending
    // after its invitee joined, and accept could never confirm a join (invite e2e, live 2026-09-29).
    const belongs = new Set(relationshipRows(rels).map((r) => r.agent));
    const seen = new Map<string, { org: string; name: string | null; label?: string; from: string[]; invitedAt?: string; joined: boolean }>();
    for (const d of descriptors) {
      for (const ref of d.contextRefs ?? []) {
        if (ref.kind !== 'org-channels' || !/^0x[0-9a-fA-F]{40}$/.test(ref.id)) continue;
        const org = ref.id.toLowerCase();
        const from = (d.participants ?? []).map((p) => p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase()).filter((a): a is string => !!a && a !== person.toLowerCase());
        const cur = seen.get(org);
        if (cur) { for (const f of from) if (!cur.from.includes(f)) cur.from.push(f); continue; }
        seen.set(org, { org, name: deps.nameOf ? await deps.nameOf(org).catch(() => null) : null, ...(ref.label ? { label: ref.label } : {}), from, ...(d.createdAt ? { invitedAt: d.createdAt } : {}), joined: belongs.has(org) });
      }
    }
    const invitations = [...seen.values()];
    return { invitations, messages: (inbox?.envelopes ?? []).length };
  }
}
const NOTE_FOUND = 'From their own inbox: the organizations whose invitation reached them, and whether they already belong. Joining is done at their Home (the Join chip) — it signs a listing they can revoke.';
const NOTE_NONE = 'No invitation has reached their inbox. An organization that recorded an invitation without sending the message has not told them yet.';

// ── ACCEPTING — spec 421 (the Ask does what the Join button does). ───────────────────────────────────────────────────────
// "Accept the invitation to Missio Nexus" / "join missio nexus": the invitee's own act. Joining SIGNS her membership (a
// member→organization delegation, her consent for herself only) and countersigns the organization's membership credential —
// a ceremony only her Home can run, with her credential. So the step asks her Home to run THE SAME ceremony the Join chip
// runs (a `confirmation` whose summary names it: `{ ceremony: 'org-join', org }`), and on resume it READS her own records:
// joined is what her relationships say, never what the surface claims. No invitation from that organization is a refusal
// that says so — accepting is not a way to join an organization that did not ask.
export const MEMBERSHIP_ACCEPT_CAPABILITY = 'organization.membership.accept' as const;
export const MEMBERSHIP_ACCEPT_TOOL: ToolSpec = {
  id: MEMBERSHIP_ACCEPT_CAPABILITY,
  verbs: ['accept the invitation', 'accept the invite', 'accept invitation', 'accept', 'join'],
  description:
    'ACCEPTS an invitation the PERSON ASKING received — joins the organization, team or circle that invited them. It signs '
    + 'their own membership at their Home (the same act as the Join chip) and is theirs alone. Only for an organization whose '
    + 'invitation is in their own inbox (person.invitations.list); never a way to join one that did not ask. Args: invitedTo (the '
    + 'organization, team or circle they were invited to).',
  inputSchema: { type: 'object', properties: { invitedTo: { type: 'string', description: 'The organization they were invited to' } }, required: ['invitedTo'] },
  capability: { id: MEMBERSHIP_ACCEPT_CAPABILITY, action: 'accept', resourceArg: 'invitedTo' },
  risk: 'low', adapter: ADAPTER.sync,   // joined is read back from her own records after the ceremony
  selfAuthorized: true,
  dryRun: 'invoke',
  establishes: 'authoritative',
  interaction: { navigationTarget: 'organizations' },
};

export function membershipAcceptInvoker(deps: InvitationsDeps, person: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    if (!person) return { refused: 'accepting an invitation is the invitee\'s own act, and there is no signed-in person on this run' };
    if (!deps.readSubjectRecord) return { refused: 'this agent cannot read its person\'s records here' };
    const org = String(args.invitedTo ?? args.org ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(org)) return { refused: 'which organization? name the one that invited you' };
    const { invitations } = await invitationsOf(deps, person);
    const inv = invitations.find((i) => i.org === org);
    const name = inv?.name ?? inv?.label ?? (deps.nameOf ? await deps.nameOf(org).catch(() => null) : null) ?? org;
    if (!inv) return { refused: `you have no invitation from ${name} — its steward has to invite you first` , org };
    if (inv.joined) return { joined: true, already: true, org, name, answer: `You already belong to ${name}.` };
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const confirmed = (ctx.supplied ?? []).some((x) => x.stepRef === stepRef && x.confirmed === true);
    if (!confirmed) {
      // A comparison's dry run stops here too: the ceremony is hers to run, never simulated.
      throw new InputRequired({ kind: 'confirmation', stepRef, toolId, prompt: `Join ${name}? This signs your membership — your consent, for you alone.`, summary: { ceremony: 'org-join', org, orgName: name } });
    }
    // RESUMED: joined is what HER records now say.
    const after = await invitationsOf(deps, person);
    const now = after.invitations.find((i) => i.org === org);
    return now?.joined
      ? { joined: true, org, name, answer: `You joined ${name}.` }
      : { refused: `the membership for ${name} was not recorded — nothing changed; the Join chip in Messages does the same thing`, org };
  };
}

