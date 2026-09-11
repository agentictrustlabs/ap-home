// WHAT I HAVE BEEN INVITED TO — spec 397, the invitee's half of spec 341 §5.1b. An organization's invitation to an agent
// reaches the invitee as a message from the inviter's own agent carrying a `org-channels` context reference (the Join
// chip the Home renders). That message sits in the invitee's OWN inbox record, so their agent can answer "what have I
// been invited to" from their own vault: the organizations named by those references, and whether they already belong.
// A read of the asker's own records (self-acting, no mandate); never another person's inbox.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';

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
interface Relationships { data?: Record<string, { agent?: string; relationship?: string }> }

export interface InvitationsDeps {
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  nameOf?: (address: string) => Promise<string | null>;
}

export function invitationsReceivedInvoker(deps: InvitationsDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'a person\'s invitations are read from their own inbox, and there is no signed-in person on this run' };
    if (!deps.readSubjectRecord) return { refused: 'this agent cannot read its person\'s inbox here' };
    const inbox = (await deps.readSubjectRecord(person.toLowerCase(), 'inbox.data').catch(() => null)) as InboxDoc | null;
    // The ENVELOPES are the record (each message carries its references); the descriptors are this side's mirror.
    const descriptors = [
      ...(inbox?.envelopes ?? []).map((e) => ({ participants: e.from ? [e.from] : [], contextRefs: e.contextRefs, createdAt: e.createdAt })),
      ...(inbox?.conversations ?? []).filter((c) => !c.archived).map((c) => ({ participants: c.participants ?? [], contextRefs: c.contextRefs, createdAt: c.createdAt })),
    ];
    const rels = (await deps.readSubjectRecord(person.toLowerCase(), 'relationships.data').catch(() => null)) as Relationships | null;
    const belongs = new Set(Object.values(rels?.data ?? {}).map((r) => String(r.agent ?? '').toLowerCase()).filter(Boolean));
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
    return {
      count: invitations.length,
      invitations,
      pending: invitations.filter((i) => !i.joined).length,
      interpretation: `read the person's own inbox (${(inbox?.envelopes ?? []).length} message(s)) for organizations that invited them`,
      note: invitations.length ? 'From their own inbox: the organizations whose invitation reached them, and whether they already belong. Joining is done at their Home (the Join chip) — it signs a listing they can revoke.' : 'No invitation has reached their inbox. An organization that recorded an invitation without sending the message has not told them yet.',
    };
  };
}
