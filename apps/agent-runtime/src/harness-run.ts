// THE HARNESS ON THIS AGENT — spec 350 W2: a treasury payment (scenario 3) and a team's creation
// (scenario 2) under a mandate.
//
// This is where the harness stops being a package and becomes a thing that moves money. `runIntent` asks
// its ports before every capability step; this module binds those ports to this Worker's substrate:
//
//   MandateVerifier  → `delegation.verifyMandateForStep` over the chain (isRevoked, ERC-1271 via the
//                      UniversalSignatureValidator — readContract only, ADR-0012)
//   PolicyEvaluator  → tool-policy's risk ladder: `treasury.payment.execute` is HIGH ⇒ a second party
//   ApprovalPort     → supplied approvals (W2): the steward pre-signs an approval over the STEP'S authority
//                      evidence and hands it in with the ask; verified ERC-1271 against the approver SA.
//                      W3 makes this durable (suspend / resume through A2aTaskDO).
//   ReceiptSink      → the audit sink + the response. Vault-resident receipts are W3.
//   ToolInvoker      → `organization.team.create` does what the Home's button does, conversationally: it
//                      builds the team's GENESIS (deploy + `<label>.team` + typed declaration + the
//                      stewardship grant child → workspace, one sponsored userOp) and ASKS the connected
//                      user for what only they hold — the name if the ask did not say it, the credential
//                      that will custody the team (custody is ALWAYS the connected user), and the
//                      signature over the genesis hash. On resume it re-derives the genesis and checks the
//                      signed userOp IS the one it derived before submitting. The mandate (delegator = the
//                      workspace) is what lets this agent act in the workspace's name; the custodian's
//                      signature is what brings the team into being. Neither substitutes for the other.
//                    → `treasury.payment.execute` REDEEMS the mandate on chain: this agent's service SA
//                      submits `DelegationManager.redeemDelegation(mandate, USDC, 0, transfer(payee, amt))`
//                      as a sponsored userOp, with the PaymentEnforcer's redeem-time args AND the
//                      DigestBindingEnforcer's presented intent digest filled in. The delegator is the
//                      PAYER — an org or its treasury SA — and it is the delegator's USDC that moves.
//
// WHO IS THE DELEGATE. The mandate names THIS agent's harness SA (`HARNESS_AGENT_SA`) as delegate,
// custodied by the interactions-session key. `DelegationManager` requires `msg.sender == delegate`, so
// the service SA executes `execute(DM, 0, redeem…)` and the DM calls back into the payer SA. No key for
// the payer is ever held here; the mandate is the only authority, and it is checked per step, on chain
// AND off.
import { CONTACT_FIELDS, CONTACT_FIELD_ARGS } from '@agenticprimitives/ontology';
import type { TriggerV1 } from '@agenticprimitives/capability-claims';
import { BALANCE_READ_TOOL, BALANCE_READ_CAPABILITY, balanceReadInvoker, renderAnswer } from './balance-read.js';
import { COORDINATION_READ_TOOLS, COORDINATION_ACTION_TOOLS, COORDINATION_CAPABILITY_IDS, ENDEAVOR_LIST_CAPABILITY, ENDEAVOR_GET_CAPABILITY, endeavorReadInvoker, endeavorActInvoker } from './coordination-bindings.js';
import { progressLine, type ProgressLineV1 } from './harness-progress.js';
import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes, toFunctionSelector, type Address, type Hex } from 'viem';
import { type Plan, type Planner,
  runIntent, InputRequired, dataFor, signatureFor,
  type RunResult, type ToolSpec, type ToolInvoker, type ApprovalPort, type ReceiptSink, type StepReceipt, type MandatePresentation, type SuppliedInputV1, type InputFieldV1, type AnswerComposer, planAdmission, instructionNeedsAct, noPlaceholders, subjectNamedInAsk, dependenciesProvided, branchesDecidable, questionAnsweredByRead, outcomeClassOf, type ExecutionBindingV1, type OutcomeClass, type ResolvedStep } from '@agenticprimitives/orchestration';
import { delegationMandateVerifier, riskLadderPolicy, mandateRequirementForStep } from '@agenticprimitives/harness';
import {
  hashDelegation, intentDigest, encodeDigestBindingArgs, decodeTimestampTerms, buildCaveat, buildVaultRecordScopeCaveat,
  encodeTimestampTerms, encodeValueTerms, ROOT_AUTHORITY, CAPABILITY_RAR_TYPE, PAYMENT_RAR_TYPE,
  type Caveat, type Delegation, type EnforcerAddresses, type MandateRequirementV1, methodSelector,} from '@agenticprimitives/delegation';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import { RELATIONSHIP_TYPE, ROLE } from '@agenticprimitives/agent-relationships';
import type { AuditSink } from '@agenticprimitives/audit';
import { enforcersFromEnv } from './org-wire.js';
import { wireToDelegation, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { selectPlanner, selectComposer } from './orchestration.js';
import { ASK_DISCOVERY_TOOLS } from '@agenticprimitives/context';
import { structuredCallFor } from './context-wiring.js';
import type { DefinitionToolV1 } from '@agenticprimitives/capability-claims';
import { loadPlaybook } from './playbook.js';
import { playbookProvenanceFromReceipts } from './skill-provenance.js';
import { declaredEffectSink } from './declared-effects.js';
import { checkGroundedComposition, groundedFallback } from '@agenticprimitives/context';
import { KB_QUESTION_TOOL, kbQuestionAvailable } from '@agenticprimitives/context';
import { VAULT_QUESTION_TOOL, vaultQuestionAvailable } from '@agenticprimitives/context';
import { resolveParty, ownAgentsOfType, candidateHint, choicesFor, VALUE_ARGS, type PartyLookups } from '@agenticprimitives/context';
import { decide, PAYMENT_SOURCE_ACCOUNT, PAYMENT_RECIPIENT, argTypesFor, readValue, isFlagTrue } from '@agenticprimitives/ontology';
import { buildAskVocabulary, type AskCapabilityLike, type SurfaceCeremony, type SurfaceDescriptor, type SurfaceRiskTier } from '@agenticprimitives/surface-catalog';
import type { ResolvedParty } from '@agenticprimitives/context';
import { MEMBERSHIP_LIST_TOOL, membershipListInvoker, AFFILIATIONS_LIST_TOOL, affiliationsListInvoker, INVITATIONS_LIST_TOOL, invitationsListInvoker, relationshipRows } from '@agenticprimitives/context';
import { RESOLUTION_REQUEST_TOOL } from './resolution-invitation.js';
import { actionLink, resolutionRequestInvoker } from './resolution-request.js';
import { partyRole, suffixesFor, COUNTERPARTY_ARGS, PARTY_ROLES, SUFFIX_FOR_CLASS, fanOutBindingFor } from '@agenticprimitives/ontology';
import { decodePaymentTerms } from '@agenticprimitives/delegation';
import { preconditionRefusal } from './capability-preconditions.js';
import { AUTHORITY_BEARING_CAPABILITIES } from './endeavor-authority-steps.js';
import { deriveStanding, standingNote, type Standing, type StandingDeps } from '@agenticprimitives/context';


export interface HarnessEnv {
  /** The Home origins this agent serves — the first is used for links a person can follow. */
  ALLOWED_ORIGINS?: string;
  CHAIN_ID: string;
  RPC_URL?: string;
  DELEGATION_MANAGER: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  /** The SA this agent acts as under a mandate (the mandate's DELEGATE). Deployed per chain, custodied by the
   *  interactions-session key. Not INTERACTIONS_SERVICE_SA: that address is what existing grants name. */
  HARNESS_AGENT_SA?: string;
  DIGEST_BINDING_ENFORCER?: string;
  PAYMENT_ENFORCER?: string;
  MOCK_USDC?: string;
  /** The AgentRelationship record — where `ap:charteredUnder` edges and their roles live. */
  AGENT_RELATIONSHIP?: string;
  [k: string]: unknown;
}

/** The action tools this agent exposes to the harness, WITH their capability declarations. Risk and
 *  capability are declared on the tool — the planner cannot describe a step out of needing authority. */
/** The child agents an Ask can charter, and the typed root each lands under (spec 346). One shape, one
 *  ceremony: what differs is the capability the mandate must grant and whose authority it needs — a team
 *  needs its workspace's, an organization needs the PERSON's (nothing above them exists yet, which is
 *  exactly why org-create belongs to the person's own realm). */
export const CHILD_AGENT_KINDS = [
  { capability: 'organization.team.create', tld: 'team', noun: 'team', parentNoun: 'a workspace or organization' },
  { capability: 'organization.create', tld: 'org', noun: 'organization', parentNoun: 'a person (their own realm)' },
  { capability: 'treasury.create', tld: 'treasury', noun: 'treasury', parentNoun: 'a person or an organization' },
  // Spec 368 — the family's own agent, chartered under a person; its members are the household.
  { capability: 'household.create', tld: 'household', noun: 'household', parentNoun: 'a person (their own realm)' },
] as const;

/** The KIND a created agent is recorded as in its owner's tree. Usually the noun; a treasury is named for
 *  WHOSE it is, because that is how the Home lists it (`person-treasury` under you, `org-treasury` inside
 *  the organization) — recording a bare "treasury" would put it in neither. */
export function recordedKind(noun: string, parent: string, person?: string): string {
  if (noun !== 'treasury') return noun;
  return person && parent.toLowerCase() === person.toLowerCase() ? 'person-treasury' : 'org-treasury';
}

export const CHILD_AGENT_TLD: Record<string, string> = Object.fromEntries(CHILD_AGENT_KINDS.map((k) => [k.capability, k.tld]));

/**
 * `organization.membership.invite` — the org-side half of joining (spec 321 W2b).
 *
 * Membership is not something an organization can impose: the invitee redeems it. So the capability an
 * organization grants is the INVITATION, and what it produces is a pre-signed org → invitee access grant
 * that the invitee's join picks up. The steward's credential signs it (the org validates its custodians'
 * signatures, ERC-1271), which is a §3.5 signature prompt like any other.
 *
 * The private half — storing the grant in the ORG's vault — is the surface's, exactly as recording a
 * created agent is: this agent holds no delegation to that vault, and an invitation nobody stored is a
 * promise nobody can find.
 */
export const ORG_INVITE_CAPABILITY = 'organization.membership.invite' as const;
/** The "pay me here" preference (`ap:primaryPayee` on the public charteredUnder edge). Spec 355/361. */
export const PRIMARY_PAYEE_CAPABILITY = 'treasury.primary.declare' as const;
/** WHO CAN READ MY RECORDS — the person's own audit of the apps they have authorized (spec 341 §4.3). */
export const ACCESS_LIST_CAPABILITY = 'access.grants.list' as const;
/** …AND STOP THEM. On-chain revocation of one grant they issued — the authority kill, not a local drop. */
export const ACCESS_REVOKE_CAPABILITY = 'access.grant.revoke' as const;
/** THE PERSON'S OWN CONTACT DETAILS — the PRIVATE vault record, never the public directory listing. */
export const PROFILE_READ_CAPABILITY = 'profile.contact.read' as const;
/** WHO THEY LIVE WITH — spec 363 W4. Their own record, private tier, never published. */
export const HOUSEHOLD_READ_CAPABILITY = 'household.roster' as const;
export const HOUSEHOLD_RECORD_CAPABILITY = 'household.member.record' as const;

/**
 * WHO I LIVE WITH — the person's own household record (spec 363 W4).
 *
 * PRIVATE TIER, and the read says so. A household is not on chain, not in the directory, and not
 * something another agent can ask about: this answers for the person asking, from their own vault.
 */
export const HOUSEHOLD_READ_TOOL: ToolSpec = {
  id: HOUSEHOLD_READ_CAPABILITY,
  description:
    'ANSWERS A QUESTION: who is in this person\'s household — the people they live with, as they have '
    + 'recorded them, with each one\'s role (guardian / dependent / member) and how they are kin '
    + '(spouse, child, parent, sibling). Use for "who is in my household", "who do I live with", "who is '
    + 'my family here". Takes no arguments and answers only for the person asking. '
    + 'NEVER A STEP TOWARD PAYING OR MESSAGING SOMEONE: if the ask is to send money to "my daughter" or '
    + 'write to "my wife", choose the capability that DOES that and pass the words — it resolves who is '
    + 'meant from this same household record, and it actually acts. Listing the household and then '
    + 'saying the money was sent is the one thing this tool must never be used for.',
  inputSchema: { type: 'object', properties: {} },
  interaction: { navigationTarget: 'household' },
};

export const PROFILE_UPDATE_CAPABILITY = 'profile.contact.update' as const;

/**
 * WHAT MY PROFILE SAYS — the person's own contact record, read from their own vault.
 *
 * TIER, STATED (the three-tier rule): this is the PRIVATE record — contact details held for them and
 * shared only with apps they grant. It is not the public directory listing and not the on-chain profile,
 * and an answer that blurs those invites somebody to "fix" their public name in the wrong place.
 */
export const PROFILE_READ_TOOL: ToolSpec = {
  id: PROFILE_READ_CAPABILITY,
  description:
    'ANSWERS A QUESTION about this person\'s own contact profile — the private record holding their name, '
    + 'email, phone and organization. Use for "what is on my profile", "what email do you have for me", '
    + '"what name am I under". Takes no arguments and answers only for the person asking. It is NOT the '
    + 'public directory listing.',
  inputSchema: { type: 'object', properties: {} },
  interaction: { navigationTarget: 'profile' },
};


/**
 * WHO CAN READ MY RECORDS — informational, and deliberately NOT one of `HARNESS_ACTION_TOOLS`.
 *
 * An action tool binds authority somebody signs; this one asks the person's own DO what they have
 * already authorized. Keeping it out of the action list is what lets a surface that cannot collect a
 * signature still offer it — and is what the ceremony-negotiation test means by "every action here
 * binds authority a person signs".
 */
export const ACCESS_LIST_TOOL: ToolSpec = {
  id: ACCESS_LIST_CAPABILITY,
  description:
    'ANSWERS A QUESTION: which apps this person has authorized to read their records, and whether each '
    + 'grant is still live on chain. Use for "who can see my records", "which apps have access", "what '
    + 'have I authorized". Takes no arguments — it answers for the person asking and cannot be pointed '
    + 'at anyone else.',
  inputSchema: { type: 'object', properties: {} },
  interaction: { navigationTarget: 'settings' },
};


export const INVITE_TOOL: ToolSpec = {
  id: ORG_INVITE_CAPABILITY,
  verbs: ['invite', 'add', 'bring'],
  // Spec 367 §6 — an invitation is recorded, never a membership: the invitee's joining establishes that.
  establishes: 'submission',
  description:
    'Invite an agent to join an organization or team as a member. Requires a mandate from the organization. '
    + 'Produces a signed access grant the invitee redeems when they join — it does NOT make them a member by itself. '
    + 'Args: org (the organization or team SA — whose authority this needs), invitee (the person\'s SA address; '
    + 'use the directory tools first when the ask names someone rather than an address). When the org is a '
    + 'HOUSEHOLD (spec 368), kin (spouse, child, parent, sibling) and role (member, guardian, dependent) ride on '
    + 'the invitation and onto the membership — the family\'s shared record of how they are related.',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The organization or team SA address' },
      invitee: { type: 'string', description: 'The invitee\'s smart-agent address (0x…)' },
      kin: { type: 'string', description: 'Household only — how the invitee is related to the household\'s founder: spouse | child | parent | sibling | a word of your own' },
      role: { type: 'string', description: 'Household only — member (default) | guardian | dependent' },
    },
    required: ['org', 'invitee'],
  },
  capability: { id: ORG_INVITE_CAPABILITY, action: 'invite', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium',
};

/**
 * "NONE OF THESE" AS A TOOL — spec 353 §3, the honest end of classification.
 *
 * The planner must pick a tool (`tool_choice: any` is what stops it answering in prose), so when nothing
 * fits it picks the nearest thing: asked to create a treasury with no treasury capability it created an
 * ORGANIZATION; asked to send a message with no messaging capability it read the directory and explained
 * that nothing had been sent. Both are a planner behaving reasonably with a menu that had no way to say no.
 *
 * This is that way. Selecting it is a real answer — "this agent cannot do that here" — and the reply lists
 * what it CAN do, drawn from the capabilities actually on offer rather than from the model's imagination.
 */
export const UNSUPPORTED_TOOL: ToolSpec = {
  id: 'ask.unsupported',
  description:
    'Choose this ONLY for an instruction that would CHANGE something and that no other tool performs. It '
    + 'is the correct answer for that, not a failure: better to say plainly that this agent cannot do a '
    + 'thing here than to do something adjacent to it. '
    + 'NEVER choose it for a question — anything asking to see, list, find, show or describe is answered '
    + 'with the directory tools, and "nothing found" is a real answer that this tool must not pre-empt. '
    + 'Args: what (what the person asked for, in their words).',
  inputSchema: {
    type: 'object',
    properties: { what: { type: 'string', description: 'What was asked, in the person\'s own words' } },
    required: ['what'],
  },
};

export const HARNESS_ACTION_TOOLS: ToolSpec[] = [
  // Spec 370 P4 — Work & Planning, bound thinly onto the Endeavor substrate (coordination-bindings.ts).
  ...COORDINATION_ACTION_TOOLS,
  {
    id: 'treasury.payment.execute',
    verbs: ['send', 'pay', 'transfer', 'wire'],
    description: 'Pay USDC from one treasury (or organization) to another. Requires a payment mandate from the PAYER. Args: payer (the paying treasury/org SA — whose authority this needs), payee (recipient SA, NAME, or the words the person used — "bob", "my daughter", "sarah" all work: the payee is resolved from the asker\'s own household and links, so pass what they said), usdc (the amount AS THE PERSON SAID IT, in whole USDC — "20", "12.50"; never smallest units, never converted).',
    inputSchema: {
      type: 'object',
      properties: {
        payer: { type: 'string', description: 'The paying treasury or organization — its address, or its name (e.g. nathan.treasury)' },
        asset: { type: 'string', description: 'ERC-20 token contract address' },
        payee: { type: 'string', description: 'Recipient address, or its agent name (e.g. bob.me)' },
        // THE ONLY QUANTITY A PLANNER MAY WRITE. A base-unit field used to sit beside this one, and a
        // model asked for "20 USDC" wrote `amount: "20"` — twenty base units, two hundred-thousandths of
        // a dollar. It settled, the receipt honestly said 0.00002 USDC, and nothing else could have
        // caught it. Units are the system's job; the planner's job is to repeat the figure it was told.
        usdc: { type: 'string', description: 'The amount as the PERSON said it, in whole USDC — e.g. "20", "12.50". Never convert it, never write smallest units.' },
        // WHY, in the person's words ("to cover poker night"). Carried onto the receipt; read by no gate and
        // never a party — a reason is not a payee.
        memo: { type: 'string', description: 'The reason for the payment, if the person gave one ("to cover poker night last night"). Never an agent.' },
      },
      // Either unit, never a guess — the same vocabulary `treasury.fund` uses. A capability that
      // understood only smallest-units left "send 2 usdc" with no amount at all, which made the
      // insufficient-funds check silently pass and walked the person into a ceremony that could not work.
      //
      // `payer` is REQUIRED: a payment must say who pays. Left optional it defaulted to whoever was being
      // asked, so "from nathan.treasury" was checked — and refused — against Nathan's own empty account.
      // Whose money moves is not a detail to infer.
      // AMOUNT IS REQUIRED, and saying so here is what makes it a QUESTION rather than a crash: the
      // loop asks the person for a declared argument it lacks (§3.5), while the mandate handler — which
      // only sees the step at signing time — can do nothing but throw "args.amount is required to bound
      // the authority it needs", which is true, unactionable, and arrives after the person has typed.
      required: ['payer', 'payee', 'amount'],
    },
    // The step ACTS ON the token and needs the PAYER's authority. Conflating them asks a person to grant
    // authority as an ERC-20 contract, which nothing can sign.
    capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'asset', authorityArg: 'payer' },
    // Spec 363 W5 — the questions this act lets the substrate answer instead of asking: which account
    // pays (when its owner marked one), and who a bare first name means (when their household says).
    // A contract may restate or narrow this; naming none would mean asking every time, which is safe
    // and was the behaviour before the decision plane existed.
    decisions: [PAYMENT_SOURCE_ACCOUNT.id, PAYMENT_RECIPIENT.id],
    risk: 'high',
  },
  INVITE_TOOL,
  RESOLUTION_REQUEST_TOOL,
  {
    id: 'messaging.direct.send',
    verbs: ['message', 'text', 'write to', 'tell', 'dm', 'send a message', 'send a note'],
    description:
      'Send a DIRECT MESSAGE to another agent — a person, an organization, anyone with an inbox. Use this '
      + 'whenever the ask is to message, write to, tell or DM somebody. Args: recipient (their ADDRESS or '
      + 'their NAME, e.g. "alice" or "alice.me" — either works, and no lookup is needed first), message '
      + '(the text to send; omit it if the ask did not say what to write and the person will be asked).',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Who to message — an address or an agent name' },
        message: { type: 'string', description: 'The message text. Omit when the ask did not say it.' },
      },
      required: ['recipient'],
    },
    // Sending as you is acting as you: bounded by a mandate like anything else, and bound to THIS message
    // by the intent digest. Low risk — a message is never authority (ADR-0041) and can be followed by
    // another one — so the ladder asks for no second party.
    capability: { id: 'messaging.direct.send', action: 'send', resourceArg: 'recipient', authorityArg: 'sender' },
    risk: 'low',
  },
  {
    id: 'treasury.fund',
    verbs: ['fund', 'top up', 'add funds', 'deposit'],
    description:
      'Fund a treasury with DEMO USDC (a faucet mint, not a transfer — no one is debited). Requires a '
      + 'mandate from the funder, because the mint is made in their name. Args: funder (the SA whose '
      + 'authority this needs — normally the person asking), treasury (its ADDRESS or its NAME, e.g. '
      + '"alice2.treasury" — either works), usdc (the amount AS THE PERSON SAID IT, in whole USDC — '
      + '"20", "12.50"; never smallest units, never converted). Use this whenever the ask is to fund, top up or add '
      + 'demo USDC to a treasury: it takes the name directly, so no lookup is needed first.',
    inputSchema: {
      type: 'object',
      properties: {
        funder: { type: 'string', description: 'The funding SA (whose authority this needs)' },
        asset: { type: 'string', description: 'The demo USDC contract address (ask the agent if unknown)' },
        treasury: { type: 'string', description: 'The treasury SA to credit' },
        usdc: { type: 'string', description: 'The amount as the PERSON said it, in whole USDC — e.g. "20", "12.50". Never convert it, never write smallest units.' },
        // WHY, in the person's words ("to cover poker night"). Carried onto the receipt; read by no gate and
        // never a party — a reason is not a payee.
        memo: { type: 'string', description: 'The reason for the payment, if the person gave one ("to cover poker night last night"). Never an agent.' },
      },
      // `funder` is OPTIONAL on purpose. The planner chooses ONE tool (that is what the planner IS), so a
      // capability whose required args it cannot fill from the sentence is a capability it will not
      // choose — it picked the lookup and answered instead. Whose authority this needs is not the
      // planner's to decide anyway: it is the mandate's delegator, and the surface asks the person
      // standing in that realm.
      // Either unit, never a guess. "fund alice2.treasury with 12.11 USDC" made the planner hesitate over
      // a field asking for 12110000 and answer with a paragraph instead; two differently-named arguments
      // remove the ambiguity rather than resolving it silently, which is the only acceptable way to be
      // unsure about an amount of money.
      required: ['treasury'],
    },
    // It acts on the TOKEN and needs the FUNDER's authority — the same split a payment has.
    capability: { id: 'treasury.fund', action: 'fund', resourceArg: 'asset', authorityArg: 'funder' },
    risk: 'low',
  },
  {
    // "WHEN SOMEONE PAYS ME, IT GOES HERE" — the Home's `PrimaryPayee` control as a capability (spec 361
    // I4). A preference, recorded as the `ap:primaryPayee` role on the PUBLIC charteredUnder edge so a
    // stranger's agent can honour it. It grants nothing: nobody may spend from the marked treasury, and
    // no gate reads the role — the resolver uses it to stop asking a payer a question only you can answer.
    id: PRIMARY_PAYEE_CAPABILITY,
    verbs: ['set my primary', 'make my primary', 'mark my primary', 'use my treasury'],
    description:
      'Say which of the owner\'s treasuries plays a standing role: the one that RECEIVES payments to '
      + 'them (role "payee" — the default, what others read before paying you) or the one they PAY FROM '
      + '(role "payer", so this agent stops asking which account every time). Args: treasury (ADDRESS or '
      + 'NAME, e.g. "alice2.treasury"), role ("payee" | "payer"), holder (the SA whose preference this '
      + 'is — normally the person asking), on (false to clear it; default true). Use for "pay me here", '
      + '"payments to me go to X", "pay from X by default", "use X for my payments". It authorizes no '
      + 'spending and nobody else can set it.',
    inputSchema: {
      type: 'object',
      properties: {
        treasury: { type: 'string', description: 'The treasury to be paid — address or name' },
        holder: { type: 'string', description: 'Whose preference this is (the treasury\'s owner)' },
        on: { type: 'boolean', description: 'true to mark it (default), false to stop' },
        role: { type: 'string', description: '"payee" — where money sent TO this person lands (default) — or "payer", the account they SPEND from. Two different questions: the account you publish and the account you use are often not the same.' },
      },
      required: ['treasury'],
    },
    capability: { id: PRIMARY_PAYEE_CAPABILITY, action: 'declare', resourceArg: 'record', authorityArg: 'holder' },
    // A preference is not a payment: it moves nothing and can be reversed by the same person in one act.
    // It IS public and it IS on chain, which is why it takes a mandate rather than nothing at all.
    risk: 'medium',
    interaction: { navigationTarget: 'treasuries' },
  },
  {
    // RECORDING WHO YOU LIVE WITH. Self-acting for the same reason a profile edit is: it is a note in
    // the person's own vault about their own life, and the Home's form asks for no signature either.
    //
    // IT SAYS NOTHING ABOUT AUTHORITY. Recording somebody as a guardian does not let them act for a
    // dependent — that is a delegation the dependent's custodian issues, and no gate reads this record.
    // Recording somebody as your spouse does not let you spend their money. The household answers "who
    // did you mean" and nothing else.
    id: HOUSEHOLD_RECORD_CAPABILITY,
    verbs: ['add', 'record', 'put'],
    description:
      'Record someone as part of this person\'s household — the private note of who they live with. '
      + 'Args: member (their agent, by name or address), role ("member" default, "guardian", '
      + '"dependent"), kin (how they are related: spouse, child, parent, sibling, or a word of your own), '
      + 'label (what to call them), remove (true to take them out). Use for "sarah is my daughter", '
      + '"add my wife to my household", "remove X from my household". A person may keep SEVERAL '
      + 'households (a child between two homes, a second home, a carer\'s week) — name one with '
      + '`household` when they say which. It grants nobody anything.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Their agent — a name (sarah.me) or an address' },
        role: { type: 'string', description: '"member" (default), "guardian" or "dependent"' },
        kin: { type: 'string', description: 'spouse | child | parent | sibling — or your own word for it' },
        label: { type: 'string', description: 'What this person calls them, e.g. "Sarah"' },
        remove: { type: 'boolean', description: 'true to take them out of the household record' },
        household: { type: 'string', description: 'Which household, when the person keeps more than one ("home", "the farm"). Omitted means their main one.' },
      },
      required: ['member'],
    },
    capability: { id: HOUSEHOLD_RECORD_CAPABILITY, action: 'execute', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low',
    selfAuthorized: true,
    interaction: { navigationTarget: 'household' },
  },
  {
    // CHANGING YOUR OWN CONTACT DETAILS. The Home's profile form needs no signature — it is the person's
    // own record, written under their own session through their own DO — and neither does this: adding a
    // prompt the button does not have would make the conversation the more expensive way to do the same
    // thing (the value-steps rule). Its authority is the session, the vault-key binding and the
    // interactions grant, exactly as the form's is.
    //
    // `low` and NOT informational: it writes. A receipt records it, and the ladder does not ask a second
    // party to approve somebody correcting their own phone number.
    id: PROFILE_UPDATE_CAPABILITY,
    // "set street address to …" opens with "set" and names no "my": the verbs are the bare imperatives too.
    verbs: ['update my', 'change my', 'set my', 'edit my', 'set', 'update', 'change', 'edit', 'correct', 'record my'],
    // THE FIELDS ARE THE RECORD'S (spec 371 §2.2): every argument comes from the ontology's one list, so an
    // address is as editable as a name and described the same way everywhere.
    description:
      'Change this person\'s own contact profile — the PRIVATE record. Args: any of '
      + CONTACT_FIELDS.map((f) => `${f.arg} (${f.label})`).join(', ')
      + '. Only the fields given are changed; the rest are left alone. A postal address is split into its fields '
      + '(street, city, region, postalCode, country — infer the country when the region makes it certain). '
      + 'Use for "my email is x@y.z", "set my name to …", "set street address to …", "I work at …". '
      + 'This is NOT the public directory listing or the agent\'s public name.',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(CONTACT_FIELDS.map((f) => [f.arg, { type: 'string', description: f.hint }])),
    },
    // `execute`, not `update`: the ACTION is read from the contract's mandate requirement, and this
    // capability has none to read (no mandate, no caveat encodes an action), so the compiler's neutral
    // default is what the contract compiles to. Disagreeing here would warn on every load about a
    // difference that decides nothing — the capability ID is what carries the meaning.
    capability: { id: PROFILE_UPDATE_CAPABILITY, action: 'execute', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low',
    // SELF-ACTING (`ToolSpec.selfAuthorized`): the invoker takes its subject from the run's principal and
    // cannot be pointed at another person's record, so there is no second party whose authority could be
    // needed — the session is it. Declared HERE, on the built-in, never merged from a contract: a
    // contract may describe an act, never weaken its gate.
    selfAuthorized: true,
    interaction: { navigationTarget: 'profile' },
  },
  {
    // …AND STOP THEM. The revocation is ON CHAIN, which is the difference between this and every
    // OAuth-shaped "disconnect": it stops the app at every gate that checks, not just at this Home
    // (ADR-0041). It is `medium` because it takes authority AWAY — the failure mode is losing access
    // you meant to keep, which the person can restore by granting again.
    id: ACCESS_REVOKE_CAPABILITY,
    verbs: ['revoke', 'remove access', 'disconnect', 'cut off'],
    description:
      'Revoke ON CHAIN a read grant this person issued to an app, so it stops working everywhere rather '
      + 'than only here. Args: app (the client id from access.grants.list, e.g. "demo-jp"), holder (the '
      + 'SA whose grant it is — normally the person asking). Use for "stop <app> reading my records", '
      + '"revoke <app> access", "cut off <app>".',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'The app\'s client id, as listed by access.grants.list' },
        holder: { type: 'string', description: 'Whose grant this is (the person who issued it)' },
      },
      required: ['app'],
    },
    capability: { id: ACCESS_REVOKE_CAPABILITY, action: 'revoke', resourceArg: 'manager', authorityArg: 'holder' },
    risk: 'medium',
    interaction: { navigationTarget: 'settings' },
  },
  ...CHILD_AGENT_KINDS.map(({ capability, tld, noun, parentNoun }): ToolSpec => ({
    verbs: [`create a ${noun}`, `create ${noun}`, `charter a ${noun}`, `charter ${noun}`, `start a ${noun}`, `make a ${noun}`, `new ${noun}`],
    id: capability,
    description:
      `Create (charter) a new ${noun.toUpperCase()} under ${parentNoun}. It becomes a typed agent named <label>.${tld}, `
      + `custodied by the connected user and stewarded by its parent. Requires a mandate from the parent. `
      + `Args: parent (the parent SA address — the mandate's delegator), label (the ${noun}'s name: lowercase letters, `
      + `digits, hyphens; omit if the ask did not name it — the person will be asked). `
      // These tools are NOT interchangeable and the planner must not treat them as a menu of near-misses:
      // asked for a treasury with no treasury tool, it picked organization.create and chartered an
      // organization the person then could not find where they looked for it (2026-09-04).
      + `ONLY for a ${noun}: a team, an organization, a treasury and a service are different kinds of agent, `
      + `and each has its own tool. If the ask names a kind that has no tool here, say so — never charter the nearest one.`,
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: `The ${parentNoun} SA address` },
        label: { type: 'string', description: `The ${noun} name label (a-z, 0-9, hyphen). Omit when the ask did not say it.` },
      },
      required: ['parent'],
    },
    capability: { id: capability, action: 'create', resourceArg: 'parent' },
    risk: 'medium',
  })),
];

// ─── organization.team.create — the genesis a connected user signs ────────────────────────────────────

/** The connected user's credential, as the Ask surface describes it (a `credential` field answer). */
export type CredentialV1 =
  | { kind: 'eoa'; address: Address }
  | { kind: 'passkey'; credentialIdDigest: Hex; pubKeyX: string; pubKeyY: string; rpIdHash: Hex };

/** A packed userOp as it travels (bigints as decimal strings) — the /session/deploy wire shape. */
export interface GenesisUserOpJson {
  sender: Address; nonce: string; initCode: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: string; gasFees: Hex; paymasterAndData: Hex; signature: Hex;
}

export const CHILD_LABEL_PATTERN = '^[a-z0-9-]{3,63}$';

/**
 * The name label a spoken or typed name becomes: lowercased, words joined by hyphens, anything that is not a
 * letter, digit or hyphen dropped, and the KIND WORD removed when it is said as part of the name ("abc
 * organization" → `abc`, "the outreach team" → `outreach`, "ABC Org" → `abc`) — the typed suffix already says
 * what it is, and `abc-organization.org` says it twice. A church or circle keeps its word: it is not the
 * suffix being created here. A name that is already a label passes through unchanged.
 */
export function labelFromName(raw: string, noun: string, tld: string): string {
  const s = raw.trim().toLowerCase();
  if (new RegExp(CHILD_LABEL_PATTERN).test(s)) return s;
  const kindWords = [noun, tld, `${noun}s`, ...(noun === 'organization' ? ['organisation', 'org'] : [])];
  const words = s.replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w, i) => !kindWords.includes(w) && !(i === 0 && (w === 'the' || w === 'a' || w === 'an')));
  return (kept.length ? kept : words).join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

/** What the Worker supplies for a team's genesis — the substrate the Home ceremony already uses, behind a
 *  port so the protocol (ask → derive → check → submit) is testable without a chain. */
export interface TeamGenesisDeps {
  /** Does `credential` custody `person`? A chain read on the person's SA (isCustodian / hasPasskey). */
  isCustodianOf(person: Address, credential: CredentialV1): Promise<boolean>;
  /** Who `<label>.team` resolves to, if anyone. */
  resolveName(name: string): Promise<Address | null>;
  /** Predict the child and build its genesis userOp: initCode from (credential, salt); callData = declare
   *  type + register `<label>.<tld>` + set primary + approve the stewardship digest (child → parent). */
  build(input: { credential: CredentialV1; salt: bigint; label: string; tld: string; parent: Address; stewardship: { salt: bigint; validUntil: number } }): Promise<{ child: Address; name: string; userOp: GenesisUserOpJson; userOpHash: Hex; stewardship: DelegationWireV1; planes?: unknown }>;
  /** Store the child's plane wires on its DO after the genesis settles (the approveHash calls it batched
   *  make the 0x03 wires verifiable). IDEMPOTENT — called on the fresh create AND on the already-created
   *  resume, because a team that exists without its planes is the broken state this exists to end. */
  provisionPlanes?(child: Address, planes: unknown): Promise<{ ok: boolean; error?: string }>;
  /** The EntryPoint's hash of an arbitrary userOp (readContract). */
  userOpHash(userOp: GenesisUserOpJson): Promise<Hex>;
  /** Has the child already been deployed? (a resume after success is a no-op) */
  isDeployed(child: Address): Promise<boolean>;
  /** Submit the signed genesis, sponsored. Throws on an inner revert. */
  submit(userOp: GenesisUserOpJson): Promise<{ txHash: Hex }>;
}

function parseCredential(v: unknown): CredentialV1 | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (c.kind === 'eoa' && typeof c.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.address)) return { kind: 'eoa', address: c.address.toLowerCase() as Address };
  if (c.kind === 'passkey' && typeof c.credentialIdDigest === 'string' && typeof c.pubKeyX === 'string' && typeof c.pubKeyY === 'string' && typeof c.rpIdHash === 'string') {
    return { kind: 'passkey', credentialIdDigest: c.credentialIdDigest as Hex, pubKeyX: c.pubKeyX, pubKeyY: c.pubKeyY, rpIdHash: c.rpIdHash as Hex };
  }
  return null;
}

/** Who must sign the genesis — the credential's address, or the passkey by its credential id. */
const signerOf = (c: CredentialV1): string => (c.kind === 'eoa' ? c.address : `passkey:${c.credentialIdDigest}`);

/**
 * The child-agent-create invoker (team, organization — same ceremony, different typed root). Reads the ask
 * (args) and the answers (ctx.supplied); asks for what is missing; derives the genesis deterministically
 * from the intent so a resume rebuilds the same child; and on a signed resume checks the signed userOp
 * against what it derived — sender, initCode, callData, hash — before submitting. `person` is the connected
 * user (from the session): the credential MUST custody them, because what you create, you custody.
 */
export function childAgentCreateInvoker(genesis: TeamGenesisDeps, env: HarnessEnv, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    const tld = CHILD_AGENT_TLD[toolId];
    const noun = CHILD_AGENT_KINDS.find((k) => k.capability === toolId)?.noun ?? 'agent';
    const aNoun = `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
    if (!tld) throw new Error(`${toolId} is not a child-agent capability`);
    const parent = String(args.parent ?? '').toLowerCase() as Address;
    if (parent !== wire.delegator.toLowerCase()) throw new Error(`the ${noun} is chartered by the mandate's delegator (${wire.delegator}); the plan named ${parent || 'no parent'}`);
    if (!person) throw new Error(`no connected user: ${aNoun} is custodied by the connected user, and there is none on this run`);

    const data = dataFor(ctx.supplied, stepRef);
    // Spoken or typed, a name is what the person SAID: "ABC Organization" becomes `abc.org`, "Riverside
    // Fellowship" becomes `riverside-fellowship.org`. Refusing "abc organization" as "not a valid name" and
    // asking again — for a name the person then says the same way — is the loop this replaces (spec 369).
    const rawLabel = labelFromName(String(data.label ?? args.label ?? ''), noun, tld);
    const label = new RegExp(CHILD_LABEL_PATTERN).test(rawLabel) ? rawLabel : '';
    const credential = parseCredential(data.custodian);
    const ask = (fields: InputFieldV1[], prompt: string): never => {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt, fields });
    };
    const labelField = (hint?: string): InputFieldV1 => ({ name: 'label', label: `${noun[0]!.toUpperCase()}${noun.slice(1)} name`, type: 'text', required: true, pattern: CHILD_LABEL_PATTERN, ...(hint ? { hint } : { hint: `lowercase letters, digits and hyphens; becomes <name>.${tld}` }) });
    const credentialField: InputFieldV1 = { name: 'custodian', label: 'Connected credential', type: 'credential', required: true, hint: `the credential you are signed in with will custody the ${noun}` };
    if (!label || !credential) {
      const fields: InputFieldV1[] = [...(label ? [] : [labelField(rawLabel ? `"${rawLabel}" is not a valid ${noun} name` : undefined)]), ...(credential ? [] : [credentialField])];
      ask(fields, label ? `Which credential will custody the ${noun}?` : `What should the ${noun} be called?`);
    }
    const name = `${label}.${tld}`;
    if (!(await genesis.isCustodianOf(person, credential!))) throw new Error(`the supplied credential does not custody the connected user's agent ${person} — custody is always the connected user`);

    // Deterministic from the intent: the same ask derives the same child, so a resume rebuilds what was
    // signed, and a second identical ask finds the team already there instead of chartering a twin.
    const digest = intentDigest(ctx.intent);
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:${tld}`)));
    const stewardshipSalt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:stewardship`)));
    // The stewardship grant's window starts where the mandate's does (a fixed point per mandate), so it too
    // is the same on every run of this ask.
    const enforcers = harnessEnforcers(env);
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === enforcers.timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;

    const g = await genesis.build({ credential: credential!, salt, label, tld, parent, stewardship: { salt: stewardshipSalt, validUntil } });
    if (await genesis.isDeployed(g.child)) {
      // A resume of a settled create still provisions: the genesis's approveHash calls are on chain, the
      // wires rebuild deterministically, and a team that exists without its planes is the broken state.
      const planes = g.planes && genesis.provisionPlanes ? await genesis.provisionPlanes(g.child, g.planes).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })) : null;
      return { agent: g.child, name: g.name, kind: recordedKind(noun, parent, person), parent, custodian: credential, person, stewardshipDelegation: g.stewardship, alreadyCreated: true, ...(planes && !planes.ok ? { planesError: planes.error } : {}) };
    }
    // Taken by someone ELSE — the child this ask derives is not there yet, so the name is not ours.
    const holder = await genesis.resolveName(name);
    if (holder && holder.toLowerCase() !== g.child.toLowerCase()) ask([labelField(`${name} is already taken — pick another name`)], `${name} is already taken. What should the ${noun} be called instead?`);

    const signed = signatureFor(ctx.supplied, stepRef);
    if (!signed) {
      throw new InputRequired({
        kind: 'signature', stepRef, toolId,
        prompt: `Sign the genesis of ${g.name} — ${aNoun} under ${parent}, custodied by you.`,
        digest: g.userOpHash, signer: signerOf(credential!),
        payload: { child: g.child, name: g.name, parent, userOp: g.userOp },
      });
    }
    // What was signed must be what this run derives. The paymaster window and gas may differ between the
    // build that was signed and this one, so the comparison is on what the genesis MEANS — sender, initCode
    // (credential + salt), callData (name, type, stewardship) — and the hash the EntryPoint computes over
    // the supplied op must be the digest the credential signed.
    const op = (signed.payload as { userOp?: GenesisUserOpJson } | undefined)?.userOp;
    if (!op) throw new Error('the signature answer carries no userOp payload');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!same(op.sender, g.child) || !same(op.initCode, g.userOp.initCode) || !same(op.callData, g.userOp.callData)) {
      throw new Error(`the signed genesis is not the one this ask derives (sender/initCode/callData differ) — refusing to submit`);
    }
    const hash = await genesis.userOpHash(op);
    if (!same(hash, signed.digest)) throw new Error(`the signed digest ${signed.digest} is not the hash of the supplied userOp (${hash})`);
    if (signed.signer.toLowerCase() !== signerOf(credential!).toLowerCase()) throw new Error(`the signature is not from the credential that will custody the ${noun}`);
    const { txHash } = await genesis.submit({ ...op, signature: signed.signature as Hex });
    // THE PLANES, in the same act. The signature just submitted approved their digests; storing the wires
    // is what turns "a team exists" into "a team with a roster, discussions and mail". REPORTED, never
    // thrown: the team is on chain, and a wire store that failed is a different fact from the create
    // failing — the same discipline as a declared effect.
    const planes = g.planes && genesis.provisionPlanes ? await genesis.provisionPlanes(g.child, g.planes).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })) : null;
    return { txHash, agent: g.child, name: g.name, kind: recordedKind(noun, parent, person), parent, custodian: credential, person, stewardshipDelegation: g.stewardship, ...(planes && !planes.ok ? { planesError: planes.error } : {}) };
  };
}

const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ type: 'bool' }] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const REDEEM_ABI = [{
  type: 'function', name: 'redeemDelegation', stateMutability: 'nonpayable',
  inputs: [
    { name: 'delegations', type: 'tuple[]', components: [
      { name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' },
      { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] },
      { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' },
    ] },
    { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  ],
  outputs: [],
}] as const;

/** What the Worker must supply: chain reads and the service SA's signing + submission. Injected so the
 *  module is testable without a Worker. */
export interface HarnessDeps {
  /** Spec 370 P4 — a PUBLIC op on a principal's InteractionsDO as the session (the `/connect/work` door),
   *  for the coordination acts. The DO derives standing and validates the command; this only carries it. */
  interactionsOp?: (principal: Address, op: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  /** Build, sign (with the service SA's custodian) and submit a sponsored userOp from `sender`. */
  executeAsServiceSa: (sender: Address, callData: Hex) => Promise<{ txHash: Hex }>;
  audit: AuditSink;
  /** The team-genesis substrate; absent ⇒ `organization.team.create` fails as unconfigured (never silently). */
  teamGenesis?: TeamGenesisDeps;
  /** Resolve an agent NAME to its address, on chain. Injected so a capability can take "alice2.treasury"
   *  where it needs an address: asking a planner to chain a lookup into a later step's args is a
   *  coordination problem we do not need to have, and it answered with a paragraph instead of acting. */
  resolveName?: (name: string) => Promise<string | null>;
  /** Send a direct message through the sender's own interactions plane. */
  sendDirectMessage?: (input: {
    sender: Address; recipient: Address; bodyText: string; session: string;
    /** Spec 364 — typed pointers the recipient's surface renders as an action. Never authority. */
    contextRefs?: Array<{ kind: string; id: string; label?: string }>;
  }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Public directory search — for QUESTIONS about who exists (`find_agents`), never to fill a party in an
   *  action: a directory hit proves an agent exists, not that this person knows them (spec 352 §7). */
  findAgents?: (terms: string) => Promise<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>;
  /** Read one record from a subject's own vault — the asker's private tier (spec 353 §3). */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** spec 360 E5 — deposit ONE declared-effect artifact in a principal's own vault. Allowlisted by record
   *  type at the DO; the caller carries no write authority (the principal's own grant performs it). */
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** Append one entry to a subject's own record — how a request reaches the person who must decide it. */
  appendSubjectRecord?: (subject: string, recordType: string, entry: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** Held resolution grants this asker can actually use — checked, not merely held (spec 338 §4). */
  verifyGrant?: (held: unknown, type: string, asker: string, session?: string) => Promise<Array<{ targetAgent?: string; owner: string; ownerName?: string; label?: string }>>;
  /** Close the note in the ASKER'S OWN vault that was waiting on this — spec 338 §7, the far end of a
   *  request they sent. Settling is a record of what happened, never a permission: the grant it refers to
   *  stays exactly as valid as its issuer left it. */
  settleResolutionRequest?: (person: string, input: { owner: string; wants: string; txHash?: string }) => Promise<void>;
  /** Spec 356 §2.2 — whose vaults this asker may read: their own, plus what they STEWARD. Derived, never
   *  a caller's list; membership and custody are not sources (see `readableVaults` in index.ts). */
  readableVaults?: (asker: string) => Promise<Array<{ subject: string; name?: string; why: 'self' | 'stewardship' }>>;
  /** Spec 356 §2.5 — the INVENTORY of a subject's vault: keys and timestamps, no plaintext. */
  survey?: (subject: string) => Promise<Array<{ recordType: string; updatedAt?: string }>>;
  /** Spec 356 §2.5 — decode exactly these keys, one batched call. */
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  /** The agents chartered under an owner, from the on-chain `ap:charteredUnder` edges (spec 355 W2).
   *  Public: the half of "what does this agent hold" that answers for someone else's agents. */
  /** The agents chartered under an owner — with the modelled ROLES each carries (`ap:primaryPayee`,
   *  `ap:primaryPayer`), so a caller can stop asking a question its owner already answered. */
  charteredAgents?: (owner: string, type: string) => Promise<Array<{ agent: string; name?: string; primary?: boolean; roles?: readonly string[] }>>;
  /** The same read with its failure reason — see `membership-read.ts` for why the difference matters. */
  readSubjectRecordStatus?: (subject: string, recordType: string) => Promise<{ ok: boolean; needsEnable?: boolean; data: unknown; error?: string }>;
  /** The COUNTERFACTUAL agent a Home will deploy for an email (spec 321 W2 predict) — deterministic from the
   *  custodian derivation; asked of the Home under the steward's session, which is the gate on knowing it. */
  predictAgentForEmail?: (input: { org: Address; email: string; session: string }) => Promise<Address | null>;
  /** WHAT FOLLOWS an email invitation (spec 360): the invitation record in the org's vault and the link,
   *  delivered by mail from the organization. Never the act itself — the grant is the act. */
  deliverEmailInvitation?: (input: { org: Address; email: string; memberAccessDelegation: unknown; session: string }) => Promise<{ ok: boolean; delivery?: string; error?: string }>;
  /**
   * Spec 366 R1 — ASK THE SUBJECT'S OWN AGENT. A step about another agent (an organization's roster,
   * asked at a person's agent) is sent to that agent's harness as the same step, with the asker's own
   * session presented; the receiver verifies the credential and derives the asker's standing against ITS
   * OWN records, runs the step under ITS playbook, and answers. Nothing is granted by routing: a person
   * with no standing there gets the same refusal by either route. Absent ⇒ the step is refused in words
   * (never a local read of the other agent's records — ADR-0013, one mechanism).
   */
  askSubjectAgent?: (input: { subject: Address; toolId: string; args: Record<string, unknown>; goal: string; asker?: Address; session?: string; correlation: { operationId: string; runRef: string; stepRef: string; intentDigest: string } }) => Promise<SubjectAnswerV1>;
  /** Reverse name lookup for an address (public directory, ADR-0040). Names roster rows; best-effort. */
  nameOf?: (address: string) => Promise<string | null>;
  /** `ap:charteredUnder` owner of an agent, from chain — who a payee treasury's receipt is told to. */
  ownerOf?: (agent: string) => Promise<string | null>;
  /** What an agent holds of the deployment's value asset — annotates a choice between accounts. */
  valueHeld?: (agent: string) => Promise<{ amount: bigint; display: string } | null>;
  /** The apps a person has authorized to read their records, and whether each grant is still live. */
  readGrants?: (person: string) => Promise<Array<{ clientId: string; hash: string; storedAt: string; revoked: boolean }>>;
  /** ONE stored grant, wire and all — asked for only when something is about to revoke it. */
  readGrantWire?: (person: string, clientId: string) => Promise<{ wire: unknown; hash: string } | null>;
  /** Merge named fields into the person's own contact record. Merge, never replace. */
  mergeProfile?: (person: string, fields: Record<string, string>) => Promise<{ ok: boolean; changed?: string[]; refused?: string[]; error?: string }>;
  /** Record ONE person in the asker's own household note. Private tier; grants nothing. */
  recordHouseholdMember?: (person: string, input: { member: string; role?: string; kin?: string; label?: string; household?: string; remove?: true }) => Promise<{ ok: boolean; removed?: true; role?: string; kin?: string; household?: string; count?: number; error?: string }>;
  now?: () => number;
}

/** What the subject's agent said (spec 366). `result` is that agent's own tool result, verbatim; `via`
 *  names who answered so the composer can say so and a receipt can cite it. */
export interface SubjectAnswerV1 {
  ok: boolean;
  /** The subject agent's structured result for the routed step (its invoker's own shape). */
  result?: unknown;
  /** Who answered, and where — and, under the subject-ask profile, the receiver's own receipts (S) naming R. */
  via: { agent: Address; name?: string | null; host?: string; runRef?: string; observedVia: 'serving-handler' | 'network'; receipts?: Array<{ stepRef: string; capability?: string; status: string }> };
  /** When the subject's agent did not answer: its words, relayed verbatim (a refusal is an answer). */
  refused?: string;
}

/**
 * Spec 366 — WHICH AGENT ANSWERS THIS STEP. A tool that declares a `subject` argument is answered by the
 * agent that argument names; when that agent is not the one addressed, the step is routed there. Pure:
 * reads the tool's declaration and the (already-resolved) args, decides nothing about permission.
 */
export function routedSubjectFor(tool: { subject?: string } | undefined, args: Record<string, unknown>, addressee: Address | undefined): Address | null {
  if (!tool?.subject) return null;
  const v = String(args[tool.subject] ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(v)) return null;
  if (addressee && v === addressee.toLowerCase()) return null;
  return v as Address;
}

/** The receiver's profile answer as the sender reads it (mirror of `@agenticprimitives/a2a` SubjectAnswerV1). */
export interface SubjectAnswerProfileV1 { extension: string; version: 1; agent: string; inResponseTo: { operationId: string; runRef: string; stepRef: string }; outcome: 'answer' | 'refused' | 'needs' | 'error'; result?: unknown; said?: string; run: { runRef: string; receipts: Array<{ stepRef: string; capability?: string; status: string; binding?: unknown }> } }

/** The body `/harness/ask` answers with. The reply is NESTED under `reply`; `ok`/`error` sit on the envelope. */
export interface AskReplyEnvelopeV1 {
  ok?: boolean; error?: string; runRef?: string;
  reply?: { kind?: string; runRef?: string; text?: string; summary?: string; results?: Array<{ toolId: string; result: unknown }>; prompt?: { kind?: string; prompt?: string; fields?: Array<{ name?: string }> } };
}

/**
 * Spec 366 — WHAT THE SUBJECT'S AGENT SAID, read from its `/harness/ask` envelope. Pure. An `answer` for
 * the routed tool is the result; anything else is relayed in the subject's own words (a refusal, a
 * prompt it raised, an authority it needs) — never retried, never guessed. Reading `kind` off the
 * ENVELOPE instead of `reply` made every real answer read as "needs more" (caught live 2026-09-07).
 */
export function readSubjectReply(envelope: (AskReplyEnvelopeV1 & { subjectAnswer?: SubjectAnswerProfileV1 }) | null, toolId: string, who: string, status: number): { ok: boolean; result?: unknown; refused?: string; runRef?: string; receipts?: Array<{ stepRef: string; capability?: string; status: string }> } {
  if (!envelope) return { ok: false, refused: `${who} answered with something that was not a reply (${status})` };
  // THE PROFILE ANSWER, when the receiver speaks it (spec 366 R2): typed outcome, the receiver's own run and
  // receipts naming our request. A receiver that does not speak the profile answers with the plain reply.
  const sa = envelope.subjectAnswer;
  if (sa && sa.extension === 'https://agenticprimitives.org/a2a/subject-ask/v1') {
    const receipts = sa.run?.receipts ?? [];
    if (sa.outcome === 'answer') return { ok: true, result: sa.result, runRef: sa.run.runRef, receipts };
    return { ok: false, refused: `${who} ${sa.outcome === 'refused' ? 'refused' : sa.outcome === 'needs' ? 'needs more before it can answer —' : 'could not answer:'} ${sa.said ?? ''}`.trim(), runRef: sa.run?.runRef, receipts };
  }
  if (envelope.ok === false || envelope.error) return { ok: false, refused: `${who} refused: ${envelope.error ?? status}` };
  const reply = envelope.reply;
  if (!reply) return { ok: false, refused: `${who} answered with no reply (${status})` };
  const runRef = reply.runRef ?? envelope.runRef;
  if (reply.kind === 'answer') {
    const hit = reply.results?.find((r) => r.toolId === toolId) ?? reply.results?.[0];
    return { ok: true, result: hit ? hit.result : { text: reply.text }, ...(runRef ? { runRef } : {}) };
  }
  const said = reply.kind === 'prompt'
    ? `it asked “${reply.prompt?.prompt ?? ''}” (${reply.prompt?.kind ?? 'prompt'}${reply.prompt?.fields?.length ? `: ${reply.prompt.fields.map((f) => f.name).join(', ')}` : ''})`
    : (reply.summary ?? reply.text ?? reply.kind ?? '');
  return { ok: false, refused: `${who} needs more before it can answer — ${said}`.trim(), ...(runRef ? { runRef } : {}) };
}

export function harnessEnforcers(env: HarnessEnv): EnforcerAddresses {
  const base = enforcersFromEnv(env as Record<string, string | undefined>);
  const db = (env.DIGEST_BINDING_ENFORCER ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(db)) throw new Error('harness: DIGEST_BINDING_ENFORCER is not configured — a mandate cannot be verified without it (no fallback)');
  return { ...base, digestBinding: db as Address };
}

/** A steward's approval of ONE step, signed over the canonical approval digest. */
export interface SuppliedApprovalV1 {
  approver: Address;
  /** keccak256(JCS({ runRef?, stepRef, mandateRef, intentDigest, capability, action, resource })) — the
   *  step's authority evidence, so an approval cannot be reused for a different step. */
  digest: Hex;
  signature: Hex;
}

export function approvalDigestFor(input: { stepRef: string; mandateRef: string; intentDigest: string; capability: string; action: string; resource?: string }): Hex {
  // Addresses are normalised: the planner returns whatever case the model chose, the approver signs
  // whatever case its tooling produced, and a digest that differs by case is a refusal nobody intended.
  const norm = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v ?? null);
  const canonical = JSON.stringify({ action: input.action, capability: input.capability, intentDigest: input.intentDigest.toLowerCase(), mandateRef: input.mandateRef.toLowerCase(), resource: norm(input.resource), stepRef: input.stepRef });
  return keccak256(toBytes(canonical));
}

/**
 * The approval port. An approval is a signature over THIS step's authority evidence, verified ERC-1271
 * against the approver, from a party the obligation names — all three, or it is not an approval.
 *
 * Approvals reach it two ways, and they are the same signature either way: pre-supplied with the ask
 * (`approvals`, how a script drives it), or SIGNED IN THE CONVERSATION — when nothing is supplied yet, the
 * port asks (spec 350 §3.5) rather than refusing an obligation nobody was given the chance to discharge.
 *
 * The asking is not a softening of the ladder. The digest is the same, the ERC-1271 check is the same, and
 * a signature over anything else discharges nothing. What changes is only that a person present at the run
 * can answer it, which is what "a second party approves" means when the second party is standing there.
 */
export function suppliedApprovalsPort(
  deps: HarnessDeps, env: HarnessEnv, approvals: SuppliedApprovalV1[], supplied?: SuppliedInputV1[],
  /** Who is present. An obligation that names no particular approver still has to name SOMEBODY in the
   *  question, or the surface signs as nobody: the prompt went out with an empty `signer`, the answer came
   *  back attributed to '', and the ERC-1271 check refused an approval the person had just given. */
  person?: Address,
): ApprovalPort {
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;
  return {
    async request(req) {
      const want = approvalDigestFor({ stepRef: req.stepRef, mandateRef: req.evidence.mandateRef, intentDigest: req.evidence.intentDigest, capability: req.step.capability.id, action: req.step.capability.action, ...(req.step.capability.resource ? { resource: req.step.capability.resource } : {}) });
      // A signature answered into THIS step counts as an approval when it is over the approval digest.
      const answered = (supplied ?? [])
        .filter((s) => s.stepRef === req.stepRef && s.signature && s.signature.digest.toLowerCase() === want.toLowerCase())
        .map((s) => ({ approver: s.signature!.signer as Address, digest: s.signature!.digest as Hex, signature: s.signature!.signature as Hex }));
      const pool = [...approvals, ...answered];
      const records: string[] = [];
      for (const ob of req.obligations) {
        const allowed = (ob.dischargeableBy.agents ?? []).map((a) => a.toLowerCase());
        const candidates = pool.filter((a) => a.digest.toLowerCase() === want.toLowerCase() && (allowed.length === 0 || allowed.includes(a.approver.toLowerCase())));
        let discharged = false;
        let sawInvalid = false;
        for (const a of candidates) {
          if (!validator) break;
          const ok = await deps.readContract({ address: validator, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [a.approver, a.digest, a.signature] }).catch(() => false);
          if (ok === true) { records.push(`approval:${a.approver.toLowerCase()}:${a.digest}`); discharged = true; break; }
          sawInvalid = true;
        }
        if (discharged) continue;
        // A signature was offered and did not verify: that is a refusal, not a question to ask again.
        if (sawInvalid) return { status: 'refused', reason: `obligation ${ob.kind} (${ob.imposedBy}) not discharged: the approval did not verify against its approver` };
        return {
          status: 'pending', resumeToken: req.stepRef,
          prompt: {
            kind: 'signature', stepRef: req.stepRef, toolId: req.step.tool.id,
            prompt: `This needs a second party to approve it. Sign to approve ${req.step.capability.id}${req.step.capability.resource ? ` on ${req.step.capability.resource}` : ''}.`,
            digest: want, signer: allowed[0] ?? person ?? '',
            payload: { obligation: ob.kind, imposedBy: ob.imposedBy, mandateRef: req.evidence.mandateRef, capability: req.step.capability.id },
          },
        };
      }
      return { status: 'discharged', records };
    },
  };
}

/** The MCP server whose vault scope an org→member access grant names. Must match the Home's
 *  `MCP_SERVER_ID`, or the grant reads as scoped to a server nobody consults. */
const MCP_SERVER_ID = 'demo-mcp';
/** spec 322 W3 — the org record a member may read once they join. */
const ORG_PROFILE_RESOURCE_SCOPE = 'vault:org.profile';

/**
 * Build the org → invitee access grant this invitation carries — the SAME shape the Home's invite panel
 * signs (`issueOrganizationResourceAccessDelegation`): read scope on the org's profile record, time-bounded,
 * value 0. Deterministic in its salt and window so a resume rebuilds exactly what was signed.
 */
function buildInviteGrant(env: HarnessEnv, org: Address, invitee: Address, salt: bigint, validUntil: number): Delegation {
  const enforcers = harnessEnforcers(env);
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: MCP_SERVER_ID, resources: [ORG_PROFILE_RESOURCE_SCOPE], ops: ['read'] }]),
    buildCaveat(enforcers.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(enforcers.value, encodeValueTerms(0n)),
  ];
  return { delegator: org, delegate: invitee, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
}

/**
 * THE INVITATION GRANT'S IDENTITY, derivable BEFORE any mandate exists — spec 361 I4's one-prompt
 * design. Everything the digest depends on is fixed by the REQUIREMENT the surface will mint from
 * (intentDigest, validAfter) plus the step's own args, so the authority_required reply can name the
 * grant digest alongside the mandate's — and ONE custodian signature over one org userOp
 * (executeBatch approveHash×2, the spec-253 mechanism) authorizes both. The invoker derives the same
 * values from the PRESENTED wire; a surface that minted faithfully lands on the identical digest.
 */
export function inviteGrantForRequirement(
  env: HarnessEnv,
  requirement: { intentDigest: string; validAfter: number },
  org: Address,
  invitee: Address,
  stepRef: string,
): { digest: Hex; validUntil: number; salt: bigint } {
  const validUntil = requirement.validAfter + 365 * 24 * 3600;
  const salt = BigInt(keccak256(toBytes(`${requirement.intentDigest}:${stepRef}:invite:${invitee.toLowerCase()}`)));
  const grant = buildInviteGrant(env, org, invitee.toLowerCase() as Address, salt, validUntil);
  return { digest: hashDelegation(grant, Number(env.CHAIN_ID), env.DELEGATION_MANAGER as Address), validUntil, salt };
}

/**
 * `organization.membership.invite`. Derives the grant, asks the steward to sign it, and returns it for the
 * surface to store in the org's vault. It does NOT make anyone a member: the invitee redeems it on join,
 * which is the whole reason the org-side capability is the INVITATION and not the membership.
 */
export function inviteInvoker(env: HarnessEnv, presented: MandatePresentation, person: Address | undefined, deps?: Pick<HarnessDeps, 'readContract' | 'deliverEmailInvitation'>, session?: string): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    const org = String(args.org ?? '').toLowerCase() as Address;
    const invitee = String(args.invitee ?? '').toLowerCase() as Address;
    if (org !== wire.delegator.toLowerCase()) throw new Error(`the invitation is issued by the mandate's delegator (${wire.delegator}); the plan named ${org || 'no organization'}`);
    if (!/^0x[0-9a-f]{40}$/.test(invitee)) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId, prompt: 'Who should be invited? Give their agent address.',
        fields: [{ name: 'invitee', label: 'Invitee', type: 'address', required: true, hint: 'their smart-agent address (0x…) — search the directory if you only have a name' }],
      });
    }
    if (invitee === org) throw new Error('an organization cannot invite itself');
    if (person && invitee === person.toLowerCase()) throw new Error('you are already the steward of this organization — an invitation to yourself grants nothing');
    // HOUSEHOLD FACETS (spec 368): kinship and role travel with the invitation and onto the membership
    // (`aphh:kinRelation` / `aphh:householdRole`). Declarative — they authorize nothing (a guardian still
    // needs a delegation to act for anyone) — so they are carried, never verified here.
    const kin = String(args.kin ?? '').trim().toLowerCase();
    const role = String(args.role ?? '').trim().toLowerCase();
    const facets = kin || role ? { ...(kin ? { kin } : {}), ...(role ? { role } : {}) } : undefined;

    const digest = intentDigest(ctx.intent);
    const chainId = Number(env.CHAIN_ID);
    const dm = env.DELEGATION_MANAGER as Address;
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === harnessEnforcers(env).timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:invite:${invitee}`)));
    const grant = buildInviteGrant(env, org, invitee, salt, validUntil);
    const grantDigest = hashDelegation(grant, chainId, dm);

    // ONE-PROMPT PATH (spec 361 I4): the surface may have already approveHash'd this exact digest in
    // the SAME org userOp that approved the mandate's — one custodian signature for both. The org's
    // ERC-1271 answers for the 0x03 sentinel, and asking the person to sign a digest their signature
    // already covers is the double-prompt this design removes. The chain is asked, never a cache.
    if (deps?.readContract) {
      const approved = await deps.readContract({
        address: org,
        abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }],
        functionName: 'isValidSignature', args: [grantDigest, '0x03'],
      }).catch(() => null);
      if (approved === '0x1626ba7e') {
        // The SAME result shape as the signed path — the surface's recorder (`invitationOf`) keys on
        // `invited` + `memberAccessDelegation`, and a short-circuit that returned a different shape was
        // an invitation the flyout silently never stored (found live: two invites issued, zero recorded).
        const approvedWire: DelegationWireV1 = { ...grant, salt: grant.salt.toString(), signature: '0x03' as Hex };
        // WHAT FOLLOWS, when the invitee was named by email: the org's invitation record and the link, by
        // mail from the organization (spec 360 — an effect never fails the act; it is reported).
        const inviteeEmail = typeof args.inviteeEmail === 'string' ? args.inviteeEmail : undefined;
        const delivered = inviteeEmail && deps?.deliverEmailInvitation && session
          ? await deps.deliverEmailInvitation({ org, email: inviteeEmail, memberAccessDelegation: approvedWire, session }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          : undefined;
        return { org, invitee, memberAccessDelegation: approvedWire, grantDigest, invited: true, approvedHash: true, ...(facets ? { facets } : {}), ...(inviteeEmail ? { inviteeEmail, emailDelivery: delivered ?? { ok: false, error: 'email delivery is not wired on this agent' } } : {}) };
      }
    }

    const signed = signatureFor(ctx.supplied, stepRef, grantDigest);
    if (!signed) {
      throw new InputRequired({
        kind: 'signature', stepRef, toolId,
        prompt: `Sign the invitation from ${org} to ${invitee} — it lets them read this organization when they join.`,
        digest: grantDigest, signer: org,
        payload: { org, invitee, scope: ORG_PROFILE_RESOURCE_SCOPE, validUntil },
      });
    }
    // The invitation is the SIGNED grant. Storing it is the surface's half (the org's vault); returning
    // it unsigned-but-claimed would be an invitation that verifies nowhere.
    const wireOut: DelegationWireV1 = { ...grant, salt: salt.toString(), signature: signed.signature as Hex };
    return { org, invitee, memberAccessDelegation: wireOut, grantDigest, invited: true, ...(facets ? { facets } : {}) };
  };
}

/**
 * An address, or a NAME that resolves to one.
 *
 * People say "fund alice2.treasury", not "fund 0x5ef5…". Requiring an address here made the planner chain
 * a lookup into a later step's arguments, and when it did not it simply answered — reporting the address
 * it had found and that nothing had happened. A capability that accepts the words a person used needs no
 * such chain, and the resolution is the chain's own (immediate, unlike the directory).
 */
async function partyAddress(value: unknown, deps: HarnessDeps, what: string): Promise<Address> {
  const raw = String(value ?? '').trim();
  if (/^0[xX][0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase() as Address;
  if (!raw) throw new Error(`${what} is required`);
  // By the time an invoker reads an argument the normaliser has already resolved it (and asked, if it had
  // to). This is the last-resort exact-name read for a caller that bypassed it — never a search.
  if (!deps.resolveName || !raw.includes('.')) throw new Error(`${what} did not resolve to an agent ("${raw}")`);
  const resolved = await deps.resolveName(raw.toLowerCase());
  if (!resolved) throw new Error(`no agent holds the name "${raw}" — check it, or give the address`);
  return resolved.toLowerCase() as Address;
}

/** The amount, from whichever unit the ask used. Never inferred from a bare number: `amount` is smallest
 *  units, `usdc` is whole USDC, and neither one present is an error rather than a zero. */
export function fundingAmount(args: Record<string, unknown>): bigint {
  const raw = String(args.amount ?? '').trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) throw new Error(`amount must be whole smallest units (got "${raw}") — use the usdc argument for a decimal figure`);
    return BigInt(raw);
  }
  const human = String(args.usdc ?? '').trim();
  if (!human) throw new Error('how much? give `usdc` (e.g. "12.11") or `amount` in smallest units');
  if (!/^\d+(\.\d{1,6})?$/.test(human)) throw new Error(`"${human}" is not an amount of USDC (up to 6 decimal places)`);
  const [whole, frac = ''] = human.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const;

/**
 * `treasury.fund` — the demo faucet, done in the FUNDER's name.
 *
 * The Home's Fund button has the person's own SA call `mint` on the demo token; through the Ask the same
 * call is made by this agent redeeming the funder's mandate, so the authority is explicit and the receipt
 * says whose it was. A mint credits without debiting anyone, which is why this is `low` risk and a payment
 * is `high` — the ladder should not demand a second party to hand out demo money.
 */
export function fundInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const wire = presented.wire as Delegation;
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const dm = env.DELEGATION_MANAGER as Address;
    // The demo token is a DEPLOYMENT fact, not something to ask a planner to remember: default it, and
    // let an explicit arg override only if someone means a different token.
    const asset = (String(args.asset || env.MOCK_USDC || '')).toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(asset)) throw new Error('treasury.fund: no demo token is configured on this deployment');
    const funder = String(args.funder ?? '').toLowerCase();
    if (funder && funder !== wire.delegator.toLowerCase()) throw new Error(`the funding is made by the mandate's delegator (${wire.delegator}); the plan named ${funder}`);
    const treasury = await partyAddress(args.treasury, deps, 'the treasury to fund');
    const amount = fundingAmount(args);
    const digest = intentDigest(ctx.intent);
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === harnessEnforcers(env).digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    const mint = encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [treasury, amount] });
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], asset, 0n, mint] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    return { txHash, treasury, asset, amount: amount.toString(), funder: wire.delegator };
  };
}

const REL_ROLE_ABI = [
  { type: 'function', name: 'getEdgeByTriple', stateMutability: 'view', inputs: [
    { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' },
  ], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'addRole', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'removeRole', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [] },
] as const;
const ZERO_EDGE = `0x${'0'.repeat(64)}` as Hex;

/**
 * `treasury.primary.declare` — "when someone pays me, it goes here" (spec 355 / spec 361 I4).
 *
 * THE SAME ACT THE HOME BUTTON MAKES, and now the only implementation of it: a role on the PUBLIC
 * `ap:charteredUnder` edge, set by the OWNER, who is the object side the contract allows to set it.
 *
 * IT GRANTS NOTHING. Nobody may spend from the marked treasury and no gate reads the role — its whole
 * effect is that a payer's resolver stops asking a question only the owner can answer. That is also why
 * it is `medium` and not `high`: it moves nothing, and the same person can undo it in one act.
 *
 * NO EDGE, NO PREFERENCE — and that is an answer, not a failure. An agent kept off the public record
 * (spec 338) has nothing to hang a public preference on; for those the grant you signed IS the
 * preference, and saying so is more use than a retry.
 */
export function primaryPayeeInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const wire = presented.wire as Delegation;
    const relationships = (env.AGENT_RELATIONSHIP ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(relationships)) throw new Error('the relationship record is not configured on this deployment');
    const owner = wire.delegator.toLowerCase() as Address;
    const named = String(args.holder ?? '').toLowerCase();
    if (named && named !== owner) throw new Error(`the preference is the owner's to set (${wire.delegator}); the plan named ${named}`);
    const treasury = await partyAddress(args.treasury, deps, 'the treasury to be paid');
    const on = args.on === undefined ? true : isFlagTrue(args.on);
    // WHICH STANDING ROLE. Receiving and spending are different questions about the same account, and
    // conflating them would move money out of the one its owner publishes.
    const roleWord = /^pay(er|ing|s)?$|from|spend/i.test(String(args.role ?? '')) ? 'payer' : 'payee';
    const roleHash = roleWord === 'payer' ? ROLE.PRIMARY_PAYER : ROLE.PRIMARY_PAYEE;

    const readEdge = async (subject: string): Promise<Hex | null> => {
      const id = await deps.readContract({
        address: relationships, abi: REL_ROLE_ABI, functionName: 'getEdgeByTriple',
        args: [subject as Address, owner, RELATIONSHIP_TYPE.CHARTERED_UNDER],
      }).catch(() => null) as Hex | null;
      return id && id !== ZERO_EDGE ? id : null;
    };
    const edgeId = await readEdge(treasury);
    if (!edgeId) {
      return {
        declared: false,
        treasury, owner,
        // The screen says this in the same words. A public preference needs a public link.
        note: 'that treasury is not in the public record, so it cannot be marked for payments — you give someone a way to reach it by answering their request instead',
      };
    }
    const hasRole = async (id: Hex): Promise<boolean> => (await deps.readContract({
      address: relationships, abi: REL_ROLE_ABI, functionName: 'hasRole', args: [id, roleHash],
    }).catch(() => false)) === true;

    // ONE PRIMARY, OR THE PREFERENCE SAYS NOTHING. Two treasuries both marked is not "more preferred" —
    // the payer's resolver reads it as ambiguity and asks anyway, which is the state this capability
    // exists to remove. So a switch CLEARS the previous one, in the same mandate, with no second
    // signature: the person said which one, and saying which one is saying which one it is not.
    const calls: Array<{ target: Address; data: Hex; what: string }> = [];
    if (on) {
      const others = (await deps.charteredAgents?.(owner, 'treasury').catch(() => []) ?? [])
        .filter((c) => c.agent.toLowerCase() !== treasury);
      for (const other of others) {
        const otherEdge = await readEdge(other.agent.toLowerCase());
        if (otherEdge && await hasRole(otherEdge)) {
          calls.push({ target: relationships, what: `cleared ${other.name ?? other.agent}`, data: encodeFunctionData({ abi: REL_ROLE_ABI, functionName: 'removeRole', args: [otherEdge, roleHash] }) });
        }
      }
    }
    const already = await hasRole(edgeId);
    if (already === on && !calls.length) {
      // Nothing to do is not a failure, and pretending a transaction happened would be a claim.
      return { declared: on, role: roleWord, alreadySet: true, treasury, owner };
    }
    if (already !== on) {
      calls.push({ target: relationships, what: on ? 'marked' : 'cleared', data: encodeFunctionData({ abi: REL_ROLE_ABI, functionName: on ? 'addRole' : 'removeRole', args: [edgeId, roleHash] }) });
    }

    const dm = env.DELEGATION_MANAGER as Address;
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const digest = intentDigest(ctx.intent);
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === harnessEnforcers(env).digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    const txHashes: string[] = [];
    for (const call of calls) {
      const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], call.target, 0n, call.data] });
      const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
      const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
      txHashes.push(txHash);
    }
    return { declared: on, role: roleWord, treasury, owner, txHash: txHashes[txHashes.length - 1] ?? null, ...(txHashes.length > 1 ? { txHashes } : {}) };
  };
}

const REVOKE_BY_OWNER_ABI = [{
  type: 'function', name: 'revokeDelegationByOwner', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'delegation', type: 'tuple', components: [
    { name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] },
    { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' },
  ] }],
}] as const;

/**
 * `access.grant.revoke` — the authority kill, said out loud.
 *
 * THE DIFFERENCE FROM "DISCONNECT". Dropping a Home's copy of a grant stops THIS Home using it; the app
 * keeps working anywhere else that checks. Revoking on chain stops it at every gate — which is the
 * property an OAuth scope cannot have and the reason this capability exists rather than a local delete.
 *
 * WHOSE GRANT. Only one the PERSON issued: the wire is fetched from their own DO by client id, and the
 * mandate's delegator must be its delegator. A revocation of somebody else's grant is not a thing this
 * can express — the chain would refuse it, and so does this, earlier and with a sentence.
 */
export function accessRevokeInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    if (!deps.readGrantWire) throw new Error('this agent cannot read the grant to revoke (no read-grant seam wired)');
    const app = String(args.app ?? '').trim().toLowerCase();
    if (!app) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId: _toolId,
        prompt: 'Which app should lose access?',
        fields: [{ name: 'app', label: 'app', type: 'text', required: true, hint: 'its client id — ask "who can read my records" to see the list' }],
      });
    }
    const holder = (person ?? wire.delegator).toLowerCase();
    if (wire.delegator.toLowerCase() !== holder) throw new Error(`a grant is revoked by the person who issued it (${holder}); the mandate is from ${wire.delegator}`);
    const found = await deps.readGrantWire(holder, app);
    if (!found) {
      // NOT AN ERROR TO RETRY. There is no such grant here, which is a fact about what they authorized.
      return { revoked: false, app, note: `no read grant for "${app}" is stored here — nothing to revoke` };
    }
    const grant = found.wire as unknown as { delegator: string; delegate: string; authority: string; caveats: Array<{ enforcer: string; terms: string; args?: string }>; salt: string; signature: string };
    if (grant.delegator.toLowerCase() !== holder) throw new Error('that grant was issued by someone else — it is not yours to revoke');

    const inner = encodeFunctionData({
      abi: REVOKE_BY_OWNER_ABI, functionName: 'revokeDelegationByOwner',
      args: [{
        delegator: grant.delegator as Address, delegate: grant.delegate as Address, authority: grant.authority as Hex,
        caveats: grant.caveats.map((c) => ({ enforcer: c.enforcer as Address, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex })),
        salt: BigInt(grant.salt), signature: grant.signature as Hex,
      }],
    });
    const dm = env.DELEGATION_MANAGER as Address;
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const digest = intentDigest(ctx.intent);
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === harnessEnforcers(env).digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    // The person's own SA makes the call (the DelegationManager only lets the owner revoke), reached by
    // redeeming their mandate — the same shape a payment uses, with the target being the manager itself.
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], dm, 0n, inner] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    return { revoked: true, app, grantHash: found.hash, txHash, holder };
  };
}

/**
 * `household.member.record` — "Sarah is my daughter", said out loud.
 *
 * SELF-ACTING (spec 350 §3.2a): a note in the person's own vault about their own life. No mandate, and
 * the Home's form will ask for no signature either — a conversation that cost one where a form does not
 * would teach people that talking to their agent is the expensive way.
 *
 * IT GRANTS NOBODY ANYTHING. Recording a guardian does not let them act for a dependent (that is a
 * delegation the dependent's custodian issues); recording a spouse does not open an account. The
 * household answers "who did you mean" and stops a directory search leaving the asker's own tier.
 */
export function householdRecordInvoker(deps: HarnessDeps, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('a household is recorded as you, and there is no signed-in person on this run');
    if (!deps.recordHouseholdMember) throw new Error('the household record is not reachable from this agent');
    const member = String(args.member ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(member)) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: 'Who should I add to your household?',
        fields: [{ name: 'member', label: 'who', type: 'text', required: true, hint: 'their name (sarah.me) or address — they need an agent for you to record them' }],
      });
    }
    // WHAT TO CALL THEM, when the person did not say. Their public agent name is a better label than the
    // words of the sentence ("my daughter" reads oddly on a payment card six weeks later), and it is a
    // fact anyone could read — nothing private is being added by naming a named agent.
    const label = String(args.label ?? '').trim() || (await deps.nameOf?.(member).catch(() => null)) || '';
    const out = await deps.recordHouseholdMember(person.toLowerCase(), {
      member,
      ...(label ? { label } : {}),
      ...(args.household !== undefined ? { household: String(args.household) } : {}),
      ...(args.role !== undefined ? { role: String(args.role) } : {}),
      ...(args.kin !== undefined ? { kin: String(args.kin) } : {}),
      // ONE READER FOR A YES/NO. `remove: true` arrives from a reader as the string "true"; comparing
      // to the boolean dropped it, and "take Dave out of the farm" silently put him back in.
      ...(isFlagTrue(args.remove) ? { remove: true as const } : {}),
    });
    if (!out.ok) throw new Error(out.error ?? 'the household record could not be written');
    // WHAT FOLLOWS (spec 368 §3): the note is the person's own; the HOUSEHOLD AGENT is the family's shared
    // record. When they steward one, the next act is to invite this person INTO it, kinship carried —
    // so the household Bob is in as spouse is the same household Alice founded. That invitation is the
    // household's own act (its custodian signs), so it is PROPOSED here, never done on the side.
    const next = isFlagTrue(args.remove) ? undefined : await householdNextFor(deps, person, member, label, args);
    return {
      ...out, member, tier: 'private', record: 'household.data',
      ...(next?.householdAgent ? { householdAgent: next.householdAgent } : {}),
      ...(next ? { next: next.next } : {}),
      note: 'this is your own private record of who you live with — it is not published anywhere, and it grants nobody any authority',
    };
  };
}

/** A proposed follow-up act: a compiled command the person may confirm (the surface runs it as a plan;
 *  authority is asked for there, never assumed here). */
export interface NextActV1 { capability: string; args: Record<string, unknown>; words: string; why: string }

/**
 * The household agent this note should also land in, and the act that puts the person there.
 *
 * Chartered `.household` agents are read from the `ap:charteredUnder` edges the person signed (spec 355 —
 * the edge, never a name resemblance). With one: invite the member into it, kinship and role carried.
 * With several: the one whose label matches the household the person named; else the first. With none:
 * propose creating one — until it exists, the family has nothing shared to be in.
 */
export async function householdNextFor(
  deps: Pick<HarnessDeps, 'charteredAgents'>, person: Address, member: string, label: string, args: Record<string, unknown>,
): Promise<{ householdAgent?: { agent: string; name?: string }; next: NextActV1 } | undefined> {
  const houses = deps.charteredAgents ? await deps.charteredAgents(person.toLowerCase(), 'household').catch(() => []) : [];
  const who = label || member;
  const kin = String(args.kin ?? '').trim().toLowerCase();
  const role = String(args.role ?? '').trim().toLowerCase();
  if (!houses.length) {
    return {
      next: {
        capability: 'household.create', args: {},
        words: `create your household agent, so ${who} can be in the same household as you`,
        why: 'the note you just made is yours alone; a household agent is the record the whole family shares',
      },
    };
  }
  const wanted = String(args.household ?? '').trim().toLowerCase();
  const named = wanted ? houses.find((h) => (h.name ?? '').toLowerCase().split('.')[0] === wanted) : undefined;
  const chosen = named ?? houses.find((h) => h.primary) ?? houses[0]!;
  const houseName = chosen.name ? chosen.name.split('.')[0] : 'your household';
  return {
    householdAgent: { agent: chosen.agent, ...(chosen.name ? { name: chosen.name } : {}) },
    next: {
      capability: ORG_INVITE_CAPABILITY,
      args: { org: chosen.agent, invitee: member, ...(kin ? { kin } : {}), ...(role ? { role } : {}) },
      words: `invite ${who} to ${houseName}${kin ? ` as your ${kin}` : ''}`,
      why: `${houseName} is the household the family shares — this puts ${who} in it, with how you are related recorded on their membership`,
    },
  };
}

/**
 * `profile.contact.update` — the Home's profile form, said out loud.
 *
 * NO MANDATE, DELIBERATELY, and the reason is not that it is unimportant: the record is the person's
 * own, the write runs under their own session in their own DO, and the form beside this conversation
 * asks for no signature either. A capability that made the spoken version cost a signature the clicked
 * version does not would be teaching people that talking to their agent is the expensive way.
 *
 * MERGE, NEVER REPLACE — enforced in the DO, because that is where the record is.
 */
export function profileUpdateInvoker(deps: HarnessDeps, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('a profile is changed as you, and there is no signed-in person on this run');
    if (!deps.mergeProfile) throw new Error('the profile record is not reachable from this agent');
    const fields: Record<string, string> = {};
    for (const f of CONTACT_FIELD_ARGS) {
      const v = String(args[f] ?? '').trim();
      if (v) fields[f] = v;
    }
    // AN ADDRESS NEEDS ITS COUNTRY (the record's own rule: the coarsest precision is required for any
    // finer one). A street with no country anywhere — not given, not already recorded — is asked for,
    // not guessed: "Colorado" makes it certain and the planner fills it; "Erie" alone does not.
    const givesLocation = CONTACT_FIELDS.some((f) => f.location && f.arg !== 'country' && fields[f.arg]);
    if (givesLocation && !fields.country && deps.readSubjectRecord) {
      const current = (await deps.readSubjectRecord(person.toLowerCase(), 'impact-profile').catch(() => null)) as { contact?: { location?: { country?: string }; country?: string } } | null;
      const known = current?.contact?.location?.country || current?.contact?.country;
      if (!known) {
        throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Which country is that address in?', fields: [{ name: 'country', label: 'Country', type: 'text', required: true }] });
      }
    }
    if (!Object.keys(fields).length) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: 'What should I change on your profile?',
        fields: [
          { name: 'firstName', label: 'First name', type: 'text', required: false },
          { name: 'lastName', label: 'Last name', type: 'text', required: false },
          { name: 'email', label: 'Email', type: 'text', required: false },
        ],
      });
    }
    // A BAD EMAIL IS WORSE THAN NO EMAIL: it is where somebody's mail goes. Read by its declared TYPE
    // (spec 363 W2), so the check is the same one the normaliser and the Home's form use — a second
    // regex here is how two surfaces come to disagree about what an address is.
    if (fields.email) {
      const read = readValue('EmailAddress', fields.email);
      if (!read.ok) throw new Error(`"${read.said}" ${read.because} — give it in full, like name@example.org`);
      fields.email = read.value;
    }
    const out = await deps.mergeProfile(person.toLowerCase(), fields);
    if (!out.ok) throw new Error(out.error ?? 'the profile could not be written');
    return {
      updated: true, changed: out.changed ?? Object.keys(fields), ...(out.refused?.length ? { refused: out.refused } : {}),
      // The tier, in the result, so the reply says it: a person who just "changed their name" should not
      // have to guess whether the directory now shows it.
      tier: 'private', record: 'impact-profile',
      note: 'this is the private contact record — the public directory listing and the agent\'s public name are separate',
    };
  };
}

/**
 * `messaging.direct.send` — the Home's message box, said out loud.
 *
 * The message goes through the SENDER's own interactions plane (`messaging.send`), which is where a direct
 * message already lives: one conversation per counterparty, bodies in each side's vault (ADR-0055). This
 * capability adds no storage and no second path — it resolves who was meant, asks for the words if the ask
 * did not carry them, and hands both to the plane that already does this.
 */
export function messageInvoker(deps: HarnessDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person || !session) throw new Error('a direct message is sent as you, and there is no signed-in person on this run');
    if (!deps.sendDirectMessage) throw new Error('messaging is not wired on this agent');
    const recipient = String(args.recipient ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error(`the recipient did not resolve to an agent (${String(args.recipient ?? '')})`);
    // A planner that cannot find who was named will sometimes fill the field with whoever it DOES know —
    // and the person it knows is the asker. "Send a message to zzz-nobody-here" came back addressed to
    // Nathan. Harmless for a message and not harmless as a habit: an invented party is the failure the
    // whole resolution tier exists to prevent, so it is a question rather than a plan.
    if (recipient === person.toLowerCase()) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: 'That would send the message to you. Who did you mean?',
        fields: [{ name: 'recipient', label: 'The person to message', type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
      });
    }
    const supplied = dataFor(ctx.supplied, stepRef);
    const text = String(supplied.message ?? args.message ?? '').trim();
    if (!text) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId, prompt: 'What should the message say?',
        fields: [{ name: 'message', label: 'Message', type: 'text', required: true, hint: 'they will see it in their inbox, from you' }],
      });
    }
    const out = await deps.sendDirectMessage({ sender: person, recipient, bodyText: text, session });
    if (!out.ok) throw new Error(out.error);
    return { sent: true, recipient, from: person, message: text, ...(out.messageId ? { messageId: out.messageId } : {}) };
  };
}

/** The invoker: informational tools go to the existing MCP path; the payment tool redeems on chain; the
 *  team tool builds a genesis the connected user signs. */
export function harnessInvoker(deps: HarnessDeps, env: HarnessEnv, presentedInput: MandatePresentation | MandatePresentation[] | null, mcpInvoke: ToolInvoker, person?: Address, session?: string, surface?: AskScopeV1, addressee?: Address, playbook?: { capabilityIds: Set<string> } | null): ToolInvoker {
  const presentedAll: MandatePresentation[] = presentedInput == null ? [] : Array.isArray(presentedInput) ? presentedInput : [presentedInput];
  // Non-payment invokers redeem the single mandate the turn presented (unchanged). The PAYMENT invoker
  // redeems the one whose caveat names the step's payee — the same selection the verifier used, so what
  // is redeemed is exactly what was judged.
  const presented: MandatePresentation | null = presentedAll[0] ?? null;
  return async (toolId, args, ctx) => {
    // Unreachable for a capability tool (the loop refuses or reports before invoking one without a
    // mandate); explicit so a future caller cannot make it reachable quietly.
    if (!presented && (CHILD_AGENT_TLD[toolId] || toolId === 'treasury.payment.execute' || toolId === 'treasury.fund' || toolId === 'messaging.direct.send' || toolId === ORG_INVITE_CAPABILITY || toolId === PRIMARY_PAYEE_CAPABILITY || toolId === ACCESS_REVOKE_CAPABILITY)) throw new Error(`${toolId} requires a mandate and none was presented`);
    if (toolId === UNSUPPORTED_TOOL.id) {
      const offered = scopedActionTools(surface, playbook).map((t) => t.capability?.id ?? t.id);
      return { unsupported: true, what: String(args.what ?? ''), available: offered };
    }
    if (toolId === MEMBERSHIP_LIST_TOOL.id) {
      return membershipListInvoker(
        {
          ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
          ...(deps.readSubjectRecordStatus ? { readSubjectRecordStatus: deps.readSubjectRecordStatus } : {}),
          ...(deps.resolveName ? { resolveName: deps.resolveName } : {}),
          ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
          // The org's own INVITATION records, found through its inventory (spec 356 §2.5). A member who
          // joined by invite never published a listing, and reading listings alone hides them.
          ...(deps.survey ? { survey: deps.survey } : {}),
          ...(deps.readRecords ? { readRecords: deps.readRecords } : {}),
        },
        (addressee ?? person ?? ('0x' as Address)), person,
      )(toolId, args, ctx);
    }
    if (toolId === INVITATIONS_LIST_TOOL.id) {
      return invitationsListInvoker(
        {
          ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
          ...(deps.survey ? { survey: deps.survey } : {}),
          ...(deps.readRecords ? { readRecords: deps.readRecords } : {}),
          ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
        },
        (addressee ?? person ?? ('0x' as Address)), person,
      )(toolId, args, ctx);
    }
    if (toolId === AFFILIATIONS_LIST_TOOL.id) {
      return affiliationsListInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}) }, person)(toolId, args, ctx);
    }
    if (toolId === RESOLUTION_REQUEST_TOOL.id) {
      return resolutionRequestInvoker(
        {
          ...(deps.sendDirectMessage ? { sendDirectMessage: deps.sendDirectMessage } : {}),
          ...(deps.appendSubjectRecord ? { appendSubjectRecord: deps.appendSubjectRecord } : {}),
          ...(deps.resolveName ? { resolveName: deps.resolveName } : {}),
          ...(env.ALLOWED_ORIGINS ? { homeOrigin: env.ALLOWED_ORIGINS } : {}),
        },
        person, session,
      )(toolId, args, ctx);
    }
    if (toolId === BALANCE_READ_CAPABILITY) return balanceReadInvoker({ ...(deps.valueHeld ? { valueHeld: deps.valueHeld } : {}), ...(deps.charteredAgents ? { charteredAgents: deps.charteredAgents } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, (addressee ?? person) as Address, person)(toolId, args, ctx);
    if (toolId === ENDEAVOR_LIST_CAPABILITY || toolId === ENDEAVOR_GET_CAPABILITY) return endeavorReadInvoker(deps, (addressee ?? person) as Address, person)(toolId, args, ctx);
    if (COORDINATION_CAPABILITY_IDS.has(toolId)) return endeavorActInvoker(deps, (addressee ?? person) as Address, person, session)(toolId, args, ctx);
    if (toolId === 'messaging.direct.send') return messageInvoker(deps, presented!, person, session)(toolId, args, ctx);
    if (toolId === ORG_INVITE_CAPABILITY) return inviteInvoker(env, presented!, person, deps, session)(toolId, args, ctx);
    if (CHILD_AGENT_TLD[toolId]) {
      if (!deps.teamGenesis) throw new Error(`${toolId} is not configured on this agent (no genesis substrate)`);
      return childAgentCreateInvoker(deps.teamGenesis, env, presented!, person)(toolId, args, ctx);
    }
    if (toolId === 'treasury.fund') return fundInvoker(deps, env, presented!)(toolId, args, ctx);
    if (toolId === PRIMARY_PAYEE_CAPABILITY) return primaryPayeeInvoker(deps, env, presented!)(toolId, args, ctx);
    if (toolId === ACCESS_REVOKE_CAPABILITY) return accessRevokeInvoker(deps, env, presented!, person)(toolId, args, ctx);
    if (toolId === PROFILE_UPDATE_CAPABILITY) return profileUpdateInvoker(deps, person)(toolId, args, ctx);
    if (toolId === HOUSEHOLD_RECORD_CAPABILITY) return householdRecordInvoker(deps, person)(toolId, args, ctx);
    if (toolId !== 'treasury.payment.execute') return mcpInvoke(toolId, args, ctx);
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    // THE KEY THAT WAS JUDGED IS THE KEY THAT REDEEMS (spec 358 W4). With several presented, pick by the
    // step's payee — identical selection to the loop's — and refuse when none fits rather than redeeming
    // a mandate for a different item.
    const paymentPresented = presentedAll.length > 1
      ? selectByPayee({ capability: { id: 'treasury.payment.execute' }, args }, presentedAll, harnessEnforcers(env).payment)
      : presented;
    if (!paymentPresented) throw new Error('no presented mandate names this payee — each fanned-out payment needs its own');
    const dm = env.DELEGATION_MANAGER as Address;
    const enforcers = harnessEnforcers(env);
    if (!enforcers.payment) throw new Error('harness: PAYMENT_ENFORCER is not configured');
    const asset = String(args.asset).toLowerCase() as Address;
    const payer = args.payer ? await partyAddress(args.payer, deps, 'the payer') : '';
    if (payer && payer !== (paymentPresented.wire as Delegation).delegator.toLowerCase()) {
      throw new Error(`the payment is made by the mandate's delegator (${(paymentPresented.wire as Delegation).delegator}); the plan named ${payer}`);
    }
    const payee = await partyAddress(args.payee, deps, 'the payee');
    const amount = fundingAmount(args);
    const wire = paymentPresented.wire as Delegation;
    const digest = intentDigest(ctx.intent);

    // Redeem-time caveat args. PaymentEnforcer: (mandateId, nonce, resourceHash) — the nonce is single-use
    // ON CHAIN, and it is derived from the INTENT and the step, never from the run. The first cut derived
    // it from the run's random ref, and the identical ask run twice paid twice: each run was a fresh nonce,
    // both were within the mandate's aggregate ceiling, and the chain saw two legitimate redemptions. An
    // intent is one thing that happens once; a second settlement needs a second intent (a new nonce in the
    // intent), not a second run. With the nonce bound to the intent, a replay reverts NonceReused on chain
    // whatever the run ref — the idempotency the loop asked for becomes an on-chain guarantee.
    // DigestBindingEnforcer: the intent digest this run is acting under — the commitment.
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const nonce = keccak256(toBytes(`${digest}:${stepRef}`));
    const paymentArgs = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [digest, nonce, keccak256(toBytes(`${paymentPresented.ref}:${stepRef}`))]);
    const caveats = wire.caveats.map((c) => {
      const e = c.enforcer.toLowerCase();
      if (e === enforcers.payment!.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: paymentArgs };
      if (e === enforcers.digestBinding.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) };
      return { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex };
    });
    // Again, at the moment of acting: the balance may have moved since the preview, and a revert with no
    // reason is a worse answer than a sentence with the numbers in it.
    const late = await preconditionRefusal({ capability: 'treasury.payment.execute', args: { ...args, payer: wire.delegator }, env, deps });
    if (late) throw new Error(late);
    const transfer = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [payee, amount] });
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], asset, 0n, transfer] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    // IDEMPOTENCY IS THE ON-CHAIN NONCE (spec 358 W4-tail). The loop's resume-with-recheck re-invokes a
    // step that already ran (§3.4), and its contract is that the invoker makes that a no-op. For a
    // payment the authoritative "already done" signal is the PaymentEnforcer's own single-use nonce:
    // keccak(intentDigest:stepRef) is consumed exactly when this precise payment settled, so a used nonce
    // means THIS payment happened. Reading it and returning idempotently is not a fallback to a weaker
    // mechanism (ADR-0013) — it is reading the one authority that already decided, before asking it again
    // and being told NonceReused. Without this, the second-party-approval resume re-submits every
    // fanned-out payment and each reverts (finding W4-FANOUT-RESUME-1).
    const dHash = hashDelegation(wire, Number(env.CHAIN_ID), dm);
    const alreadySettled = enforcers.payment
      ? await deps.readContract({ address: enforcers.payment as Address, abi: IS_NONCE_USED_ABI, functionName: 'isNonceUsed', args: [wire.delegator, dHash, nonce] }).catch(() => false)
      : false;
    if (alreadySettled) {
      // This exact payment already happened. Report it done, without a txHash we did not just create —
      // the receipt of the settling run holds that; re-inventing one would be a claim (spec 357 §4).
      return { asset, payee, amount: amount.toString(), payer: wire.delegator, alreadySettled: true };
    }
    // THE EFFECT OWNER DECIDES WHAT HAPPENED (spec 367 §8). The payment's stable identity at the enforcer is
    // (delegator, delegation hash, intent-derived nonce): submitting it twice reverts, and reading it says
    // whether it settled. So an uncertain submit — the bundler answered nothing, the receipt read timed
    // out — is RECONCILED against that identity before it is called a failure: settled ⇒ committed (no tx
    // hash of our own to show; the settling run's receipt holds it); not settled ⇒ failed before effect,
    // which a retry under the same identity may safely attempt again. Unknown never becomes a second effect.
    let txHash: Hex;
    try {
      ({ txHash } = await deps.executeAsServiceSa(serviceSa, callData));
    } catch (e) {
      const settled = enforcers.payment
        ? await deps.readContract({ address: enforcers.payment as Address, abi: IS_NONCE_USED_ABI, functionName: 'isNonceUsed', args: [wire.delegator, dHash, nonce] }).catch(() => null)
        : null;
      if (settled === true) return { asset, payee, amount: amount.toString(), payer: wire.delegator, alreadySettled: true, outcome: 'committed', effectIdentity: `${dHash}:${nonce}`, reconciled: true };
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`${settled === false ? 'failed before effect' : 'outcome unknown and not reconcilable'}: ${reason}`);
    }
    return { txHash, asset, payee, amount: amount.toString(), payer: wire.delegator, outcome: 'committed', effectIdentity: `${dHash}:${nonce}` };
  };
}

/** PaymentEnforcer.isNonceUsed — the on-chain idempotency read (spec 358 W4-tail). readContract only. */
const IS_NONCE_USED_ABI = [{
  type: 'function', name: 'isNonceUsed', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }],
}] as const;

export interface HarnessRunInput {
  intent: { goal: string; constraints?: Record<string, unknown>; context?: Record<string, unknown> };
  /** Spec 370 P1 — the checkpoint's record of what ran: the admitted plan and the completed steps. The
   *  loop replays the completed steps and plans nothing anew; the remaining steps are verified afresh. */
  resume?: { plan: Plan; completed: ReadonlyArray<{ stepRef: string; result?: unknown; receipt?: StepReceipt }> };
  /** Spec 370 P2 — one sentence per loop event, as the run goes, for a surface to show or say. Composed
   *  here because the tools' words are known here; what the caller does with it is its business. */
  onProgress?: (line: Omit<ProgressLineV1, 'seq' | 'at'>) => void;
  /** The mandate(s) the caller presents. `null` is legitimate on an ASK: the run then reports the
   *  authority it would need (`authority-required`) instead of failing — and grants nothing. A LIST is
   *  the spec 358 W4 keyring: a fanned-out plan needs a mandate per item, and each step is judged under
   *  the one whose payment caveat names ITS payee — selection is deterministic, verification unchanged. */
  presented: DelegationWireV1 | DelegationWireV1[] | null;
  approvals?: SuppliedApprovalV1[];
  /** Spec 350 §3.4 — answers to the prompts an earlier run of this ask raised (a resume). */
  supplied?: SuppliedInputV1[];
  /**
   * Spec 361 I4 — a CALLER-SUPPLIED plan: the deterministic entry a SCREEN uses. A form already knows
   * its intent and parameters; routing a button click through an LLM to rediscover them is the named
   * anti-pattern ("do not convert clicks into sentences"). A supplied plan replaces only the PROPOSER —
   * every step still crosses the same tool allowlist, the same normaliser, the same verifier, the same
   * risk ladder and the same approval port as a model-planned step. Planner proposes, mandate
   * authorizes; a caller is just a different proposer, and a caller-named tool the surface does not
   * offer fails the loop's own unknown-tool gate.
   */
  plan?: { steps: Array<{ toolId: string; args: Record<string, unknown>; id?: string }> };
  /** Spec 367 §8 — when this run answers ANOTHER agent's routed request: the request it responds to, pinned
   *  onto every receipt's binding (`correlation.inResponseTo`) so the causal chain R → S is on the record. */
  inResponseTo?: { agent: Address; operationId: string; runRef: string; stepRef: string };
  /** The connected user (the session's SA). What they create, they custody. */
  person?: Address;
  /** Their Home session — the interactions plane authenticates a direct message with it. */
  session?: string;
  /**
   * WHAT THE SURFACE SUPPORTS, and where the person is standing (spec 352 §2).
   *
   * The Ask is asked from inside an app, and the app knows things this agent does not: which product
   * capabilities it can actually complete a ceremony for, and what realm the person has selected. Handing
   * a planner every capability this substrate CAN do — including ones whose surface has no way to finish
   * them — invites a plan the person cannot follow through.
   *
   * SCOPING IS DISCLOSURE, NEVER AUTHORITY. A surface may only NARROW: it cannot add a capability, and
   * naming one does not permit it. The mandate is still the gate, verified per step against the chain
   * (spec 338's rule, one layer up: showing a capability does not permit it, and hiding one does not
   * protect it).
   */
  surface?: AskScopeV1;
  /** Spec 369 — the words arrived by voice (the transcript the agent itself produced). Trace only. */
  channel?: 'text' | 'voice';
  /** The agent being asked. Informational tools that read an organization's own records default to it —
   *  "who are the members" asked OF an organization means that one. */
  addressee?: Address;
  runRef?: string;
  /** The MCP-backed invoker for informational tools (the existing orchestrate path). */
  mcpInvoke: ToolInvoker;
}

/**
 * What the planner is told, on top of "choose a tool".
 *
 * The rule it exists to state is the one the tool shapes cannot: an ask is either a QUESTION or an
 * INSTRUCTION, and a lookup is applicable to both. Given "send 5 USDC from nathan.treasury to
 * alice2.treasury" alongside a directory read, a planner will resolve both names and stop — every step
 * defensible, the money unmoved, and a fluent paragraph explaining that no transfer was made. That is not
 * a hallucination; it is a planner doing the most obviously-safe thing with tools that did not say which
 * of them ACTS.
 *
 * So: capabilities take the words people use, and looking something up is never the answer to an
 * instruction.
 */
const ASK_PLANNER_SYSTEM =
  'You are the planning component of an agent. Choose the tool that satisfies the goal and provide its '
  + 'arguments. You may ONLY use the provided tools. Do not answer in prose — select a tool.\n\n'
  + 'An ask is either a QUESTION about what exists, or an INSTRUCTION to do something.\n'
  + '• An INSTRUCTION ("send", "pay", "fund", "create", "charter", "invite") is satisfied ONLY by the '
  + 'capability that performs it. Never answer one with a directory lookup: the capabilities take agent '
  + 'NAMES ("nathan.treasury", "bob.me") wherever they need an address and resolve them themselves, so '
  + 'there is never a reason to look an address up first. If no capability performs what was asked, choose '
  + '`ask.unsupported` — saying so is the correct answer, and a directory lookup is NOT a way of saying it. '
  + 'A capability missing from your tools does not exist here, however obviously related another one looks.\n'
  + '• A QUESTION is what the directory tools are for — and the IMPERATIVE MOOD DOES NOT MAKE ONE AN '
  + 'INSTRUCTION. "Show me the members", "list the teams", "give me her address" and "who is…" are all the '
  + 'same request: to SEE something. Answer them with the directory tools. If those return nothing, that '
  + 'is the answer — say so. NEVER choose `ask.unsupported` for a request to see, list, find, show or '
  + 'describe: `ask.unsupported` is only for an instruction that would CHANGE something this agent cannot '
  + 'change.\n\n'
  + 'MEMBERSHIP IS NOT IN THE DIRECTORY. Who belongs to an organization, team, circle or church is private '
  + 'and the public directory has never held it, so searching there returns nothing and that nothing means '
  + 'only that you looked in the wrong place. Use `organization.membership.list` for every ask about '
  + 'members, membership, rosters, "who is in" or "who belongs to".\n\n'
  + 'Missing details are not a reason to fall back to a lookup: the capability will ask the person for '
  + 'what it needs. Choosing the tool that ACTS is what lets it.\n\n'
  + 'NEVER INVENT A PLACEHOLDER. If the ask does not say an amount, a name or a recipient, OMIT that '
  + 'argument entirely — it will be asked for. Writing "<UNKNOWN>", "TBD" or a guessed number puts that '
  + 'value inside the authority the person is asked to sign.\n\n'
  + 'NEVER use an address from the context as a recipient, payee or invitee. The context tells you who is '
  + 'ASKING and which agent they are addressing — not who they are talking about. Pass the words the '
  + 'person used ("alice", "alice.me") and let the capability resolve them; if the ask names nobody, pass '
  + 'nothing and it will ask.';

/** What a presented mandate is FOR, in the words the planner knows the capability by. Read from the wire's
 *  own caveats — the mandate says what it covers, and nothing here has to be told. */
export function mandateCapabilityWords(presented: { caveats?: Array<{ enforcer?: string; terms?: string }> } | null): string | null {
  // The id is not IN the caveat: `capabilityHandler` reduces it to a 4-byte METHOD SELECTOR
  // (`methodSelector(id)`), so searching the terms for the id's own bytes matched nothing, ever — the
  // guidance this feeds was silently never added and the drift it was written to stop carried on.
  // Compare selectors, which is what is actually there.
  const terms = (presented?.caveats ?? []).map((c) => String(c.terms ?? '').toLowerCase()).join(' ');
  if (!terms) return null;
  for (const id of Object.keys(CAPABILITY_WORDS)) {
    const selector = methodSelector(id).slice(2).toLowerCase();
    if (selector && terms.includes(selector)) return CAPABILITY_WORDS[id]!;
  }
  return null;
}

/** Plain words for the capabilities an agent offers, for a refusal that says what it CAN do. An id with no
 *  word falls back to the id — an unfamiliar capability must still be readable, never silently dropped. */
export const CAPABILITY_WORDS: Record<string, string> = {
  'organization.team.create': 'create teams',
  'organization.create': 'create organizations',
  'household.create': 'create a household',
  'treasury.create': 'create treasuries',
  'organization.membership.invite': 'invite members',
  'coordination.endeavor.list': 'see what the organization is working on',
  'treasury.balance.read': 'read a balance',
  'coordination.endeavor.get': 'read one endeavor',
  'coordination.endeavor.request': 'ask the organization to take on a goal',
  'coordination.contribution.propose': 'offer to do plan steps',
  'coordination.contribution.allocate': 'allocate plan steps',
  'coordination.endeavor.satisfy': 'close an endeavor as done',
  'treasury.payment.execute': 'make payments',
  'treasury.fund': 'fund a treasury with demo USDC',
  'messaging.direct.send': 'send direct messages',
  'resolution.invitation.request': 'ask someone how to reach an agent of theirs',
  'treasury.primary.declare': 'say which treasury receives payments to you',
  'access.grants.list': 'say which apps can read your records',
  'access.grant.revoke': 'revoke an app\'s access on chain',
  'profile.contact.update': 'change your own contact details',
  'household.member.record': 'record who is in your household',
};

/** Which RAR type bounds a capability — the SAME map the verifier uses, so what a person is asked to sign
 *  is what the verifier will judge. */
export const REQUIREMENT_TYPE_FOR = (capabilityId: string): string =>
  capabilityId === 'treasury.payment.execute' ? PAYMENT_RAR_TYPE : CAPABILITY_RAR_TYPE;

/** One step's readable trace: which tool ran, how it read the question, and the query it actually sent.
 *  This is not the receipt (that is authority evidence and lives on `receipts`) — it is the answer showing
 *  its work, which is the difference between "there are none" and "I looked here and found none". */
export interface AskEvidence {
  toolId: string;
  interpretation?: string;
  query?: string;
  count?: number;
  /** What a keyword search actually looked for. A name match that found nothing and a directory that holds
   *  none of a kind are different facts, and this is the one that says which happened. */
  searched?: string;
  /** WHOSE data the tool read (vault-question's `looked`/`recordsOf`) — what attribution is checked
   *  against: an answer may not present these as anybody else's (spec 358 W3). */
  subjects?: string[];
  /** Why nothing came back, when the tool said. An answer built on a refusal must not read like an answer
   *  built on an empty result. */
  reason?: string;
}

/** Pull the trace out of what the steps observed. Only fields a tool deliberately returned for display —
 *  never the whole result, which would put arbitrary read data on a surface that did not ask for it. */
export function askEvidence(steps: RunResult['steps']): AskEvidence[] {
  const out: AskEvidence[] = [];
  for (const o of steps) {
    const r = o.result as { query?: unknown; interpretation?: unknown; count?: unknown; reason?: unknown; searchedNamesFor?: unknown; note?: unknown; looked?: unknown; recordsOf?: unknown } | null;
    if (!r || typeof r !== 'object') continue;
    const has = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
    if (!has(r.query) && !has(r.interpretation) && !has(r.reason) && !has(r.searchedNamesFor)) continue;
    out.push({
      toolId: o.step.toolId,
      ...(has(r.interpretation) ? { interpretation: r.interpretation as string } : {}),
      ...(has(r.query) ? { query: r.query as string } : {}),
      ...(typeof r.count === 'number' ? { count: r.count } : {}),
      ...(has(r.searchedNamesFor) ? { searched: r.searchedNamesFor as string } : {}),
      // A tool's own explanation of an empty result beats anything reconstructed from the shape of it.
      ...(has(r.reason) ? { reason: r.reason as string } : has(r.note) ? { reason: r.note as string } : {}),
      ...((): { subjects?: string[] } => {
        const looked = Array.isArray(r.looked) ? (r.looked as Array<{ subject?: unknown }>).map((l) => String(l.subject ?? '')).filter(Boolean) : [];
        const of = Array.isArray(r.recordsOf) ? (r.recordsOf as unknown[]).map(String).filter(Boolean) : [];
        const subjects = [...new Set([...looked, ...of])];
        return subjects.length ? { subjects } : {};
      })(),
    });
  }
  return out;
}

/** What the Ask surface gets back: an answer, the authority it would need, a question for the person, or
 *  the finished thing. One shape, so a surface never has to guess which of four states it is in. */
export type AskReplyVariant =
  | { kind: 'answer'; text: string; runRef: string;
      /** WHAT IT READ TO SAY THAT. A generated query is the one kind of evidence a person cannot
       *  reconstruct from the answer, and an answer whose query nobody can inspect is a claim (spec 357
       *  §4). Present when a step produced one; display only, and it decides nothing. */
      evidence?: AskEvidence[];
      /**
       * THE STRUCTURED RESULT, for a caller that supplied its own plan (spec 361).
       *
       * A person gets the sentence; a SCREEN that asked for exactly one informational capability wants
       * its rows — and rendering a table by parsing composed prose is how a surface starts disagreeing
       * with the record it is showing. Present only for a supplied plan: a conversational answer carries
       * evidence (what was looked at) and never the raw shape, which nothing but the composer should read.
       */
      results?: Array<{ toolId: string; result: unknown }> }
  | { kind: 'authority_required'; runRef: string; requirement: MandateRequirementV1; delegate: Address; delegator: Address; capability: string; stepRef: string; summary: string;
      /** What the ASKER is to the delegator, derived (spec 353 S5). Absent when nothing could read it —
       *  which is not "no standing", so a surface must not render absence as a refusal. */
      standing?: Standing; note?: string;
      /** WHO the words became. A person authorizing "send nathan a message" is authorizing it against an
       *  ADDRESS, and this is the only place they can see which one before they sign. Display only. */
      parties?: ResolvedParty[];
      /** Why standing could not be read, when it could not. Never a refusal — the ask proceeds. */
      standingUnavailable?: string;
      /** Spec 361 I4 one-prompt — OTHER digests this act will need signed BY THE SAME DELEGATOR, so the
       *  surface can approveHash them in the same org userOp as the mandate's: one signature, every
       *  authority the act needs. Derived from the requirement (deterministic); display + ceremony
       *  input, verified on chain like everything else. */
      alsoApprove?: Array<{ purpose: string; digest: Hex }> }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: NonNullable<RunResult['prompt']> }
  | { kind: 'done'; runRef: string; result: unknown; receipts: RunResult['receipts']; skillProvenance?: Record<string, unknown>;
      /** Spec 367 §6 — what the acted step ESTABLISHED, in its outcome class's words; a surface says no more than this. */
      fulfillment?: { capability: string; established: OutcomeClass; evidence?: string; words: string };
      /** Spec 361 — where the outcome LIVES: the acted capability's contract-declared binding, so a surface
       *  can offer 'open it' without a hand-kept capability→route table. Display only. */
      interaction?: { result?: string; navigationTarget?: string };
      /** Spec 360 — WHAT FOLLOWED, and whether it reached anyone. An effect cannot fail the act, so a
       *  disclosure that did not go out is otherwise invisible: money moved, both parties were promised a
       *  receipt, and the person was told "Done". A surface must be able to say which half happened. */
      effects?: Array<{ produces: string; ok: boolean; error?: string }>;
      /** Spec 363 W6 — WHAT WAS DECIDED, and why, for the act that just happened. A person who was never
       *  asked which account paid should be able to see which one did and on what basis, AFTER as well as
       *  before: the authority card is gone by then, and the receipt is where the answer lives. */
      decisions?: NonNullable<RunResult['receipts'][number]['decisions']> }
  | { kind: 'refused'; runRef: string; outcome: RunResult['outcome']; error: string; receipts: RunResult['receipts']; skillProvenance?: Record<string, unknown> };

/**
 * Spec 367 wave 1 — WHAT THE PLANNER ACTUALLY RECEIVED, on every reply. Before blaming a model, a failing turn
 * must answer: was the capability exposed; which playbook and contract versions; which planner (a supplied
 * screen plan, a compiled shape, the model); what did admission say; what did the executor get; where did
 * each bound party come from. The deployed planner consumes the context assembled for THAT turn, not an
 * architecture document. Display and evals only; it decides nothing and no gate reads it.
 */
export interface PlannerTraceV1 {
  /** Who proposed the plan: the screen (supplied), a compiled one-correct-plan shape, or the model. */
  planner: 'supplied' | 'compiled' | 'anthropic' | 'rule-based' | string;
  /** The tool ids the planner could choose from — a capability absent here was never an option. */
  toolsExposed: string[];
  /** The playbook this run was admitted under (digest-pinned), or null for the bare harness. */
  playbook: { archetypeId: string; archetypeVersion: string; digest: string } | null;
  /** keccak256 of the exact system prompt the model was given (doctrine + rules + examples). */
  promptDigest: Hex;
  /** How many contract examples were rendered into that prompt. */
  examplesRendered: number;
  /** Every admission verdict, in order — a refused plan shows what was proposed and why it was refused. */
  admission: Array<{ refused: Array<{ code: string; message: string; stepIndex?: number; toolId?: string }>; replanned: boolean }>;
  /** The plan that ran (or was refused last), as the executor received it BEFORE argument resolution. */
  plan: Array<{ toolId: string; args: Record<string, unknown> }>;
  /** Each party binding and WHERE IT CAME FROM (spec 367 §3): the person's words, a decision rule, memory, or the resolver. */
  bindings: Array<{ arg: string; raw: string; agent: string; label?: string; source: 'said' | 'context' | 'decision' | 'memory' | 'resolver' | 'disclosed'; because?: string }>;
  /** What the surface declared (spec 353): the realm kind and how many capabilities it offered. */
  surface?: { realm?: string; capabilities?: number; channel?: 'text' | 'voice' };
}

export type AskReply = AskReplyVariant & { plannerTrace?: PlannerTraceV1 };

/** Which arg a capability's RESOURCE is read from — the same declaration the tool makes, restated where
 *  the requirement is built so the two cannot disagree. */
const RESOURCE_ARG_FOR: Record<string, string> = {
  'treasury.payment.execute': 'asset',
  'treasury.fund': 'asset',
  'organization.membership.invite': 'org',
  'messaging.direct.send': 'recipient',
  'coordination.endeavor.request': 'org',
  'coordination.contribution.propose': 'org',
  'coordination.contribution.allocate': 'org',
  'coordination.endeavor.satisfy': 'org',
  // The CALL's target: the relationship record. See the pin in `resolveStepArgs` for why the treasury,
  // which is what the statement is ABOUT, cannot be the caveat's location.
  'treasury.primary.declare': 'record',
  // Likewise: a revocation is a call to the DelegationManager, and WHICH grant it kills travels in the
  // calldata. The caveat bounds the contract; the invoker bounds the grant to one the person issued.
  'access.grant.revoke': 'manager',
  'profile.contact.update': 'record',
  'household.member.record': 'record',
};

/** Arg names that hold an AGENT — a name here is the words a person used, and every one of them has to be
 *  an address by the time a caveat encodes it. */
/**
 * The arguments that name an AGENT and must become an address before anything is signed — every argument
 * any capability declares as a party, plus the two the estate carries that no capability names yet.
 *
 * Derived from the ontology binding rather than listed here, because listing them here is how the newest
 * capability got missed: `resolution.invitation.request` took an `owner`, nothing resolved it, and the
 * mandate refused to mint with "not an address or CAIP-10 account: alice.me" — after the person had
 * already been asked to grant. A capability that declares its parties now gets them resolved by saying so.
 */
const PARTY_ARGS: readonly string[] = [
  ...new Set([...PARTY_ROLES.map((r) => r.arg), 'workspace', 'funder']),
];

/**
 * Parties that are never the asker.
 *
 * A planner given the asker's address in the intent context will reach for it when it cannot find who was
 * named — "send a direct message to zzz-nobody-here" came back addressed to Nathan, and so did "send a
 * message to alice", because an address it could see beat a name it had to resolve. Paying, inviting or
 * messaging YOURSELF is not a plausible reading of any of those sentences, so it is a question.
 *
 * The counterpart args are deliberately absent: `payer`, `funder`, `parent`, `org` and `treasury` are very
 * often the asker, and asking there would be noise.
 */
export const NEVER_THE_ASKER: ReadonlySet<string> = COUNTERPARTY_ARGS;

/**
 * What to call each party when asking a person which one they meant — READ FROM THE ONTOLOGY.
 *
 * This was a hand-kept map duplicating `PartyRoleV1.word`, and a duplicate of a modelled fact is a
 * duplicate that drifts: the same argument could be called one thing in the question a person is asked
 * and another in the record that answers it. `workspace` has no declared role and falls back to its own
 * name, which is honest — an undeclared party has no agreed word for it.
 */
const partyWord = (arg: string): string => PARTY_ROLES.find((r) => r.arg === arg)?.word ?? arg;

/**
 * WHAT KIND OF AGENT EACH PARTY IS — now read from the ONTOLOGY (spec 355).
 *
 * "Send money to nathan" means nathan.treasury and "send nathan a message" means nathan.me. Same word,
 * two agents, and the difference is in the CAPABILITY. That was a table here; it is a projection of
 * `@agenticprimitives/ontology` `PARTY_ROLES` now, where each party says which ontology CLASSES it may be
 * (`ap:Treasury`, `ap:PersonAgent`) and which RELATIONSHIP to follow when the agent named is not one of
 * them (`ap:charters` — from alice to the treasury chartered under her).
 *
 * The table did not merely duplicate the ontology, it disagreed with it: it looked for a treasury whose
 * NAME matched its owner's, which the ontology never claimed and the estate does not do, so paying
 * "alice" dead-ended because alice2.treasury does not look like "alice". `check:ontology-bindings` now
 * fails the build if a binding names a term the T-box does not declare.
 */
/**
 * The organization a "members of …" sentence names — the WORDS only, never an agent. "how many members
 * are in missio nexus organization" → "missio nexus"; a sentence that names none → undefined (the tool
 * then means the agent being asked). Generic tail nouns are stripped because the private tier matches a
 * display name whole ("Missio Nexus"), and "missio nexus organization" is not that name. Resolution is
 * the resolver's (`resolveStepArgs` → `resolveParty`): this never looks anything up.
 */
/**
 * "What teams am I part of / which organizations do I belong to / do I have a treasury" → the affiliations
 * read, with the TYPE word the sentence used mapped onto the ontology's suffix vocabulary. A sentence that
 * asks about being part of something with no type word lists everything. Null when the sentence is not
 * about the asker's own links (e.g. "who are the members of X" — a roster, which is a different read).
 */
export function affiliationAskOf(goal: string): { type: string | null } | null {
  const g = goal.toLowerCase().trim();
  const words: Record<string, string> = {
    team: 'team', teams: 'team', org: 'org', orgs: 'org', organization: 'org', organizations: 'org', organisation: 'org', organisations: 'org',
    circle: 'circle', circles: 'circle', church: 'church', churches: 'church', treasury: 'treasury', treasuries: 'treasury',
    workspace: 'workspace', workspaces: 'workspace', service: 'svc', services: 'svc', registry: 'registry', registries: 'registry',
  };
  const typeWord = Object.keys(words).find((w) => new RegExp(`\\b${w}\\b`).test(g));
  const mine = /\b(am i|do i|i am|i'm|i belong|my)\b/.test(g);
  const about = /\b(part of|member of|belong|on|in|have|hold|do i)\b/.test(g);
  const asksList = /^(what|which|list|show|do i|am i)\b/.test(g);
  if (!mine || !about || !asksList) return null;
  if (/\bmembers?\b.*\b(of|in|on)\b/.test(g)) return null; // a roster question, not "what am I in"
  // NO TYPE WORD ⇒ only the "part of / belong to / member of" phrasing is this question. "What records do
  // I hold" opens the same way and is a records question — the live scenario set caught this shortcut
  // taking it (spec 367 W2), which is what the set is for. A shortcut that grows is a planner in disguise.
  if (!typeWord && !/\b(part of|belong to|member of|belong)\b/.test(g)) return null;
  return { type: typeWord ? words[typeWord]! : null };
}

/**
 * The single-payment sentence: the payee's WORDS and the amount as said. "send 10 usdc to David" →
 * { payee: 'David', usdc: '10' }; "pay david 10 usdc" → the same; "send 10 usdc" → no payee (asked for).
 * Never resolves anything and never invents a value: an absent part is omitted, and the capability asks.
 */
/**
 * THE REASON IS NOT THE PAYEE. "Send bob 0.2 USDC to cover poker night last night" names one payee and one
 * reason; the clause after `to cover` / `for` / `because` / `toward` is why, and it travels as `memo` —
 * onto the receipt, never into a party. Before this, "cover poker night last night" was looked up as an
 * agent, nothing answered to it, and the person was asked which agent they meant by their own reason.
 */
export function splitPurpose(sentence: string): { body: string; memo?: string } {
  const m = sentence.match(/\s+(?:(?:to|in order to)\s+(?:cover|pay for|pay back|reimburse|settle|help with|chip in for|contribute to)|for|because|since|as (?:a )?(?:reimbursement|thanks|payment) for|towards?|regarding|re:)\s+(.+?)\s*[.!?]*$/i);
  if (!m || m.index === undefined) return { body: sentence };
  // "for" is also how a person says WHO — "send 5 usdc for bob" is rare but "pay for bob's ticket" is a
  // reason; the marker `for` is taken as a reason only when what follows is not a lone name.
  const memo = m[1]!.trim();
  if (/^for$/i.test(sentence.slice(m.index).trim().split(/\s+/)[0] ?? '') && /^[a-z0-9.@-]+$/i.test(memo)) return { body: sentence };
  return { body: sentence.slice(0, m.index).trim(), memo };
}

export function paymentAskOf(goal: string): { payee?: string; usdc?: string; memo?: string } | null {
  const { body: g, memo } = splitPurpose(goal.trim());
  if (!/\b(send|pay|transfer)\b/i.test(g)) return null;
  if (/\b(each|every|all)\b[\s\S]{0,40}\bmembers?\b/i.test(g)) return null; // the fan-out shape
  if (!/\busdc\b/i.test(g)) return null; // only money we know the unit of; "send a message" is not this
  const amount = g.match(/(\d+(?:\.\d+)?)\s*usdc/i)?.[1];
  let rest = g.replace(/(\d+(?:\.\d+)?)\s*usdc/i, ' ').replace(/\b(send|pay|transfer)\b/i, ' ').replace(/\bfrom\b[\s\S]*$/i, ' ');
  const to = rest.match(/\bto\s+(.+?)\s*$/i)?.[1];
  const payee = (to ?? rest).replace(/^(to|please|now)\s+/i, '').replace(/[.!?]+$/, '').trim();
  return { ...(payee ? { payee } : {}), ...(amount ? { usdc: amount } : {}), ...(memo ? { memo } : {}) };
}

/**
 * Spec 367 W2 — the few-shot block rendered from the playbook's contracts. One line per example, the
 * positive ones as the exact tool call, the negative ones as what NOT to choose and why. Deterministic
 * (same definition ⇒ same block), so the receipt's playbook digest covers what the planner was taught.
 */
export function utteranceExamples(tools: ReadonlyArray<{ id: string; utterances?: ReadonlyArray<{ says: string; args?: Record<string, string>; isNot?: string }> }>): string {
  const lines: string[] = [];
  for (const t of tools) {
    for (const u of t.utterances ?? []) {
      if (u.isNot !== undefined) lines.push(`- "${u.says}" → NOT ${t.id}: ${u.isNot}`);
      else lines.push(`- "${u.says}" → ${t.id} ${JSON.stringify(u.args ?? {})}`);
    }
  }
  if (!lines.length) return '';
  return `\n\nEXAMPLES FROM THE PLAYBOOK (the domain author's own; follow their shape exactly — arguments are the person's WORDS, never addresses):\n${lines.join('\n')}`;
}

/** Selection kinds a screen declares → the typed-name suffix a party role admits (ADR-0061). */
const KIND_SUFFIX: Record<string, string> = { person: 'me', me: 'me', org: 'org', organization: 'org', team: 'team', workspace: 'workspace', treasury: 'treasury', 'person-treasury': 'treasury', 'org-treasury': 'treasury', service: 'svc', svc: 'svc', circle: 'circle', church: 'church' };

export function orgPhraseOf(goal: string): string | undefined {
  const m = goal.match(/\bmembers?\b[^?]*?\b(?:of|in|on)\b\s+(?:the\s+)?([^?.,;!]+?)\s*[?.!]*$/i);
  if (!m) return undefined;
  const phrase = (m[1] ?? '')
    // "… of missio nexus 1 usdc" (the fan-out sentence) — the amount is the payment's, not the name's.
    .replace(/\s+\d+(?:\.\d+)?\s*[a-z]*$/i, '')
    .replace(/\s+(organization|organisation|org|team|workspace|circle|church|treasury|group)$/i, '')
    .trim();
  // A pronoun or a bare generic noun names nothing — "members of my org" means the agent being asked.
  return phrase && !/^(it|this|that|there|here|my|our|your|their|the|org|organization|team|workspace|circle|church)$/i.test(phrase) ? phrase : undefined;
}

export function partyTypesFor(capabilityId: string, arg: string): readonly string[] | undefined {
  const suffixes = suffixesFor(partyRole(capabilityId, arg));
  return suffixes.length ? suffixes : undefined;
}

/**
 * The step's args as the ENFORCERS will need them.
 *
 * A requirement is built from what the planner wrote, and the planner writes what the person said:
 * `payee: "alice2.treasury"`, `asset: "usdc"`. Both are correct English and neither can be encoded — the
 * caveat wants twenty bytes. Resolving inside the invoker is too late: the person is asked to grant an
 * authority whose limits name a string, and minting it throws. So the words become addresses HERE, once,
 * before anything is shown or signed.
 */
export async function resolveStepArgs(
  args: Record<string, unknown>,
  env: HarnessEnv,
  lookups: PartyLookups,
  where?: {
    stepRef: string; toolId: string; capabilityId?: string; authorityArg?: string; subject?: string; required?: string[];
    /** Spec 363 W5 — the DECISION POINTS this step's capability consults, from its contract (or the
     *  built-in declaration). A point not named here is not consulted: the question is asked. */
    consults?: readonly string[];
    /**
     * THE BASE-UNIT FIGURE IN THESE ARGS WAS COMPUTED BY US, not written by a planner.
     *
     * True for a SCREEN's supplied plan (the form computed 20000000 and knows it) and for the
     * re-normalisation this function does over args the loop already normalised. False — the default —
     * for anything a planner wrote, which is why `amount: "20"` meaning twenty dollars is refused
     * rather than spent.
     */
    computedUnits?: boolean;
    /** Spec 367 §7 — the validated application context: the agent addressed and the realm kind the surface
     *  declared. A CONTEXT-side party the sentence did not name is filled from these — deterministically,
     *  from the party role's declared classes — never from "the first one available". */
    addressee?: string;
    realmKind?: string;
    /** Spec 361 I6 — the on-screen selection the surface declared (entity + its kind). */
    selection?: { entity?: string; kind?: string; label?: string };
  },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args };

  // ── A PLACEHOLDER IS AN OMISSION, IN EVERY ARGUMENT ──────────────────────────────────────────────
  //
  // Told not to invent values, a planner writes `payer: "<UNKNOWN>"` instead of leaving the argument
  // out — and the resolver dutifully went looking for an agent by that name: *"I could not find
  // <UNKNOWN>. Which agent do you mean? — nothing in the agents you are linked to … answers to
  // <UNKNOWN>"*. The person is being asked to fix our plumbing, and the branch that would have offered
  // them their own treasuries never ran, because the argument LOOKED answered.
  //
  // Swept ONCE, at the top, for every argument rather than only the numeric ones that had this guard
  // before: an omission is an omission whatever it was going to name, and every question below reads
  // better against an argument that is honestly absent.
  const PLACEHOLDER = /^<.*>$|^(unknown|tbd|n\/a|none|null|undefined|todo|xxx+)$/i;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && PLACEHOLDER.test(v.trim())) delete out[k];
  }

  // ── EVERY DECLARED VALUE, READ ONCE, BY ITS TYPE (spec 363 W2) ───────────────────────────────────
  //
  // The parsing that used to live here — a NUMERIC set, a currency-word regex, an email check in one
  // invoker, a `wants` allowlist in another — is now ONE reader per type in the ontology package, bound
  // to the argument by `ARG_TYPES`. A person's phrasing is understood identically wherever they typed it,
  // and an unreadable value comes back with the words that could not be read instead of being dropped.
  const unreadable = new Map<string, { said: string; because: string; word: string; hint?: string }>();
  for (const b of argTypesFor(where?.capabilityId ?? where?.toolId ?? '')) {
    if (out[b.arg] === undefined || out[b.arg] === '') continue;
    const read = readValue(b.type, out[b.arg], { ...(env.MOCK_USDC ? { assets: [env.MOCK_USDC.toLowerCase()] } : {}) });
    if (read.ok) { out[b.arg] = read.value; continue; }
    // A placeholder reports no `said`: it is the planner's, and quoting `<UNKNOWN>` back at somebody who
    // typed "a tenner" tells them about our plumbing and nothing about their answer.
    delete out[b.arg];
    if (read.said) unreadable.set(b.arg, { said: read.said, because: read.because, word: b.word, ...(b.hint ? { hint: b.hint } : {}) });
  }
  // WHAT THEY WROTE THAT COULD NOT BE READ, asked once more WITH the reason — never the same question
  // again as though nothing had been typed.
  for (const [arg, u] of unreadable) {
    throw new InputRequired({
      kind: 'data', stepRef: where?.stepRef ?? 'pending', toolId: where?.toolId ?? '',
      prompt: `“${u.said}” — ${u.because}. What should ${u.word} be?`,
      fields: [{ name: arg, label: u.word, type: 'text', required: true, ...(u.hint ? { hint: u.hint } : {}) }],
    });
  }

  // ── A UNIT THE PLANNER COMPUTED IS NOT A UNIT ────────────────────────────────────────────────────
  //
  // THE INCIDENT: asked to send 20 USDC, the planner wrote `amount: "20"` into the base-unit field —
  // twenty smallest units, two hundred-thousandths of a dollar. Every gate passed (it is well under any
  // ceiling), the transfer settled, and the receipt honestly read "0.00002 USDC". Nothing else in the
  // system could have caught it, because nothing else knew what the person had said.
  //
  // So base units are no longer an argument a planner can write: the field is gone from its schema, and
  // a value that arrives in it anyway is treated as a figure of UNKNOWN unit — named back to the person
  // rather than converted by us. A SUPPLIED PLAN is different: a screen that computed 20000000 knows
  // exactly what it means, and that is the one caller allowed to say so.
  if (out.amount !== undefined && !where?.computedUnits) {
    const said = String(out.amount).trim();
    delete out.amount;
    if (out.usdc === undefined && said) {
      throw new InputRequired({
        kind: 'data', stepRef: where?.stepRef ?? 'pending', toolId: where?.toolId ?? '',
        prompt: `How much should I send? I read “${said}” but not what it is in.`,
        fields: [{ name: 'usdc', label: 'How much', type: 'text', required: true, hint: `in whole USDC — type ${said} if that is what you meant` }],
      });
    }
  }

  // ONE UNIT, ONCE, AND EARLY. The planner may say `usdc: "3"` or `amount: "3000000"` — both honest
  // readings of "3 usdc" — and everything downstream must see exactly one. It ran at the END of this
  // function until the choice prompt needed to know what the act COSTS: a person asking for 20 was
  // offered accounts holding 7, because the list was built before anything had read the figure.
  // Only a figure we can actually READ is converted. An unreadable answer ("a tenner") is left where it
  // is, so the question below can name it back — converting here threw a bare error instead, which is
  // the same silent-refusal shape in different clothes.
  if (out.usdc !== undefined && out.amount === undefined && /^\d+(\.\d+)?$/.test(String(out.usdc).trim())) {
    out.amount = fundingAmount(out).toString();
    delete out.usdc;
  }

  // ── WHOSE AGENT ACTS ─────────────────────────────────────────────────────────────────────────────
  // The acting party is the one whose authority the step spends, and it is the argument most likely to be
  // silently wrong: it is rarely spoken aloud ("send alice 20 USDC" names neither the sender nor the
  // payer), so it gets defaulted, and a default nobody checks becomes an authority request naming the
  // wrong agent.
  //
  // Two failures this closes, both from one omission — nobody had ever set it:
  //   · messaging declares `authorityArg: 'sender'` and no `sender` argument existed, so the delegator
  //     fell through to the RESOURCE and Nathan was asked to authorize a message AS ALICE, its recipient.
  //   · a payment took the realm the person was standing in — their person SA — as the payer, and died on
  //     a balance check against an account that holds no money and never could.
  if (where?.authorityArg && where.subject) {
    const arg = where.authorityArg;
    const current = String(out[arg] ?? '').trim();
    // Unspoken ⇒ the agent ADDRESSED when the realm's class admits it (a person standing in an organization
    // means that organization — "invite carol" at missio-nexus.org acts as the org), else the person asking.
    // Acting as yourself is the only reading of "send alice a message"; acting as the room you stand in is
    // the only reading of "invite carol" said inside it. Declared classes decide, never proximity.
    if (!current) {
      const realmSuffix = where.realmKind ? ({ person: 'me', org: 'org', service: 'svc' } as Record<string, string>)[where.realmKind] : undefined;
      const typesHere = partyTypesFor(where.capabilityId ?? where.toolId, arg) ?? [];
      if (where.addressee && realmSuffix && typesHere.includes(realmSuffix) && where.addressee.toLowerCase() !== where.subject.toLowerCase()) {
        out[arg] = where.addressee.toLowerCase();
        lookups.onResolved?.({ arg, raw: partyWord(arg), agent: where.addressee.toLowerCase(), hint: 'the organization you are standing in', via: 'context' });
      } else {
        out[arg] = where.subject.toLowerCase();
      }
    }
    const types = partyTypesFor(where.capabilityId ?? where.toolId, arg);
    const isAsker = String(out[arg] ?? '').toLowerCase() === where.subject.toLowerCase();
    // A person is not a treasury. When the capability acts on a kind the asker's own SA is not, find the
    // one of THEIR agents that is — the typed suffix already says which. Never a widening: their tree only.
    if (types?.length && isAsker && !types.includes('me')) {
      let found = false;
      for (const type of types) {
        const mine = await ownAgentsOfType(where.subject, type, lookups);
        if (mine.length === 1) {
          const c = mine[0]!;
          lookups.onResolved?.({ arg, raw: partyWord(arg), agent: c.agent, label: c.label, hint: candidateHint(c) });
          out[arg] = c.agent;
          found = true;
          break;
        }
        if (mine.length > 1) {
          // WHAT THE ACT COSTS, when the figure is already known — so the list can say which accounts can
          // actually do it. Offering an account that will revert as an equal choice is offering a wrong
          // answer politely, and the person asking for 20 was shown six accounts holding less.
          const needs = /^\d+$/.test(String(out.amount ?? ''))
            ? { amount: BigInt(String(out.amount)), display: `${(Number(out.amount) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC` }
            : undefined;

          // ── THE DECISION PLANE (spec 363 §2) ──
          //
          // The person may have said which account they pay from — `ap:primaryPayer`, a mark on the
          // public charteredUnder edge. When exactly one carries it, that IS the answer and the question
          // is not worth asking; the rule says so, and the reply CITES it, because a decision that
          // cannot say why is indistinguishable from a guess.
          //
          // A marked account that cannot cover the act does NOT decide: paying from it would fail, and
          // using it silently would turn a preference into a wrong answer. The question comes back with
          // what is known, which is the fail-closed default this table always ends in.
          if (where.consults?.includes(PAYMENT_SOURCE_ACCOUNT.id) && arg === 'payer') {
            const chosen = decide(PAYMENT_SOURCE_ACCOUNT, mine.map((c) => ({ value: c, satisfies: c.roles ?? [] })));
            if (chosen) {
              const held = lookups.valueHeld ? await lookups.valueHeld(chosen.value.agent).catch(() => null) : null;
              const covers = !needs || !held || held.amount >= needs.amount;
              if (covers) {
                lookups.onResolved?.({
                  arg, raw: partyWord(arg), agent: chosen.value.agent, label: chosen.value.label,
                  hint: candidateHint(chosen.value), because: chosen.because, ruleId: chosen.ruleId,
                  pointId: PAYMENT_SOURCE_ACCOUNT.id,
                });
                out[arg] = chosen.value.agent;
                found = true;
                break;
              }
            }
          }

          // Two of yours could pay — a person may hold several treasuries, and creating one in a sentence
          // makes that ordinary. Which one is yours to say, not ours to rank.
          const choices = await choicesFor(mine, lookups, needs);
          // NOT ONE OF THEM CAN DO IT. Asking someone to choose between accounts that will all revert is
          // asking them to pick which failure they would like; the useful answer is the shortfall and
          // what would fix it. The list stays — they may be about to fund one, and hiding a person's own
          // accounts to make a point is worse — but the question stops pretending it is a choice.
          const noneCover = !!needs && choices.length > 0 && choices.every((c) => /not enough for/.test(c.hint));
          const fullest = noneCover ? choices[0]!.hint.split(' · ')[0]!.split(' — ')[0] : '';
          throw new InputRequired({
            kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
            prompt: noneCover
              ? `None of your ${type === 'treasury' ? 'treasuries' : `${type}s`} holds ${needs!.display} — the fullest has ${fullest}. Fund one first, or pick it anyway if you are about to.`
              : needs
                ? `Which of your ${type === 'treasury' ? 'treasuries' : `${type}s`} should pay the ${needs.display}?`
                : `Which of your ${type === 'treasury' ? 'treasuries' : `${type}s`} should be ${partyWord(arg)}?`,
            fields: [{
              name: arg, label: partyWord(arg), type: 'choice', required: true,
              // WHAT EACH ONE HOLDS, and whether it can cover this act — the ones that can, first. The
              // balance is evidence, never the answer: the question is still asked, because an account
              // that cannot pay today may be the one they mean to fund.
              choices,
              // One of theirs may not be in their tree yet; a full name is always a valid answer.
              allowOther: true,
            }],
          });
        }
      }
      // NONE OF THEIRS IS OF THE RIGHT KIND — and the person SA it was defaulted to is NOT a fallback.
      // The capability says a payer is a treasury or an organization precisely because a person agent is
      // neither, and leaving it in place is how a payment came out of someone's PERSON agent while their
      // seven treasuries sat untouched. It succeeded, which was the worst part: the money left an account
      // nobody meant to spend from and the run said "done".
      if (!found) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `You have no ${types[0]} to be ${partyWord(arg)}. Which agent should be?`,
          fields: [{
            name: arg, label: partyWord(arg), type: 'text', required: true,
            hint: `give a name (yours2.${types[0]}) or an address — a ${types[0]} is what holds what would be spent`,
          }],
        });
      }
    }
  }
  // ── A PARTY NAMED BY EMAIL (spec 315/321, one flow) ─────────────────────────────────────────────
  //
  // "Invite carol@example.org to missio nexus": the role admits an email (`alsoAccepts`), the person has no
  // agent yet, and the agent their Home WILL deploy for that email is deterministic — so it is bound in
  // the email's place and the email is kept beside it, for the invitation to reach them. Nothing is
  // guessed: a role that does not admit email leaves the value for the ordinary resolver to ask about.
  if (where && lookups.predictAgentForEmail && lookups.session) {
    for (const key of PARTY_ARGS) {
      const raw = String(out[key] ?? '').trim().toLowerCase();
      if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue;
      const role = partyRole(where.capabilityId ?? where.toolId, key);
      if (!role?.alsoAccepts?.includes('email')) continue;
      const orgArg = String(out.org ?? where.addressee ?? '').toLowerCase();
      const predicted = /^0x[0-9a-f]{40}$/.test(orgArg) ? await lookups.predictAgentForEmail({ org: orgArg as Address, email: raw, session: lookups.session }).catch(() => null) : null;
      if (!predicted) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `I could not work out the agent ${raw} will get. Which organization is this for?`,
          fields: [{ name: 'org', label: 'the organization', type: 'text', required: true, hint: 'the organization inviting them (its name or address)' }],
        });
      }
      out[key] = predicted.toLowerCase();
      out[`${key}Email`] = raw;
      lookups.onResolved?.({ arg: key, raw, agent: predicted.toLowerCase(), label: raw, hint: 'the agent their Home will hold for this email — they join by the link' });
    }
  }
  // ── THE REALM YOU STAND IN SUPPLIES A CONTEXT PARTY (spec 367 §7) ──────────────────────────────
  //
  // "Create an organization called Riverside Fellowship" names no parent; a person standing in their own
  // realm means THEIR realm, and a screen that already selected an organization means THAT one. The
  // sentence path got this from the planner reading the prompt's context; a supplied command left it
  // empty and was asked — the parity gate caught the difference. Now both are filled the same way: a
  // `context`-side party role whose declared classes admit the realm's class takes the addressee, and
  // the binding says it came from context. Nothing else is guessed: a realm whose class the role does not
  // admit fills nothing, and the person is asked.
  if (where && (where.selection?.entity || (where.addressee && where.realmKind))) {
    // TWO SOURCES OF VALIDATED CONTEXT, most specific first: the entity SELECTED on the screen (spec 361
    // I6 — a member on the roster, a team, a treasury), then the realm the person stands in. A selection is
    // a reference the app checked before it declared it; it is never a sentence the model wrote.
    const realmSuffix = where.realmKind ? ({ person: 'me', org: 'org', service: 'svc' } as Record<string, string>)[where.realmKind] : undefined;
    const sel = where.selection?.entity && /^0x[0-9a-f]{40}$/i.test(where.selection.entity) ? where.selection : undefined;
    const selSuffix = sel?.kind ? ((KIND_SUFFIX as Record<string, string>)[sel.kind.toLowerCase()] ?? sel.kind.toLowerCase()) : undefined;
    const candidates: Array<{ agent: string; suffix: string; hint: string; side: readonly string[] }> = [
      // A selected entity may fill a CONTEXT party ("charter a team under it") or a COUNTERPARTY ("invite
      // her") — the person pointed at it. The realm fills CONTEXT parties only: the room you stand in is
      // never the one you are messaging or inviting.
      ...(sel && selSuffix ? [{ agent: sel.entity!.toLowerCase(), suffix: selSuffix, hint: `the ${sel.label ?? sel.kind ?? 'one'} you have selected`, side: ['context', 'counterparty'] as const }] : []),
      ...(where.addressee && realmSuffix ? [{ agent: where.addressee.toLowerCase(), suffix: realmSuffix, hint: 'the realm you are standing in', side: ['context'] as const }] : []),
    ];
    for (const role of PARTY_ROLES) {
      if (role.capability !== (where.capabilityId ?? where.toolId)) continue;
      if (String(out[role.arg] ?? '').trim()) continue;
      const admits = role.requires.map((iri) => SUFFIX_FOR_CLASS[iri]).filter(Boolean);
      const hit = candidates.find((c) => c.side.includes(role.side) && admits.includes(c.suffix) && (!where.subject || c.agent !== where.subject.toLowerCase() || role.side === 'context'));
      if (!hit) continue;
      out[role.arg] = hit.agent;
      lookups.onResolved?.({ arg: role.arg, raw: partyWord(role.arg), agent: hit.agent, hint: hit.hint, via: 'context' });
    }
  }
  for (const key of PARTY_ARGS) {
    const raw = String(out[key] ?? '').trim();
    // NEVER THE ASKER — checked BEFORE the address short-circuit. A planner given the asker's address in
    // its context wrote it as the INVITEE of "invite her", and the guard below only ever saw names, so the
    // person was about to be asked to authorize inviting themselves. An address is not exempt from the
    // rule; it is the form the mistake most often takes. When the screen has SELECTED someone the role
    // admits (spec 361 I6), that selection is the answer — "her" is the member they clicked.
    if (where && NEVER_THE_ASKER.has(key) && where.subject && raw.toLowerCase() === where.subject.toLowerCase()) {
      const sel = where.selection?.entity && /^0x[0-9a-f]{40}$/i.test(where.selection.entity) ? where.selection : undefined;
      const selSuffix = sel?.kind ? ((KIND_SUFFIX as Record<string, string>)[sel.kind.toLowerCase()] ?? sel.kind.toLowerCase()) : undefined;
      const admits = partyTypesFor(where.capabilityId ?? where.toolId, key) ?? [];
      if (sel && selSuffix && admits.includes(selSuffix) && sel.entity!.toLowerCase() !== where.subject.toLowerCase()) {
        out[key] = sel.entity!.toLowerCase();
        lookups.onResolved?.({ arg: key, raw: partyWord(key), agent: sel.entity!.toLowerCase(), label: sel.label ?? sel.entity, hint: `the ${sel.label ?? 'one'} you have selected`, via: 'context' });
        continue;
      }
      throw new InputRequired({
        kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
        prompt: `That would be you. Who is ${partyWord(key)}?`,
        fields: [{ name: key, label: partyWord(key), type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
      });
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      // Nothing to resolve — and still worth reporting. An address here is usually the answer a person
      // just PICKED from a list of four Nathans; showing them a bare 0x… on the next card asks them to
      // re-verify a choice they made a moment ago against a string that tells them nothing.
      lookups.onResolved?.({ arg: key, raw, agent: raw.toLowerCase() });
      continue;
    }
    // A party the TOOL requires and the sentence did not name is a QUESTION. Skipping it because the field
    // was empty let "send a direct message to zzz-nobody-here" sail past resolution into an authority
    // request for a recipient that could not exist — failing at the last possible moment, after the person
    // had granted. An OPTIONAL party (a funder that defaults to the asker) still skips.
    if (!raw && !(where && (where.required ?? []).includes(key))) continue;
    if (where) {
      // Inside a run: resolve properly, and ASK when the words name several agents or none.
      // A party that arrived as the asker's own address was not resolved from the sentence — it was
      // borrowed from the context. Ask before that becomes an authority request naming the wrong person.
      if (NEVER_THE_ASKER.has(key) && where.subject && raw.toLowerCase() === where.subject.toLowerCase()) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `That would be you. Who is ${partyWord(key)}?`,
          fields: [{ name: key, label: partyWord(key), type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
        });
      }
      out[key] = await resolveParty(raw, lookups, {
        stepRef: where.stepRef, toolId: where.toolId, argName: key, what: partyWord(key),
        // Which questions this capability lets the substrate answer for the person (spec 363 W5).
        ...(where.consults?.length ? { consults: where.consults } : {}),
        // WHOSE tier: the person asking. Without a subject the private providers are skipped and the
        // answer is an honest "unknown" — never a widening to a public search.
        ...(where.subject ? { subject: where.subject } : {}),
        // WHAT KIND of agent this argument is, so "nathan" means his treasury when money moves and him
        // when a message is sent. Undeclared ⇒ no narrowing: a capability that has not said what it acts
        // on gets every candidate and, if there are several, a question.
        ...(() => { const t = partyTypesFor(where.capabilityId ?? where.toolId, key); return t ? { types: t } : {}; })(),
        // What the ask was FOR, so a request raised from this dead end can carry it and be finished in
        // one press later. EITHER UNIT: the planner writes `usdc: "3"` or `amount: "3000000"` and both
        // are honest readings of "3 usdc" — reading only the first meant the amount was dropped exactly
        // when the sentence had named one.
        ...(() => {
          const whole = String(out.usdc ?? '').trim();
          if (/^\d+(\.\d+)?$/.test(whole)) return { pendingAmount: whole };
          const smallest = String(out.amount ?? '').trim();
          if (!/^\d+$/.test(smallest)) return {};
          const n = Number(smallest) / 1e6;
          return Number.isFinite(n) && n > 0 ? { pendingAmount: String(n) } : {};
        })(),
      });
      continue;
    }
    // Outside a run (building a requirement to display): resolve what is certain, leave the rest as
    // written — there is nobody to ask here, and a silent guess is the thing to avoid.
    const resolved = raw.includes('.') && lookups.resolveName ? await lookups.resolveName(raw.toLowerCase()).catch(() => null) : null;
    if (resolved) out[key] = resolved.toLowerCase();
  }
  // ANYTHING THE TOOL DECLARED AND THE SENTENCE DID NOT GIVE IS A QUESTION (§3.5).
  //
  // Party arguments are asked for above. Everything else was nobody's job, so "send money to alice" —
  // which names no figure — reached the mandate handler and died there on "args.amount is required to
  // bound the authority it needs": true, unactionable, and after the person had already typed. The loop
  // can just ask. `amount` and `usdc` are the same requirement in two units, so either satisfies it.
  // BOTH DIRECTIONS. The unit reader above turns `usdc` into base-unit `amount` and deletes `usdc`, so a
  // contract that requires `usdc` (the person's unit) must be satisfied by `amount` (ours) — one way only,
  // and "send bob.me 1.2 usdc" asked for the usdc it had just been given, the moment the payee resolved
  // without a question of its own (caught live 2026-09-07).
  const ALTERNATIVES: Record<string, readonly string[]> = { amount: ['amount', 'usdc'], usdc: ['usdc', 'amount'] };
  const WORD_FOR_ARG: Record<string, { label: string; hint: string }> = {
    amount: { label: 'How much', hint: 'in whole USDC, e.g. 10 or 12.50' },
    message: { label: 'Message', hint: 'what to say' },
    label: { label: 'Name', hint: 'lowercase letters, digits and hyphens' },
  };
  if (where?.required?.length) {
    // A PLACEHOLDER IS NOT AN ANSWER — and by here it cannot BE one: the placeholder sweep at the top
    // deleted it, and a value of a declared type has already been read by its own reader. What is left
    // for this check is the simple question it should always have been: was anything given at all.
    const given = (k: string): boolean => {
      const v = String(out[k] ?? '').trim();
      return !!v && !/^<.*>$|^(unknown|tbd|n\/a|null|undefined)$/i.test(v);
    };
    const missing = where.required.filter((k) => !PARTY_ARGS.includes(k)
      && (ALTERNATIVES[k] ?? [k]).every((alt) => !given(alt)));
    if (missing.length) {
      const fields: InputFieldV1[] = missing.map((k) => ({
        name: (ALTERNATIVES[k]?.[1] ?? k),
        label: WORD_FOR_ARG[k]?.label ?? k,
        type: 'text' as const, required: true,
        ...(WORD_FOR_ARG[k]?.hint ? { hint: WORD_FOR_ARG[k]!.hint } : {}),
      }));
      throw new InputRequired({
        kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
        prompt: missing.length === 1 && missing[0] === 'amount' ? 'How much should I send?' : 'I need a little more to do that.',
        fields,
      });
    }
  }


  // ── WHOSE AGENT ACTS ─────────────────────────────────────────────────────────────────────────────
  // The acting party is the one whose authority the step spends, and it is the argument most likely to be
  // silently wrong: it is rarely spoken aloud ("send alice 20 USDC" names neither the sender nor the
  // payer), so it gets defaulted, and a default nobody checks becomes an authority request naming the
  // wrong agent.
  //
  // Two failures this closes, both from one omission — nobody had ever set it:
  //   · messaging declares `authorityArg: 'sender'` and no `sender` argument existed, so the delegator
  //     fell through to the RESOURCE and Nathan was asked to authorize a message AS ALICE, its recipient.
  //   · a payment took the realm the person was standing in — their person SA — as the payer, and died on
  //     a balance check against an account that holds no money and never could.
  if (where?.authorityArg && where.subject) {
    const arg = where.authorityArg;
    const current = String(out[arg] ?? '').trim();
    // Unspoken ⇒ the person asking. Acting as yourself is the only reading of "send alice a message".
    if (!current) out[arg] = where.subject.toLowerCase();
    const types = partyTypesFor(where.capabilityId ?? where.toolId, arg);
    const isAsker = String(out[arg] ?? '').toLowerCase() === where.subject.toLowerCase();
    // A person is not a treasury. When the capability acts on a kind the asker's own SA is not, find the
    // one of THEIR agents that is — the typed suffix already says which. Never a widening: their tree only.
    if (types?.length && isAsker && !types.includes('me')) {
      let found = false;
      for (const type of types) {
        const mine = await ownAgentsOfType(where.subject, type, lookups);
        if (mine.length === 1) {
          const c = mine[0]!;
          lookups.onResolved?.({ arg, raw: partyWord(arg), agent: c.agent, label: c.label, hint: candidateHint(c) });
          out[arg] = c.agent;
          found = true;
          break;
        }
        if (mine.length > 1) {
          // WHAT THE ACT COSTS, when the figure is already known — so the list can say which accounts can
          // actually do it. Offering an account that will revert as an equal choice is offering a wrong
          // answer politely, and the person asking for 20 was shown six accounts holding less.
          const needs = /^\d+$/.test(String(out.amount ?? ''))
            ? { amount: BigInt(String(out.amount)), display: `${(Number(out.amount) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC` }
            : undefined;

          // ── THE DECISION PLANE (spec 363 §2) ──
          //
          // The person may have said which account they pay from — `ap:primaryPayer`, a mark on the
          // public charteredUnder edge. When exactly one carries it, that IS the answer and the question
          // is not worth asking; the rule says so, and the reply CITES it, because a decision that
          // cannot say why is indistinguishable from a guess.
          //
          // A marked account that cannot cover the act does NOT decide: paying from it would fail, and
          // using it silently would turn a preference into a wrong answer. The question comes back with
          // what is known, which is the fail-closed default this table always ends in.
          if (where.capabilityId === 'treasury.payment.execute' && arg === 'payer') {
            const chosen = decide(PAYMENT_SOURCE_ACCOUNT, mine.map((c) => ({ value: c, satisfies: c.roles ?? [] })));
            if (chosen) {
              const held = lookups.valueHeld ? await lookups.valueHeld(chosen.value.agent).catch(() => null) : null;
              const covers = !needs || !held || held.amount >= needs.amount;
              if (covers) {
                lookups.onResolved?.({
                  arg, raw: partyWord(arg), agent: chosen.value.agent, label: chosen.value.label,
                  hint: candidateHint(chosen.value), because: chosen.because, ruleId: chosen.ruleId,
                });
                out[arg] = chosen.value.agent;
                found = true;
                break;
              }
            }
          }

          // Two of yours could pay — a person may hold several treasuries, and creating one in a sentence
          // makes that ordinary. Which one is yours to say, not ours to rank.
          const choices = await choicesFor(mine, lookups, needs);
          // NOT ONE OF THEM CAN DO IT. Asking someone to choose between accounts that will all revert is
          // asking them to pick which failure they would like; the useful answer is the shortfall and
          // what would fix it. The list stays — they may be about to fund one, and hiding a person's own
          // accounts to make a point is worse — but the question stops pretending it is a choice.
          const noneCover = !!needs && choices.length > 0 && choices.every((c) => /not enough for/.test(c.hint));
          const fullest = noneCover ? choices[0]!.hint.split(' · ')[0]!.split(' — ')[0] : '';
          throw new InputRequired({
            kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
            prompt: noneCover
              ? `None of your ${type === 'treasury' ? 'treasuries' : `${type}s`} holds ${needs!.display} — the fullest has ${fullest}. Fund one first, or pick it anyway if you are about to.`
              : needs
                ? `Which of your ${type === 'treasury' ? 'treasuries' : `${type}s`} should pay the ${needs.display}?`
                : `Which of your ${type === 'treasury' ? 'treasuries' : `${type}s`} should be ${partyWord(arg)}?`,
            fields: [{
              name: arg, label: partyWord(arg), type: 'choice', required: true,
              // WHAT EACH ONE HOLDS, and whether it can cover this act — the ones that can, first. The
              // balance is evidence, never the answer: the question is still asked, because an account
              // that cannot pay today may be the one they mean to fund.
              choices,
              // One of theirs may not be in their tree yet; a full name is always a valid answer.
              allowOther: true,
            }],
          });
        }
      }
      // NONE OF THEIRS IS OF THE RIGHT KIND — and the person SA it was defaulted to is NOT a fallback.
      // The capability says a payer is a treasury or an organization precisely because a person agent is
      // neither, and leaving it in place is how a payment came out of someone's PERSON agent while their
      // seven treasuries sat untouched. It succeeded, which was the worst part: the money left an account
      // nobody meant to spend from and the run said "done".
      if (!found) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `You have no ${types[0]} to be ${partyWord(arg)}. Which agent should be?`,
          fields: [{
            name: arg, label: partyWord(arg), type: 'text', required: true,
            hint: `give a name (yours2.${types[0]}) or an address — a ${types[0]} is what holds what would be spent`,
          }],
        });
      }
    }
  }
  for (const key of PARTY_ARGS) {
    const raw = String(out[key] ?? '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      // Nothing to resolve — and still worth reporting. An address here is usually the answer a person
      // just PICKED from a list of four Nathans; showing them a bare 0x… on the next card asks them to
      // re-verify a choice they made a moment ago against a string that tells them nothing.
      lookups.onResolved?.({ arg: key, raw, agent: raw.toLowerCase() });
      continue;
    }
    // A party the TOOL requires and the sentence did not name is a QUESTION. Skipping it because the field
    // was empty let "send a direct message to zzz-nobody-here" sail past resolution into an authority
    // request for a recipient that could not exist — failing at the last possible moment, after the person
    // had granted. An OPTIONAL party (a funder that defaults to the asker) still skips.
    if (!raw && !(where && (where.required ?? []).includes(key))) continue;
    if (where) {
      // Inside a run: resolve properly, and ASK when the words name several agents or none.
      // A party that arrived as the asker's own address was not resolved from the sentence — it was
      // borrowed from the context. Ask before that becomes an authority request naming the wrong person.
      if (NEVER_THE_ASKER.has(key) && where.subject && raw.toLowerCase() === where.subject.toLowerCase()) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `That would be you. Who is ${partyWord(key)}?`,
          fields: [{ name: key, label: partyWord(key), type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
        });
      }
      out[key] = await resolveParty(raw, lookups, {
        stepRef: where.stepRef, toolId: where.toolId, argName: key, what: partyWord(key),
        // WHOSE tier: the person asking. Without a subject the private providers are skipped and the
        // answer is an honest "unknown" — never a widening to a public search.
        ...(where.subject ? { subject: where.subject } : {}),
        // WHAT KIND of agent this argument is, so "nathan" means his treasury when money moves and him
        // when a message is sent. Undeclared ⇒ no narrowing: a capability that has not said what it acts
        // on gets every candidate and, if there are several, a question.
        ...(() => { const t = partyTypesFor(where.capabilityId ?? where.toolId, key); return t ? { types: t } : {}; })(),
        // What the ask was FOR, so a request raised from this dead end can carry it and be finished in
        // one press later. EITHER UNIT: the planner writes `usdc: "3"` or `amount: "3000000"` and both
        // are honest readings of "3 usdc" — reading only the first meant the amount was dropped exactly
        // when the sentence had named one.
        ...(() => {
          const whole = String(out.usdc ?? '').trim();
          if (/^\d+(\.\d+)?$/.test(whole)) return { pendingAmount: whole };
          const smallest = String(out.amount ?? '').trim();
          if (!/^\d+$/.test(smallest)) return {};
          const n = Number(smallest) / 1e6;
          return Number.isFinite(n) && n > 0 ? { pendingAmount: String(n) } : {};
        })(),
      });
      continue;
    }
    // Outside a run (building a requirement to display): resolve what is certain, leave the rest as
    // written — there is nobody to ask here, and a silent guess is the thing to avoid.
    const resolved = raw.includes('.') && lookups.resolveName ? await lookups.resolveName(raw.toLowerCase()).catch(() => null) : null;
    if (resolved) out[key] = resolved.toLowerCase();
  }

  // ── THE TOKEN IS A DEPLOYMENT FACT, AND THE PLANNER MUST NOT SUPPLY IT ───────────────────────────
  //
  // Asked to send USDC, a model wrote Base Sepolia's token address — recalled from memory, well-formed,
  // and wrong for this chain. Accepting it would put a contract that does not exist here inside a signed
  // mandate's allowedTargets, and the person granting would read "make payments" over a token nobody can
  // name. This deployment has exactly ONE demo token, so which token is not a planner's choice to make.
  //
  // It was lost in a refactor and the mandate then carried `asset: ""`, which the caveat builder refused
  // — after the person had already answered twice. A test pins it now.
  const usesAsset = where?.capabilityId === 'treasury.payment.execute' || where?.capabilityId === 'treasury.fund'
    || where?.toolId === 'treasury.payment.execute' || where?.toolId === 'treasury.fund';
  if (env.MOCK_USDC && usesAsset) out.asset = String(env.MOCK_USDC).toLowerCase();

  // The RECORD a standing preference is written in: the relationship record, because a caveat cannot
  // narrow to one edge and the treasury the statement is ABOUT travels in the calldata.
  if (where?.capabilityId === PRIMARY_PAYEE_CAPABILITY && env.AGENT_RELATIONSHIP) {
    out.record = String(env.AGENT_RELATIONSHIP).toLowerCase();
  }

  if (where?.capabilityId === ACCESS_REVOKE_CAPABILITY && env.DELEGATION_MANAGER) {
    out.manager = String(env.DELEGATION_MANAGER).toLowerCase();
  }
  // The RECORD a profile edit writes. Not an address and not a contract — it is a vault record type, and
  // naming it is what lets a receipt say WHICH of the three "profiles" was changed.
  if (where?.capabilityId === PROFILE_UPDATE_CAPABILITY) out.record = 'impact-profile';
  if (where?.capabilityId === HOUSEHOLD_RECORD_CAPABILITY) out.record = 'household.data';
  return out;
}

/** Turn a finished run into the one reply shape. Nothing here decides anything — it reads what the loop
 *  already concluded.
 *
 *  The one thing it ADDS is prose, and only on the `answer` path: a question's result is rendered from the
 *  observations by the `AnswerComposer` (grounded in them, never beyond them). An ACTION's result is never
 *  paraphrased — what was created, at what address, in which transaction is stated from the receipt, where
 *  precision is the point. No composer, or a composer that fails, ⇒ the raw result, unchanged: the evidence
 *  is identical either way and only its rendering degrades. */
/**
 * THE THING THEY WERE WAITING FOR HAPPENED — spec 338 §7.
 *
 * Someone could not be reached, so they asked; a grant came back and their Home remembered what it was
 * for. The moment the payment that grant enabled settles, that note has nothing left to wait on. Left
 * open it keeps offering a payment already made, which is the one thing a "finish this" card must never
 * invite.
 *
 * Only a party reached THROUGH its owner's disclosure closes anything: an address typed outright was
 * nobody's answer to anything. Best-effort, and deliberately so — the money has moved and been receipted;
 * a note that fails to close costs a card, not a payment, and failing the run over it would be worse.
 */
async function settleFinishedRequests(
  input: { deps?: HarnessDeps; principal?: Address; resolved?: ResolvedParties; session?: string },
  r: RunResult,
): Promise<void> {
  const settle = input.deps?.settleResolutionRequest;
  if (!settle || !input.principal) return;
  const paid = r.receipts.filter((rc) => rc.toolId === 'treasury.payment.execute' && rc.status === 'executed');
  if (!paid.length) return;
  const txHash = (r.result as { txHash?: string } | null)?.txHash;

  // The args that MOVE VALUE, from the ontology binding (spec 355) — not a hand-kept list of arg names
  // that would drift the first time a capability names its payee something else.
  const paidTo = [...(input.resolved?.values() ?? [])].filter((p) => VALUE_ARGS.has(p.arg));
  if (!paidTo.length) return;

  // WHOSE NOTE THIS CLOSES IS A QUESTION ABOUT WHERE THE MONEY WENT, not about how the payee was
  // phrased. `ownedBy` is there when the run followed someone's disclosure to get the address — but a
  // person who answered "which treasury?" by picking one, or who pasted the address outright, paid the
  // very same agent and is owed the same finished card. So when the resolution did not carry an owner,
  // ask the records that can say: a held grant whose target IS this payee names the person who gave it.
  const owners = new Set(paidTo.map((p) => p.ownedBy).filter((o): o is string => !!o));
  const unattributed = paidTo.filter((p) => !p.ownedBy).map((p) => p.agent.toLowerCase());
  if (unattributed.length && input.deps?.verifyGrant && input.deps.readSubjectRecord && input.session) {
    const held = await input.deps.readSubjectRecord(input.principal, 'resolution.grants').catch(() => null);
    const grants = await input.deps.verifyGrant(held, 'treasury', input.principal, input.session).catch(() => []);
    for (const g of grants) {
      if (g.targetAgent && unattributed.includes(g.targetAgent.toLowerCase())) owners.add(g.owner.toLowerCase());
    }
  }

  for (const owner of owners) {
    await settle(input.principal, { owner, wants: 'treasury', ...(txHash ? { txHash } : {}) }).catch(() => undefined);
  }
}

/** Spec 367 wave 1 — EVERY reply kind carries the planner trace, decorated in one place so a new return path
 *  cannot forget it (the prompt and authority paths had). */
export async function askReplyFor(env: HarnessEnv, input: Parameters<typeof askReplyForInner>[1]): Promise<AskReply> {
  const reply = await askReplyForInner(env, input);
  return input.plannerTrace && !reply.plannerTrace ? { ...reply, plannerTrace: input.plannerTrace } : reply;
}

async function askReplyForInner(env: HarnessEnv, input: {
  /** Spec 371 — the tools the run was offered, for rendering a read's `answer` template. */
  tools?: ToolSpec[];
  intent: { goal: string }; result: RunResult; addressee: Address;
  /** What the surface said it can render — a prompt it never declared is refused, not stranded. */
  surface?: AskScopeV1;
  composer?: AnswerComposer | null;
  /** Read-only checks that spare a person a ceremony whose outcome is already knowable (spec 352 §2).
   *  Absent ⇒ no early refusal; the chain still decides. */
  deps?: HarnessDeps;
  /** Spec 361 — the caller supplied its own plan (a SCREEN), so an informational answer carries the
   *  structured result as well as the sentence: a table rendered by parsing prose is a surface that will
   *  eventually disagree with the record it is showing. */
  suppliedPlan?: boolean;
  /** Resolve a NAME the planner passed where an address is needed. The requirement is built from the
   *  step's args BEFORE any invoker runs, so "as nathan.treasury" has to become an address here or the
   *  person is asked to grant authority as a string nothing can sign. */
  resolveName?: (name: string) => Promise<string | null>;
  /** The person asking. Used ONLY to say, before a ceremony, what they are to the agent whose authority
   *  the plan needs — never consulted by a gate (spec 353 §4). */
  principal?: Address;
  /** Verifies a stewardship wire on chain. Absent ⇒ a held wire is not upgraded to `steward` on its word. */
  verifyStewardship?: StandingDeps['verifyStewardship'];
  /** Spec 367 wave 1 — attached to every reply kind so the How pane can show what the planner saw. */
  plannerTrace?: PlannerTraceV1;
  /** What the run's party words resolved to, for the surface to show back before a signature. */
  resolved?: ResolvedParties;
  /** Spec 361 — contract interaction bindings by capability id, from the run's own merged tools. */
  interactionFor?: Record<string, { editor?: string; review?: string; result?: string; navigationTarget?: string }>;
  /** The asker's Home session — carried so a finished payment can ask the resolver gate whose disclosure
   *  it used, which is what says whose note it just closed. */
  session?: string;
}): Promise<AskReply> {
  const r = input.result;
  // spec 354 §4.5 — the playbook provenance manifest for this run's outbound artifact (undefined when
  // the agent ran the bare harness). Attached to every terminal reply that carries a result.
  const prov = playbookProvenanceFromReceipts(r.receipts, input.addressee);
  const withProv = <T extends AskReply>(reply: T): T => ({ ...reply, ...(prov ? { skillProvenance: prov } : {}), ...(input.plannerTrace ? { plannerTrace: input.plannerTrace } : {}) } as T);
  if (r.outcome === 'authority-required' && r.required) {
    // Already normalised by the loop (`normalizeArgs`); re-run defensively for a caller that did not.
    // RE-NORMALISING WHAT THE LOOP ALREADY NORMALISED. `computedUnits` because the base-unit figure in
    // these args is OURS — the loop converted it from what the person said — and the planner-unit guard
    // must not fire on our own arithmetic. It did, and an InputRequired thrown here (outside the loop's
    // catch) escaped as "input required: data for (pending)".
    const args = await resolveStepArgs(r.required.args, env, { ...(input.resolveName ? { resolveName: input.resolveName } : {}) }, {
      stepRef: r.required.stepRef, toolId: r.required.toolId, computedUnits: true,
    });
    // The resource was read out of an arg BEFORE the args were normalised, so it has to be re-read from
    // the resolved ones — not merely repaired when it looks wrong. It looked fine: the planner's recalled
    // token address is a perfectly well-formed address for another chain, and `locations` would have
    // pinned the mandate to it while `limits` named the real one.
    const resourceArg = RESOURCE_ARG_FOR[r.required.capability.id] ?? 'parent';
    const resource = String(args[resourceArg] ?? r.required.capability.resource ?? '');
    const required = {
      ...r.required,
      args,
      capability: { ...r.required.capability, ...(resource ? { resource } : {}) },
    };
    // BEFORE asking anyone to authorize this: is it already impossible? Walking a person through a
    // signature for a payment their account cannot cover is the same wrong as asking them to grant
    // authority they do not hold — knowable in advance, and cruel to discover afterwards.
    if (input.deps) {
      const refusal = await preconditionRefusal({ capability: required.capability.id, args, env, deps: input.deps, addressee: input.addressee });
      if (refusal) return { kind: 'refused', runRef: r.runRef, outcome: 'denied', error: refusal, receipts: r.receipts };
    }
    const requirement = mandateRequirementForStep({ required, intent: input.intent, requirementType: REQUIREMENT_TYPE_FOR(r.required.capability.id) });
    // THE CALLS THIS AUTHORITY MAKES. A capability mandate's `actions` are capability ids, whose synthetic
    // selectors mean something to the verifier and nothing to the chain — so a capability that redeems its
    // mandate against a contract must also name the real function it calls, or `AllowedMethodsEnforcer`
    // refuses it after the person has already signed. Deployment knowledge, declared here where the call
    // is made, never guessed by a planner.
    const calls = ONCHAIN_CALLS_FOR[r.required.capability.id];
    if (calls?.length) requirement.methods = [...calls];
    // ONE-PROMPT (spec 361 I4): an invitation needs a SECOND signature from the same delegator (the
    // org→invitee grant). Naming its digest here lets the surface approveHash both in one org userOp —
    // one custodian signature for the mandate AND the grant, and the invoker's run finds the grant
    // already approved on chain instead of prompting again.
    const alsoApprove: Array<{ purpose: string; digest: Hex }> = [];
    if (r.required.capability.id === ORG_INVITE_CAPABILITY) {
      const org = String(args.org ?? '').toLowerCase();
      const invitee = String(args.invitee ?? '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(org) && /^0x[0-9a-f]{40}$/.test(invitee)) {
        const g = inviteGrantForRequirement(env, { intentDigest: requirement.intentDigest, validAfter: requirement.validAfter ?? Math.floor(Date.now() / 1000) - 60 }, org as Address, invitee as Address, r.required.stepRef);
        alsoApprove.push({ purpose: `the invitation grant ${org.slice(0, 10)}… → ${invitee.slice(0, 10)}…`, digest: g.digest });
      }
    }
    // WHOSE authority: the step's declared `authority` (the payer), else the resource it acts on (the
    // parent a team is chartered under), else the agent being asked. Never the person by default — a
    // team's authority is its workspace's — and never the token a payment moves.
    // A capability that DECLARES whose authority it spends does not get to fall through to the thing it
    // acts on. That fallthrough is how "send alice a message" became a request to authorize it AS ALICE:
    // messaging declares `authorityArg: 'sender'`, nothing set a sender, and the resource — the recipient
    // — was next in line. Acting-party resolution now always fills it; this makes the old route
    // unreachable rather than merely unused.
    const declaresAuthority = !!HARNESS_ACTION_TOOLS.find((t) => (t.capability?.id ?? t.id) === r.required!.capability.id)?.capability?.authorityArg;
    const fallback = declaresAuthority ? input.addressee : (required.capability.resource ?? input.addressee);
    const named = ((required.capability.authority ?? fallback) as string).trim();
    const delegator = (/^0x[0-9a-fA-F]{40}$/.test(named)
      ? named
      : ((input.resolveName ? await input.resolveName(named.toLowerCase()) : null) ?? input.addressee)).toLowerCase() as Address;
    // WHO CAN GRANT THIS (spec 353 S5). The chain will decide either way; the point is to decide it BEFORE
    // a person signs rather than after. A member who signs as an org they do not custody gets a `not-live`
    // verdict that is accurate, unhelpful, and arrives once the work is already done.
    let standing: Standing | undefined;
    // An UNREADABLE standing is not "no standing", and it must not read as one. Absence gets a reason, so
    // a surface (and whoever is debugging it) can tell "we looked and they are a member" apart from "we
    // never looked", which are opposite facts that look identical when the field is simply missing.
    let standingUnavailable: string | undefined;
    if (!input.principal) standingUnavailable = 'the asker was not named to this reply';
    else if (!input.deps?.readSubjectRecord) standingUnavailable = 'this agent cannot read the asker\'s links';
    else {
      const read = input.deps.readSubjectRecord;
      standing = await deriveStanding(
        { readSubjectRecord: read, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}) },
        { principal: input.principal, subject: delegator },
      ).catch((e: unknown) => { standingUnavailable = e instanceof Error ? e.message : String(e); return undefined; });
    }
    const note = standing ? standingNote(standing, CAPABILITY_WORDS[r.required.capability.id] ?? 'authority') : '';
    return {
      kind: 'authority_required', runRef: r.runRef, requirement, delegator,
      ...(alsoApprove.length ? { alsoApprove } : {}),
      delegate: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
      capability: r.required.capability.id, stepRef: r.required.stepRef,
      summary: `${r.required.capability.id} on ${delegator}`,
      ...(standing ? { standing } : {}), ...(note ? { note } : {}),
      ...(standingUnavailable ? { standingUnavailable } : {}),
      // Only the parties this STEP actually names — a run that resolved three things does not get to
      // show all three under a mandate that covers one.
      ...(() => {
        const named = [...(input.resolved?.values() ?? [])].filter((p) => Object.values(args).some((v) => String(v).toLowerCase() === p.agent));
        return named.length ? { parties: named } : {};
      })(),
    };
  }
  if (r.outcome === 'suspended' && r.prompt) {
    // CEREMONY NEGOTIATION (spec 353 S4). Offering only what a surface can finish catches this at plan
    // time; this catches the rest — a capability that asks for something its risk tier never implied, or a
    // surface whose declaration and behaviour have drifted. A run that suspends on a prompt nobody can
    // answer is not waiting, it is stuck, and stuck reads to a person as broken rather than as unsupported.
    const kind = r.prompt.kind;
    const declared = input.surface?.ceremonies;
    if (declared?.length && !new Set([...ASSUMED_CEREMONIES, ...declared]).has(kind)) {
      return {
        kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
        error: `this needs a ${kind} and this surface cannot collect one — nothing was authorized`,
      };
    }
    // STANDING BEFORE THE QUESTION (spec 353 S5). A prompt is a demand on a person. Asking a member to
    // look up an invitee's address for an invitation only a steward can authorize spends their effort on
    // a refusal we could already see — the same wrong as collecting a signature that will not verify.
    //
    // Only on POSITIVE evidence: `member` means we read their links and they hold no stewardship there.
    // `none` does NOT refuse — a person can custody an agent that no row of theirs mentions, and custody
    // at grant time is the gate. Fail open on ambiguity, closed only on what was actually read.
    const pendingCapability = r.prompt.toolId ?? '';
    if (input.principal && input.deps?.readSubjectRecord && AUTHORITY_BEARING_CAPABILITIES.includes(pendingCapability)) {
      const st = await deriveStanding(
        { readSubjectRecord: input.deps.readSubjectRecord, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}) },
        { principal: input.principal, subject: input.addressee },
      ).catch(() => null);
      if (st?.relation === 'member') {
        return {
          kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
          error: standingNote(st, CAPABILITY_WORDS[pendingCapability] ?? pendingCapability),
        };
      }
    }
    return { kind: 'prompt', runRef: r.runRef, resumeToken: r.resumeToken ?? r.prompt.stepRef, prompt: r.prompt };
  }
  if (r.outcome === 'completed') {
    // "None of these" is stated, never composed: a model asked to phrase a refusal will soften it into a
    // suggestion, and the useful part is the list of what this agent CAN do — which is not its to invent.
    const unsupported = r.steps.find((o) => o.ok && (o.result as { unsupported?: boolean } | null)?.unsupported);
    if (unsupported) {
      const u = unsupported.result as { what?: string; available?: string[] };
      const can = (u.available ?? []).map((id) => CAPABILITY_WORDS[id] ?? id);
      return withProv({
        kind: 'answer', runRef: r.runRef,
        // Quoted rather than folded into the sentence: the person's words come back in their own person
        // ("book me a flight"), and "I can't book me a flight" reads like a machine that did not listen.
        text: u.what?.trim()
          ? `I can't help with “${u.what.trim()}” here.${can.length ? ` What I can do as this agent: ${can.join(', ')}.` : ''}`
          : `I can't do that here.${can.length ? ` What I can do as this agent: ${can.join(', ')}.` : ''}`,
      });
    }
    const acted = r.receipts.some((rc) => rc.status === 'executed' && rc.risk !== 'informational');
    if (acted) {
      await settleFinishedRequests(input, r).catch(() => undefined);
      // The binding of the LAST authority-bearing step that executed — that is the act the person asked
      // for; informational reads before it are how it was planned, not what was done.
      const actedCap = [...r.receipts].reverse().find((rc) => rc.status === 'executed' && rc.risk !== 'informational')?.capability?.id;
      const ix = actedCap ? input.interactionFor?.[actedCap] : undefined;
      const effects = r.receipts.flatMap((rc) => rc.effects ?? []);
      const decided = r.receipts.flatMap((rc) => rc.decisions ?? []);
      // Spec 367 §6 — FULFILLMENT: what the evidence established, said in the outcome class's own words.
      // A submission ("invited", "asked") is reported as a submission — never as the outcome the person
      // asked for, which somebody else still has to bring about.
      const actedReceipt = [...r.receipts].reverse().find((rc) => rc.status === 'executed' && rc.risk !== 'informational');
      const established = actedReceipt?.binding?.expectedOutcome ?? 'authoritative';
      const res = (r.result && typeof r.result === 'object' ? r.result : {}) as { txHash?: string; inviteeEmail?: string; emailDelivery?: { ok: boolean; delivery?: string; error?: string } };
      // AN EFFECT THAT DID NOT HAPPEN IS SAID. The email that carries an invitation is the act's declared
      // consequence; a done reply that reports the grant and not the mail hid a failed send behind
      // "submitted and recorded" (caught live 2026-09-07).
      const mail = res.inviteeEmail
        ? (res.emailDelivery?.ok ? ` — invitation ${res.emailDelivery.delivery === 'logged' ? 'link logged (email not configured)' : `emailed to ${res.inviteeEmail}`}` : ` — but the email to ${res.inviteeEmail} did not go: ${res.emailDelivery?.error ?? 'delivery failed'}`)
        : '';
      // WHAT MAY FOLLOW (spec 368 §3): an invoker may propose the next act as a compiled command. It is a
      // proposal the person confirms on the surface — the run that results asks for its own authority.
      const nextRaw = (res as { next?: unknown }).next as Partial<NextActV1> | undefined;
      const next: NextActV1 | undefined = nextRaw && typeof nextRaw.capability === 'string' && nextRaw.args && typeof nextRaw.args === 'object' && typeof nextRaw.words === 'string'
        ? { capability: nextRaw.capability, args: nextRaw.args as Record<string, unknown>, words: nextRaw.words, why: typeof nextRaw.why === 'string' ? nextRaw.why : '' }
        : undefined;
      const fulfillment = actedCap ? {
        capability: actedCap, established,
        ...(res.txHash ? { evidence: `tx ${res.txHash}` } : actedReceipt?.outputDigest ? { evidence: `receipt ${actedReceipt.stepRef}` } : {}),
        words: (established === 'submission'
          ? `${CAPABILITY_WORDS[actedCap] ?? actedCap}: submitted and recorded — the outcome is not established until the other party acts`
          : `${CAPABILITY_WORDS[actedCap] ?? actedCap}: done${res.txHash ? ', on chain' : ''}`) + mail,
      } : undefined;
      return withProv({ kind: 'done', runRef: r.runRef, result: r.result ?? null, receipts: r.receipts, ...(fulfillment ? { fulfillment } : {}), ...(next ? { next } : {}), ...(effects.length ? { effects } : {}), ...(decided.length ? { decisions: decided } : {}), ...(ix ? { interaction: { ...(ix.result ? { result: ix.result } : {}), ...(ix.navigationTarget ? { navigationTarget: ix.navigationTarget } : {}) } } : {}) });
    }
    const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
    const evidence = askEvidence(r.steps);
    // A SCREEN'S OWN PLAN gets its rows back; a person gets the sentence. Only for a supplied plan, and
    // only the informational steps — nothing here is a second copy of an ACT's result, which lives on the
    // receipt where it can be checked.
    const results = input.suppliedPlan
      ? r.steps.filter((o) => o.ok && o.result && typeof o.result === 'object').map((o) => ({ toolId: o.step.toolId, result: o.result }))
      : [];
    const withEvidence = (text: string): AskReply => withProv({ kind: 'answer', runRef: r.runRef, text, ...(evidence.length ? { evidence } : {}), ...(results.length ? { results } : {}) });
    // RENDERED, NOT COMPOSED (spec 371 §2). When every read that ran carries the author's `answer`
    // template and its result has the fields, the reply is the template over the result — the person's
    // unit, no interpretation, no model. The composer is for reads that declare no sentence.
    const offered = input.tools ?? [];
    const readSteps = r.steps.filter((o) => o.ok && !o.skipped);
    if (readSteps.length && readSteps.every((o) => offered.find((t) => t.id === o.step.toolId)?.answer)) {
      const rendered = readSteps.map((o) => renderAnswer(offered.find((t) => t.id === o.step.toolId)!.answer!, o.result));
      if (rendered.every((x): x is string => typeof x === 'string' && x.length > 0)) return withEvidence(rendered.join(' '));
    }
    if (!input.composer) return withEvidence(raw);
    try {
      // GROUNDED COMPOSITION — spec 358 W3. Every real gate ran before the invoker; this is the one
      // stage that was ungoverned, and it is where the week's false sentences were written. The prose is
      // checked against the evidence it will be shown WITH: one recompose carrying the governor's own
      // corrections, then the floor — the evidence stated plainly, because after two ungrounded
      // compositions the person gets the observations, not a third guess.
      let text = await input.composer.compose({ intent: input.intent, observations: r.steps });
      let violations = checkGroundedComposition(text, evidence, input.intent.goal);
      if (violations.length) {
        text = await input.composer.compose({
          intent: input.intent, observations: r.steps,
          corrections: violations.map((v) => v.correction),
        });
        violations = checkGroundedComposition(text, evidence, input.intent.goal);
        if (violations.length) text = groundedFallback(evidence);
      }
      return withEvidence(text);
    } catch {
      return withEvidence(raw);
    }
  }
  return withProv({ kind: 'refused', runRef: r.runRef, outcome: r.outcome, error: r.error ?? 'the run did not complete', receipts: r.receipts });
}

/**
 * WHAT THE APP CAN DO, AND WHERE THE PERSON IS STANDING — spec 353's `AskScopeV1`, the scope half of an ask.
 *
 * An Ask never happens in a vacuum: it happens inside an app, with a connected user, acting in a selected
 * context. All three are already substrate facts, and the app knows them before the harness runs.
 *
 * SCOPE IS HONESTY; THE MANDATE IS AUTHORITY. This decides what the conversation OFFERS, how it phrases
 * things and how it refuses. It decides nothing about what is permitted, and it is consumed BEFORE the
 * authority stage: it is not a parameter of `verifyMandateForStep`, of the `PolicyEvaluator`, or of any
 * gate. Threading it into a verifier is the drift to refuse (353 §4).
 *
 * WHAT IS DELIBERATELY ABSENT: roles, memberships, entitlements, policy verdicts. An app-asserted role is
 * a client-supplied authorization claim — the exact pattern ADR-0041 forbids and Pydantic warns about —
 * so standing is DERIVED here from vault and chain, never accepted from the payload. An earlier cut of
 * this carried `role: 'steward' | 'member'` from the Home; it is removed rather than ignored, because a
 * field that exists gets used.
 */
export interface AskScopeV1 {
  /** Capability ids this app can carry to completion. Absent ⇒ everything this agent offers. */
  capabilities?: string[];
  /** Prompt kinds and ceremonies this surface can actually render (350 §3.5 kinds, plus
   *  'mandate-signature'). A run that would suspend on one the app cannot render should refuse at plan
   *  time rather than strand (353 S4 — not yet enforced). */
  ceremonies?: string[];
  /** The realm the person selected, as the app understands it — the delegator candidate and the private
   *  tier. NOT their standing in it. */
  realm?: { kind?: 'person' | 'org' | 'service' };
  /**
   * Spec 361 I6 — CONTEXT PARITY: what the person has SELECTED on the screen the Ask was opened from — an
   * entity (a member on the roster, a team, a treasury), a filter, an open draft. A screen supplies meaning
   * through selection long before a sentence is typed; this is how that meaning reaches the Ask. It is
   * validated application context (a reference, never only words in a prompt): a party the sentence did
   * not name may be filled from it when the party role's declared classes admit the selection's kind, and
   * the binding says so (`context`). It permits nothing and reaches no verifier.
   */
  selection?: { entity?: string; kind?: string; label?: string; filter?: Record<string, string>; draftRunRef?: string };
}

/**
 * WHAT EACH CAPABILITY WILL ASK A PERSON FOR — spec 353 S4.
 *
 * Risk implies a floor (a payment is high, so somebody signs), but it does not predict everything:
 * `organization.team.create` is MEDIUM and still needs a signature, because an agent's genesis is signed
 * by the credential that will custody it. A ceremony list derived from risk alone would have declared that
 * capability renderable by a surface that cannot collect a signature, and the run would have suspended on
 * a prompt nobody could answer — the Mastra failure class, arriving through the UX door instead of the
 * storage one.
 *
 * So each capability states what it may ask for. `data` and `confirmation` are assumed of every surface (a
 * conversation that cannot ask a question is not a conversation); only the ceremonies BEYOND that are
 * listed, because those are the ones an app can genuinely lack.
 */
export const CAPABILITY_CEREMONIES: Record<string, string[]> = {
  'organization.team.create': ['signature'],        // the child's genesis
  'organization.create': ['signature'],
  'household.create': ['signature'],
  'treasury.create': ['signature'],
  'organization.membership.invite': ['signature'],  // the org signs the invitation grant
  'coordination.endeavor.request': ['signature'],   // the mandate — asking as you is an act of yours
  'coordination.contribution.propose': ['signature'],
  'coordination.contribution.allocate': ['signature'],  // the org's decision, under a steward's signature
  'coordination.endeavor.satisfy': ['signature'],
  'treasury.payment.execute': ['signature'],        // the mandate, and the ladder's second party
  'treasury.fund': ['signature'],                   // the mandate
  'messaging.direct.send': ['signature'],           // the mandate — sending as you is acting as you
  'resolution.invitation.request': ['signature'],   // the mandate — asking is an act of yours too
  'treasury.primary.declare': ['signature'],        // the mandate — a public statement of yours
  'access.grant.revoke': ['signature'],             // the mandate — taking authority back is an act too
};

/**
 * The EVM functions each capability calls when it redeems its mandate — real 4-byte selectors.
 *
 * A capability mandate bounds `allowedMethods` by the CAPABILITY's synthetic selector, which the chain has
 * never heard of; without the real one the enforcer reverts `MethodNotAllowed` and the person has signed
 * for nothing. Only capabilities that actually execute on chain under their own mandate appear here — an
 * invitation derives a grant and a message rides a plane, and neither calls a contract this way.
 */
const methodSelectorOf = (signature: string): Hex => toFunctionSelector(`function ${signature}`);

const ONCHAIN_CALLS_FOR: Record<string, readonly Hex[]> = {
  // `mint(address,uint256)` on the demo token.
  'treasury.fund': [methodSelectorOf('mint(address,uint256)')],
  // `addRole(bytes32,bytes32)` / `removeRole(bytes32,bytes32)` on the relationship record — a switch
  // clears the previous primary in the same mandate, so both are named.
  [PRIMARY_PAYEE_CAPABILITY]: [methodSelectorOf('addRole(bytes32,bytes32)'), methodSelectorOf('removeRole(bytes32,bytes32)')],
  // `revokeDelegationByOwner((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))` — the
  // authority kill. The struct shape is the DelegationManager's, so the selector is computed from it
  // rather than written down: a hand-copied selector is a revocation that reverts.
  [ACCESS_REVOKE_CAPABILITY]: [methodSelectorOf('revokeDelegationByOwner((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))')],
};

/** Ceremonies every surface is assumed to render: it is a conversation, so it can ask and be answered. */
const ASSUMED_CEREMONIES = ['data', 'confirmation'];

/** Can this surface complete this capability? Silence means yes — a surface that has not said what it
 *  renders is not narrowed by its silence (the same rule as `capabilities`). */
export function surfaceCanRender(capabilityId: string, ceremonies?: string[]): boolean {
  if (!ceremonies?.length) return true;
  const renders = new Set([...ASSUMED_CEREMONIES, ...ceremonies]);
  return (CAPABILITY_CEREMONIES[capabilityId] ?? []).every((c) => renders.has(c));
}

/**
 * THE ASK VOCABULARY THIS AGENT PUBLISHES — spec 353 S2, the ∩ a surface computes its scope from.
 *
 * PROJECTED from the same tool declarations the planner composes with, never a second list. The moment
 * this is hand-kept it drifts: the vocabulary advertises a capability the planner cannot pick, or the
 * planner offers one the vocabulary never named, and both lists are separately right.
 *
 * Vocabulary is DISCLOSURE. A capability appearing here permits nothing — the mandate decides authority,
 * and this list is not consulted by any gate (spec 353 §4).
 */
export function askDescriptors(playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null): SurfaceDescriptor[] {
  // THE PUBLISHED VOCABULARY IS NARROWED BY THE PLAYBOOK (spec 354 §4.4 / K5). The classification
  // vocabulary a surface reads to build its scope is `app.capabilities ∩ this agent's definition
  // capabilities` — so a treasury reassigned to a read-only Bookkeeper stops PUBLISHING payment, exactly
  // as it stops OFFERING it at plan time. Disclosure honesty from behavior; the mandate gate is untouched
  // (this list is consulted by no gate — spec 353 §4). Absent playbook ⇒ the bare harness publishes all.
  const tools = playbook
    ? HARNESS_ACTION_TOOLS
        .filter((t) => playbook.capabilityIds.has(t.capability?.id ?? t.id))
        // The published description is the contract's too — a surface reads this to build its scope, and
        // a stale hand-kept sentence here is the drift `CAPABILITY_WORDS` already suffered.
        .map((t) => mergeContractTool(t, playbook.tools?.[t.capability?.id ?? t.id]))
    : HARNESS_ACTION_TOOLS;
  return tools.filter((t) => t.id !== UNSUPPORTED_TOOL.id).map((t) => {
    const id = t.capability?.id ?? t.id;
    return {
      id,
      protocol: 'a2a' as const,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
      authorization: {
        mode: 'agentic-delegation' as const,
        riskTier: (t.risk ?? 'medium') as SurfaceRiskTier,
        // What this one may ASK A PERSON for, beyond its risk floor. `organization.team.create` is medium
        // and still needs a signature — see CAPABILITY_CEREMONIES.
        ...(CAPABILITY_CEREMONIES[id]?.length ? { ceremonies: CAPABILITY_CEREMONIES[id] as SurfaceCeremony[] } : {}),
      },
      // `key-required`, not `never-retry`: every authority-bearing step here derives its on-chain nonce
      // from the intent, so the SAME ask retried settles once and a second submission reverts. Retrying
      // is safe with the same key and is not safe without one.
      operations: { rateLimitProfile: 'harness', maxBodyBytes: 65536, timeoutMs: 30000, idempotency: 'key-required' as const, cache: 'no-store' as const },
    };
  });
}

/** The vocabulary as a surface consumes it: every capability, with the ceremonies it may ask for and the
 *  PLAIN WORDS for it. The words travel with the capability because a surface that keeps its own list
 *  keeps a list that goes stale: the Home's copy was missing three, so a person granting authority to send
 *  a message read "needs permission to messaging.direct.send", which is the id, not a sentence. */
/**
 * WHAT IS WAITING ON THIS PERSON — surfaced when they open the Ask, not left for them to remember.
 *
 * A request lands in someone's records and a message lands in their inbox, and both rely on them going
 * to look. The one surface they DID open is this one, so it is the right place to say "someone is waiting
 * on you" — once, briefly, and only about things that are genuinely theirs to decide.
 *
 * It reports; it never acts. Nothing here approves anything, and the words point at where the decision is
 * made rather than pretending it can be made in a sentence.
 */
export async function waitingOn(
  deps: { readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown> },
  person: string | undefined,
  homeOrigin?: string,
): Promise<string | null> {
  if (!person || !deps.readSubjectRecord) return null;
  const doc = await deps.readSubjectRecord(person, 'resolution.requests').catch(() => null);
  const rows = (doc as { requests?: Array<{ kind?: string; requester?: string; wants?: string; status?: string }> } | null)?.requests ?? [];
  const pending = rows.filter((r) => r.kind !== 'resolution.invitation.sent' && !!r.requester && (r.status ?? 'pending') === 'pending');
  if (!pending.length) return null;
  const where = actionLink(homeOrigin, '/treasuries');
  const what = pending.length === 1
    ? `Someone has asked you for a way to reach your ${pending[0]!.wants ?? 'agent'}.`
    : `${pending.length} people have asked you for a way to reach agents of yours.`;
  // WHERE, not just what. A notice that does not say where to go is one more thing to work out.
  return `${what}${where ? ` You decide at ${where}.` : ''}`;
}

/**
 * Spec 367 §7 — THE COMMAND behind a capability: its fields, typed by the ontology class the contract gave
 * each input. A screen renders these as controls (an Agent is a party picker, an Amount a number, a Flag a
 * checkbox); Ask fills the same fields from words. Both post the same supplied plan to the same boundary,
 * and a missing value comes back as the same structured prompt. Projection only — it permits nothing.
 */
export interface CommandFieldV1 {
  name: string;
  label: string;
  kind: 'agent' | 'amount' | 'text' | 'flag' | 'asset';
  required: boolean;
  /** For an agent field: the typed-name suffixes it may resolve to (from the party role), if declared. */
  types?: string[];
  /** For an agent field: the role also accepts an email address (someone with no agent yet). */
  acceptsEmail?: boolean;
  hint?: string;
}

export function commandFieldsFor(playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null): Record<string, CommandFieldV1[]> {
  const tools = playbook
    ? HARNESS_ACTION_TOOLS.filter((t) => playbook.capabilityIds.has(t.capability?.id ?? t.id)).map((t) => mergeContractTool(t, playbook.tools?.[t.capability?.id ?? t.id]))
    : HARNESS_ACTION_TOOLS;
  const out: Record<string, CommandFieldV1[]> = {};
  for (const t of tools) {
    if (t.id === UNSUPPORTED_TOOL.id) continue;
    const id = t.capability?.id ?? t.id;
    const schema = (t.inputSchema ?? {}) as { properties?: Record<string, { description?: string; 'x-ap-class'?: string }>; required?: string[] };
    const required = new Set(schema.required ?? []);
    out[id] = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
      const cls = String(prop?.['x-ap-class'] ?? '').toLowerCase();
      const kind: CommandFieldV1['kind'] = cls === 'agent' || PARTY_ARGS.includes(name) ? 'agent'
        : cls === 'amount' || name === 'usdc' || name === 'amount' ? 'amount'
        : cls === 'flag' ? 'flag' : cls === 'asset' || name === 'asset' ? 'asset' : 'text';
      const types = kind === 'agent' ? partyTypesFor(id, name) : undefined;
      const acceptsEmail = kind === 'agent' && !!partyRole(id, name)?.alsoAccepts?.includes('email');
      return {
        name, kind, required: required.has(name),
        label: kind === 'agent' ? partyWord(name) : name === 'usdc' ? 'amount (USDC)' : name,
        ...(types?.length ? { types: [...types] } : {}),
        ...(acceptsEmail ? { acceptsEmail: true } : {}),
        ...(prop?.description ? { hint: prop.description } : {}),
      };
    });
  }
  return out;
}

export function askVocabulary(
  playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null,
): Array<AskCapabilityLike & { label: string }> {
  return buildAskVocabulary(askDescriptors(playbook)).map((c) => ({
    ...c,
    // PLAIN WORDS, from the contract when it has them. `CAPABILITY_WORDS` is the built-in fallback and
    // stays authoritative for the bare harness — but a domain author who wrote a sentence for their own
    // capability should see it, and this is the copy the Home renders on the authority card.
    label: CAPABILITY_WORDS[c.id] ?? c.id,
  }));
}

/**
 * The action tools this ask may compose: what this agent offers, narrowed by what the SURFACE says it can
 * complete and by the realm the person is standing in. Narrowing only — a surface that names a capability
 * this agent does not have gets nothing extra, and a realm never grants.
 */
/** The risk ladder, ordered. Comparing by index is how "never lower" is enforced. */
const RISK_ORDER = ['informational', 'low', 'medium', 'high', 'critical'] as const;
const riskRank = (r: string | undefined): number => Math.max(0, RISK_ORDER.indexOf((r ?? 'informational') as never));

/**
 * WHAT A SKILL.md MAY AND MAY NOT SAY ABOUT A BUILT-IN CAPABILITY.
 *
 * A contract is written by a domain author and lives in a corpus anyone with the domain can publish to.
 * The harness has a running invoker for these capabilities, with an authority shape the verifier already
 * compares against. So the boundary is not "the contract is the source" — it is:
 *
 *   THE CONTRACT MAY DESCRIBE THE ACT. IT MAY NOT WEAKEN THE GATE.
 *
 * MERGED FROM THE CONTRACT (behaviour — a wrong value costs a worse plan, never an unauthorized act):
 *   · `description` — the sentence a planner chooses BY. The single highest-value field, and the one the
 *     hand-kept copies kept going stale on.
 *   · `inputSchema` — what to ask for. `required` is UNIONED with the built-in's, so a contract can ask
 *     for more and never for less: dropping a required arg would let a step run with something missing.
 *   · `enumerates` — what a result lists. Fan-out is capped by the ontology's own binding regardless.
 *   · `risk` — RAISED ONLY. `max(built-in, contract)`. A contract that says a payment is informational
 *     does not make it one; that is the same rule `stepRiskClass` applies to plans ("a plan cannot lower
 *     a risk"), applied to playbooks, and without it a published SKILL.md could remove the mandate gate
 *     from `treasury.payment.execute` — authority laundering with a nicer name.
 *
 * NEVER TAKEN FROM THE CONTRACT (authority — the verifier compares against these):
 *   · `capability.id` / `action` — what is being exercised.
 *   · `resourceArg` / `authorityArg` — WHICH argument the mandate is bound to. Rebinding `authorityArg`
 *     from `payer` to `payee` would have the gate check the wrong party while still passing.
 *   · whether a mandate is required at all.
 *
 * A contract that disagrees on an authority field is not obeyed and not silently ignored — it is logged,
 * because a domain author who wrote it believes it is in force.
 */
export function mergeContractTool(builtin: ToolSpec, contract: DefinitionToolV1 | undefined): ToolSpec {
  if (!contract) return builtin;
  const cap = builtin.capability;
  if (cap && contract.capability) {
    for (const [field, mine, theirs] of [
      ['action', cap.action, contract.capability.action],
      ['resourceArg', cap.resourceArg, contract.capability.resourceArg],
      ['authorityArg', cap.authorityArg, contract.capability.authorityArg],
    ] as const) {
      if (theirs !== undefined && theirs !== mine) {
        console.warn(`[playbook] contract for ${cap.id} declares ${field}=${String(theirs)}; the running capability binds ${String(mine)} and that is what the verifier compares — the contract's value is NOT applied`);
      }
    }
  }
  const builtinReq = ((builtin.inputSchema as { required?: string[] } | undefined)?.required) ?? [];
  const contractReq = ((contract.inputSchema as { required?: string[] } | undefined)?.required) ?? [];
  // PROPERTIES ARE A UNION TOO — the contract's description of an argument wins per key, but an argument
  // it does not mention SURVIVES. Replacing the schema hid `payer` (the treasury contract's inputs name
  // payee/asset/amount; `authorityArg: payer` is bound by the RUNNING capability) — and the loop only
  // accepts a supplied answer for a declared argument, so "Which of your treasuries?" became
  // unanswerable: every answer was filtered out and the identical question asked forever. Describing an
  // act may add words; hiding an argument the capability binds is weakening the gate's resumability.
  const builtinProps = ((builtin.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
  const contractProps = ((contract.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
  const inputSchema = contract.inputSchema
    ? {
        ...(builtin.inputSchema as Record<string, unknown> | undefined ?? {}),
        ...(contract.inputSchema as Record<string, unknown>),
        properties: { ...builtinProps, ...contractProps },
        required: [...new Set([...builtinReq, ...contractReq])],
      }
    : builtin.inputSchema;
  return {
    ...builtin,
    ...(contract.description ? { description: contract.description } : {}),
    ...(inputSchema ? { inputSchema: inputSchema as never } : {}),
    ...(contract.enumerates ? { enumerates: contract.enumerates } : {}),
    // Spec 361 — the interaction binding is the MOST behavioural field yet: a wrong name costs a worse
    // screen, never an unauthorized act. Merged like description; a surface with no registration for the
    // name falls back to generic rendering.
    ...(contract.interaction ? { interaction: contract.interaction } : {}),
    // Spec 363 W5 — WHICH QUESTIONS this capability may answer for the person instead of asking. A
    // domain author owns that (it is behaviour), the RULES stay in the ontology (they decide whose money
    // moves), and a point the substrate does not publish is refused rather than silently ignored — a
    // contract naming a decision nobody implements would read as "this asks nothing" while asking
    // everything.
    ...(contract.decisions?.length ? { decisions: [...contract.decisions] } : {}),
    // Spec 367 W2 — the contract's VERBS join the built-in's (union: an act answers to every word either
    // declares; the contract's are the domain author's). Behavioural: plan admission reads them to say an
    // instruction must be answered by an act — never which act, never authority.
    ...(builtin.verbs?.length || contract.verbs?.length ? { verbs: [...new Set([...(builtin.verbs ?? []), ...(contract.verbs ?? [])])] } : {}),
    // Spec 371 — what a READ answers (union, like verbs) and how its answer reads (the contract's sentence
    // wins: it is the domain author's). Behaviour: question admission and rendering, never a gate.
    ...(builtin.answers?.length || contract.answers?.length ? { answers: [...new Set([...(builtin.answers ?? []), ...(contract.answers ?? [])])] } : {}),
    ...(contract.answer ? { answer: contract.answer } : builtin.answer ? { answer: builtin.answer } : {}),
    // Spec 367 §6 — what the step establishes: the contract's word, else the built-in's. A contract may
    // LOWER it (authoritative → submission: "an invitation is not a membership") — that is honesty about
    // the outcome, not authority; it may not raise a lookup into an act (a read stays a read).
    ...(contract.establishes && (builtin.capability || contract.establishes === 'lookup') ? { establishes: contract.establishes } : builtin.establishes ? { establishes: builtin.establishes } : {}),
    // Raised only — never lowered.
    ...(builtin.risk || contract.risk
      ? { risk: (riskRank(contract.risk) > riskRank(builtin.risk) ? contract.risk : builtin.risk) as never }
      : {}),
  };
}

export function scopedActionTools(surface?: AskScopeV1, playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null): ToolSpec[] {
  let tools = HARNESS_ACTION_TOOLS;
  const declared = surface?.capabilities?.length ? new Set(surface.capabilities) : null;
  if (declared) tools = tools.filter((t) => declared.has(t.capability?.id ?? t.id));
  // THE PLAYBOOK NARROWS THE OFFER (spec 354 §4.4): only what this agent's compiled archetype knows how
  // to do. Behavior honesty, not authority — a removed tool is one the planner will not pick; the mandate
  // gate is untouched. Absent playbook ⇒ no narrowing (the bare harness offers everything the surface
  // allows).
  if (playbook) {
    tools = tools.filter((t) => playbook.capabilityIds.has(t.capability?.id ?? t.id));
    // …AND THE CONTRACT DESCRIBES IT. Narrowing was all a playbook could do; now the SKILL.md a domain
    // author wrote supplies the behavioural half of each tool it kept (see `mergeContractTool` for the
    // line between describing an act and weakening its gate).
    tools = tools.map((t) => mergeContractTool(t, playbook.tools?.[t.capability?.id ?? t.id]));
  }
  // A person's own realm charters organizations; an organization charters what lives inside it. Offering
  // `organization.create` while standing in a service is offering a plan whose parent makes no sense.
  const kind = surface?.realm?.kind;
  if (kind === 'org') tools = tools.filter((t) => t.id !== 'organization.create' && t.id !== 'household.create');
  if (kind === 'service') tools = tools.filter((t) => !CHILD_AGENT_TLD[t.id] && t.id !== ORG_INVITE_CAPABILITY);
  // Do not OFFER what this surface cannot finish. A plan built from a capability whose ceremony nobody can
  // render is a plan that strands mid-run, after the person has already been asked for things.
  tools = tools.filter((t) => surfaceCanRender(t.capability?.id ?? t.id, surface?.ceremonies));
  return tools;
}


/**
 * WHICH KEY FITS THIS STEP — spec 358 W4. A payment step is judged under the presented mandate whose
 * PaymentEnforcer caveat names the step's payee; every other capability takes the first (the single-
 * mandate ask, unchanged). Returning null is honest: the loop then reports authority-required for THAT
 * item's own args, which is what the surface mints the next mandate from. Reading a caveat's terms is
 * not verifying them — the verifier judges the selected mandate alone, afterwards, as always.
 */
function selectByPayee(rs: { capability: { id: string }; args: Record<string, unknown> }, all: MandatePresentation[], paymentEnforcer?: string): MandatePresentation | null {
  if (rs.capability.id !== 'treasury.payment.execute' || !paymentEnforcer) return all[0] ?? null;
  const payee = String(rs.args.payee ?? '').toLowerCase();
  if (!payee) return all[0] ?? null;
  for (const p of all) {
    const wire = p.wire as { caveats?: Array<{ enforcer?: string; terms?: unknown }> };
    const caveat = (wire.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === paymentEnforcer.toLowerCase());
    if (!caveat) continue;
    try {
      if (decodePaymentTerms(caveat.terms as never).payee.toLowerCase() === payee) return p;
    } catch { /* an undecodable caveat fits nothing */ }
  }
  return null;
}

/** Run one ask under a mandate. Everything the loop decided is on the receipts; nothing here re-decides. */
/** What the run's party words became, keyed so the same party resolved twice is recorded once. Display
 *  only — nothing reads it to decide anything. */
export type ResolvedParties = Map<string, ResolvedParty>;

export async function runUnderMandate(env: HarnessEnv, deps: HarnessDeps, input: HarnessRunInput): Promise<{ result: RunResult; plannerKind: string; resolved: ResolvedParties; interactionFor: Record<string, NonNullable<ToolSpec['interaction']>>; trace: PlannerTraceV1; tools: ToolSpec[]; playbook: { digest: string; triggers?: TriggerV1[] } | null }> {
  const resolved: ResolvedParties = new Map();
  const chainId = Number(env.CHAIN_ID);
  const dm = env.DELEGATION_MANAGER as Address;
  const enforcers = harnessEnforcers(env);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // The KEYRING (spec 358 W4): one mandate stays exactly what it was; several are normalised into a
  // list, and each step is judged under the one whose payment caveat names ITS payee — selected
  // deterministically below, verified alone, exactly as if the person had asked N times.
  const presentedList: MandatePresentation[] = (input.presented == null ? [] : Array.isArray(input.presented) ? input.presented : [input.presented])
    .map((w) => { const wire = wireToDelegation(w); return { ref: hashDelegation(wire, chainId, dm), wire }; });
  const presented: MandatePresentation | MandatePresentation[] | null =
    presentedList.length === 0 ? null : presentedList.length === 1 ? presentedList[0]! : presentedList;
  const firstPresented = presentedList[0] ?? null;
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;

  const verifier = delegationMandateVerifier({
    actor: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
    enforcers,
    checks: {
      delegationDigest: (d) => hashDelegation(d, chainId, dm),
      isRevoked: async (d) => (await deps.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean,
      verifySignature: async ({ signer, digest, signature }) => {
        if (!validator) return false;
        return (await deps.readContract({ address: validator, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [signer, digest, signature] })) === true;
      },
    },
    now,
  });
  const policy = riskLadderPolicy({ discharge: { 'second-party-approval': { role: 'steward' } } });
  const receiptSink: ReceiptSink = {
    async record(r: StepReceipt) {
      await deps.audit.write({
        id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        action: `harness.step.${r.status}`, outcome: r.status === 'executed' || r.status === 'compensated' ? 'success' : r.status === 'denied' || r.status === 'failed' ? 'failure' : 'success',
        actor: { type: 'agent', id: (env.HARNESS_AGENT_SA ?? '').toLowerCase() },
        subject: { type: 'harness-step', id: `${r.runRef}:${r.stepRef}` },
        metadata: { toolId: r.toolId, risk: r.risk, capability: r.capability ?? null, mandateRef: r.authority?.presentedRef ?? null, decision: r.authority?.decision.decision ?? null, approvalRecords: r.approvalRecords ?? null, idempotencyKey: r.idempotencyKey ?? null, pendingInput: r.pendingInput ?? null, error: r.error ?? null },
      } as never);
    },
  };
  // AUTHORITY ALREADY IN HAND. A turn that presents a mandate is the turn AFTER a person granted one for
  // this ask — and re-planning from scratch let it drift to a different tool, so the grant bought nothing
  // and the person was told "I can't help with that" one step after being told it needed their signature.
  // Saying what the mandate covers is guidance, never authority: the verifier still judges the step, and a
  // plan that ignores this is refused by the same gates as any other.
  // The acting agent's playbook (spec 354 §4.3), loaded from ITS vault at admission and digest-verified.
  // Absent ⇒ the bare harness offers everything the surface allows; present ⇒ the Ask offers only what
  // the archetype knows how to do, and the planner is told what it IS.
  const playbook = await loadPlaybook(deps.readSubjectRecord, String(input.addressee ?? '')).catch(() => null);
  const first = Array.isArray(input.presented) ? input.presented[0] ?? null : input.presented;
  const holding = first ? mandateCapabilityWords(first) : null;
  const systemPrompt = holding
    ? `${ASK_PLANNER_SYSTEM}

The person has ALREADY granted authority to ${holding} for this exact ask. That is the capability to use; do not choose another, and do not choose ask.unsupported.`
    : ASK_PLANNER_SYSTEM;
  /**
   * COMPILED FAN-OUT — spec 358 W4 by way of spec 355's rule: compile, don't interpret. "Pay every
   * member 1 usdc" has exactly one correct plan — enumerate the members, then the payment once with
   * forEach — and a plan with one correct shape should not depend on a model choosing to emit two tool
   * calls (live, it emitted one and the composer PROMISED the payments instead). The canonical shape
   * compiles; the model plans everything the compiler does not claim.
   */
  // THE COMPILED READ-PLANS (the latency program's planner half). Three model calls in sequence is the
  // whole ~28s of a conversational read; the first — the planner deciding "who are the members" means
  // the membership tool — is a decision a REGEX makes identically every time. Same doctrine as
  // compiledFanOut below: the match is deterministic and decided BEFORE any planner runs, and anything
  // it does not confidently match falls through to the model unchanged. These are READS: no capability,
  // no mandate, so a wrong match costs a wrong tool's honest refusal, never an unauthorized act.
  const compiledRead = (goal: string): Plan | null => {
    const g = goal.toLowerCase();
    // Spec 371 — a balance is the chain's figure now, never a sum of receipts. "what is my balance", "how
    // much does alice2.treasury hold", "how much money does missio nexus have" → the balance read, with the
    // account phrase for the party resolver (or none: the asker's own treasuries).
    if (/\b(balance|how much (money|usdc|funds)?|what do (i|we) (hold|have)|funds)\b/.test(g) && !/\b(pay|send|transfer|receipts?|payments?|history)\b/.test(g)) {
      const m = goal.match(/\b(?:of|in|does|do|for)\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .'-]*?)\s*(?:hold|have|has|holds|currently)?\s*[?.!]*$/i);
      const phrase = (m?.[1] ?? '').replace(/\s+(treasury|account|wallet|organization|org)$/i, '').trim();
      const account = phrase && !/^(i|we|my|our|it|there|this|that|you|money|usdc|funds|balance)$/i.test(phrase) ? phrase : undefined;
      return { steps: [{ toolId: BALANCE_READ_TOOL.id, args: account ? { account } : {} }], rationale: 'compiled: balance read (spec 371)' };
    }
    if (/\bmembers?\b.*\b(of|on|in)\b|\bwho (are|is|belongs)\b.*\bmembers?\b|\bwho belongs\b/.test(g)) {
      // THE ORGANIZATION THE SENTENCE NAMES travels with the step. This plan used to carry no args, so
      // the roster read fell to the addressee: asked at alice.me, "how many members are in Missio Nexus"
      // read ALICE's own roster and answered "none listed" — while the same words at the org's own
      // surface listed four. The phrase is resolved by `resolveStepArgs` in the asker's private tier
      // (the `org` party role), or asked; nothing here decides which agent it is.
      const org = orgPhraseOf(goal);
      return { steps: [{ toolId: MEMBERSHIP_LIST_TOOL.id, args: org ? { org } : {} }] };
    }
    // "What teams am I on / which circles do I belong to" — the person's own links by TYPE. The type word
    // is the ontology's own suffix vocabulary (ADR-0061), read from the sentence; nothing else is decided.
    const aff = affiliationAskOf(goal);
    if (aff) return { steps: [{ toolId: AFFILIATIONS_LIST_TOOL.id, args: aff.type ? { type: aff.type } : {} }] };
    if (/\b(what|which|how many)\b.*\b(kinds?|types?|records?)\b.*\b(hold|have|vault|keep)|\brecords? (do|does) .* hold\b/.test(g)) {
      return { steps: [{ toolId: VAULT_QUESTION_TOOL.id, args: { question: goal } }] };
    }
    if (/\b(my|our)\b.*\breceipts?\b|\breceipts?\b.*\b(do i|have i|my)\b/.test(g)) {
      return { steps: [{ toolId: VAULT_QUESTION_TOOL.id, args: { question: goal } }] };
    }
    return null;
  };

  const compiledFanOut = (goal: string): Plan | null => {
    const g = goal.toLowerCase();
    if (!/\b(pay|send)\b/.test(g) || !/\b(each|every|all)\b[\s\S]{0,40}\bmembers?\b/.test(g)) return null;
    const amount = g.match(/(\d+(?:\.\d+)?)\s*usdc/)?.[1];
    const org = orgPhraseOf(goal);
    return {
      steps: [
        { toolId: MEMBERSHIP_LIST_TOOL.id, args: org ? { org } : {}, ref: 'roster', id: 's0' },
        // No amount ⇒ the argument is OMITTED and the capability asks — never a placeholder (§3.5).
        { toolId: 'treasury.payment.execute', args: { payee: { $item: 'agent' }, ...(amount ? { usdc: amount } : {}) }, id: 's1', forEach: { ref: 'roster.members' } },
      ],
      rationale: 'compiled: per-member payment (spec 358 W4)',
    };
  };

  // ONE PAYMENT, one correct plan (spec 355: compile, don't interpret). "send 10 usdc to David" is the
  // payment capability with the payee's WORDS and the amount as said — and live, a model given a bare
  // first name chose the household lookup instead (a read that ends with "nothing was sent"), despite
  // that tool saying in its own description never to be used that way. The shape is deterministic, so
  // it is compiled; who "David" is stays the resolver's question (private tier, or ask). The fan-out
  // form ("every member") is matched first and excluded here.
  const compiledPayment = (goal: string): Plan | null => {
    const p = paymentAskOf(goal);
    return p ? { steps: [{ toolId: 'treasury.payment.execute', args: { ...(p.payee ? { payee: p.payee } : {}), ...(p.usdc ? { usdc: p.usdc } : {}), ...(p.memo ? { memo: p.memo } : {}) } }], rationale: 'compiled: single payment (spec 355)' } : null;
  };

  // Fan-out guidance (spec 358 W4) — appended to whichever prompt applies. The form is taught, the
  // SAFETY is not delegated to the model: the loop refuses a forEach over anything the producing tool
  // does not declare enumerable, the ontology binding caps the count, and every item re-enters the
  // verifier — a mandate per payment, exactly as if the person had asked N times.
  const fanOutPrompt = `${systemPrompt}

FOR EVERY / FOR EACH asks ("pay every member of X 2 usdc") are the ONE case where you emit TWO tool
calls, BOTH IN THIS SAME RESPONSE, in order:
  1. organization.membership.list with arguments {"$ref": "roster"} — it enumerates the members.
  2. the per-item capability ONCE — for a payment: treasury.payment.execute with
     {"$forEach": "roster.members", "payee": {"$item": "agent"}, "usdc": "<the amount asked>"}.
The runtime expands call 2 into one act per member, each separately authorized. Do NOT list members
yourself, do NOT emit one call per member, and never fan out over anything except what a tool
enumerates. "Choose the tool" above means one CAPABILITY — this two-call form is still one capability,
fanned out.

A step that should happen ONLY IF an earlier read found something adds {"$when": {"ref": "<name>.<path>",
"exists": true}} (or "exists": false for the other branch) to its arguments — the runtime takes or skips
it from that result; do not plan two alternatives and hope. Reads that need nothing from each other may
be emitted together; the runtime runs them side by side.`;
  // The playbook's own words lead: an agent set to an archetype is TOLD what it is before the rules of
  // asking. Rendered from the compiled definition (spec 354) — versioned and receipted, never a silent
  // prompt edit.
  // Spec 367 W2 — THE SKILL'S OWN EXAMPLES teach the planner. Each contract's utterances, positive and
  // negative, rendered once as few-shot; the same fixtures are the scenario eval set. Absent ⇒ nothing
  // is rendered (an archetype with no examples plans from descriptions, as before).
  const examples = playbook ? utteranceExamples(Object.values(playbook.tools ?? {})) : '';
  const withPlaybook = playbook ? `${playbook.instructions}\n\n---\n\n${fanOutPrompt}${examples}` : fanOutPrompt;
  const selected = selectPlanner(env as never, { systemPrompt: withPlaybook });
  // The compiler answers for the shapes it claims; the model answers for the rest. Not a fallback pair
  // (ADR-0013): the match is deterministic and decided BEFORE any planner runs, the way a rule-based
  // planner rule would be.
  // Spec 367 wave 1 — the trace starts here: which planner actually proposed, and what it could see.
  // A RESUME plans nothing (spec 370 P1): the checkpoint holds the plan this intent was admitted with, and
  // the loop takes it from `resume` — this planner is never consulted on that path. Named so the trace
  // says where the plan came from.
  let plannerUsed: PlannerTraceV1['planner'] = input.resume ? 'checkpoint' : input.plan ? 'supplied' : selected.kind;
  const planner: Planner = input.plan
    // The screen's plan verbatim — interpretation is what Ask ADDS in front of the same boundary, not a
    // toll every caller pays. One-shot: a failed supplied step is the caller's to correct, not a model's
    // to re-plan around (re-planning a click would act on something nobody clicked).
    ? { plan: async () => ({ steps: input.plan!.steps }) }
    : {
        plan: async (pin) => {
          const compiled = compiledRead(pin.intent.goal) ?? compiledFanOut(pin.intent.goal) ?? compiledPayment(pin.intent.goal);
          if (compiled) { plannerUsed = 'compiled'; return compiled; }
          plannerUsed = selected.kind; return selected.planner.plan(pin);
        },
      };
  const kind = input.plan ? 'supplied' : selected.kind;
  const trace: PlannerTraceV1 = {
    planner: plannerUsed, toolsExposed: [], playbook: playbook ? { archetypeId: playbook.archetypeId, archetypeVersion: playbook.archetypeVersion, digest: playbook.digest } : null,
    promptDigest: keccak256(toBytes(withPlaybook)), examplesRendered: (examples.match(/^- /gm) ?? []).length,
    admission: [], plan: [], bindings: [],
    ...(input.surface || input.channel ? { surface: { ...(input.surface?.realm?.kind ? { realm: input.surface.realm.kind } : {}), ...(input.surface?.capabilities ? { capabilities: input.surface.capabilities.length } : {}), ...(input.channel ? { channel: input.channel } : {}) } } : {}),
  };
  // What the harness may compose: the PUBLIC agent directory (read-only, through discovery — ADR-0040)
  // and the action tools, each declaring the capability and risk that decide whether it needs authority.
  // The private-vault tools are NOT here: they ride their own delegation on the orchestrate skill, and an
  // Ask is not a way around it. Nothing on this list writes to the knowledge base — the indexer is its
  // only writer, and a fact the chain does not have is a fact discovery must not be told.
  // ACTIONS FIRST. The planner picks one tool; when an ask is "do this", a directory read listed ahead of
  // the capability that does it is a plausible-looking answer to a question nobody asked.
  // Membership is a QUESTION, and its answer is private — so it sits with the informational tools (no
  // mandate, nothing changes) rather than among the capabilities, and it is offered whatever the surface
  // declared: a scope narrows what may be DONE, never what may be asked.
  // `kb.question` is offered only where a model can write the query (spec 357 W3). Listing a tool the
  // agent cannot run would have the planner pick it and the step fail — and a tool that degraded to a
  // keyword search instead would answer a different question than the one it advertised (ADR-0013).
  const tools = [
    ...scopedActionTools(input.surface, playbook), ...ASK_DISCOVERY_TOOLS,
    ...(kbQuestionAvailable({ call: structuredCallFor(env as never) }) ? [KB_QUESTION_TOOL] : []),
    // The asker's OWN records (spec 356 W2). Needs a model to choose from the survey AND the survey seam
    // itself — absent either, it is not listed rather than listed and broken.
    ...(vaultQuestionAvailable({ call: structuredCallFor(env as never) }, deps) ? [VAULT_QUESTION_TOOL] : []),
    MEMBERSHIP_LIST_TOOL,
    // What became of an organization's invitations — accepted, waiting, declined, expired.
    ...(deps.survey && deps.readRecords ? [INVITATIONS_LIST_TOOL] : []),
    // What the asker is PART OF, by agent type (ADR-0061) — their own links, private tier.
    ...(deps.readSubjectRecord ? [AFFILIATIONS_LIST_TOOL] : []),
    // Spec 371 — the balance read: what an account holds now, on chain, in the person's unit.
    ...(deps.valueHeld ? [BALANCE_READ_TOOL] : []),
    // Spec 370 P4 — the organization's work, read through the same record the Home's Work surface reads.
    ...(deps.readSubjectRecord ? COORDINATION_READ_TOOLS : []),
    // The person's own access audit — informational, always available on their own surface.
    ...(deps.readGrants ? [ACCESS_LIST_TOOL] : []),
    ...(deps.readSubjectRecord ? [PROFILE_READ_TOOL, HOUSEHOLD_READ_TOOL] : []),
    UNSUPPORTED_TOOL,
  ];
  const localInvoke = harnessInvoker(deps, env, presentedList, input.mcpInvoke, input.person, input.session, input.surface, input.addressee, playbook);
  trace.toolsExposed = tools.map((t) => t.id);
  // Spec 367 §5 — THE EXECUTION BINDING on every receipt: the intent digest, the person, the agent the step
  // is about, the resource and authority it names, the outcome class it was expected to establish, its
  // stable operation identity, and where each party came from. Evidence only; no gate reads it.
  const intentDigest = keccak256(toBytes(JSON.stringify({ goal: input.intent.goal, addressee: input.addressee ?? null, asker: input.person ?? null })));
  const bindingFor = (rs: ResolvedStep): ExecutionBindingV1 => {
    const sourceOf = (v: unknown): NonNullable<ExecutionBindingV1['argSources']>[string] => {
      const low = String(v ?? '').toLowerCase();
      const hit = [...resolved.values()].find((r) => r.agent.toLowerCase() === low);
      if (!hit) return 'said';
      return hit.via === 'context' ? 'context' : hit.ruleId ? 'decision' : hit.hint?.startsWith('remembered') ? 'memory' : hit.ownedBy ? 'disclosed' : /^0x[0-9a-f]{40}$/i.test(hit.raw) ? 'said' : 'resolver';
    };
    const parties = Object.entries(rs.args).filter(([, v]) => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v));
    const subjectArg = rs.tool.subject ? rs.args[rs.tool.subject] : undefined;
    return {
      intentDigest, ...(input.person ? { principal: input.person.toLowerCase() } : {}),
      ...(typeof subjectArg === 'string' ? { subject: subjectArg.toLowerCase() } : {}),
      ...(rs.capability.resource ? { resource: rs.capability.resource } : {}),
      ...(rs.capability.authority ? { authority: rs.capability.authority } : {}),
      expectedOutcome: outcomeClassOf(rs.tool),
      operationId: rs.idempotencyKey ?? `${rs.runRef}:${rs.stepRef}`,
      ...(parties.length ? { argSources: Object.fromEntries(parties.map(([k, v]) => [k, sourceOf(v)])) } : {}),
      ...(input.inResponseTo ? { correlation: { inResponseTo: input.inResponseTo } } : {}),
    };
  };
  const result = await runIntent(input.intent, {
    planner, tools, bindingFor,
    ...(input.resume ? { resume: input.resume } : {}),

    // Spec 366 R1 — a step ABOUT ANOTHER AGENT is answered by that agent. The tool declares which argument
    // names its subject; the resolver has already turned the person's words into an address in THEIR
    // tier; if that address is not the agent addressed, the step goes to the subject's own harness with
    // the asker's session, and what comes back is the subject's own answer (or its refusal, in its
    // words). The local invoker never reads another principal's records for a routed step.
    invoke: async (toolId, args, ctx) => {
      const tool = tools.find((t) => t.id === toolId);
      const subject = routedSubjectFor(tool, args, input.addressee);
      if (!subject) return localInvoke(toolId, args, ctx);
      if (!deps.askSubjectAgent) {
        return { refused: `this agent cannot ask ${subject} — agent-to-agent asks are not wired here`, via: { agent: subject } };
      }
      const stepRef = ctx.step.id ?? `s${ctx.index}`;
      const answer = await deps.askSubjectAgent({
        subject, toolId, args, goal: input.intent.goal, ...(input.person ? { asker: input.person } : {}), ...(input.session ? { session: input.session } : {}),
        // R: this step's stable operation identity, for the receiver to name in S (spec 367 §8).
        correlation: { operationId: `${input.runRef ?? 'run'}:${stepRef}`, runRef: input.runRef ?? 'run', stepRef, intentDigest },
      });
      const who = answer.via.name ? `${answer.via.name} (${subject})` : subject;
      if (!answer.ok) {
        return { refused: answer.refused ?? `${who} did not answer`, via: answer.via, note: `${who}'s own agent was asked and answered this way; relay its words, do not retry or guess.` };
      }
      const r = (answer.result && typeof answer.result === 'object') ? (answer.result as Record<string, unknown>) : { result: answer.result };
      return { ...r, via: answer.via, note: `${String(r.note ?? '')} Answered by ${who}'s own agent — say so in one clause.`.trim() };
    },
    // WHAT WAS DECIDED FOR THE PERSON, onto the receipt (spec 363 W6). The resolver reports each party it
    // decided rather than asked, WITH the rule that answered; this hands those to the loop for the step
    // they belong to, so a run can be audited for its decisions and not only for its authority.
    decisionsFor: (toolId, args) => [...resolved.values()]
      .filter((r) => r.pointId && r.ruleId && r.because && Object.values(args).some((v) => String(v).toLowerCase() === r.agent.toLowerCase()))
      .map((r) => ({ point: r.pointId!, ruleId: r.ruleId!, arg: r.arg, chose: r.agent, because: r.because! })),
    // The person's words become this substrate's own ONCE, before the capability is extracted, before the
    // verifier judges the step and before any invoker reads an argument. Anywhere later and the run is
    // judging "alice2.treasury" against an allowlist of addresses.
    // The stepRef is a placeholder: the loop stamps the real one onto any question this raises, because
    // only the loop knows which step it was normalising for.
    normalizeArgs: ({ toolId, tool, args }) => resolveStepArgs(args, env, { ...deps, ...(input.session ? { session: input.session } : {}), onResolved: (r) => {
      // The SAME party can be reported twice — once resolved from words or from the asker's own tree, and
      // once again as the plain address it now is. Keep whichever knows its name: overwriting a labelled
      // record with a bare address is how "nathan.treasury" became "0x2c47…" on the card a person reads
      // before signing.
      const key = `${r.arg}:${r.agent}`;
      if (r.label || !resolved.has(key)) resolved.set(key, r);
    } }, {
      stepRef: 'pending', toolId, ...(tool.capability?.id ? { capabilityId: tool.capability.id } : {}),
      // A SCREEN'S OWN PLAN may state base units; a planner may not (see the unit guard above).
      ...(input.plan ? { computedUnits: true } : {}),
      // What this capability lets the substrate decide rather than ask (spec 363 W5).
      ...(tool.decisions?.length ? { consults: tool.decisions } : {}),
      // WHOSE authority this step spends — declared by the tool, never inferred from the sentence.
      ...(tool.capability?.authorityArg ? { authorityArg: tool.capability.authorityArg } : {}),
      ...(input.person ? { subject: input.person } : {}),
      // Spec 367 §7 / 361 I6 — the validated application context a party may be filled from.
      ...(input.addressee ? { addressee: input.addressee } : {}),
      ...(input.surface?.realm?.kind ? { realmKind: input.surface.realm.kind } : {}),
      ...(input.surface?.selection ? { selection: input.surface.selection } : {}),
      // The tool's OWN declaration of what it cannot work without — asked for, never inferred.
      required: (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    }),
    ports: {
      events: (e) => {
        if (e.type === 'PlanRefused') trace.admission.push({ refused: e.violations, replanned: e.replanning });
        else if (e.type === 'PlanCreated') trace.admission.push({ refused: [], replanned: false });
        if (input.onProgress) {
          const line = progressLine(e, tools, (id) => CAPABILITY_WORDS[id]);
          if (line) input.onProgress(line);
        }
      },
      mandateVerifier: verifier, policyEvaluator: policy,
      approvalPort: suppliedApprovalsPort(deps, env, input.approvals ?? [], input.supplied, input.person), receiptSink,
      // PLAN ADMISSION (spec 367 W1) — the plan's SHAPE, judged from declarations before any step runs:
      // an instruction must be answered by an act (`verbs` on the action tools); a placeholder is not an
      // argument; a step whose tool declares a `subject` may not leave it empty when the sentence names
      // an agent the asker KNOWS (their own links — private tier, never the directory). Refused ⇒ one
      // re-plan told why ⇒ refused in words. The verifier still judges every admitted step.
      planAdmission: planAdmission([
        instructionNeedsAct,
        noPlaceholders,
        dependenciesProvided,
        branchesDecidable,
        questionAnsweredByRead,
        subjectNamedInAsk(async () => {
          if (!input.person || !deps.readSubjectRecord) return [];
          const doc = await deps.readSubjectRecord(input.person, 'relationships.data').catch(() => null);
          return relationshipRows(doc).map((r) => ({ name: r.name, agent: r.agent }));
        }),
      ]),
      // spec 360 — what the playbook promised FOLLOWS a successful step. Isolated by the loop: an effect
      // that cannot be delivered never fails the act that produced it.
      effectSink: declaredEffectSink(
        {
          ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}),
          ...(deps.sendDirectMessage ? { sendDirectMessage: deps.sendDirectMessage } : {}),
          ...(deps.nameOf ? { nameFor: deps.nameOf } : {}),
          // WHO A RECEIPT IS TOLD TO, asked of the run's OWN resolution record first.
          //
          // "Send bob 2 usdc" reaches an UNNAMED treasury of bob's — unnamed means unlisted (spec 338),
          // so there is no public edge to read and the chain honestly answers nothing. But this run
          // already knows whose it is: it got there through a grant bob issued or a link bob published,
          // and the resolver recorded that as `ownedBy`. These are two different questions — "who
          // disclosed this agent to me" and "who does the public record say holds it" — and for telling
          // somebody their treasury was paid, the first is the right one and the only one that answers
          // for an unlisted agent. The payment then went through and NOBODY was told, which is the exact
          // silence spec 360 exists to end.
          ownerOf: async (agent: string) => {
            const low = agent.toLowerCase();
            const known = [...resolved.values()].find((r) => r.agent.toLowerCase() === low && r.ownedBy);
            if (known?.ownedBy) return known.ownedBy.toLowerCase();
            return deps.ownerOf ? deps.ownerOf(low) : null;
          },
        },
        { ...(input.session ? { session: input.session } : {}), ...(env.MOCK_USDC ? { usdc: env.MOCK_USDC } : {}), ...(input.person ? { person: input.person } : {}) },
      ),
    },
    // WHOSE PLAYBOOK DECLARES WHAT FOLLOWS — spec 360, resolved PER STEP.
    //
    // An effect follows THE ACT, so it is declared by the agent whose authority the act spends: a
    // payment's receipt belongs to the treasury whose funds moved. Reading it from the ADDRESSEE would
    // tie every consequence to whichever agent the person happened to be talking to — and in the Home's
    // Ask that is their own person agent, which is never the treasury a Treasury archetype applies to.
    // That is why "money moved and nobody was told" survived the first cut of this feature.
    //
    // So: the step's declared `authorityArg` names the agent spending authority; its playbook is loaded
    // and asked. The addressee's own playbook is the fallback for steps that spend nobody else's.
    declaredEffects: async (capabilityId, step) => {
      const authorityArg = step.tool.capability?.authorityArg;
      const actor = authorityArg ? String(step.args?.[authorityArg] ?? '') : '';
      if (/^0x[0-9a-fA-F]{40}$/.test(actor) && actor.toLowerCase() !== String(input.addressee ?? '').toLowerCase()) {
        const theirs = await loadPlaybook(deps.readSubjectRecord, actor).catch(() => null);
        if (theirs?.declaredEffects?.[capabilityId]?.length) return theirs.declaredEffects[capabilityId]!;
      }
      return playbook?.declaredEffects?.[capabilityId] ?? [];
    },
    presented,
    // The keyring's selector: a payment step is judged under the mandate whose PaymentEnforcer caveat
    // names its payee. Selection reads a caveat; it verifies nothing — the verifier still judges the one
    // selected mandate alone (ADR-0013: one mechanism, deterministically chosen).
    selectPresentation: (rs, all) => selectByPayee(rs, all, enforcers.payment),
    // Which relations a plan may FAN OUT over — the ontology's plan-shapes binding, injected so the loop
    // stays domain-free. Absence fails closed in the loop.
    fanOut: (relation) => {
      const b = fanOutBindingFor(relation);
      return b ? { maxItems: b.maxItems } : null;
    },
    // ALWAYS report, never throw (spec 358 W4-tail): a step whose authority is not present — nothing
    // presented at all, OR a keyring that holds no key for THIS payee — is one the caller resolves by
    // coming back with the mandate. Throwing `no_mandate_presented` stranded a fan-out the moment it
    // reached its second payee, whose mandate had not been minted yet. Reporting names the step and its
    // args; the surface mints exactly that and resumes.
    onMissingMandate: 'report' as const,
    // Spec 354 §4.5 — the playbook that admitted this run (canonical id + version + definition digest),
    // stamped onto every receipt by the loop. Absent ⇒ the bare harness; receipts carry no skillRef.
    ...(playbook ? { skillRef: { skillId: playbook.archetypeId, version: playbook.archetypeVersion, commitment: playbook.digest } } : {}),
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    now,
  });
  // Spec 361 I2 — the interaction bindings of the tools this run OFFERED (contract-merged), keyed by
  // capability id, so the reply can say where its outcome lives. Display data; decides nothing.
  const interactionFor: Record<string, NonNullable<ToolSpec['interaction']>> = {};
  for (const t of tools) if (t.interaction) interactionFor[t.capability?.id ?? t.id] = t.interaction;
  trace.planner = plannerUsed;
  trace.plan = result.plan.steps.map((s) => ({ toolId: s.toolId, args: s.args }));
  trace.bindings = [...resolved.values()].map((r) => ({
    arg: r.arg, raw: r.raw, agent: r.agent, ...(r.label ? { label: r.label } : {}),
    source: r.via === 'context' ? 'context' : r.ruleId ? 'decision' : r.hint?.startsWith('remembered') ? 'memory' : r.ownedBy ? 'disclosed' : /^0x[0-9a-f]{40}$/i.test(r.raw) ? 'said' : 'resolver',
    ...(r.because ? { because: r.because } : {}),
  }));
  return { result, plannerKind: kind, resolved, interactionFor, trace, tools, playbook: playbook ? { digest: playbook.digest, ...(playbook.triggers?.length ? { triggers: playbook.triggers } : {}) } : null };
}
