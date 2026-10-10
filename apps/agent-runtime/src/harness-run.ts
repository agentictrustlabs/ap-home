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
import { contractsGenerationOf, type ContractsGeneration } from '@agenticprimitives/agent-account';
import { CONTACT_FIELDS, CONTACT_FIELD_ARGS, ONTOLOGY_MANIFEST_DIGEST, OUTCOME_CLASSES, outcomeClassOf as ontologyOutcomeClassOf } from '@agenticprimitives/ontology';
import { bindSelectedOffer, type SelectedOfferBindingV1 } from './engagement-campaign.js';
import { classifyProviderFailure } from './provider-outage.js';
import type { TriggerV1 } from '@agenticprimitives/capability-claims';
import { BALANCE_READ_TOOL, BALANCE_READ_CAPABILITY, balanceReadInvoker, renderAnswer } from './balance-read.js';
import { HOLDINGS_READ_TOOL, HOLDINGS_READ_CAPABILITY, holdingsReadInvoker } from './holdings-read.js';
import { EXTERNAL_AGENT_TOOL } from './external-agent.js';
import { PLAYBOOK_ANSWER_TOOL, playbookAnswerAvailable, playbookAnswerInvoker, type PlaybookMaterial } from './playbook-answer.js';
import { instructionSkillTools, instructionSourcesOf, skillApplyInvoker, skillReaderFor } from './skill-apply.js';
import { appendNote, dayRecordsFor, reviewDaysOf, studyFrom, studyRecords, type StudyAccess } from './card-room.js';
import { memoryRecordFor } from './playbook-memory.js';
import { remembered, forget } from './run-memo.js';
import { DISCOVERY_FIND_TOOL, ENGAGEMENT_INVOKE_TOOL, DISCOVERY_INSPECT_TOOL, DISCOVERY_FIND_CAPABILITY, ENGAGEMENT_INVOKE_CAPABILITY, discoveryFindInvoker } from './enterprise-tools.js';
import { WAITING_LIST_TOOL } from './waiting-on-me.js';
import { INVITATIONS_RECEIVED_TOOL, MEMBERSHIP_ACCEPT_TOOL, MEMBERSHIP_ACCEPT_CAPABILITY, membershipAcceptInvoker } from './invitations-received.js';
import { PERSON_ROLES_TOOL, type OrgMembershipAnswer } from './member-roles.js';
import { MEMBER_ROLE_SET_TOOL, MEMBER_ROLE_SET_CAPABILITY, memberRoleSetInvoker } from './member-role-set.js';
import type { RoleOfferV1 } from './org-role.js';
import { SECURITY_READ_TOOLS, SECURITY_ACT_TOOLS, isSecurityTool, securityInvoker, securityChainDeps } from './security-tools.js';
import { INBOX_LIST_TOOL, inboxListInvoker } from './inbox-list.js';
import { WORK_SEARCH_TOOL, workSearchInvoker } from './work-search-tool.js';
import { GITHUB_TOOLS, GITHUB_ACTS, githubInvoker } from './connectors/github-tools.js';
import { CALENDAR_TOOLS, CALENDAR_ACTS, calendarInvoker } from './connectors/calendar-tools.js';
import { MAIL_DRIVE_TOOLS, MAIL_DRIVE_ACTS, mailDriveInvoker } from './connectors/mail-drive-tools.js';
import { connectorStatus } from './connectors/google-token.js';
import { MEMORY_TOOLS, MEMORY_ACTS, MEMORY_LIST_TOOL, MEMORY_REMEMBER, memoryFactsInvoker, memoryProposalFor, connectorMemoryProposal } from './memory-facts-tools.js';
import { ROUTINE_TOOLS, ROUTINE_ACTS, ROUTINE_LIST, routineInvoker, compiledRoutine } from './routine-tools.js';
import { WEB_TOOLS, webReadInvoker } from './web-read.js';
import { WEB_SEARCH_TOOLS, webSearchInvoker } from './web-search.js';
import { BUILD_TOOLS, BUILD_ACTS, buildInvoker } from './build-tools.js';
import { executorInvokeInvoker, readExecutors, type ExecutorSessionSeam } from './executor-invoke.js';
import { LIBRARY_TOOLS, LIBRARY_ACTS, libraryInvoker, stewardshipOver } from './library-tools.js';
import { MCP_CONNECTOR_PREFIX, MCP_CONNECTORS_LIST, MCP_CONNECTORS_LIST_TOOL, isMcpTool, isMcpConnectorRecord, mcpConnectorTools, mcpConnectorInvoker, type McpConnectorRecordV1 } from './connectors/mcp-connector.js';
import { PREFERENCES_TOOLS, PREFERENCES_ACTS, PREFERENCES_GET, preferencesInvoker } from './preferences-tools.js';
import type { TriggerScheduleV1 } from './triggers.js';
import { factsForPrompt, factsOf, type RememberedFactsV1 } from '@agenticprimitives/context';
import { CONTACT_INVITE_TOOL, CONTACT_LIST_TOOL, CONTACT_REMOVE_TOOL, contactInviteInvoker, contactListInvoker, contactRemoveInvoker, type ContactDeps } from './contacts.js';
import { STANDARD_SURFACE_SKILL } from '@agenticprimitives/a2a/standard';
import { MEMBER_CONSULT_TOOL, consultAskOf } from './member-consult.js';
import { ENGAGEMENT_PROBE_TOOL } from './engagement-probe.js';
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import { relationshipCredentialDigest, termsDigestOf, type RelationshipCredentialBodyV1 } from '@agenticprimitives/agent-relationships';
import { replayingInvoker, inputsFor, type RunRecordV1, type RunMarks, type RunEvent, type CommitmentRefV1, externalExecutorsReadOnly, formatTraceparent, traceIdOf, spanIdOf, type TraceContextV1, fitEvidence, observed, isToolInvocationResult, reconcileByTool, type ReconcileRequest, type ReconcileAnswer, outcomeConformance, classifyOpenIntent , selectByDeclaredUtterances , selectByJudgment , selectByOntology, selectByOntologyThenJudgment, selectByProposalThenJudgment, selectByOntologyFirst, type OntologyFirstSelectionV1, type AskerContextV1, selectByFramedJudgment, addUsage, judgeAnswerPreference, type ModelUsageV1, type OntologySelectionV1, type JudgmentSelectionV1, type FramedSelectionV1, type ProposedSelectionV1, selectByOutcome, outcomeSteps, type OutcomeSelectionV1, type OutcomePlanV1, planForPicked, type SelectivePlanV1, choosePlanAround } from '@agenticprimitives/orchestration';
import { holdModeOf, stepsUnderHold } from './skeleton-hold.js';
import { chainProceedModeOf, stepsUnderChainProceed } from './chain-proceed.js';
import { recentParties, conversationForPrompt, preferredChoice as pickPreferred, CONFIRMATION_RECORD, standingFor, declareInstruction, forgetInstruction, instructionContextOf, STANDING_RECORD, type ConversationMemoryV1, type ConfirmationPreferencesV1, type StandingInstructionsV1 } from '@agenticprimitives/context';
import { COORDINATION_READ_TOOLS, COORDINATION_ACTION_TOOLS, COORDINATION_CAPABILITY_IDS, ENDEAVOR_LIST_CAPABILITY, ENDEAVOR_GET_CAPABILITY, endeavorReadInvoker, endeavorActInvoker } from './coordination-bindings.js';
import { progressLine, type ProgressLineV1 } from './harness-progress.js';

// Spec 376 — the subset handlers (capability, payment) live in an ambient registry that nothing in this
// Worker populated: `readMandate` and `deriveMandate` answered null/refused for every mandate, and the
// first hand-off could not read the parent it held. Registered once, at load.
registerDefaultSubsetHandlers();
import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes, toFunctionSelector, type Address, type Hex } from 'viem';
import { type Plan, type Planner,
  runIntent, CONTINUE_STEP_ID, deriveArgs, type ArgDerivationV1, InputRequired, dataFor, signatureFor,
  type RunResult, type ToolSpec, type ToolInvoker, type ApprovalPort, type ReceiptSink, type StepReceipt, type MandatePresentation, type SuppliedInputV1, type InputFieldV1, type AnswerComposer, planAdmission, capabilitiesAvailable, instructionNeedsAct, noPlaceholders, subjectNamedInAsk, dependenciesProvided, branchesDecidable, questionAnsweredByRead, numbersFromTheWords, partiesDistinct, actingPartyFromTheWords, kindNamedIsChartered, completePlan, transitionsHold, type FactsV1, outcomeClassOf, type ExecutionBindingV1, type OutcomeClass, type ResolvedStep } from '@agenticprimitives/orchestration';
import { delegationMandateVerifier, riskLadderPolicy, mandateRequirementForStep, composeOfferedTools, mergeContractTool as composeMergeContractTool, loadPlaybook, declaredEffectSink, setBillStep, declaredCapabilities, type AskScopeV1 } from '@agenticprimitives/harness';
// Spec 353 — the scope schema is Ring 0 now (spec 399 §4); this app keeps exporting it for its callers.
export type { AskScopeV1 } from '@agenticprimitives/harness';
import {
  hashDelegation, intentDigest, encodeDigestBindingArgs, digestBindingStepNonce, decodeDigestBindingTerms, decodeTimestampTerms, buildCaveat, buildVaultRecordScopeCaveat,
  encodeTimestampTerms, encodeValueTerms, ROOT_AUTHORITY, CAPABILITY_RAR_TYPE, PAYMENT_RAR_TYPE,
  type Caveat, type Delegation, type EnforcerAddresses, type MandateRequirementV1, methodSelector, deriveMandate, readMandate, readDigestBindings, registerDefaultSubsetHandlers, NO_SEMANTICS_DIGEST, type VersionBindingV1, isStandingWire, decodeAllowedMethodsTerms } from '@agenticprimitives/delegation';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import { RELATIONSHIP_TYPE, ROLE } from '@agenticprimitives/agent-relationships';
import type { AuditSink } from '@agenticprimitives/audit';
import { enforcersFromEnv } from './org-wire.js';
import { wireToDelegation, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { routeProvider, routePolicy, meterFor, selectPlanner, selectComposer, defaultProvider, plannerPromptBudget, type LlmProvider, type RoutePolicy, type RouteDecision, type RouteNeed , RULE_BASED_PLANNER } from './orchestration.js';
import { ASK_DISCOVERY_TOOLS } from '@agenticprimitives/context';
import { recentToolsOf } from './ops-index.js';
import { structuredCallFor, textStreamFor, logprobChoiceFor, kbRetrievalMode, type StructuredCallRecordV1 } from './context-wiring.js';

/** Spec 415 A4 — the estate's retrieval mode, unless a comparison run toggled it (`retrieval/kb`). */
const kbModeOf = (env: { KB_RETRIEVAL?: string }, variant: HarnessRunInput['variant']): ReturnType<typeof kbRetrievalMode> => {
  const t = variant?.toggles?.['retrieval/kb'];
  return t === 'off' || t === 'tool' || t === 'playbook' ? t : kbRetrievalMode(env);
};
import type { DefinitionToolV1 } from '@agenticprimitives/capability-claims';
import { CATALOG_MCP_TOOL_NAMES, CATALOG_TOOLS, catalogBindingFor, catalogInvoker, isCatalogTool } from './catalog-tools.js';
import { PEOPLE_GROUP_MCP_TOOL_NAMES, PEOPLE_GROUP_TOOLS, isPeopleGroupTool, peopleGroupInvoker, servesProfile, toolsServedAt } from './people-group-tools.js';
import { playbookProvenanceFromReceipts } from './skill-provenance.js';
import { checkGroundedComposition, groundedFallback } from '@agenticprimitives/context';
import { KB_QUESTION_TOOL, kbQuestionAvailable, KB_RETRIEVE_TOOL } from '@agenticprimitives/context';
import { VAULT_QUESTION_TOOL, vaultQuestionAvailable } from '@agenticprimitives/context';
import { resolveParty, ownAgentsOfType, candidateHint, choicesFor, VALUE_ARGS, type PartyLookups } from '@agenticprimitives/context';
import { decide, PAYMENT_SOURCE_ACCOUNT, PAYMENT_RECIPIENT, argTypesFor, readValue, isFlagTrue } from '@agenticprimitives/ontology';
import { buildAskVocabulary, type AskCapabilityLike, type SurfaceCeremony, type SurfaceDescriptor, type SurfaceRiskTier } from '@agenticprimitives/surface-catalog';
import type { ResolvedParty } from '@agenticprimitives/context';
import { CAPABILITY_TRANSITIONS, SITUATION } from '@agenticprimitives/ontology';
const SITUATION_MEMBERSHIP = SITUATION.OrganizationMembership;
import { MEMBERSHIP_LIST_TOOL, membershipListInvoker, AFFILIATIONS_LIST_TOOL, affiliationsListInvoker, INVITATIONS_LIST_TOOL, invitationsListInvoker, relationshipRows } from '@agenticprimitives/context';
import { RESOLUTION_REQUEST_TOOL } from './resolution-invitation.js';
import { actionLink, resolutionRequestInvoker } from './resolution-request.js';
import { partyRole, suffixesFor, COUNTERPARTY_ARGS, PARTY_ROLES, SUFFIX_FOR_CLASS, CLASS_FOR_SUFFIX, fanOutBindingFor } from '@agenticprimitives/ontology';
import { decodePaymentTerms } from '@agenticprimitives/delegation';
import { preconditionRefusal } from './capability-preconditions.js';
import { AUTHORITY_BEARING_CAPABILITIES } from './endeavor-authority-steps.js';
import { deriveStanding, standingNote, type Standing, type StandingDeps } from '@agenticprimitives/context';
import { vaultServerId } from './vault-server-id.js';


export interface HarnessEnv {
  /** Spec 408 — the estate's contract generation ("1" pre-spec-408, "2" spec 408); absent ⇒ "1". */
  CONTRACTS_GENERATION?: string;
  /** Spec 426 — operator config for executor-invoke: a JSON map `executor-ref → { url, client }`. Absent ⇒ no
   *  executor is configured and every invoke capability refuses (fail-closed). */
  EXECUTORS?: string;
  /** Spec 415 A4 — the skills corpus (service binding to skills-mcp): where an INSTRUCTION skill's body is read, by the
   *  digest its playbook tool names, when the planner chooses it. Absent ⇒ instruction skills are not offered. */
  SKILLS_MCP?: Fetcher;
  /** Spec 416 §4f — `fast`: the fast judge picks among the playbook's instruction skills before the planner runs. */
  SKILL_SELECTION_DEFAULT?: string;
  /** Spec 416 §4h — `full`: the default skill stage tells the judge the asker's recent skills here and their memory
   *  (real asks only). Measured on seeded states: 18/19 vs 7/19 with standing alone. Off unless set. */
  SKILL_SELECTION_ASKER_CONTEXT?: string;
  /** Spec 397 W2 — the ARD registry this agent finds other agents in (`POST /search`); absent ⇒ no find tool. */
  ARD_REGISTRY_ORIGIN?: string;
  /** The Home origins this agent serves — the first is used for links a person can follow. */
  ALLOWED_ORIGINS?: string;
  CHAIN_ID: string;
  RPC_URL?: string;
  /** The deployment's vault server id (`vault-server-id.ts`); unset ⇒ demo-mcp. */
  VAULT_SERVER_ID?: string;
  DELEGATION_MANAGER: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  /** The SA this agent acts as under a mandate (the mandate's DELEGATE). Deployed per chain, custodied by the
   *  interactions-session key. Not INTERACTIONS_SERVICE_SA: that address is what existing grants name. */
  HARNESS_AGENT_SA?: string;
  DIGEST_BINDING_ENFORCER?: string;
  /** Spec 410 §7 — PayloadClassesEnforcer (generation 3); absent on an older estate. */
  PAYLOAD_CLASSES_ENFORCER?: string;
  /** Spec 410 §7 — TreasurySpendPolicy (generation 3): the Ask reads `remaining()` before a payment is offered for signature. */
  TREASURY_SPEND_POLICY?: string;
  PAYMENT_ENFORCER?: string;
  MOCK_USDC?: string;
  /** The AgentRelationship record — where `ap:charteredUnder` edges and their roles live. */
  AGENT_RELATIONSHIP?: string;
  [k: string]: unknown;
  /** Spec 410 §10 — the ontology manifest digest this ESTATE adopted by governance (apgov:AdoptedVersion); absent ⇒ the package's own. */
  ADOPTED_ONTOLOGY_MANIFEST_DIGEST?: string;
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
  // Spec 372 S3 — the Smart Agent an OUTSIDE RUNTIME acts as (Claude Code, Goose, a bot): a Service-class
  // agent chartered under a person or an organization. Chartering grants it nothing; a delegation does.
  { capability: 'service.create', tld: 'svc', noun: 'service agent', parentNoun: 'a person or an organization' },
  // ANOTHER PERSON OF THEIR OWN — person-class, `.me`-named, custodied by the same credential, and never
  // their default (`ap:DefaultPersonChoice`). A trail name, a pen name, a character in a game: each is a
  // person-shaped agent with its own card, its own vault and its own memory of the people it met under that
  // name. Chartered under the PERSON because that is whose it is; nothing above them exists to charter it.
  { capability: 'person.create', tld: 'me', noun: 'person', parentNoun: 'a person (their own realm)' },
] as const;

/** The KIND a created agent is recorded as in its owner's tree. Usually the noun; a treasury is named for
 *  WHOSE it is, because that is how the Home lists it (`person-treasury` under you, `org-treasury` inside
 *  the organization) — recording a bare "treasury" would put it in neither. */
export function recordedKind(noun: string, parent: string, person?: string): string {
  // The Home's tree kinds (`AgentKind`): a service agent is recorded as `service`, whatever the prose says.
  if (noun === 'service agent') return 'service';
  // A person of theirs is recorded as `person` — the one kind that is person-CLASS, so it lists under
  // "other people of yours" rather than among the things they steward.
  if (noun === 'person') return 'person';
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
/** Spec 394 — a STANDING INSTRUCTION: the person's declared default for one argument of one capability, per room. */
export const STANDING_INSTRUCTION_CAPABILITY = 'context.instruction.declare' as const;

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


export const ACCESS_AUDIT_CAPABILITY = 'access.grants.audit' as const;
/** Spec 400 W2 (B4) — ONE SCREEN OF EVERY GRANT an agent issued: apps (Home MCP connections among them), members,
 *  contacts, runtimes' standing grants, a coach's study grant — who holds it, what it permits, its digest, whether
 *  the chain says it is revoked. The ACL a peer platform shows, made of grants. For the asker's own agent or one
 *  they steward; a read, never authority. Revoke with `access.grant.revoke` naming the digest. */
export const ACCESS_AUDIT_TOOL: ToolSpec = {
  id: ACCESS_AUDIT_CAPABILITY,
  answers: ['every grant', 'all the grants', 'who holds a grant', 'what has this organization granted', 'what have I granted', 'grants issued', 'audit the grants'],
  description:
    'LISTS EVERY GRANT an agent has ISSUED that its records can enumerate — apps reading its records (Home MCP '
    + 'connections among them), members\' access delegations, contacts, standing grants to runtimes, a coach\'s study '
    + 'grant — each with who holds it, what it permits, its digest, when, and whether it is revoked on chain. Use for '
    + '"what has the organization granted", "every grant", "who holds a grant", "audit the grants". Args: subject '
    + '(optional — the organization whose grants, a name or address; omit for the asker\'s own). A read.',
  inputSchema: { type: 'object', properties: { subject: { type: 'string', description: 'Whose grants — an organization the asker stewards (name or address); omit for their own' } } },
  establishes: 'lookup',
  interaction: { navigationTarget: 'grants' },
};

export const INVITE_TOOL: ToolSpec = {
  id: ORG_INVITE_CAPABILITY,

  adapter: ADAPTER.sync, carries: CARRIES.membership,
  verbs: ['invite', 'add', 'bring'],
  // Spec 367 §6 — an invitation is recorded, never a membership: the invitee's joining establishes that.
  establishes: 'submission',
  description:
    'Invite an agent to join an organization or team as a member. Requires a mandate from the organization. '
    + 'Produces a signed access grant the invitee redeems when they join — it does NOT make them a member by itself. '
    + 'Args: org (the organization or team, as the ask names it — whose authority this needs), invitee (the person '
    + 'to invite, EXACTLY as the ask names them — a name, a typed name like carol.me, or an address; the agent '
    + 'resolves it, so never plan a directory lookup in its place). When the org is a '
    + 'HOUSEHOLD (spec 368), kin (spouse, child, parent, sibling) and role (member, guardian, dependent) ride on '
    + 'the invitation and onto the membership — the family\'s shared record of how they are related.',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The organization or team, as the ask names it (a name or an address)' },
      invitee: { type: 'string', description: 'The person to invite, as the ask names them (a name, a typed name, or an address)' },
      kin: { type: 'string', description: 'Household only — how the invitee is related to the household\'s founder: spouse | child | parent | sibling | a word of your own' },
      role: { type: 'string', description: 'Household only — member (default) | guardian | dependent' },
    },
    required: ['org', 'invitee'],
  },
  capability: { id: ORG_INVITE_CAPABILITY, action: 'invite', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium',
  // Spec 374 — the ORGANIZATION invites; the act runs at its own agent, whose steward signs its grant. An
  // ask about another organization is sent there (spec 366 R1, for acts), and the asker's run holds a
  // commitment until the organization's steward finishes it.
  subject: 'org',
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
/** Spec 418 — the selection stage's CLARIFY: when the pick splits between two skills, the answer asks which one the person
 *  means (naming each by its purpose) instead of declining. Planned only by the selection stage — never offered to a
 *  model planner (filtered out of what the planner sees). Informational; nothing is performed. */
export const ASK_CLARIFY_TOOL: ToolSpec = {
  id: 'ask.clarify',
  description: '(Selection stage only.) Ask the person which of two skills they mean. Never plan this tool.',
  inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' }, description: 'The two skill ids' }, purposes: { type: 'array', items: { type: 'string' }, description: 'Each skill\'s purpose, in words' }, what: { type: 'string', description: 'What was asked' } }, required: ['options'] },
  answer: '{{answer}}',
};

/** Spec 418 A2 — the classes a plan should deliver: each intermediate step's artifact, then the final skill's products. */
export function expectedDeliversOf(steps: ReadonlyArray<{ tool: string; for?: string }>, skills: ReadonlyArray<{ id: string; produces?: ReadonlyArray<{ iri: string; label: string; within?: string; alternative?: string }> }>, lexicon?: ReadonlyArray<{ iri: string; label: string; terms: readonly string[] }>): Array<{ iri: string; label: string; required?: boolean; alternative?: string }> {
  const out = new Map<string, string>();
  const alternative = new Map<string, string>();
  const required = new Set<string>();
  const gloss = (iri: string, label: string) => { const e = lexicon?.find((x) => x.iri === iri); const also = (e?.terms ?? []).filter((t) => t.toLowerCase() !== label.toLowerCase()).slice(0, 3); return also.length ? `${label} (also: ${also.join(', ')})` : label; };
  for (const st of steps.slice(0, -1)) if (st.for) { const lab = skills.flatMap((x) => x.produces ?? []).find((k) => k.iri === st.for)?.label ?? st.for.split('#').pop()!; out.set(st.for, gloss(st.for, lab)); required.add(st.for); }
  const last = steps[steps.length - 1];
  // A part of a whole the same skill produces (`within`) is not asked for on its own: the person asked for the whole.
  const made = skills.find((x) => x.id === last?.tool)?.produces ?? [];
  // 2026-10-02 — and a terminal product's ALTERNATIVE GROUP (the definition's `produces[].alternative`, from the data
  // graph's `skills:alternativeGroup`) rides along, so the outcome check (v3) scores the group once: the drafter writes a
  // Letter of Inquiry OR a Grant Proposal, and 51 of 68 grant runs on chain panels 1–4 lost ~⅓ for the one it never wrote.
  // Only the terminal skill's: an intermediate is a specific artifact the plan was built on, never "one of".
  for (const k of made) if (!(k.within && made.some((w) => w.iri === k.within))) { out.set(k.iri, gloss(k.iri, k.label)); if (k.alternative && !required.has(k.iri)) alternative.set(k.iri, k.alternative); }
  // The intermediate artifacts are REQUIRED (the plan was built on them); the terminal skill's products are candidates —
  // the outcome check asks which of them the request wants (spec 418 A2 v2).
  return [...out].map(([iri, label]) => ({ iri, label, ...(required.has(iri) ? { required: true } : {}), ...(alternative.has(iri) ? { alternative: alternative.get(iri)! } : {}) }));
}

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
  // Spec 400 W3/W4 — the forge's acts (a connector's; the playbook narrows who offers them).
  ...GITHUB_TOOLS.filter((t) => GITHUB_ACTS.has(t.id)),
  ...CALENDAR_TOOLS.filter((t) => CALENDAR_ACTS.has(t.id)),
  ...MAIL_DRIVE_TOOLS.filter((t) => MAIL_DRIVE_ACTS.has(t.id)),
  // Spec 398 §9 / ap-build B3 — a build run: the WORKSPACE's act, done in the Build service's sandbox.
  ...BUILD_TOOLS.filter((t) => BUILD_ACTS.has(t.id)),
  // Spec 402 W1 — memory that follows the person: remember / forget, self-acting (a note about herself, in her vault).
  ...MEMORY_TOOLS.filter((t) => MEMORY_ACTS.has(t.id)),
  // Spec 421 — accepting an invitation: the invitee's own act; her Home runs the Join ceremony, her records say it happened.
  MEMBERSHIP_ACCEPT_TOOL,
  // Spec 427 — a steward sets what a member does in the organization: the organization's act, under its mandate.
  MEMBER_ROLE_SET_TOOL,
  // Spec 422 §9.1 — the Security section's acts: add a credential (a ceremony her Home runs under her credential), rename one,
  // link / unlink an email or phone. Self-acting: her own account, her own vault; her Home runs the ceremony, her records say.
  ...SECURITY_ACT_TOOLS,
  // Spec 412 W5 — her Library, written by her agent: save / visibility / publish, self-acting (her own records).
  ...LIBRARY_TOOLS.filter((t) => LIBRARY_ACTS.has(t.id)),
  // Spec 402 W3 — a routine of the person's own, from a sentence: declare / remove, self-acting (her own clock).
  ...ROUTINE_TOOLS.filter((t) => ROUTINE_ACTS.has(t.id)),
  // Spec 403 W2/W4 — her preferences (how her agent answers and reaches her), self-acting.
  ...PREFERENCES_TOOLS.filter((t) => PREFERENCES_ACTS.has(t.id)),
  {
    id: 'treasury.payment.execute',

    adapter: ADAPTER.chain, carries: CARRIES.payment,
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
      // NAMED AS THE PROPERTY IS NAMED. `required` said `amount` after the property became `usdc`; the
      // loop's alternatives (amount ⇄ usdc) hid it, and Gemini refused the whole vocabulary — "schema
      // at top-level requires unspecified property 'amount'" — so every ask on that provider failed
      // before a word was read. A required name that no property declares is an invalid schema.
      required: ['payer', 'payee', 'usdc'],
    },
    // The step ACTS ON the token and needs the PAYER's authority. Conflating them asks a person to grant
    // authority as an ERC-20 contract, which nothing can sign.
    // Spec 408 §2.2 — REDEEMS ON CHAIN: `DelegationManager.redeemDelegation`, where every enforcer fires.
    capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'asset', authorityArg: 'payer', redeemsOnChain: true },
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

    adapter: ADAPTER.sync, carries: CARRIES.message,
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
    id: 'messaging.topic.post',

    adapter: ADAPTER.sync, carries: CARRIES.message,
    verbs: ['post in', 'post to the topic', 'reply in the topic', 'answer in the thread', 'say in the topic'],
    description:
      'POST IN A TOPIC of an organization — a reply in the thread where something was said to you (spec 400 W2: a '
      + 'mention in a topic is answered in that topic, never by a private message). Args: org (the organization\'s '
      + 'ADDRESS or NAME), channelId (the topic\'s id — a mention\'s context names it), message (the text to post).',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'The organization whose topic it is — an address or a name' },
        channelId: { type: 'string', description: 'The topic id (from the mention\'s context)' },
        message: { type: 'string', description: 'The text to post' },
      },
      required: ['org', 'channelId', 'message'],
    },
    // Posting as you is acting as you — the same mandate shape as a direct message; low risk, a post is never authority.
    capability: { id: 'messaging.topic.post', action: 'post', resourceArg: 'org', authorityArg: 'sender' },
    risk: 'low',
  },
  {
    id: 'treasury.fund',

    adapter: ADAPTER.chain,
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
    capability: { id: 'treasury.fund', action: 'fund', resourceArg: 'asset', authorityArg: 'funder', redeemsOnChain: true }, // spec 408 §2.2
    risk: 'low',
  },
  {
    // "WHEN SOMEONE PAYS ME, IT GOES HERE" — the Home's `PrimaryPayee` control as a capability (spec 361
    // I4). A preference, recorded as the `ap:primaryPayee` role on the PUBLIC charteredUnder edge so a
    // stranger's agent can honour it. It grants nothing: nobody may spend from the marked treasury, and
    // no gate reads the role — the resolver uses it to stop asking a payer a question only you can answer.
    id: PRIMARY_PAYEE_CAPABILITY,
    adapter: ADAPTER.chain,
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
    capability: { id: PRIMARY_PAYEE_CAPABILITY, action: 'declare', resourceArg: 'record', authorityArg: 'holder', redeemsOnChain: true }, // spec 408 §2.2
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
    adapter: ADAPTER.sync,
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
    // A STANDING INSTRUCTION (spec 394): "from now on, pay from alice3.treasury". A DECLARED DEFAULT for one
    // argument of one capability, kept in the person's own vault, scoped to the room they are standing in.
    // Self-acting like the household record: a note about their own habits, published nowhere. IT AUTHORIZES
    // NOTHING — the next payment still asks for its mandate; it only answers "from which account?" before
    // the question is asked. Never over a spoken value. The invoker reads the instruction BACK and writes it
    // only from the person's supplied yes (the 385 trusted-event rule): a planner's reading of "from now on"
    // writes nothing.
    id: STANDING_INSTRUCTION_CAPABILITY,
    adapter: ADAPTER.sync, carries: CARRIES.instruction,
    verbs: ['from now on', 'always', 'by default', 'default to', 'standing instruction', 'stop defaulting', 'no longer default'],
    description:
      'Keep a STANDING INSTRUCTION — this person\'s own default for an argument of one of their acts, in this room. '
      + 'Args: capability (the act, as its id or as the person names it: "pay", "invite", "message"), arg (the argument '
      + 'it fills; omit for the act\'s acting party — the payer, the sender), value (the agent to default to — a name '
      + 'or address), forget (true to clear the default instead). "From now on pay from alice3.treasury", "always '
      + 'invite as missio nexus", "stop defaulting my payments". It is read back before it is kept, it is theirs '
      + 'alone, and it authorizes nothing — every act still asks for its mandate.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'The act the default is for — its id (treasury.payment.execute) or the person\'s word for it (pay)' },
        arg: { type: 'string', description: 'The argument it fills (payer, sender, org). Omit for the act\'s acting party.' },
        value: { type: 'string', description: 'The agent to default to — a name (alice3.treasury) or an address' },
        holder: { type: 'string', description: 'Whose instruction this is — the person asking' },
        forget: { type: 'boolean', description: 'true to clear the standing instruction for this act + argument' },
      },
      required: ['capability'],
    },
    capability: { id: STANDING_INSTRUCTION_CAPABILITY, action: 'declare', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low',
    selfAuthorized: true,
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
    adapter: ADAPTER.sync,
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
    adapter: ADAPTER.chain,
    verbs: ['revoke', 'remove access', 'disconnect', 'cut off'],
    description:
      'Revoke ON CHAIN a grant this agent issued, so it stops working everywhere rather than only here: an '
      + 'app\'s read grant by client id, or ANY grant by its digest from access.grants.audit (a member\'s access, a '
      + 'contact, a runtime\'s standing grant, a coach\'s study grant). Args: app (the client id from '
      + 'access.grants.list) OR digest (0x…, from access.grants.audit), holder (the SA whose grant it is — the person '
      + 'asking, or an organization they steward). Use for "stop <app> reading my records", "revoke <app> access", '
      + '"revoke grant 0x…", "cut off <app>".',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'The app\'s client id, as listed by access.grants.list' },
        digest: { type: 'string', description: 'The grant\'s digest (0x…), as listed by access.grants.audit' },
        holder: { type: 'string', description: 'Whose grant this is (the agent that issued it)' },
      },
    },
    capability: { id: ACCESS_REVOKE_CAPABILITY, action: 'revoke', resourceArg: 'manager', authorityArg: 'holder', redeemsOnChain: true }, // spec 408 §2.2
    risk: 'medium',
    interaction: { navigationTarget: 'settings' },
  },
  ...CHILD_AGENT_KINDS.map(({ capability, tld, noun, parentNoun }): ToolSpec => ({
    verbs: [`create a ${noun}`, `create ${noun}`, `charter a ${noun}`, `charter ${noun}`, `start a ${noun}`, `make a ${noun}`, `new ${noun}`, `open a ${noun}`, `set up a ${noun}`],
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
    risk: 'medium', adapter: ADAPTER.chain,
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
  const kindWords = [noun, tld, `${noun}s`, ...(noun === 'organization' ? ['organisation', 'org'] : []), ...(noun === 'service agent' ? ['service', 'agent', 'bot', 'runtime'] : [])];
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
  /** Spec 426 §5 — THE SESSION SEAM for executor-invoke: an id_token for the run's principal, scoped to the
   *  executor's client (prod: the principal's own credential; demo: demo-signin `{ as }`). null ⇒ the invoke
   *  step refuses. Absent ⇒ invoke capabilities refuse (the estate wires this where demo-signin lives). */
  executorSession?: ExecutorSessionSeam;
  /** Spec 370 P4 — a PUBLIC op on a principal's InteractionsDO as the session (the `/connect/work` door),
   *  for the coordination acts. The DO derives standing and validates the command; this only carries it. */
  interactionsOp?: (principal: Address, op: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  /** Spec 427 — an organization's own object, asked IN-WORKER what it records of `member` (`person.roles.list`: a
   *  person's agent reading its own person's memberships). null ⇒ that organization could not be asked. */
  memberRoleAt?: (org: string, member: string) => Promise<OrgMembershipAnswer | null>;
  /** Spec 427 — the organization's own object writes the role on a member's record, in-Worker, for a run that
   *  presented the organization's mandate (`organization.member.role.set`). */
  setMemberRoleAt?: (org: string, input: { member: string; orgRole: RoleOfferV1 | null; by: string }) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Build, sign (with the service SA's custodian) and submit a sponsored userOp from `sender`. */
  executeAsServiceSa: (sender: Address, callData: Hex) => Promise<{ txHash: Hex }>;
  audit: AuditSink;
  /** The team-genesis substrate; absent ⇒ `organization.team.create` fails as unconfigured (never silently). */
  teamGenesis?: TeamGenesisDeps;
  /** Resolve an agent NAME to its address, on chain. Injected so a capability can take "alice2.treasury"
   *  where it needs an address: asking a planner to chain a lookup into a later step's args is a
   *  coordination problem we do not need to have, and it answered with a paragraph instead of acting. */
  resolveName?: (name: string) => Promise<string | null>;
  /** Spec 402 W3 — the person's own routines on her agent's object: list, declare one from a sentence, remove one. */
  listTriggers?: (agent: string) => Promise<TriggerScheduleV1[]>;
  declareTrigger?: (agent: string, row: TriggerScheduleV1) => Promise<TriggerScheduleV1>;
  removeTrigger?: (agent: string, triggerId: string) => Promise<void>;
  /** Send a direct message through the sender's own interactions plane. */
  sendDirectMessage?: (input: {
    sender: Address; recipient: Address; bodyText: string; session: string;
    /** Spec 400 W1 / 375 W2 — the sender is an agent the session's person STEWARDS (an outside runtime's reply, an
     *  organization's): the person drives that agent's rail with the stewardship wire; the message is from the agent. */
    stewardship?: unknown;
    /** Spec 364 — typed pointers the recipient's surface renders as an action. Never authority. */
    contextRefs?: Array<{ kind: string; id: string; label?: string }>;
    /** Spec 400 W2a — the sender is the run's own agent, under a mandate chain rooted at it (a standing grant its
     *  custodian signed); no session — the app drives the agent's own rail in-Worker. Set only by `messageInvoker`. */
    asSelf?: true;
    /** Spec 410 §3 — the step's logical operation identity; the sender's object records the envelope under it. */
    operationId?: string;
  }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Spec 400 W2 (B3) — post in an organization's topic as `sender`: a person under their session, or an agent
   *  (the run's own under a chain rooted at it, or one the person stewards) as a MEMBER of that organization —
   *  the org's object checks the invitation record and authors the post as the member. */
  postTopic?: (input: { org: Address; channelId: string; sender: Address; senderName?: string | null; bodyText: string; session: string; stewardship?: unknown; asSelf?: true; operationId?: string }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Public directory search — for QUESTIONS about who exists (`find_agents`), never to fill a party in an
   *  action: a directory hit proves an agent exists, not that this person knows them (spec 352 §7). */
  findAgents?: (terms: string) => Promise<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>;
  /** Read one record from a subject's own vault — the asker's private tier (spec 353 §3). */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** spec 360 E5 — deposit ONE declared-effect artifact in a principal's own vault. Allowlisted by record
   *  type at the DO; the caller carries no write authority (the principal's own grant performs it). */
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown, /** spec 410 §3 — the operation ledger's key */ operationId?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Spec 412 W5 — sign a digest AS an agent served here, under its DEL-001 session leaf (ERC-1271-verifiable against
   *  the agent); a Library release's signature. Null when the agent holds no leaf in this deployment. */
  signAsAgent?: (agent: string, digest: Hex) => Promise<Hex | null>;
  /** Spec 413 — a shelf hint to the public tier's indexer after a Library act (`{owner, entryId}`, no content). */
  announceShelf?: (owner: string, entryId: string) => Promise<void>;
  /** Append one entry to a subject's own record — how a request reaches the person who must decide it. */
  appendSubjectRecord?: (subject: string, recordType: string, entry: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** Spec 410 §8 — one logical write into BOTH parties' vaults (a countersigned relationship credential or its revocation);
   *  the second copy that cannot be written voids the first. */
  writeSharedRecord?: (parties: [string, string], recordType: string, record: unknown, operationId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Spec 410 §3 — the reconcile's read: what `subject`'s object did for a logical operation, or null. Throws when it
   *  cannot be asked (the loop records that as indeterminate, never as absent). */
  lookupOperation?: (subject: string, operationId: string) => Promise<{ kind: 'send' | 'write'; ref: string; at: string } | null>;
  /** Spec 410 §3 — the A2A hop's reconcile read: the receiver's run for a routed step, when the receiver is served HERE
   *  (in-process; a receiver elsewhere answers `unreadable` and its own record-backed idempotency covers the re-ask).
   *  `done` carries the recorded answer; `running` says the receiver has not finished; `absent` that it never started. */
  readSubjectRun?: (subject: Address, runRef: string) => Promise<{ state: 'done'; outcome: string; at: number; result?: unknown; receipts: number } | { state: 'running' } | { state: 'absent' } | { state: 'unreadable'; reason: string }>;
  /** Held resolution grants this asker can actually use — checked, not merely held (spec 338 §4). */
  verifyGrant?: (held: unknown, type: string, asker: string, session?: string) => Promise<Array<{ targetAgent?: string; owner: string; ownerName?: string; label?: string }>>;
  /** Close the note in the ASKER'S OWN vault that was waiting on this — spec 338 §7, the far end of a
   *  request they sent. Settling is a record of what happened, never a permission: the grant it refers to
   *  stays exactly as valid as its issuer left it. */
  settleResolutionRequest?: (person: string, input: { owner: string; wants: string; txHash?: string }) => Promise<void>;
  /** Spec 356 §2.2 — whose vaults this asker may read: their own, plus what they STEWARD. Derived, never
   *  a caller's list; membership and custody are not sources (see `readableVaults` in index.ts). */
  readableVaults?: (asker: string) => Promise<Array<{ subject: string; name?: string; why: 'self' | 'stewardship' }>>;
  /** Spec 400 W2 (B5) — one subject's search indexes (its interactions object: messages, topics; its task object: runs). */
  searchSubject?: (subject: string, query: string, opts: { kinds?: string[]; since?: string; limit?: number }) => Promise<{ hits: import('./work-search.js').SearchHit[]; indexed: number }>;
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
  deliverEmailInvitation?: (input: { org: Address; email: string; memberAccessDelegation: unknown; /** Spec 410 §8 — the organization's side of the membership credential, for the invitee to countersign. */ relationshipOffer?: unknown; session: string }) => Promise<{ ok: boolean; delivery?: string; error?: string }>;
  /**
   * Spec 366 R1 — ASK THE SUBJECT'S OWN AGENT. A step about another agent (an organization's roster,
   * asked at a person's agent) is sent to that agent's harness as the same step, with the asker's own
   * session presented; the receiver verifies the credential and derives the asker's standing against ITS
   * OWN records, runs the step under ITS playbook, and answers. Nothing is granted by routing: a person
   * with no standing there gets the same refusal by either route. Absent ⇒ the step is refused in words
   * (never a local read of the other agent's records — ADR-0013, one mechanism).
   */
  /** Spec 375 — the kind of the agent being asked (`person` | `org` | `team` | `treasury` | …), read on chain once
   *  per ask. A read consults it to know whether "no subject" means "which one?" (a person) or "me". */
  addresseeKind?: string | null;
  /** Spec 376 — the harness's own Smart Agent signs a digest (its custodian, the interactions-session key):
   *  what lets it attenuate a mandate it holds as delegate onward to a specialist. */
  signAsHarness?: (digest: Hex) => Promise<Hex>;
  /** Spec 376 — HAND ONE STEP to another agent under a child mandate. The executor's harness runs it with
   *  the chain presented; what comes back is read like a routed answer (an answer, a refusal, a need). */
  handoffTo?: (input: { executor: Address; intent: { goal: string; context?: Record<string, unknown> }; plan: { steps: Array<{ toolId: string; args: Record<string, unknown>; id?: string }> }; presented: unknown[]; supplied?: SuppliedInputV1[]; parent: { agent: Address; runRef: string; stepRef: string; operationId: string; childRef: string } }) => Promise<SubjectAnswerV1>;
  /** Spec 379 — whether an agent address is served by THIS deployment (its harness runs here). Absent ⇒ every
   *  address is treated as served, so only a card URL counts as outside. */
  isServedHere?: (agent: string) => boolean;
  askSubjectAgent?: (input: { subject: Address; toolId: string; args: Record<string, unknown>; goal: string; asker?: Address; session?: string; /** Spec 397 — the asker came through a client they authorized (no session): the admission evidence, forwarded verbatim for the receiver to verify itself. */ appCredential?: { authorization: string; body: string }; /** Spec 397 — the agent routing this step when it is not the asker's own (an organization the person asked AT). */ via?: Address; /** Spec 390 W2 — W3C Trace Context for the hop: this run's trace, the routed step as the parent span. */ trace?: { traceparent: string; tracestate?: string }; /** Appendix M8 — the run ref the receiver is to adopt for a fresh ask (named by the sender). */ runRef?: string; correlation: { operationId: string; runRef: string; stepRef: string; intentDigest: string }; /** Spec 374 W2 — continue the receiver's parked run with what this turn presented/supplied. */ continue?: { runRef: string; presented?: unknown[]; supplied?: unknown[] } }) => Promise<SubjectAnswerV1>;
  /** Appendix M8 — READ the subject agent's own progress lines for a routed run, under the asker's session,
   *  while the hop is in flight. The receiver's DO answers; nothing is copied but the sentences. */
  readSubjectProgress?: (input: { subject: Address; runRef: string; session?: string; /** The asker, for a run admitted without a session (an in-Worker read the receiver trusts as it trusts a routed hop). */ asker?: Address; after: number; wait?: number }) => Promise<{ lines: Array<{ seq: number; said: string; stepRef?: string; terminal?: boolean }>; terminal: boolean; known: boolean }>;
  /** Reverse name lookup for an address (public directory, ADR-0040). Names roster rows; best-effort. */
  nameOf?: (address: string) => Promise<string | null>;
  /** Spec 387 W2 — what a NAME publishes on chain (its `atl:mcpEndpoint` binds the catalog reads). Records first, never a convention. */
  readNameRecords?: (name: string) => Promise<{ a2aEndpoint?: string; mcpEndpoint?: string } | null>;
  /** What an agent PUBLICLY advertises on its profile (`atl:capabilities`). `playbook.answer` is listed only for a skill on it. */
  advertisedCapabilities?: (agent: Address) => Promise<string[]>;
  /** Spec 366 R2/R3 — set by the receiver of a ROUTED ask, once per request: the wires the asker presented
   *  for standing, and that their own tree is not this agent's to read. Every standing derivation in this
   *  run inherits it (`StandingDeps.context`). */
  standingContext?: { presented?: readonly unknown[]; routed?: boolean };
  /** Verifies a stewardship wire on chain (shape, ERC-1271, revocation). Built once per deployment so a
   *  read tool can judge a wire the asker PRESENTED (spec 366 R2); absent ⇒ no wire is believed. */
  verifyStewardship?: StandingDeps['verifyStewardship'];
  /** `ap:charteredUnder` owner of an agent, from chain — who a payee treasury's receipt is told to. */
  ownerOf?: (agent: string) => Promise<string | null>;
  /** THE VALUE RAIL'S EVIDENCE (spec 373) — the on-chain `atl:agentType` of an agent. A typed name is a
   *  claim; this record is the authority (ADR-0061), genesis writes it, and an unnamed treasury still has
   *  it. Absent or unreadable ⇒ a value move is REFUSED, because a rail that fails open is not a rail. */
  agentTypeOf?: (agent: string) => Promise<string | null>;
  /** What an agent holds of the deployment's value asset — annotates a choice between accounts. */
  valueHeld?: (agent: string) => Promise<{ amount: bigint; display: string } | null>;
  /** The apps a person has authorized to read their records, and whether each grant is still live. */
  readGrants?: (person: string) => Promise<Array<{ clientId: string; hash: string; storedAt: string; revoked: boolean }>>;
  /** Spec 400 W2 (B4) — every grant `subject` issued (its object enumerates them); entitlement is the caller's to establish. */
  auditGrants?: (subject: string) => Promise<Array<{ kind: string; holder: string; holderName?: string; what: string; digest: string; issuedAt?: string; revoked: boolean; source: string }>>;
  /** Spec 400 W2 (B4) — the wire of one grant `holder` issued, by digest — for the revocation about to expand it. */
  grantWireByDigest?: (holder: string, digest: string) => Promise<{ wire: unknown; hash: string; source: string } | null>;
  /** ONE stored grant, wire and all — asked for only when something is about to revoke it. */
  readGrantWire?: (person: string, clientId: string) => Promise<{ wire: unknown; hash: string } | null>;
  /** The person's STUDY GRANT to one coach service (`card-room.ts`), wire and all — read by the person's own
   *  agent to present to the coach it is about to consult. Null when none is stored. */
  studyGrantWire?: (person: string, coach: string) => Promise<{ wire: unknown; hash: string; delegate: string } | null>;
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
  via: { agent: Address; name?: string | null; host?: string; runRef?: string; observedVia: 'serving-handler' | 'network' | 'delivered' | 'handoff'; receipts?: Array<{ stepRef: string; capability?: string; status: string }>; childRef?: string };
  /** When the subject's agent did not answer: its words, relayed verbatim (a refusal is an answer). */
  refused?: string;
  /** Spec 374 — the receiver PARKED the step for its own steward (or asked something): `via.runRef` is
   *  where it waits, `said` is its words. An act on this becomes a commitment; a read relays the words. */
  needs?: boolean;
  said?: string;
  /** Spec 374 W2 — WHAT the receiver needs, whole: its authority request (requirement, delegator, …) or
   *  its prompt, so a steward asker can be asked for it here and carry it back. */
  needsWhat?: unknown;
}

/**
 * Spec 366 — WHICH AGENT ANSWERS THIS STEP. A tool that declares a `subject` argument is answered by the
 * agent that argument names; when that agent is not the one addressed, the step is routed there. Pure:
 * reads the tool's declaration and the (already-resolved) args, decides nothing about permission.
 */
/** Spec 376 — the step in words, for the sub-intent: the capability's phrase, else the tool's id. */
function toolWordsFor(tool: ToolSpec): string { return (tool.capability?.id && CAPABILITY_WORDS[tool.capability.id]) || tool.answer || tool.id; }

/** Appendix M8 / spec 410 §3 — THE RECEIVER'S RUN REF FOR A ROUTED STEP, named by the sender before it asks: the same
 *  function names it for the hop and for the reconcile, so a retry looks for the run the first attempt started. */
export function receiverRunRefFor(senderRunRef: string, stepRef: string): string {
  return `routed-${senderRunRef}-${stepRef}`.replace(/[^A-Za-z0-9._:-]/g, '_');
}

export function routedSubjectFor(tool: { subject?: string } | undefined, args: Record<string, unknown>, addressee: Address | undefined): Address | null {
  if (!tool?.subject) return null;
  const v = String(args[tool.subject] ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(v)) return null;
  if (addressee && v === addressee.toLowerCase()) return null;
  return v as Address;
}

/** The receiver's profile answer as the sender reads it (mirror of `@agenticprimitives/a2a` SubjectAnswerV1). */
export interface SubjectAnswerProfileV1 { extension: string; version: 1; agent: string; inResponseTo: { operationId: string; runRef: string; stepRef: string }; outcome: 'answer' | 'refused' | 'needs' | 'error'; result?: unknown; said?: string; run: { runRef: string; receipts: Array<{ stepRef: string; capability?: string; status: string; binding?: unknown }> } }

/** One step another agent answered (spec 366): who, reached how, under which of its runs, with what receipts. */
export interface RoutedStepV1 { stepRef: string; toolId: string; agent: string; name?: string; observedVia: string; runRef?: string; receipts?: number;
  /** Spec 376 — the child mandate a handed-off step ran under (its delegation hash). */
  childRef?: string;
  /** Spec 383 W2 — the standing the receiver's receipt names: for whom, by whom, under which steward wire (digest). */
  standing?: { relation: string; subject: string; principal: string; because: string; wireRef?: string } }

/** The routed steps of a run, read from each observation's `via` — the sender's record of the hop. */
export function routedStepsOf(steps: ReadonlyArray<{ stepRef?: string; step: { id?: string; toolId: string }; result?: unknown }>): RoutedStepV1[] {
  const out: RoutedStepV1[] = [];
  steps.forEach((o, i) => {
    const via = (o.result as { via?: { agent?: string; name?: string | null; observedVia?: string; runRef?: string; receipts?: Array<{ binding?: { standing?: RoutedStepV1['standing'] } }>; childRef?: string } } | null | undefined)?.via;
    if (!via?.agent) return;
    // Spec 383 W2 — the receiver's receipt names the standing the hop ran under; lifted so the asker's reply
    // (and the Home) can say "for Missio Nexus, under steward wire 0x…" without shipping the receipts whole.
    const standing = (via.receipts ?? []).map((r) => r?.binding?.standing).find((sd) => sd && sd.relation !== 'none');
    // The observation's OWN stepRef, never its index: a run that begins with the spec-413 retrieval step (`retrieve`)
    // shifted every index by one, so the reply named `s1` for the step the record (and its provenance graph) calls `s0`.
    out.push({ stepRef: o.stepRef ?? o.step.id ?? `s${i}`, toolId: o.step.toolId, agent: via.agent, ...(via.name ? { name: via.name } : {}), observedVia: via.observedVia ?? 'unknown', ...(via.runRef ? { runRef: via.runRef } : {}), ...(via.receipts?.length ? { receipts: via.receipts.length } : {}), ...(via.childRef ? { childRef: via.childRef } : {}), ...(standing ? { standing } : {}) });
  });
  return out;
}

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
export function readSubjectReply(envelope: (AskReplyEnvelopeV1 & { subjectAnswer?: SubjectAnswerProfileV1 }) | null, toolId: string, who: string, status: number): { ok: boolean; result?: unknown; refused?: string; needs?: boolean; said?: string; needsWhat?: unknown; runRef?: string; receipts?: Array<{ stepRef: string; capability?: string; status: string }> } {
  if (!envelope) return { ok: false, refused: `${who} answered with something that was not a reply (${status})` };
  // THE PROFILE ANSWER, when the receiver speaks it (spec 366 R2): typed outcome, the receiver's own run and
  // receipts naming our request. A receiver that does not speak the profile answers with the plain reply.
  const sa = envelope.subjectAnswer;
  if (sa && sa.extension === 'https://agenticprimitives.org/a2a/subject-ask/v1') {
    const receipts = sa.run?.receipts ?? [];
    if (sa.outcome === 'answer') return { ok: true, result: sa.result, runRef: sa.run.runRef, receipts };
    // Spec 374 — `needs` from the receiver means it PARKED the act for its own steward (or asked the
    // asker something); the run reference is where it waits, and the caller decides whether that is a
    // commitment (an act) or a relayed question (a read).
    // A refusal is never empty (spec 420 refusalIsSaid): the receiver's own words, else its reply's error.
    const why = (sa.said ?? '').trim() || String((envelope.reply as { error?: string } | undefined)?.error ?? '').trim() || 'it gave no reason';
    return { ok: false, refused: `${who} ${sa.outcome === 'refused' ? 'refused' : sa.outcome === 'needs' ? 'needs more before it can answer —' : 'could not answer:'} ${why}`.trim(), ...(sa.outcome === 'needs' ? { needs: true, said: sa.said ?? '', ...(sa.result !== undefined ? { needsWhat: sa.result } : {}) } : {}), runRef: sa.run?.runRef, receipts };
  }
  if (envelope.ok === false || envelope.error) return { ok: false, refused: `${who} refused: ${envelope.error ?? status}` };
  const reply = envelope.reply;
  if (!reply) return { ok: false, refused: `${who} answered with no reply (${status})` };
  const runRef = reply.runRef ?? envelope.runRef;
  if (reply.kind === 'answer') {
    const hit = reply.results?.find((r) => r.toolId === toolId) ?? reply.results?.[0];
    return { ok: true, result: hit ? hit.result : { text: reply.text }, ...(runRef ? { runRef } : {}) };
  }
  // Spec 376 — a hand-off that FINISHED at the specialist is an answer too: its result and its receipts.
  if (reply.kind === 'done') {
    const d = reply as typeof reply & { receipts?: Array<{ stepRef: string; capability?: { id?: string }; status: string }>; result?: unknown };
    const receipts = (d.receipts ?? []).map((rc) => ({ stepRef: rc.stepRef, ...(rc.capability?.id ? { capability: rc.capability.id } : {}), status: rc.status }));
    return { ok: true, result: d.result ?? { done: true }, ...(runRef ? { runRef } : {}), receipts };
  }
  const said = reply.kind === 'prompt'
    ? `it asked “${reply.prompt?.prompt ?? ''}” (${reply.prompt?.kind ?? 'prompt'}${reply.prompt?.fields?.length ? `: ${reply.prompt.fields.map((f) => f.name).join(', ')}` : ''})`
    : (reply.summary ?? reply.text ?? reply.kind ?? '');
  return { ok: false, refused: `${who} needs more before it can answer — ${said}`.trim(), ...(runRef ? { runRef } : {}) };
}

/**
 * Spec 410 §3 — THE RECONCILE PORT, one lookup per effect kind, keyed on the step's logical operation identity:
 *
 *   payment   the PaymentEnforcer's nonce slot for (delegator, delegation hash, intent-derived nonce) — the one
 *             authority that already decided whether THIS payment settled; true ⇒ found, CONFIRMED by a chain read.
 *   send      the sender's object's operation ledger (`op:<operationId>` → the envelope id it recorded).
 *   write     the subject's object's operation ledger (→ the record type it wrote).
 *
 *   routed    (the fallback, any tool) the RECEIVER's run for the step — the sender named its ref before it asked
 *             (`receiverRunRefFor`), so a retry finds the run the first attempt started: completed ⇒ found with the
 *             recorded answer; still running ⇒ indeterminate (no second ask); failed or never started ⇒ absent.
 *             A receiver served elsewhere is `absent` here and reconciled at ITS door: `/harness/ask` answers a
 *             repeated (runRef, operationId) from its record instead of running again.
 *
 * A read that throws is INDETERMINATE (the loop does nothing this attempt); a tool nobody bound is absent.
 */
export function harnessReconcilePort(deps: HarnessDeps, env: HarnessEnv, presentedList: MandatePresentation[], intent: { goal: string; context?: Record<string, unknown> }, addressee: string, opts: { /** Spec 374 W2 — steps already parked at their subject: this turn CONTINUES that run, which is not a second ask. */ routedAt?: Record<string, { runRef: string }> } = {}): ReturnType<typeof reconcileByTool> {
  const enforcers = harnessEnforcers(env);
  const ledger = (subjectOf: (req: ReconcileRequest) => string | Promise<string>, kind: 'send' | 'write') => async (req: ReconcileRequest): Promise<ReconcileAnswer> => {
    if (!deps.lookupOperation) return { status: 'absent' };
    const subject = (await subjectOf(req)).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(subject)) return { status: 'absent' };
    const found = await deps.lookupOperation(subject, req.operationId); // throws ⇒ indeterminate (reconcileByTool)
    if (!found || found.kind !== kind) return { status: 'absent' };
    return { status: 'found', output: kind === 'send' ? { sent: true, messageId: found.ref, reconciled: true } : { kept: true, record: found.ref, reconciled: true }, observation: { outcome: 'confirmed', providerRef: found.ref, observedAt: found.at, evidence: [{ kind: 'read-back', ref: `the ${kind === 'send' ? "sender's" : "subject's"} object recorded this operation at ${found.at}` }] } };
  };
  const self = (): string => addressee;
  const payment = async (req: ReconcileRequest): Promise<ReconcileAnswer> => {
    if (!enforcers.payment) return { status: 'absent' };
    const wire = (presentedList.length > 1 ? selectByPayee({ capability: { id: 'treasury.payment.execute' }, args: req.args }, presentedList, enforcers.payment) : presentedList[0])?.wire as Delegation | undefined;
    if (!wire) return { status: 'absent' };
    const digest = intentDigest(intent);
    const nonce = keccak256(toBytes(`${digest}:${req.step.idempotencyKey ?? req.stepRef}`));
    const dHash = hashDelegation(wire, Number(env.CHAIN_ID), env.DELEGATION_MANAGER as Address);
    const used = (await deps.readContract({ address: enforcers.payment as Address, abi: IS_NONCE_USED_ABI, functionName: 'isNonceUsed', args: [wire.delegator, dHash, nonce] })) as boolean; // throws ⇒ indeterminate
    if (!used) return { status: 'absent' };
    return { status: 'found', output: { alreadySettled: true, outcome: 'committed', effectIdentity: `${dHash}:${nonce}`, reconciled: true }, observation: { outcome: 'confirmed', providerRef: `${dHash}:${nonce}`, observedAt: new Date().toISOString(), evidence: [{ kind: 'chain-read', ref: 'PaymentEnforcer.isNonceUsed: this exact payment had already settled' }] } };
  };
  const routed = async (req: ReconcileRequest): Promise<ReconcileAnswer> => {
    const subject = routedSubjectFor(req.tool as { subject?: string }, req.args, addressee as Address);
    if (!subject || !deps.readSubjectRun) return { status: 'absent' };
    if (opts.routedAt?.[req.stepRef]) return { status: 'absent' }; // a continuation of the receiver's parked run — one ask, resumed
    const run = await deps.readSubjectRun(subject, receiverRunRefFor(req.runRef, req.stepRef)); // throws ⇒ indeterminate
    if (run.state === 'running') return { status: 'indeterminate', reason: `${subject} is still running this step (${receiverRunRefFor(req.runRef, req.stepRef)}); asking again would be a second act` };
    if (run.state !== 'done' || run.outcome !== 'completed') return { status: 'absent' };
    const at = new Date(run.at).toISOString();
    return { status: 'found', output: { routed: true, runRef: receiverRunRefFor(req.runRef, req.stepRef), result: run.result ?? { done: true }, reconciled: true }, observation: { outcome: 'confirmed', providerRef: receiverRunRefFor(req.runRef, req.stepRef), observedAt: at, evidence: [{ kind: 'read-back', ref: `${subject} recorded a completed run for this step at ${at} (${run.receipts} receipt${run.receipts === 1 ? '' : 's'})` }] } };
  };
  return reconcileByTool({
    'treasury.payment.execute': payment,
    'messaging.direct.send': ledger(self, 'send'),
    'messaging.topic.post': ledger((req) => partyAddress(req.args.org, deps, 'the organization'), 'send'), // the ORG's object records the post
    [STANDING_INSTRUCTION_CAPABILITY]: ledger(self, 'write'),
    [HOUSEHOLD_RECORD_CAPABILITY]: ledger(self, 'write'),
    [MEMORY_REMEMBER]: ledger(self, 'write'),
    'person.memory.forget': ledger(self, 'write'),
    'person.contact.invite': ledger(self, 'write'),
    'person.contact.remove': ledger(self, 'write'),
    ...Object.fromEntries([...PREFERENCES_ACTS, ...ROUTINE_ACTS].map((id) => [id, ledger(self, 'write')])),
  }, routed);
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
  /** Spec 376 — the keyring, so a CHILD mandate's approval can be judged over its PARENT's reference: the
   *  second party approved the person's mandate for this step; a child derived from it inherits that. */
  presentedAll?: MandatePresentation[],
): ApprovalPort {
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;
  return {
    async request(req) {
      const digestFor = (mandateRef: string) => approvalDigestFor({ stepRef: req.stepRef, mandateRef, intentDigest: req.evidence.intentDigest, capability: req.step.capability.id, action: req.step.capability.action, ...(req.step.capability.resource ? { resource: req.step.capability.resource } : {}) });
      const leaf = (presentedAll ?? []).find((p) => p.ref.toLowerCase() === String(req.evidence.mandateRef).toLowerCase())?.wire as { authority?: string } | undefined;
      const parentRef = leaf?.authority && leaf.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase() ? leaf.authority : null;
      const want = digestFor(req.evidence.mandateRef);
      const wants = [want, ...(parentRef ? [digestFor(parentRef)] : [])].map((w) => w.toLowerCase());
      // A signature answered into THIS step counts as an approval when it is over the approval digest.
      const answered = (supplied ?? [])
        .filter((s) => s.stepRef === req.stepRef && s.signature && wants.includes(s.signature.digest.toLowerCase()))
        .map((s) => ({ approver: s.signature!.signer as Address, digest: s.signature!.digest as Hex, signature: s.signature!.signature as Hex }));
      const pool = [...approvals, ...answered];
      const records: string[] = [];
      // Spec 397 `act-as-me` — SHE DECIDED ONCE. When the step's mandate is a CHILD derived from a STANDING wire (no
      // intent binding) that the run's principal — or the treasury the step spends from — signed, the person's own
      // standing decision IS the second party for this step: the cap, the payee, the asset and the capability were
      // hers to set, and the chain already verified the child ⊆ that wire. Recorded on the receipt by the wire's
      // digest, so a reviewer can see which standing decision stood in. A wire whose delegator is someone else's
      // discharges nothing — it is not her decision.
      const parentWire = parentRef ? (presentedAll ?? []).find((p) => p.ref.toLowerCase() === parentRef.toLowerCase())?.wire as { delegator?: string; caveats?: Array<{ enforcer: string; terms: string; args?: string }> } | undefined : undefined;
      const standingOwners = new Set([person, req.step.capability.authority, req.step.capability.resource].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()));
      const standingByHer = !!parentWire && typeof parentWire.delegator === 'string' && standingOwners.has(parentWire.delegator.toLowerCase())
        && (() => { try { return isStandingWire(parentWire, harnessEnforcers(env).digestBinding); } catch { return false; } })();
      for (const ob of req.obligations) {
        if (ob.kind === 'second-party-approval' && standingByHer && parentRef) { records.push(`approval:standing:${parentRef.toLowerCase()}`); continue; }
        const allowed = (ob.dischargeableBy.agents ?? []).map((a) => a.toLowerCase());
        const candidates = pool.filter((a) => wants.includes(a.digest.toLowerCase()) && (allowed.length === 0 || allowed.includes(a.approver.toLowerCase())));
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

// The MCP server whose vault scope an org→member access grant names is the deployment's `VAULT_SERVER_ID`
// (`vault-server-id.ts`) — the same value the Home and the vault hold, or the grant reads as scoped to a server
// nobody consults.
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
    buildVaultRecordScopeCaveat([{ server: vaultServerId(env), resources: [ORG_PROFILE_RESOURCE_SCOPE], ops: ['read'] }]),
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
 * Spec 410 §8 — THE ORGANIZATION'S SIDE OF THE MEMBERSHIP CREDENTIAL, derived with the invitation. The body both
 * parties will sign (`has-member`, the invitee, the organization, the chain, the invitation's own instant, the
 * facets by digest) is fixed here so the requirement and the invoker derive the SAME digest: the organization
 * approves it in the one-prompt batch beside the access grant (its signature is the `0x03` sentinel), and the
 * member countersigns at acceptance. Deterministic from the mandate's `validAfter`, never from the clock.
 */
export function relationshipOfferFor(env: HarnessEnv, org: Address, invitee: Address, validAfter: number, facets?: { kin?: string; role?: string }): { body: RelationshipCredentialBodyV1; digest: Hex; terms?: Record<string, unknown> } {
  const terms = facets && Object.keys(facets).length ? { ...(facets.kin ? { kin: facets.kin } : {}), ...(facets.role ? { role: facets.role } : {}) } : undefined;
  const body: RelationshipCredentialBodyV1 = {
    type: 'ap.relationship-credential.v1', kind: 'has-member', subject: invitee.toLowerCase() as Address, object: org.toLowerCase() as Address,
    chainId: Number(env.CHAIN_ID), issuedAt: new Date(validAfter * 1000).toISOString(), termsDigest: termsDigestOf(terms),
  };
  return { body, digest: relationshipCredentialDigest(body), ...(terms ? { terms } : {}) };
}

/**
 * `organization.membership.invite`. Derives the grant, asks the steward to sign it, and returns it for the
 * surface to store in the org's vault. It does NOT make anyone a member: the invitee redeems it on join,
 * which is the whole reason the org-side capability is the INVITATION and not the membership.
 */
export function inviteInvoker(env: HarnessEnv, presented: MandatePresentation, person: Address | undefined, deps?: Pick<HarnessDeps, 'readContract' | 'deliverEmailInvitation' | 'sendDirectMessage'>, session?: string): ToolInvoker {
  /** WHAT FOLLOWS an invitation to an AGENT (spec 341 §5.1b, spec 360): the invitee is TOLD — a message from the inviter's
   *  own agent carrying the Join reference the Home renders as the chip. An effect never fails the act; it is reported.
   *  Without the inviter's session (a run admitted through a client) the message cannot be sent here, and that is said. */
  const tell = async (org: Address, invitee: Address): Promise<{ ok: boolean; error?: string; messageId?: string }> => {
    if (!person || !session || !deps?.sendDirectMessage) return { ok: false, error: person && !session ? 'the invitee was not told — telling them is a message sent as you, which needs your session (finish this at your Home, or tell them yourself)' : 'the invitee was not told — no messaging door here' };
    try {
      return await deps.sendDirectMessage({ sender: person, recipient: invitee, bodyText: 'You\'re invited to join this organization. Open the "Join" chip on this message to accept — you\'ll sign a listing you can revoke anytime.', session, contextRefs: [{ kind: 'org-channels', id: org.toLowerCase(), label: 'Join the organization' }] });
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
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
    // Spec 410 §8 — the organization's side of the membership credential, approved in the same batch as the grant
    // (or not: an older Home approves the grant alone, and the offer is then absent and SAID, never inferred).
    const offer = relationshipOfferFor(env, org, invitee, Number(decodeTimestampTerms(ts.terms as Hex).validAfter), facets);
    const relationshipOffer = deps?.readContract
      ? ((await deps.readContract({ address: org, abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }], functionName: 'isValidSignature', args: [offer.digest, '0x03'] }).catch(() => null)) === '0x1626ba7e'
        ? { ...offer.body, ...(offer.terms ? { terms: offer.terms } : {}), digest: offer.digest, signatures: { object: '0x03' as Hex } }
        : null)
      : null;
    const offerNote = relationshipOffer ? {} : { relationshipOfferNote: 'the organization did not approve the membership credential in this prompt; the membership will be recorded without the two-sided credential' };

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
          ? await deps.deliverEmailInvitation({ org, email: inviteeEmail, memberAccessDelegation: approvedWire, ...(relationshipOffer ? { relationshipOffer } : {}), session }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          : undefined;
        return { org, invitee, memberAccessDelegation: approvedWire, grantDigest, invited: true, approvedHash: true, ...(inviteeEmail ? {} : { told: await tell(org, invitee) }), ...(facets ? { facets } : {}), ...(relationshipOffer ? { relationshipOffer } : {}), ...offerNote, ...(inviteeEmail ? { inviteeEmail, emailDelivery: delivered ?? { ok: false, error: 'email delivery is not wired on this agent' } } : {}) };
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
    return { org, invitee, memberAccessDelegation: wireOut, grantDigest, invited: true, ...(facets ? { facets } : {}), ...(relationshipOffer ? { relationshipOffer } : {}), ...offerNote, told: await tell(org, invitee) };
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
/**
 * THE VALUE RAIL, enforced (spec 373). Refuse unless this end of the transfer is a treasury, on chain.
 *
 * The refusal is a sentence a person can act on — whose account it is, what it is instead, and what would
 * fix it — because "invalid payee" tells somebody holding money nothing about what to do next.
 */
async function refuseUnlessTreasury(deps: HarnessDeps, agent: string, end: string): Promise<void> {
  const who = String(agent ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(who)) throw new Error(`the account ${end} did not resolve to an agent — money moves between treasuries`);
  const name = (await deps.nameOf?.(who).catch(() => null)) ?? null;
  const label = name ?? `${who.slice(0, 8)}…${who.slice(-4)}`;
  if (!deps.agentTypeOf) throw new Error(`this agent cannot read what kind of account ${label} is, and money only moves between treasuries — nothing was paid`);
  const type = (await deps.agentTypeOf(who).catch(() => null))?.toLowerCase() ?? null;
  if (type === 'treasury') return;
  if (type === 'person') {
    throw new Error(`${label} is a person, and money moves between treasuries — a person is who a payment is FOR, an account is where it GOES. Name their treasury, or ask them to mark one to be paid into.`);
  }
  throw new Error(type
    ? `${label} is ${type === 'org' ? 'an organization' : `a ${type}`}, and money moves between treasuries — name the treasury it charters.`
    : `${label} has no agent type recorded on chain, so this agent cannot tell it is a treasury — money only moves between treasuries, and nothing was paid.`);
}

/**
 * Spec 384 — THE REDEEM-TIME ARGUMENT FOR A DIGEST-BINDING CAVEAT, by the caveat's own KIND. A mandate may bind
 * the intent AND the offer it fulfils (and a projection); the enforcer compares each caveat's bound digest to the
 * one PRESENTED for that kind. Feeding the intent digest to every binding caveat reverted `DigestMismatch` on
 * chain the first time a mandate carried an offer binding (live, 2026-09-08) — after the verifier had already
 * admitted the step. The step's own digests are what is presented; a kind the step cannot present is refused
 * here, before a transaction is sent.
 */
function digestBindingArgsFor(c: Caveat, digests: { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation?: ContractsGeneration }): Hex {
  const { kind } = decodeDigestBindingTerms(c.terms as Hex);
  const presented = kind === 'intent' ? digests.intent : kind === 'offer' ? digests.offer : kind === 'plan' ? digests.plan : digests.projection;
  if (!presented) throw new Error(`the mandate binds ${kind === 'offer' ? 'an offer' : kind === 'plan' ? 'a plan' : 'a projection'} this step does not name — nothing was redeemed`);
  // R917-C-4 (spec 408 §1.4): the step's nonce rides with the digest, so THIS step redeems once on chain — on a
  // generation-2 estate. Generation 1's enforcer takes the digest alone (a deployment fact, never a retry).
  return encodeDigestBindingArgs(presented, digests.generation === 1 ? { generation: 1 } : { generation: 2, stepNonce: digests.stepNonce });
}
/** The digests a step presents at redemption, and its single-use nonce (`keccak256("<intentDigest>:<operation>")` —
 *  the step's DECLARED idempotency key when it carries one, else its step ref (spec 410 §3: two identical payments are
 *  two operations; one retried is one); the payment nonce's own derivation). `plan` is the digest of the plan this run
 *  executes (spec 408 §2.3). */
const stepDigests = (args: Record<string, unknown>, intent: Hex, stepRef: string, plan?: Hex, generation: ContractsGeneration = 2): { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation: ContractsGeneration } => ({
  intent,
  ...(typeof args.offerDigest === 'string' && /^0x[0-9a-fA-F]{64}$/.test(args.offerDigest) ? { offer: args.offerDigest as Hex } : {}),
  ...(typeof args.projectionDigest === 'string' && /^0x[0-9a-fA-F]{64}$/.test(args.projectionDigest) ? { projection: args.projectionDigest as Hex } : {}),
  ...(plan ? { plan } : {}),
  stepNonce: digestBindingStepNonce(intent, stepRef),
  generation,
});

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
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: digestBindingArgsFor(c, stepDigests(args, digest, ctx.step.idempotencyKey ?? ctx.step.id ?? `s${ctx.index}`, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: env.CONTRACTS_GENERATION }))) }
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
    const txHashes: string[] = [];
    for (const [k, call] of calls.entries()) {
      // R917-C-4: one step, several redemptions (clear the previous primary, mark the new one) — each is its own
      // single-use nonce (`<stepRef>#<k>`), so a replay of the step reverts on chain and the two calls do not.
      const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === harnessEnforcers(env).digestBinding.toLowerCase()
        ? { enforcer: c.enforcer, terms: c.terms as Hex, args: digestBindingArgsFor(c, stepDigests(args, digest, `${ctx.step.id ?? `s${ctx.index}`}#${k}`, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: env.CONTRACTS_GENERATION }))) }
        : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
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
    const digestArg = String(args.digest ?? '').trim().toLowerCase();
    if (!app && !/^0x[0-9a-f]{64}$/.test(digestArg)) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId: _toolId,
        prompt: 'Which grant should be revoked?',
        fields: [{ name: 'digest', label: 'grant digest', type: 'text', required: true, hint: 'its digest from the grants screen (0x…), or an app\'s client id in "app"' }],
      });
    }
    // WHOSE GRANT: the mandate's delegator — the person for their own, the organization when its steward signs FOR it
    // (spec 400 W2 B4: an org's grants are revoked from the org's grants screen under the org's mandate).
    const holder = wire.delegator.toLowerCase();
    if (person && !digestArg && wire.delegator.toLowerCase() !== person.toLowerCase()) throw new Error(`a grant is revoked by the person who issued it (${person}); the mandate is from ${wire.delegator}`);
    const found = digestArg
      ? (deps.grantWireByDigest ? await deps.grantWireByDigest(holder, digestArg) : null)
      : await deps.readGrantWire(holder, app);
    if (!found) {
      // NOT AN ERROR TO RETRY. There is no such grant here, which is a fact about what they authorized.
      return { revoked: false, ...(app ? { app } : { digest: digestArg }), note: digestArg ? `no grant with digest ${digestArg.slice(0, 14)}… was issued by ${holder} — nothing to revoke` : `no read grant for "${app}" is stored here — nothing to revoke` };
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
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: digestBindingArgsFor(c, stepDigests(args, digest, ctx.step.idempotencyKey ?? ctx.step.id ?? `s${ctx.index}`, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: env.CONTRACTS_GENERATION }))) }
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
/**
 * A STANDING INSTRUCTION, DECLARED — spec 394. Resolves the act and the argument, reads the instruction back as
 * a question ("From now on, when you pay, pay from alice3.treasury — keep that?") and writes the record ONLY
 * from the person's supplied yes on the resume: the trusted event, exactly as a confirmation (385) is kept
 * from the choice the person supplied. The room is the agent addressed when it is not the person themselves.
 * Nothing here reaches a verifier; the record fills a question before it is asked and nothing more.
 */
export function standingInstructionInvoker(deps: HarnessDeps, person: Address | undefined, addressee: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('a standing instruction is kept as you, and there is no signed-in person on this run');
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('this agent cannot keep standing instructions');
    const me = person.toLowerCase();
    const context = instructionContextOf(addressee && addressee.toLowerCase() !== me ? addressee : undefined);
    // WHICH ACT: its id, or the person's word for it (a verb the tool lists, or its CAPABILITY_WORDS phrase).
    const said = String(args.capability ?? '').trim().toLowerCase();
    const acts = HARNESS_ACTION_TOOLS.filter((t) => t.capability?.authorityArg && t.id !== STANDING_INSTRUCTION_CAPABILITY);
    const tool = acts.find((t) => t.id === said)
      ?? acts.find((t) => (CAPABILITY_WORDS[t.id] ?? '').toLowerCase() === said)
      ?? acts.find((t) => (t.verbs ?? []).some((v) => v.toLowerCase() === said || said.split(/\s+/).includes(v.toLowerCase())))
      ?? acts.find((t) => t.id.split('.').some((part) => part === said));
    const supplied = dataFor(ctx.supplied, stepRef);
    const chosenAct = typeof supplied.capability === 'string' ? acts.find((t) => t.id === supplied.capability) : undefined;
    const act = chosenAct ?? tool;
    if (!act) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: said ? `Which act is “${said}” — I did not recognise it.` : 'Which act is the standing instruction for?',
        fields: [{ name: 'capability', label: 'the act', type: 'choice', required: true, choices: acts.map((t) => ({ value: t.id, label: CAPABILITY_WORDS[t.id] ?? t.id })) }],
      });
    }
    const arg = String(args.arg ?? '').trim().toLowerCase() || act.capability!.authorityArg!;
    const forget = isFlagTrue(args.forget);
    if (forget) {
      const prev = (await deps.readSubjectRecord(me, STANDING_RECORD).catch(() => null)) as StandingInstructionsV1 | null;
      const wrote = await deps.writeSubjectRecord(me, STANDING_RECORD, forgetInstruction(prev, { context, capability: act.id, arg }), ctx.operationId);
      if (!wrote.ok) throw new Error(wrote.error ?? 'the standing instruction could not be cleared');
      return { cleared: true, capability: act.id, arg, context, tier: 'private', record: STANDING_RECORD, note: `the next time you ${CAPABILITY_WORDS[act.id] ?? act.id}, the ${arg} is asked for again` };
    }
    // THE DEFAULT: the resolver gave `value` an address when it could (an ontology party role, any agent); a
    // word that did not resolve is asked for, never guessed.
    const value = String(args.value ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(value)) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: value ? `Which agent is “${value}”? I could not resolve it.` : `What should the ${arg} default to when you ${CAPABILITY_WORDS[act.id] ?? act.id}?`,
        fields: [{ name: 'value', label: 'the default', type: 'text', required: true, hint: 'an agent name (alice3.treasury) or address' }],
      });
    }
    const label = (await deps.nameOf?.(value).catch(() => null)) ?? undefined;
    const sentence = `From now on, when you ${CAPABILITY_WORDS[act.id] ?? act.id}${context !== 'any' ? ` here` : ''}, the ${arg} is ${label ?? value} unless you say otherwise.`;
    // THE READ-BACK. The person's supplied yes is the write; anything else keeps nothing.
    const answer = String(supplied.keep ?? '').trim().toLowerCase();
    if (!answer) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: `${sentence} Keep that as a standing instruction?`,
        fields: [{ name: 'keep', label: 'keep it', type: 'choice', required: true, choices: [{ value: 'yes', label: 'Yes, keep it' }, { value: 'no', label: 'No' }] }],
      });
    }
    if (answer !== 'yes') return { kept: false, capability: act.id, arg, note: 'nothing was kept' };
    const prev = (await deps.readSubjectRecord(me, STANDING_RECORD).catch(() => null)) as StandingInstructionsV1 | null;
    const next = declareInstruction(prev, { context, capability: act.id, arg, value, ...(label ? { label } : {}), saidAs: sentence });
    const wrote = await deps.writeSubjectRecord(me, STANDING_RECORD, next, ctx.operationId);
    if (!wrote.ok) throw new Error(wrote.error ?? 'the standing instruction could not be kept');
    return {
      kept: true, capability: act.id, arg, value, ...(label ? { label } : {}), context, tier: 'private', record: STANDING_RECORD,
      note: 'this is your own note of a default — it fills the question before it is asked and authorizes nothing; every act still asks for its mandate',
    };
  };
}

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
export function messageInvoker(deps: HarnessDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined, chain?: { presentedAll: MandatePresentation[]; chainId: number; delegationManager: Address }): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!deps.sendDirectMessage) throw new Error('messaging is not wired on this agent');
    // Spec 400 W2a — AN AGENT SENDING AS ITSELF, with no one's session. The run is the agent's own (an outside runtime
    // answering on its inbox) and the mandate is a CHAIN the verifier already judged: a standing grant its custodian
    // signed once (root delegator = this agent) → the child the runtime derived for this intent. The act is the
    // agent's, on its own rail, in-Worker (`internal.messaging.send`). A chain rooted anywhere else, or no chain,
    // with no session, is refused as before — a session-less send is never quietly sent as someone.
    const asSelf = !session && !!person && !!chain && rootDelegatorOf(presented, chain).toLowerCase() === person.toLowerCase();
    if (!person || (!session && !asSelf)) throw new Error('a direct message is sent as you, and there is no signed-in person on this run');
    const recipient = String(args.recipient ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error(`the recipient did not resolve to an agent (${String(args.recipient ?? '')})`);
    // WHO THE MESSAGE IS FROM (spec 400 W1 / 375 W2). The mandate's delegator is the agent this act is an act OF. When
    // that is the person, the message is theirs, on their own rail. When it is an agent they STEWARD — an outside
    // runtime answering a message sent to it, an organization replying — the message is FROM that agent: the person
    // drives its rail with the stewardship wire their own links hold, as the DO admits a steward. A steward who holds
    // no wire for it cannot send as it, and is told so — never a message quietly sent as themselves instead.
    const delegator = asSelf ? person.toLowerCase() : String((presented?.wire as { delegator?: string } | undefined)?.delegator ?? '').toLowerCase();
    let sender: Address = person;
    let stewardship: unknown;
    if (!asSelf && /^0x[0-9a-f]{40}$/.test(delegator) && delegator !== person.toLowerCase()) {
      const links = deps.readSubjectRecord ? await deps.readSubjectRecord(person.toLowerCase(), 'relationships.data').catch(() => null) : null;
      const row = relationshipRows(links).find((r) => r.agent.toLowerCase() === delegator && r.relationship === 'steward' && r.stewardshipDelegation);
      if (!row) throw new Error(`this message would be sent as ${delegator}, which you do not steward`);
      sender = delegator as Address;
      stewardship = row.stewardshipDelegation;
    }
    // A planner that cannot find who was named will sometimes fill the field with whoever it DOES know —
    // and the person it knows is the asker. "Send a message to zzz-nobody-here" came back addressed to
    // Nathan. Harmless for a message and not harmless as a habit: an invented party is the failure the
    // whole resolution tier exists to prevent, so it is a question rather than a plan.
    if (recipient === sender.toLowerCase()) {
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
    const out = await deps.sendDirectMessage({ sender, recipient, bodyText: text, session: session ?? '', ...(stewardship ? { stewardship } : {}), ...(asSelf ? { asSelf: true as const } : {}), operationId: ctx.operationId });
    if (!out.ok) throw new Error(out.error);
    return { sent: true, recipient, from: sender, ...(sender !== person ? { drivenBy: person } : {}), ...(asSelf ? { underStandingGrant: true } : {}), message: text, ...(out.messageId ? { messageId: out.messageId } : {}) };
  };
}

/**
 * `messaging.topic.post` — a reply IN THE TOPIC (spec 400 W2, B3). Who posts is decided exactly as `messageInvoker`
 * decides who sends: the person under their session; an agent they steward (the mandate's delegator, their
 * stewardship wire); the run's own agent under a chain rooted at it (a runtime answering a mention, no session).
 * The org's object authors the post as that member after checking its invitation record.
 */
export function topicPostInvoker(deps: HarnessDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined, chain?: { presentedAll: MandatePresentation[]; chainId: number; delegationManager: Address }): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!deps.postTopic) throw new Error('topic posting is not wired on this agent');
    const asSelf = !session && !!person && !!chain && rootDelegatorOf(presented, chain).toLowerCase() === person.toLowerCase();
    if (!person || (!session && !asSelf)) throw new Error('a topic post is made as you, and there is no signed-in person on this run');
    const org = String(args.org ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(org)) throw new Error(`the organization did not resolve to an agent (${String(args.org ?? '')})`);
    const channelId = String(args.channelId ?? '').trim();
    if (!channelId) throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Which topic? (its id is in the mention\'s context)', fields: [{ name: 'channelId', label: 'Topic id', type: 'text', required: true }] });
    const delegator = asSelf ? person.toLowerCase() : String((presented?.wire as { delegator?: string } | undefined)?.delegator ?? '').toLowerCase();
    let sender: Address = person; let stewardship: unknown;
    if (!asSelf && /^0x[0-9a-f]{40}$/.test(delegator) && delegator !== person.toLowerCase()) {
      const links = deps.readSubjectRecord ? await deps.readSubjectRecord(person.toLowerCase(), 'relationships.data').catch(() => null) : null;
      const row = relationshipRows(links).find((r) => r.agent.toLowerCase() === delegator && r.relationship === 'steward' && r.stewardshipDelegation);
      if (!row) throw new Error(`this post would be made as ${delegator}, which you do not steward`);
      sender = delegator as Address; stewardship = row.stewardshipDelegation;
    }
    const supplied = dataFor(ctx.supplied, stepRef);
    const text = String(supplied.message ?? args.message ?? '').trim();
    if (!text) throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'What should the post say?', fields: [{ name: 'message', label: 'Message', type: 'text', required: true }] });
    const senderName = deps.nameOf ? await deps.nameOf(sender).catch(() => null) : null;
    const out = await deps.postTopic({ org, channelId, sender, senderName, bodyText: text, session: session ?? '', ...(stewardship ? { stewardship } : {}), ...(asSelf ? { asSelf: true as const } : {}), operationId: ctx.operationId });
    if (!out.ok) throw new Error(out.error);
    return { posted: true, org, channelId, from: sender, ...(sender !== person ? { drivenBy: person } : {}), ...(asSelf ? { underStandingGrant: true } : {}), message: text, ...(out.messageId ? { messageId: out.messageId } : {}) };
  };
}

/** `access.grants.audit` — every grant a subject issued, for the asker's own agent or one they steward. */
export function accessAuditInvoker(deps: HarnessDeps, person: Address | undefined): ToolInvoker {
  return async (_toolId, args) => {
    if (!person) return { refused: 'a grants audit is over the asker\'s own agent or one they steward, and there is no asker on this run' };
    if (!deps.auditGrants || !deps.readableVaults) return { refused: 'the grants audit is not wired on this agent' };
    const wanted = String(args.subject ?? '').trim();
    const readable = await deps.readableVaults(person.toLowerCase());
    let subject = readable.find((r) => r.why === 'self') ?? { subject: person.toLowerCase(), why: 'self' as const };
    if (wanted) {
      const byAddr = /^0x[0-9a-fA-F]{40}$/.test(wanted) ? wanted.toLowerCase() : (deps.resolveName ? (await deps.resolveName(wanted).catch(() => null))?.toLowerCase() : null);
      const hit = readable.find((r) => r.subject.toLowerCase() === byAddr || (r.name ?? '').toLowerCase().startsWith(wanted.toLowerCase()));
      if (!hit) return { refused: `${wanted} is not an agent you steward — a grants audit reads only your own agent or one you steward` };
      subject = hit;
    }
    const grants = await deps.auditGrants(subject.subject);
    const live = grants.filter((g) => !g.revoked);
    const named = deps.nameOf ? await Promise.all(grants.map(async (g) => ({ ...g, holderName: g.holderName ?? (/^0x[0-9a-f]{40}$/i.test(g.holder) ? await deps.nameOf!(g.holder).catch(() => null) ?? undefined : undefined) }))) : grants;
    return {
      subject: subject.subject, ...(subject.name ? { subjectName: subject.name } : {}), why: subject.why,
      count: live.length, total: grants.length, grants: named,
      note: grants.length ? 'each row is one grant this agent issued: who holds it, what it permits, its digest; a revoked one is refused everywhere, not only here. Revoke with access.grant.revoke and the digest.' : 'this agent has issued no grant its records can enumerate',
    };
  };
}

/** The ROOT delegator of the presented leaf's chain — who the act is ultimately an act OF. Walks `authority` through
 *  the wires this turn presented (the verifier already refused a chain with a missing link); a root mandate is its own. */
export function rootDelegatorOf(leaf: MandatePresentation, chain: { presentedAll: MandatePresentation[]; chainId: number; delegationManager: Address }): string {
  let wire = leaf.wire as Delegation;
  for (let hop = 0; hop < 5; hop++) {
    const auth = String(wire.authority).toLowerCase();
    if (auth === ROOT_AUTHORITY.toLowerCase()) return wire.delegator;
    const parent = chain.presentedAll.map((p) => p.wire as Delegation).find((d) => hashDelegation(d, chain.chainId, chain.delegationManager).toLowerCase() === auth);
    if (!parent) return wire.delegator;
    wire = parent;
  }
  return wire.delegator;
}

/** The invoker: informational tools go to the existing MCP path; the payment tool redeems on chain; the
 *  team tool builds a genesis the connected user signs. */
export function harnessInvoker(deps: HarnessDeps, env: HarnessEnv, presentedInput: MandatePresentation | MandatePresentation[] | null, mcpInvoke: ToolInvoker, person?: Address, session?: string, surface?: AskScopeV1, addressee?: Address, playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null): ToolInvoker {
  const presentedAll: MandatePresentation[] = presentedInput == null ? [] : Array.isArray(presentedInput) ? presentedInput : [presentedInput];
  // Non-payment invokers redeem the single mandate the turn presented (unchanged). The PAYMENT invoker
  // redeems the one whose caveat names the step's payee — the same selection the verifier used, so what
  // is redeemed is exactly what was judged.
  const presented: MandatePresentation | null = presentedAll[0] ?? null;
  const raw: ToolInvoker = async (toolId, args, ctx) => {
    // Spec 396 W3 — the DO calls this step makes are charged to it on the run's bill.
    setBillStep(ctx.step.id ?? `s${ctx.index}`);
    // Unreachable for a capability tool (the loop refuses or reports before invoking one without a
    // mandate); explicit so a future caller cannot make it reachable quietly.
    if (!presented && (CHILD_AGENT_TLD[toolId] || toolId === 'treasury.payment.execute' || toolId === 'treasury.fund' || toolId === 'messaging.direct.send' || toolId === 'messaging.topic.post' || GITHUB_ACTS.has(toolId) || BUILD_ACTS.has(toolId) || CALENDAR_ACTS.has(toolId) || MAIL_DRIVE_ACTS.has(toolId) || toolId === ORG_INVITE_CAPABILITY || toolId === MEMBER_ROLE_SET_CAPABILITY || toolId === CONTACT_INVITE_TOOL.id || toolId === CONTACT_REMOVE_TOOL.id || toolId === PRIMARY_PAYEE_CAPABILITY || toolId === ACCESS_REVOKE_CAPABILITY)) throw new Error(`${toolId} requires a mandate and none was presented`);
    if (toolId === ASK_CLARIFY_TOOL.id) {
      const ids = Array.isArray(args.options) ? (args.options as unknown[]).map(String).slice(0, 2) : [];
      const purposes = Array.isArray(args.purposes) ? (args.purposes as unknown[]).map(String) : [];
      const [pa, pb] = purposes;
      const answer = pa && pb ? `I can take this two ways — ${pa.replace(/^./, (x) => x.toLowerCase())}, or ${pb.replace(/^./, (x) => x.toLowerCase())}. Which do you mean?` : 'Which do you mean?';
      return { answer, clarify: ids };
    }
    if (toolId === UNSUPPORTED_TOOL.id) {
      const offered = scopedActionTools(surface, playbook).map((t) => t.capability?.id ?? t.id);
      return { unsupported: true, what: String(args.what ?? ''), available: offered };
    }
    if (toolId === MEMBERSHIP_LIST_TOOL.id) {
      return membershipListInvoker(
        {
          ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
          ...(deps.standingContext ? { context: deps.standingContext } : {}),
          ...(deps.verifyStewardship ? { verifyStewardship: deps.verifyStewardship } : {}),
          ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}),
          ...(deps.readSubjectRecordStatus ? { readSubjectRecordStatus: deps.readSubjectRecordStatus } : {}),
          ...(deps.resolveName ? { resolveName: deps.resolveName } : {}),
          ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
          // The org's own INVITATION records, found through its inventory (spec 356 §2.5). A member who
          // joined by invite never published a listing, and reading listings alone hides them.
          ...(deps.survey ? { survey: deps.survey } : {}),
          ...(deps.readRecords ? { readRecords: deps.readRecords } : {}),
          // WHAT KIND OF AGENT IS ASKING ITSELF (spec 375): without this the self-only rule read every
          // unattended run as a person's, and a team's own message trigger parked on "Which organization?"
          // while standing in the organization it meant. The kind is the on-chain record, read once per run.
          ...(deps.addresseeKind !== undefined ? { addresseeKind: deps.addresseeKind } : {}),
        },
        (addressee ?? person ?? ('0x' as Address)), person,
      )(toolId, args, ctx);
    }
    if (toolId === INVITATIONS_LIST_TOOL.id) {
      return invitationsListInvoker(
        {
          ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
          ...(deps.standingContext ? { context: deps.standingContext } : {}),
          ...(deps.verifyStewardship ? { verifyStewardship: deps.verifyStewardship } : {}),
          ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}),
          ...(deps.survey ? { survey: deps.survey } : {}),
          ...(deps.readRecords ? { readRecords: deps.readRecords } : {}),
          ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
          ...(deps.addresseeKind !== undefined ? { addresseeKind: deps.addresseeKind } : {}),
        },
        (addressee ?? person ?? ('0x' as Address)), person,
      )(toolId, args, ctx);
    }
    if (toolId === AFFILIATIONS_LIST_TOOL.id) {
      return affiliationsListInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}) }, person)(toolId, args, ctx);
    }
    // Spec 400 W1 — what has been said to THIS agent, from its own inbox (an outside runtime's poll; a person's "what's new").
    if (toolId === INBOX_LIST_TOOL.id) {
      return inboxListInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, person)(toolId, args, ctx);
    }
    if (toolId === WORK_SEARCH_TOOL.id) {
      return workSearchInvoker({ ...(deps.readableVaults ? { readableVaults: deps.readableVaults } : {}), ...(deps.searchSubject ? { searchSubject: deps.searchSubject } : {}) }, person)(toolId, args, ctx);
    }
    // Spec 401 C1 — CONTACTS: membership on the person agent. The organization's mechanism with the person as principal.
    if (toolId === CONTACT_INVITE_TOOL.id || toolId === CONTACT_LIST_TOOL.id || toolId === CONTACT_REMOVE_TOOL.id) {
      const cdeps: ContactDeps = {
        env, enforcers: harnessEnforcers(env), vaultServerId: vaultServerId(env),
        ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
        ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}),
        ...(deps.survey ? { survey: deps.survey } : {}),
        ...(deps.readRecords ? { readRecords: deps.readRecords } : {}),
        ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
        ...(deps.agentTypeOf ? { agentTypeOf: deps.agentTypeOf } : {}),
        ...(deps.sendDirectMessage ? { sendDirectMessage: deps.sendDirectMessage } : {}),
        ...(deps.executeAsServiceSa ? { executeAsServiceSa: deps.executeAsServiceSa } : {}),
        digestBindingArgsFor, stepDigests,
      };
      if (toolId === CONTACT_LIST_TOOL.id) return contactListInvoker(cdeps, person)(toolId, args, ctx);
      if (toolId === CONTACT_INVITE_TOOL.id) return contactInviteInvoker(cdeps, presented!, person, session)(toolId, args, ctx);
      return contactRemoveInvoker(cdeps, presented!, person)(toolId, args, ctx);
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
    if (toolId === BALANCE_READ_CAPABILITY) return balanceReadInvoker({ ...(deps.valueHeld ? { valueHeld: deps.valueHeld } : {}), ...(deps.agentTypeOf ? { agentTypeOf: deps.agentTypeOf } : {}), ...(deps.charteredAgents ? { charteredAgents: deps.charteredAgents } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, (addressee ?? person) as Address, person)(toolId, args, ctx);
    // Spec 419 — what an agent HOLDS, from the public chartered-under record; unnamed ⇒ the agent being asked.
    if (toolId === HOLDINGS_READ_CAPABILITY) return holdingsReadInvoker({ ...(deps.charteredAgents ? { charteredAgents: deps.charteredAgents } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, (addressee ?? person) as Address)(toolId, args, ctx);
    // The coordination reads judge standing themselves; the routed context rides in as `StandingDeps.context`.
    const coordinationDeps = { ...deps, ...(deps.standingContext ? { context: deps.standingContext } : {}), ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}) };
    if (toolId === ENDEAVOR_LIST_CAPABILITY || toolId === ENDEAVOR_GET_CAPABILITY) return endeavorReadInvoker(coordinationDeps, (addressee ?? person) as Address, person)(toolId, args, ctx);
    if (COORDINATION_CAPABILITY_IDS.has(toolId)) return endeavorActInvoker(coordinationDeps, (addressee ?? person) as Address, person, session)(toolId, args, ctx);
    if (toolId === 'messaging.direct.send') return messageInvoker(deps, presented!, person, session, { presentedAll, chainId: Number(env.CHAIN_ID), delegationManager: env.DELEGATION_MANAGER as Address })(toolId, args, ctx);
    if (toolId === 'messaging.topic.post') return topicPostInvoker(deps, presented!, person, session, { presentedAll, chainId: Number(env.CHAIN_ID), delegationManager: env.DELEGATION_MANAGER as Address })(toolId, args, ctx);
    if (toolId === ORG_INVITE_CAPABILITY) return inviteInvoker(env, presented!, person, deps, session)(toolId, args, ctx);
    if (CHILD_AGENT_TLD[toolId]) {
      if (!deps.teamGenesis) throw new Error(`${toolId} is not configured on this agent (no genesis substrate)`);
      return childAgentCreateInvoker(deps.teamGenesis, env, presented!, person)(toolId, args, ctx);
    }
    if (toolId === 'treasury.fund') return fundInvoker(deps, env, presented!)(toolId, args, ctx);
    if (toolId === PRIMARY_PAYEE_CAPABILITY) return primaryPayeeInvoker(deps, env, presented!)(toolId, args, ctx);
    if (toolId === ACCESS_REVOKE_CAPABILITY) return accessRevokeInvoker(deps, env, presented!, person)(toolId, args, ctx);
    if (toolId === ACCESS_AUDIT_CAPABILITY) return accessAuditInvoker(deps, person)(toolId, args, ctx);
    // Spec 400 W3/W4 — GitHub as a connector: reads under the holder's connector, acts under the holder's mandate.
    if (WEB_TOOLS.some((t) => t.id === toolId)) return webReadInvoker()(toolId, args, ctx);
    if (WEB_SEARCH_TOOLS.some((t) => t.id === toolId)) return webSearchInvoker(env as never)(toolId, args, ctx);
    if (PREFERENCES_TOOLS.some((t) => t.id === toolId)) return preferencesInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}) }, person, addressee)(toolId, args, ctx);
    if (MAIL_DRIVE_TOOLS.some((t) => t.id === toolId)) return mailDriveInvoker({ env: env as never, ...(deps.resolveName ? { resolveName: deps.resolveName } : {}) }, (presented ?? null) as never, person)(toolId, args, ctx);
    if (CALENDAR_TOOLS.some((t) => t.id === toolId)) return calendarInvoker({ env: env as never, ...(deps.resolveName ? { resolveName: deps.resolveName } : {}) }, (presented ?? null) as never, person)(toolId, args, ctx);
    if (LIBRARY_TOOLS.some((t) => t.id === toolId)) { if (!deps.readSubjectRecord) throw new Error('the private tier is not configured'); return libraryInvoker({ readSubjectRecord: deps.readSubjectRecord, ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}), ...(deps.signAsAgent ? { signAsOwner: deps.signAsAgent } : {}), ...(deps.announceShelf ? { announce: deps.announceShelf } : {}), stewardOf: (who, owner) => stewardshipOver({ readSubjectRecord: deps.readSubjectRecord!, ...(deps.verifyStewardship ? { verifyStewardship: deps.verifyStewardship } : {}), ...(deps.standingContext ? { context: deps.standingContext } : {}) }, who, owner) }, addressee, person)(toolId, args, ctx); }
    if (isMcpTool(toolId) || toolId === MCP_CONNECTORS_LIST) return mcpConnectorInvoker({ env: env as never, readConnectors: (h) => mcpConnectorsOf(deps, h), ...(deps.resolveName ? { resolveName: deps.resolveName } : {}) }, (presented ?? null) as never, addressee)(toolId, args, ctx);
    if (BUILD_TOOLS.some((t) => t.id === toolId)) return buildInvoker({ env: env as never, ...(deps.nameOf ? { nameOf: deps.nameOf } : {}), ...(deps.resolveName ? { resolveName: deps.resolveName } : {}), ...(deps.survey ? { survey: deps.survey } : {}), ...(deps.readRecords ? { readRecords: deps.readRecords } : {}), ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}) }, (presented ?? null) as never, addressee)(toolId, args, ctx);
    if (GITHUB_TOOLS.some((t) => t.id === toolId)) return githubInvoker({ env: env as unknown as Record<string, unknown>, ...(deps.nameOf ? { nameOf: deps.nameOf } : {}), ...(deps.resolveName ? { resolveName: deps.resolveName } : {}) }, (presented ?? null) as never, person)(toolId, args, ctx);
    if (toolId === PROFILE_UPDATE_CAPABILITY) return profileUpdateInvoker(deps, person)(toolId, args, ctx);
    if (toolId === HOUSEHOLD_RECORD_CAPABILITY) return householdRecordInvoker(deps, person)(toolId, args, ctx);
    if (toolId === STANDING_INSTRUCTION_CAPABILITY) return standingInstructionInvoker(deps, person, addressee)(toolId, args, ctx);
    if (ROUTINE_TOOLS.some((t) => t.id === toolId)) return routineInvoker({ ...(deps.listTriggers ? { listTriggers: deps.listTriggers } : {}), ...(deps.declareTrigger ? { declareTrigger: deps.declareTrigger } : {}), ...(deps.removeTrigger ? { removeTrigger: deps.removeTrigger } : {}), ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.writeSubjectRecord ? { writeSubjectRecord: deps.writeSubjectRecord } : {}) }, person, addressee, (i) => { throw new InputRequired(i); }, (c, ref) => dataFor((c as { supplied?: unknown }).supplied as never, ref))(toolId, args, ctx);
    // Spec 422 §9.1 — the Security section, asked: reads from the chain + her vault; acts as ceremonies her Home runs.
    if (isSecurityTool(toolId)) return securityInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...securityChainDeps(env as never) }, person)(toolId, args, ctx);
    // Spec 427 — the organization's agent rewrites the role on its member's record, under the mandate this run presented.
    if (toolId === MEMBER_ROLE_SET_CAPABILITY) {
      if (!deps.setMemberRoleAt) throw new Error('setting a member\u2019s role is not configured on this estate');
      return memberRoleSetInvoker({ setRoleAt: deps.setMemberRoleAt, ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, (presented!.wire as Delegation).delegator, person)(toolId, args, ctx);
    }
    if (toolId === MEMBERSHIP_ACCEPT_CAPABILITY) return membershipAcceptInvoker({ ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) }, person)(toolId, args, ctx);
    if (MEMORY_TOOLS.some((t) => t.id === toolId)) return memoryFactsInvoker(deps, person, (ctx as { runRef?: string }).runRef ?? (ctx.idempotencyKey ? ctx.idempotencyKey.split(':').slice(0, -1).join(':') : undefined), addressee)(toolId, args, ctx);
    // Spec 387 W2 — the addressee's own catalog: bound by ITS name's records at call time (cached by the reader),
    // so an unattended run at a service (a gateway's task, a routed ask) reads it exactly as a person's does.
    if (isCatalogTool(toolId)) return catalogInvoker(await catalogBindingFor(deps, addressee ? String(addressee) : undefined))(toolId, args, ctx);
    // Spec 426 — ONE generic branch for every executor-invoke capability (no branch per domain): the
    // definition carries the `invoke` block; call the resolved executor as the run's principal (the acting
    // agent). Self-acting — no mandate; `deps.executorSession` is the authority seam, refusing on null.
    // THE CONTRACT'S `invoke` WINS over a same-named built-in: a person's People-Group Steward pack reaches the
    // people-group MCP by `mcp.tools-call` (executor gc-people-groups), while the SERVICE's People-Group Catalog
    // archetype carries no invoke and binds by its own name record below. Dispatching the name-record path first
    // sent alice's `peoplegroup.count` to a record she does not have ("publishes no people-group catalog", 2026-10-09).
    {
      const invoke = playbook?.tools?.[toolId]?.invoke;
      if (invoke) {
        const needsSeam = (invoke as { transport?: string }).transport !== 'mcp.tools-call';
        if (needsSeam && !deps.executorSession) return { refused: `executor-invoke is not configured on this deployment (no session seam) for ${toolId}` };
        // The run's own session rides to the seam (§5 production binding): the Home mints the principal's
        // id_token from it. The seam still refuses a principal the session does not own.
        const seam = deps.executorSession;
        return executorInvokeInvoker({ executors: readExecutors(env.EXECUTORS), session: (p, c) => (seam ? seam(p, c, session) : Promise.resolve(null)) }, invoke, addressee ?? person)(toolId, args, ctx);
      }
    }
    // The people-group catalog (ap-people-group-catalog/v1) — the same record, a different profile; listed only where `tools/list` served it.
    if (isPeopleGroupTool(toolId)) return peopleGroupInvoker(await catalogBindingFor(deps, addressee ? String(addressee) : undefined))(toolId, args, ctx);
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
    // Spec 376 — THE PAYER IS THE CHAIN'S ROOT DELEGATOR. A child mandate's delegator is the harness that
    // attenuated it; the USDC that moves is the ROOT delegator's (the treasury the person signed for), and
    // every check that names the payer names that one.
    const rootDelegatorOf = (leaf: Delegation): Address => {
      let cur = leaf;
      for (let hop = 0; hop < 4 && String(cur.authority).toLowerCase() !== ROOT_AUTHORITY.toLowerCase(); hop++) {
        const up = presentedAll.map((p) => p.wire as Delegation).find((d) => hashDelegation(d, Number(env.CHAIN_ID), env.DELEGATION_MANAGER as Address).toLowerCase() === String(cur.authority).toLowerCase());
        if (!up) break;
        cur = up;
      }
      return cur.delegator.toLowerCase() as Address;
    };
    const rootPayer = rootDelegatorOf(paymentPresented.wire as Delegation);
    const payer = args.payer ? await partyAddress(args.payer, deps, 'the payer') : '';
    if (payer && payer !== rootPayer) {
      throw new Error(`the payment is made by the mandate's delegator (${rootPayer}); the plan named ${payer}`);
    }
    const payee = await partyAddress(args.payee, deps, 'the payee');
    // ── THE VALUE RAIL (spec 373) ──────────────────────────────────────────────────────────────────
    // Money moves between ACCOUNTS. Both ends are checked HERE, at the moment of acting, because this is
    // the one place nothing can go around: a hand-supplied plan, a peer's step, an address typed straight
    // into the argument, or a resolver that learns a new way to be wrong. On 2026-09-08 every other gate
    // passed and the money landed on `carol.me`.
    //
    // The evidence is the on-chain `atl:agentType`, never the name: a suffix is a claim, the record is the
    // authority, and an unnamed treasury has the record but no suffix. Fail-closed — unreadable is
    // refused, and the sentence says which end and what it is.
    await refuseUnlessTreasury(deps, payer || rootPayer, 'paying from');
    await refuseUnlessTreasury(deps, payee, 'being paid');
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
    const stepRef = ctx.step.idempotencyKey ?? ctx.step.id ?? `s${ctx.index}`; // spec 410 §3 — the nonce's logical identity
    const nonce = keccak256(toBytes(`${digest}:${stepRef}`));
    const paymentArgs = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [digest, nonce, keccak256(toBytes(`${paymentPresented.ref}:${stepRef}`))]);
    const caveats = wire.caveats.map((c) => {
      const e = c.enforcer.toLowerCase();
      if (e === enforcers.payment!.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: paymentArgs };
      if (e === enforcers.digestBinding.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: digestBindingArgsFor(c, stepDigests(args, digest, stepRef, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: env.CONTRACTS_GENERATION }))) };
      return { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex };
    });
    // Again, at the moment of acting: the balance may have moved since the preview, and a revert with no
    // reason is a worse answer than a sentence with the numbers in it.
    const late = await preconditionRefusal({ capability: 'treasury.payment.execute', args: { ...args, payer: rootPayer }, env, deps });
    if (late) throw new Error(late);
    // Spec 376 — A CHILD REDEEMS WITH ITS CHAIN. The leaf is the mandate the verifier judged; when its
    // `authority` names a parent this turn also presented, the parent follows it, with ITS OWN redeem-time
    // args (its bound intent digest; the same nonce keyed under its own hash). `DelegationManager`
    // enforces every link's caveats; a link that is missing, revoked or wider than its child reverts.
    const chain: Array<{ delegator: Address; delegate: Address; authority: Hex; caveats: typeof caveats; salt: bigint; signature: Hex }> = [{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }];
    let auth = String(wire.authority).toLowerCase();
    for (let hop = 0; hop < 4 && auth !== ROOT_AUTHORITY.toLowerCase(); hop++) {
      const link = presentedAll.map((p) => p.wire as Delegation).find((d) => hashDelegation(d, Number(env.CHAIN_ID), dm).toLowerCase() === auth);
      if (!link) throw new Error('the presented mandate is a child whose parent was not presented — a chain is redeemed whole or not at all');
      const bound = readDigestBindings(link.caveats, enforcers.digestBinding).intent ?? digest;
      const linkCaveats = link.caveats.map((c) => {
        const e = c.enforcer.toLowerCase();
        if (e === enforcers.payment!.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [bound, nonce, keccak256(toBytes(`${hashDelegation(link, Number(env.CHAIN_ID), dm)}:${stepRef}`))]) };
        if (e === enforcers.digestBinding.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: digestBindingArgsFor(c, stepDigests(args, bound, stepRef, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: env.CONTRACTS_GENERATION }))) };
        return { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex };
      });
      chain.push({ delegator: link.delegator, delegate: link.delegate, authority: link.authority as Hex, caveats: linkCaveats, salt: link.salt, signature: link.signature as Hex });
      auth = String(link.authority).toLowerCase();
    }
    const transfer = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [payee, amount] });
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [chain, asset, 0n, transfer] });
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
      return { asset, payee, amount: amount.toString(), payer: rootPayer, alreadySettled: true };
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
      if (settled === true) return { asset, payee, amount: amount.toString(), payer: rootPayer, alreadySettled: true, outcome: 'committed', effectIdentity: `${dHash}:${nonce}`, reconciled: true };
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`${settled === false ? 'failed before effect' : 'outcome unknown and not reconcilable'}: ${reason}`);
    }
    return { txHash, asset, payee, amount: amount.toString(), payer: rootPayer, outcome: 'committed', effectIdentity: `${dHash}:${nonce}` };
  };
  // Spec 410 §2 — every family says what it saw, at the one boundary they all cross.
  return async (toolId, args, ctx) => observeResult(toolId, await raw(toolId, args, ctx));
}

/**
 * Spec 410 §2 — WHAT EACH ADAPTER FAMILY CAN VOUCH FOR, from the shape of what it returned. Named per family,
 * never inferred from success: a value that proves nothing stays a raw value and the loop records `attempted`.
 *
 *   chain effects      `txHash` — the bundler client waited for the transaction receipt: the chain was READ after
 *                      the submit, so the effect is CONFIRMED and the tx hash is the provider's reference.
 *   payment, settled   `alreadySettled` — the enforcer's nonce slot said this exact payment had happened: a
 *                      reconcile, CONFIRMED, the effect identity as the reference.
 *   messaging          `messageId` — the sender's object delivered to the recipient's gate synchronously and
 *                      recorded (deliver-or-409); COMMITTED by the provider, not read back.
 *   vault writes       `record` + kept/remembered/updated/changed/forgotten/cleared — the object answered ok for
 *                      that record type: COMMITTED, the record type as the reference.
 *   invitation         `invited` — a submission: the organization RECORDED the invitation (ACCEPTED); a membership
 *                      is what the invitee's acceptance establishes, not this.
 *   github / calendar  `url` / `event.id` — the provider returned the created object: COMMITTED. A draft is ACCEPTED.
 *   mail
 *   MCP connector      `called` — an outside server said something; nothing proves a commit: ACCEPTED at most.
 *   routed / hand-off  `via.runRef` — the receiver's run; COMMITTED when its receipts came back, else ACCEPTED.
 */
export function observeResult(toolId: string, result: unknown): unknown {
  if (isToolInvocationResult(result) || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof r[k] === 'string' && (r[k] as string).length ? (r[k] as string) : undefined);
  const txHash = str('txHash');
  if (txHash) return observed(result, 'confirmed', { providerRef: txHash, evidence: [{ kind: 'chain-read', ref: 'the bundler client waited for the transaction receipt before returning' }] });
  if (r.alreadySettled === true) return observed(result, 'confirmed', { ...(str('effectIdentity') ? { providerRef: str('effectIdentity') } : {}), evidence: [{ kind: 'reconcile', ref: 'PaymentEnforcer.isNonceUsed: this exact payment had already settled' }] });
  if ((r.sent === true || r.posted === true) && str('messageId')) return observed(result, 'committed', { providerRef: str('messageId'), evidence: [{ kind: 'response-digest', ref: 'the sender\'s object delivered to the recipient\'s gate and recorded the envelope' }] });
  if (str('record') && (r.kept === true || r.remembered === true || r.updated === true || r.changed === true || r.forgotten === true || r.cleared === true)) return observed(result, 'committed', { providerRef: str('record'), evidence: [{ kind: 'response-digest', ref: `the vault answered ok for ${str('record')}` }] });
  if (r.invited === true) return observed(result, 'accepted', { ...(str('grantDigest') ? { providerRef: str('grantDigest') } : {}), evidence: [{ kind: 'response-digest', ref: 'the organization recorded the invitation; membership is what the acceptance establishes' }] });
  if (r.added === true && str('grantDigest')) return observed(result, 'committed', { providerRef: str('grantDigest'), evidence: [{ kind: 'response-digest', ref: 'the contact record and its grant were written to the vault' }] });
  if ((r.opened === true || r.commented === true || r.promoted === true) && str('url')) return observed(result, 'committed', { providerRef: str('url'), evidence: [{ kind: 'response-digest', ref: 'GitHub returned the object it created' }] });
  if (r.created === true && r.event && typeof r.event === 'object' && typeof (r.event as { id?: unknown }).id === 'string') return observed(result, 'committed', { providerRef: String((r.event as { id: string }).id), evidence: [{ kind: 'response-digest', ref: 'the calendar returned the event it created' }] });
  if (r.deleted === true && str('id')) return observed(result, 'committed', { providerRef: str('id'), evidence: [{ kind: 'response-digest', ref: 'the provider answered the delete' }] });
  if (r.sent === true && str('threadId')) return observed(result, 'committed', { providerRef: str('messageId') ?? str('threadId'), evidence: [{ kind: 'response-digest', ref: 'the mail provider returned the sent message' }] });
  if (r.drafted === true) return observed(result, 'accepted', { ...(str('draftId') ? { providerRef: str('draftId') } : {}), evidence: [{ kind: 'response-digest', ref: 'a draft is held, not sent' }] });
  if (r.called === true && str('connector')) return observed(result, 'accepted', { evidence: [{ kind: 'response-digest', ref: `an outside MCP server (${str('connector')}) answered; nothing proves it committed` }] });
  const via = r.via as { runRef?: unknown; receipts?: unknown } | undefined;
  if (via && typeof via.runRef === 'string') return observed(result, Array.isArray(via.receipts) && via.receipts.length ? 'committed' : 'accepted', { providerRef: via.runRef, evidence: [{ kind: 'response-digest', ref: Array.isArray(via.receipts) && via.receipts.length ? `the receiver's run returned ${via.receipts.length} receipt(s)` : 'the receiver holds the step' }] });
  void toolId;
  return result;
}

/** PaymentEnforcer.isNonceUsed — the on-chain idempotency read (spec 358 W4-tail). readContract only. */
const IS_NONCE_USED_ABI = [{
  type: 'function', name: 'isNonceUsed', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }],
}] as const;

export interface HarnessRunInput {
  /** Spec 390 W2 — the W3C Trace Context the request arrived with, so a routed hop this run makes carries the
   *  SAME trace outbound (the caller's, not one derived here). Recorded on the run record; read by no gate. */
  traceContext?: TraceContextV1 | null;
  /** Spec 390 W3 — where the runtime's own windows (playbook, catalog, standing…) are recorded, itemising the
   *  `receive_request` span; absent ⇒ only the console line. */
  marks?: RunMarks;
  intent: { goal: string; constraints?: Record<string, unknown>; context?: Record<string, unknown>; /** Spec 410 §5 — set here, after the playbook is known; bound by the intent digest (`delegation.VersionBindingV1`). */ versions?: { ontologyManifestDigest: string; semanticsDigest: string } };
  /** The message's DATA part naming a skill — the material `playbook.answer` reasons over. Never in the intent: it is
   *  what the person can already see, not what they asked, and it must not bind a mandate's digest. */
  material?: Record<string, unknown> | null;
  /** A VERIFIED STUDY GRANT for this run (`card-room.ts`): the addressee is a coach service consulted by the
   *  person's own agent, and `playbook.answer` reads that person's study records under it. Set only by
   *  `runAgentAsk` after `verifyStudyGrant`; absent, the answering tool knows only what the message carried. */
  study?: StudyAccess;
  /** Spec 370 P1 — the checkpoint's record of what ran: the admitted plan and the completed steps. The
   *  loop replays the completed steps and plans nothing anew; the remaining steps are verified afresh. */
  resume?: { plan: Plan; completed: ReadonlyArray<{ stepRef: string; result?: unknown; receipt?: StepReceipt }> };
  /** Spec 370 P2 — one sentence per loop event, as the run goes, for a surface to show or say. Composed
   *  here because the tools' words are known here; what the caller does with it is its business. */
  onProgress?: (line: Omit<ProgressLineV1, 'seq' | 'at'>) => void;
  /** Spec 370 P6 — REPLAY a recorded run: its plan is the plan, its observations answer every step, and
   *  every gate runs again against the world as it is now. Nothing executes. */
  /** Spec 374 W2 — where each routed step of this run waits, from the checkpoint (a resume continues THAT run). */
  routedAt?: Record<string, { agent: Address; name?: string; runRef: string; stepRef?: string }>;
  replayOf?: RunRecordV1;
  /** Spec 370 P7 — the asker's own recent turns (their vault's `conversation.recent`). Shown to the
   *  planner as words, handed to the resolver for pronouns and repeated names. NEVER part of the intent:
   *  the mandate binds the intent's digest, and a memory that grows between turns would break every resume. */
  conversation?: ConversationMemoryV1 | null;
  /** Spec 402 W1 — what the asker's agent remembers about the asker; only when the asker addresses their OWN agent. */
  memory?: RememberedFactsV1 | null;
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
  /** A SCREEN reading rows (its supplied plan is informational and it never shows the sentence). A screen read of a
   *  tool this agent does not expose is answered "not offered" without running — never recorded as a denial. */
  rowsOnly?: boolean;
  /** Spec 384 W3 — a campaign selected a provider for this run's step: every step exercising that capability is
   *  handed to the provider and carries the offer's digest (`bindSelectedOffer`), so the requirement names the
   *  offer and a mandate that does not is refused. Shapes the plan; no gate reads it. */
  engagement?: SelectedOfferBindingV1 | null;
  /** Spec 367 §8 — when this run answers ANOTHER agent's routed request: the request it responds to, pinned
   *  onto every receipt's binding (`correlation.inResponseTo`) so the causal chain R → S is on the record. */
  inResponseTo?: { agent: Address; operationId: string; runRef: string; stepRef: string };
  /** The connected user (the session's SA). What they create, they custody. */
  person?: Address;
  /** Their Home session — the interactions plane authenticates a direct message with it. */
  session?: string;
  /** Spec 397 — no session: the person asked THROUGH A CLIENT they authorized. The `A2A-Session` authorization and
   *  the exact body it bound, kept so a routed hop can present the same evidence to the subject's agent. */
  appCredential?: { authorization: string; body: string };
  /** Spec 397 — THROUGH A HOST: the registered client of the person and the template whose wire admitted the ask
   *  (`ask-as-me`) or whose standing wire a step's mandate derives from (`act-as-me`). Ids the receipt names; never
   *  the wire. Accepted only beside a verified `A2A-Session` admission. */
  via?: { client: string; template: string };
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
  /** Spec 377 — the provider this turn plans, composes and looks things up with. Absent ⇒ the deployment
   *  default. Validated by the caller against what the deployment offers; never a gate input. */
  provider?: LlmProvider;
  /** Per-area providers (2026-10-01), each already resolved by the caller against what the deployment offers: the
   *  SELECTOR's (planner + selection judge), the ANSWER's (skill.apply and the pairwise's second answer) and the JUDGE's
   *  (quality · outcome · pairwise). Absent ⇒ `provider`. Behaviour, never authority. */
  selectionProvider?: LlmProvider;
  answerProvider?: LlmProvider;
  judgeProvider?: LlmProvider;
  /** Spec 415 A4 — what a COMPARISON asked this run to do differently (already admitted by the caller: a
   *  comparison estate, the agent's own steward). The planner kind and the capability toggles apply here; the
   *  provider was folded into `provider`. Behaviour, never authority. */
  /** Spec 418 §12 — this run is a COMPARISON (the request carried a variant, whatever its fields): self-acting writes are
   *  held (dry run). Set by the ask surface from the request itself, never inferred from which variant fields arrived. */
  comparison?: boolean;
  variant?: { plannerKind?: 'model' | 'rule-based'; selection?: 'model' | 'declared' | 'ontology' | 'judgment' | 'ontology+judgment' | 'propose+judgment' | 'ontology-first' | 'framed-judgment' | 'outcome' | 'outcome-selective'; toggles?: Record<string, string>;
    judgeProfile?: 'thorough' | 'fast' | 'logprob';
    askerContext?: { digest: string; recentSkills?: Array<{ id: string; times: number }>; memoryTags?: string[]; heldClasses?: string[] };
    /** Spec 416 W3 — conformal acceptance under a fitted map. */
    acceptance?: { method: 'conformal'; alpha: number; temperature: number; qhat: number; mapDigest: string } };
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
  'service.create': 'charter service agents',
  'person.create': 'add another person of your own',
  'treasury.create': 'create treasuries',
  'organization.membership.invite': 'invite members',
  'organization.member.role.set': 'set what a member does here',
  'coordination.endeavor.list': 'see what the organization is working on',
  'treasury.balance.read': 'read a balance',
  'coordination.endeavor.get': 'read one endeavor',
  'context.instruction.declare': 'keep a standing instruction',
  'coordination.endeavor.request': 'ask the organization to take on a goal',
  'coordination.contribution.propose': 'offer to do plan steps',
  'coordination.contribution.allocate': 'allocate plan steps',
  'coordination.endeavor.satisfy': 'close an endeavor as done',
  'coordination.milestone.achieve': 'record a milestone as achieved',
  'coordination.step.satisfy': 'record a step as done',
  'coordination.commitment.withdraw': 'withdraw a commitment',
  'coordination.commitment.reallocate': 'reallocate a contribution',
  'coordination.decision.request': 'raise a decision for named approvers',
  'coordination.decision.record': 'record a decision on a pending request',
  'treasury.payment.execute': 'make payments',
  'treasury.fund': 'fund a treasury with demo USDC',
  'messaging.direct.send': 'send direct messages',
  'messaging.topic.post': 'post in a topic',
  'resolution.invitation.request': 'ask someone how to reach an agent of theirs',
  'treasury.primary.declare': 'say which treasury receives payments to you',
  'access.grants.list': 'say which apps can read your records',
  'access.grants.audit': 'list every grant this agent issued',
  'github.pr.open': 'open a pull request on GitHub',
  'github.pr.comment': 'comment on a pull request',
  'github.pr.merge': 'promote (merge) a pull request',
  'build.run': 'run a build task for the workspace in a sandbox',
  'build.promote': 'promote a build — merge its pull request under a signature over the exact commit',
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
      /** Spec 361 / 402 W4 — APPS INSIDE THE ASK: the first read step whose contract names a RESULT component, so the
       *  surface can render that component over the step's result beside the sentence. The app's registry resolves the
       *  name; an unknown name renders nothing and the sentence stands. `toolId` says which result it is over. */
      interaction?: { result?: string; navigationTarget?: string; toolId?: string };
      /** Spec 402 W1b — WHAT MAY FOLLOW an answer: a memory the agent PROPOSES from what the person said about herself
       *  ("remember that I lead the Thursday circle") — one click, nothing written until she clicks. */
      next?: NextActV1;
      /** Spec 366 — WHICH STEPS WERE ANSWERED BY ANOTHER AGENT, and how: the subject's agent, how it was
       *  reached, its run and its receipts. Evidence a surface can show and a record can cite (M8). */
      routed?: RoutedStepV1[];
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
      /** Spec 361 / 402 W4 — the required capability's REVIEW component (from its contract), rendered before she signs. */
      interaction?: { review?: string; navigationTarget?: string };
      /** Spec 421 W2 — the arguments of this act that came ONLY from someone else's words (not hers), with where from — said
       *  on the card before she signs. Evidence, never a gate: the signature is still hers to give or withhold. */
      fromOthers?: Array<{ arg: string; from: string[] }>;
      /** Spec 374 W2 — this authority is the SUBJECT'S request, relayed: the step waits at that agent, and
       *  the mandate the asker grants travels there on resume. Absent ⇒ a local step. */
      routedAt?: { agent: Address; name?: string; runRef: string };
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
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: NonNullable<RunResult['prompt']>;
      /** Spec 397 — the question is a routed target's: where it waits, kept on the checkpoint so the answer continues THAT run. */
      routedAt?: { agent: Address; name?: string; runRef: string; stepRef?: string } }
  /** Spec 374 — the run waits on ANOTHER agent's steward. Not resumable by the asker: only the debtor's
   *  delivered answer moves it. `on` is where the act actually waits; `commitment` is the record. */
  | { kind: 'waiting'; runRef: string; stepRef: string; text: string; on: { agent: Address; name?: string; runRef: string }; commitment: CommitmentRefV1;
      /** How THIS run resolved the words the parked act names — cited (a remembered choice, the last ask), so the
       *  person waiting can see which "xyz" they are waiting on and say otherwise. Display; decides nothing. */
      parties?: ResolvedParty[] }
  | { kind: 'done'; runRef: string; result: unknown; receipts: RunResult['receipts']; skillProvenance?: Record<string, unknown>;
      /** Spec 412 W5 — every step's outcome on a SUPPLIED multi-step act (an app's one run), by tool id. */
      results?: Array<{ toolId: string; result: unknown }>;
      /** Spec 366/374 — which steps were DONE BY ANOTHER AGENT (a routed act): the subject, how it was reached, its run. */
      routed?: RoutedStepV1[];
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
  planner: 'supplied' | 'compiled' | 'anthropic' | 'groq' | 'openai' | 'xai' | 'rule-based' | string;
  /** Spec 377 — the concrete model the planner ran (`openai/gpt-oss-120b`, `claude-haiku-4-5-20251001`). Absent
   *  for supplied / compiled / rule-based plans. Display only. */
  model?: string;
  /** The tool ids the planner could choose from — a capability absent here was never an option. */
  toolsExposed: string[];
  /** The playbook this run was admitted under (digest-pinned), or null for the bare harness. */
  playbook: { archetypeId: string; archetypeVersion: string; digest: string } | null;
  /** keccak256 of the exact system prompt the model was given (doctrine + rules + examples). */
  promptDigest: Hex;
  /** How many contract examples were rendered into that prompt. */
  examplesRendered: number;
  /** How much of the playbook's instructions the planner was shown: the doctrine (`chars`) of the whole
   *  (`of`). The per-act execution bodies are not rendered — see `plannerDoctrineOf`. */
  instructionsRendered?: { chars: number; of: number };
  /** A provider's prompt budget and how the prompt was made to fit it: the estimate the request was judged
   *  by and every drop taken, in order (`fitPlannerPrompt`). Absent ⇒ no budget applied. */
  promptBudget?: { tokens: number; estimated: number; trimmed: string[] };
  /** Spec 391 — the composer's evidence, FITTED to its budget: how much it saw of how much there was, and every
   *  result whose body was replaced by its summary. Never a silent slice. */
  composerEvidence?: { chars: number; of: number; dropped: Array<{ tool: string; stepRef?: string; bytes: number }> };
  /** Spec 420 §10 — per party word, what the private tier returned before narrowing (evidence; bounded to 12 entries). */
  resolution?: Array<{ arg: string; raw: string; outcome: string; looked?: string[]; candidates: Array<{ agent: string; source: string; match?: string; context?: string; kind?: string }> }>;
  /** Spec 421 W1 — the planner calls that CONTINUED a plan from what was read: the steps each one added. */
  continuations?: Array<{ steps: Array<{ toolId: string }> }>;
  /** Spec 388 — which provider carried the planner and the composer, and why (the numbers beside the reason). */
  /** Spec 415 — every structured model call the run made (the selection judge, a skill's answer, the KB and vault
   *  choosers), as it ran: provider, model, why, when. Each becomes a model invocation on the run's provenance. */
  structuredCalls?: Array<{ role: 'judge' | 'structured'; stepRef?: string; provider: string; model: string; because?: string; startMs: number; endMs: number; failed?: boolean; tokensIn?: number; tokensOut?: number; cachedIn?: number; reasoningOut?: number }>;
  /** Spec 416 §4h — the answer's quality by the rubric (a comparison's instrument): P(true) per question, the mean,
   *  the judge's own time and reported tokens — kept apart from the ask's. */
  quality?: { judge: string; scores: Record<string, number>; score: number; ms: number; tokensIn?: number; tokensOut?: number; error?: string };
  /** Spec 416 §4h — the default and light answers judged side by side: P(default better), P(light better), P(tie). */
  pairwise?: { judge: string; preference: Record<string, number>; ms: number; error?: string };
  /** Spec 416 §4g — milliseconds per runtime stage of this ask (the marks, summed per name). */
  stages?: Record<string, number>;
  /** Spec 416 §4f — the default skill stage's outcome: the fast judge chose a skill, or handed the ask to the planner.
   *  `skeleton` (2026-10-01, `skill-selection/hold`): a skill was chosen, a required input was missing, and the skill ran
   *  under the skeleton instruction instead of only asking — a comparison reads this, never the answer, to tell them apart. */
  skillStage?: 'chose' | 'handed-to-planner' | 'clarify' | 'skeleton';
  /** 2026-10-02 (`plan/chain-proceed`) — a chain's TERMINAL step ran under the proceed-anyway instruction (the grant
   *  chain paused at the drafter's Stage 1 soft gate in every arm, 0.35–0.46). Absent when it did not run. */
  chainProceed?: boolean;
  /** Spec 418 A2 — what the planned skills should DELIVER (each intermediate step's artifact + the final skill's
   *  products), glossed from the lexicon — the outcome check's expected classes. */
  expectedDelivers?: Array<{ iri: string; label: string; required?: boolean; alternative?: string }>;
  /** Spec 420 §2 — what goal regression did to the plan: the reads it inserted, the gaps (a standing the asker lacks) and
   *  violations (facts that contradict a step) it named, the submissions it marked. Present only under `plan/regression`. */
  regression?: { inserted: Array<{ before: number; toolId: string; because: string }>; gaps: Array<{ index: number; toolId: string; because: string }>; violations: Array<{ index: number; toolId: string; because: string }>; submissions: Array<{ index: number; toolId: string; establishes: string }>; facts: { standingAtRoom: string; situations: number; known: string[] }; /** Spec 420 §3 — acts the offer marked or left out for the asker's standing. */ offer?: Array<{ toolId: string; needs: string; has: string; mode: string }> };
  /** Spec 418 A1 — ms from a streamed step's start to its first words (the earliest step's). */
  answerFirstWordsMs?: number;
  /** Wall-clock time of those first words — the surface computes time from the ASK to them (what a person feels). */
  answerFirstWordsAt?: number;
  /** Spec 418 §12 — this run was a comparison: its self-acting writes were held (dry run). */
  comparison?: boolean;
  /** Spec 416 — milliseconds spent choosing (planner or selection arm), summed over re-plans. */
  selectionMs?: number;
  /** What the model planner's calls used, as the provider reported them (summed over re-plans). */
  plannerUsage?: ModelUsageV1;
  /** What the composer's calls used, as the provider reported them. */
  composeUsage?: ModelUsageV1;
  route?: { policy: RoutePolicy; /** Spec 388 W3 — where the minute was counted: this isolate's own window, or the deployment's shared meter. */ meter?: 'isolate' | 'shared'; planner?: RouteDecision; composer?: RouteDecision; /** Spec 388 W2 — each structured call the run's steps made (the KB and vault choosers), in order. */ structured?: RouteDecision[] };
  /** Every admission verdict, in order — a refused plan shows what was proposed and why it was refused. */
  admission: Array<{ refused: Array<{ code: string; message: string; stepIndex?: number; toolId?: string }>; replanned: boolean }>;
  /** The plan that ran (or was refused last), as the executor received it BEFORE argument resolution. */
  plan: Array<{ toolId: string; args: Record<string, unknown> }>;
  /** Spec 415 A4 — what the DECLARED selector decided (`skill-selection/rules`): the choice or the hold, the rejected
   *  neighbour, every candidate's score, the parameters. Absent when the model or a compiled shape planned. */
  selection?: { approach: 'declared'; chose: string | null; hold?: string; rejected: string[]; scores: Record<string, number>; params: { threshold: number; margin: number } }
    | ({ approach: 'ontology' } & OntologySelectionV1)
    | ({ approach: 'judgment' } & JudgmentSelectionV1)
    | ({ approach: 'ontology+judgment'; chose: string | null; hold?: string; decidedBy: 'ontology' | 'judgment'; ontology: OntologySelectionV1; judgment?: JudgmentSelectionV1 })
    | ({ approach: 'propose+judgment' } & ProposedSelectionV1)
    | ({ approach: 'ontology-first' } & OntologyFirstSelectionV1)
    | ({ approach: 'framed-judgment' } & FramedSelectionV1)
    | ({ approach: 'outcome' } & OutcomeSelectionV1)
    /** Spec 418 D6 — the one-skill pick, then (only when the pick has a producible upstream input) one small dataflow call. */
    | ({ approach: 'outcome-selective'; chose: string | null; hold?: string; distribution: Record<string, number>; judge: { name: string; kind: string }; reading?: unknown } & Partial<Omit<SelectivePlanV1, 'judge'>> & { planJudge?: { name: string; kind: string } });
  /** Each party binding and WHERE IT CAME FROM (spec 367 §3): the person's words, a decision rule, memory, or the resolver. */
  bindings: Array<{ arg: string; raw: string; agent: string; label?: string; source: 'said' | 'context' | 'standing' | 'decision' | 'memory' | 'resolver' | 'disclosed'; because?: string }>;
  /** What the surface declared (spec 353): the realm kind and how many capabilities it offered. */
  surface?: { realm?: string; capabilities?: number; channel?: 'text' | 'voice' };
  /** Spec 370 P7 — how many recent turns the resolver could recall for this ask (0 = no memory read). */
  recalledTurns?: number;
}

export type AskReply = AskReplyVariant & { plannerTrace?: PlannerTraceV1 };

/** Which arg a capability's RESOURCE is read from — the same declaration the tool makes, restated where
 *  the requirement is built so the two cannot disagree. */
const RESOURCE_ARG_FOR: Record<string, string> = {
  'treasury.payment.execute': 'asset',
  'treasury.fund': 'asset',
  'organization.membership.invite': 'org',
  'organization.member.role.set': 'org',
  'messaging.direct.send': 'recipient',
  'messaging.topic.post': 'org',
  'github.pr.open': 'holder',
  'github.pr.comment': 'holder',
  'github.pr.merge': 'holder',
  'build.run': 'workspace',
  'build.promote': 'workspace',
  'coordination.endeavor.request': 'org',
  'coordination.contribution.propose': 'org',
  'coordination.contribution.allocate': 'org',
  'coordination.endeavor.satisfy': 'org',
  'coordination.milestone.achieve': 'org',
  'coordination.step.satisfy': 'org',
  'coordination.commitment.withdraw': 'org',
  'coordination.commitment.reallocate': 'org',
  'coordination.decision.request': 'org',
  'coordination.decision.record': 'org',
  // The CALL's target: the relationship record. See the pin in `resolveStepArgs` for why the treasury,
  // which is what the statement is ABOUT, cannot be the caveat's location.
  'treasury.primary.declare': 'record',
  // Likewise: a revocation is a call to the DelegationManager, and WHICH grant it kills travels in the
  // calldata. The caveat bounds the contract; the invoker bounds the grant to one the person issued.
  'access.grant.revoke': 'manager',
  'person.contact.remove': 'manager',
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

export function paymentAskOf(goal: string): { payee?: string; payer?: string; usdc?: string; memo?: string } | null {
  const { body: g, memo } = splitPurpose(goal.trim());
  if (!/\b(send|pay|transfer)\b/i.test(g)) return null;
  if (/\b(each|every|all)\b[\s\S]{0,40}\bmembers?\b/i.test(g)) return null; // the fan-out shape
  if (!/\busdc\b/i.test(g)) return null; // only money we know the unit of; "send a message" is not this
  const amount = g.match(/(\d+(?:\.\d+)?)\s*usdc/i)?.[1];
  // THE PAYEE IS ON THE PAYMENT'S OWN LINE. A plan step's ask carries a second sentence after a blank line
  // ("Do this by exercising treasury.payment.execute as 0x…", spec 350 W3) and the payee capture ran to the
  // end of the message — "nathan.treasury\n\nDo this by exercising…" was looked up as a name (spec 382, live).
  const firstLine = g.split(/\n\s*\n/)[0] ?? g;
  // THE PAYER THE PERSON NAMED ("… from alice3.treasury") travels as `payer` — resolved in her tier like any party. It
  // was once stripped and dropped, and the account she had marked as her default paid instead (act laboratory, live).
  const from = firstLine.match(/\bfrom\s+(?:my\s+|our\s+|the\s+)?(.+?)(?:\s+to\s+.*)?\s*[.!?]*$/i)?.[1]?.replace(/(\d+(?:\.\d+)?)\s*usdc/i, ' ').trim();
  const payer = from && !/^(my|our)?\s*(account|treasury|wallet|balance|funds?)$/i.test(from) ? from : undefined;
  // Only the from-clause goes — "from alice3.treasury to bob" keeps "to bob".
  let rest = firstLine.replace(/(\d+(?:\.\d+)?)\s*usdc/i, ' ').replace(/\b(send|pay|transfer)\b/i, ' ').replace(/\bfrom\s+.+?(?=\s+to\s+|\s*[.!?]*$)/i, ' ');
  const to = rest.match(/\bto\s+(.+?)\s*$/i)?.[1];
  const payee = (to ?? rest).replace(/^(to|please|now)\s+/i, '').replace(/[.!?]+$/, '').trim();
  return { ...(payee ? { payee } : {}), ...(payer ? { payer } : {}), ...(amount ? { usdc: amount } : {}), ...(memo ? { memo } : {}) };
}

/**
 * THE PLANNER'S SHARE OF THE PLAYBOOK — the doctrine, not the act bodies.
 *
 * The ~/skills compiler renders an archetype's instructions as the archetype's own doctrine (who the agent
 * is, whose records, what needs authority, how it answers) followed by ONE SECTION PER ACT under the heading
 * below — each act's SKILL.md body, verbatim (`packages/archetype-compiler/src/index.ts`, the `acts` block).
 * For the person steward that tail is 24k of the 31k characters, and the planner is the only consumer of
 * the instructions field at all: it was reading every act's execution contract in order to pick a tool,
 * while the same contracts' `description`, `inputSchema` and `utterances` — the parts written FOR
 * selection — were already beside it as tools and examples. Live, that was a 13.6k-token request; a free
 * planner tier caps at 8k, and every planner paid the latency.
 *
 * The split is STRUCTURAL, on the compiler's heading, never a character budget: nothing is cut mid-sentence
 * and nothing is dropped silently — the trace records the share (`instructionsRendered`), and an
 * instructions document without the heading is rendered whole. The digest covers exactly what was shown.
 */
export const ACT_SECTIONS_HEADING = '\n## How each act is done\n';
/** The ask planner's completion budget. A tool call is a few hundred tokens, but a REASONING model (Groq's
 *  gpt-oss) thinks inside the completion first: at 512 it thought for 30s and called nothing. Groq does not
 *  meter `max_tokens` against its per-minute limit (measured: −54 tokens for −512), so the budget costs nothing
 *  to keep at the adapters' default. */
export const ASK_PLANNER_MAX_TOKENS = 1024;
export function plannerDoctrineOf(instructions: string): { text: string; chars: number; of: number } {
  const at = instructions.indexOf(ACT_SECTIONS_HEADING);
  const text = at >= 0 ? instructions.slice(0, at).trimEnd() : instructions;
  return { text, chars: text.length, of: instructions.length };
}

/**
 * Spec 376 W2 — THE PLAYBOOK'S SPECIALISTS applied to a plan: a step of a capability the playbook hands to a
 * specialist gets that executor, BY NAME (resolved in the agent's own tier before it runs). A step that
 * already names one keeps it — the person's words outrank the rule. Nothing here is authority: the parent
 * mandate is asked of the person as always, the child minted from it, the specialist's gate judges the child.
 */
export function withSpecialists(plan: Plan, specialists: ReadonlyArray<{ capability: string; executor: string }> | undefined, tools: ReadonlyArray<ToolSpec>): Plan {
  if (!specialists?.length) return plan;
  const byCap = new Map(specialists.map((s) => [s.capability, s.executor]));
  return {
    ...plan,
    steps: plan.steps.map((st) => {
      if (st.executor) return st;
      const tool = tools.find((t) => t.id === st.toolId);
      const executor = byCap.get(tool?.capability?.id ?? st.toolId);
      return executor ? { ...st, executor } : st;
    }),
  };
}

/**
 * Spec 376 W2 — "HAVE X DO IT", parsed once. A sentence that opens by naming who is to act ("have
 * runtime-c3s0.svc pay nathan.treasury 1 usdc", "ask alice2.treasury to fund …") splits into the executor
 * — a TYPED name only, so "have a look" names nobody — and the ask that remains, which the compiled shapes
 * and the planner see as they always did. Without this the payment compiler read the whole sentence as a
 * payee. The name is words; the harness resolves it in the asker's own tier before the step runs.
 */
export function executorPrefixOf(goal: string): { executor?: string; rest: string } {
  const m = goal.trim().match(/^(?:have|ask|tell|get|let)\s+([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\s+(?:to\s+)?(.+)$/i);
  return m ? { executor: m[1]!.toLowerCase(), rest: m[2]! } : { rest: goal };
}

/** Every step of a plan handed to one executor (the sentence form of spec 376 W2). */
export function withExecutor(plan: Plan, executor: string): Plan {
  return { ...plan, steps: plan.steps.map((st) => (st.executor ? st : { ...st, executor })) };
}

/**
 * Spec 367 W2 — the few-shot block rendered from the playbook's contracts. One line per example, the
 * positive ones as the exact tool call, the negative ones as what NOT to choose and why. Deterministic
 * (same definition ⇒ same block), so the receipt's playbook digest covers what the planner was taught.
 */
export function utteranceExamples(tools: ReadonlyArray<{ id: string; utterances?: ReadonlyArray<{ says: string; args?: Record<string, string>; isNot?: string }> }>,
  /** Under a prompt budget: at most this many POSITIVE examples per tool (the negatives always render —
   *  "what not to choose" is the rarer lesson). `undefined` ⇒ every example the author wrote. */
  positivesPerTool?: number): string {
  const lines: string[] = [];
  for (const t of tools) {
    let positives = 0;
    for (const u of t.utterances ?? []) {
      if (u.isNot !== undefined) lines.push(`- "${u.says}" → NOT ${t.id}: ${u.isNot}`);
      else if (positivesPerTool === undefined || positives++ < positivesPerTool) lines.push(`- "${u.says}" → ${t.id} ${JSON.stringify(u.args ?? {})}`);
    }
  }
  if (!lines.length) return '';
  return `\n\nEXAMPLES FROM THE PLAYBOOK (the domain author's own; follow their shape exactly — arguments are the person's WORDS, never addresses):\n${lines.join('\n')}`;
}

/**
 * FIT THE PLANNER PROMPT TO A PROVIDER'S BUDGET — by dropping WHOLE, NAMED parts in a fixed order, never by
 * cutting text mid-way, and recording every drop on the trace (`promptBudget.trimmed`).
 *
 * The estimate is chars-per-token (prose ≈ 4, tool JSON ≈ 3.5 — measured against Groq's own count of a
 * 33k-char request at 8.1k tokens). The order is what a planner can best do without:
 *   1. `examples:one-positive-per-tool` — the domain author's negatives stay; positives beyond one per tool go.
 *   2. `conversation:2-turns`           — the last two recalled asks instead of four.
 *   3. `doctrine:opening-only`          — the archetype's opening paragraph(s), not its sections.
 *   4. `examples:negatives-only`        — no positive examples at all.
 * When even that does not fit, the smallest form is sent and `over-budget` is recorded — the provider's
 * refusal then says the exact count; nothing here pretends to have fitted.
 */
export function estimatePromptTokens(system: string, tools: ReadonlyArray<Pick<ToolSpec, 'id' | 'description' | 'inputSchema'>>, user: string): number {
  const toolChars = tools.reduce((n, t) => n + JSON.stringify({ name: t.id, description: t.description, parameters: t.inputSchema ?? {} }).length, 0);
  return Math.ceil((system.length + user.length) / 4 + toolChars / 3.5);
}
export function fitPlannerPrompt(
  parts: { doctrine: string | null; contract: (conversationTurns: number) => string; examples: (positivesPerTool?: number) => string },
  tools: ReadonlyArray<Pick<ToolSpec, 'id' | 'description' | 'inputSchema'>>,
  user: string,
  budgetTokens: number,
): { text: string; estimated: number; trimmed: string[] } {
  const opening = (d: string) => { const at = d.indexOf('\n## '); return at >= 0 ? d.slice(0, at).trimEnd() : d; };
  const render = (o: { positives?: number; turns: number; doctrineOpening: boolean }) => {
    const d = parts.doctrine === null ? null : o.doctrineOpening ? opening(parts.doctrine) : parts.doctrine;
    const body = `${parts.contract(o.turns)}${parts.examples(o.positives)}`;
    return d ? `${d}\n\n---\n\n${body}` : body;
  };
  const steps: Array<{ name: string | null; o: { positives?: number; turns: number; doctrineOpening: boolean } }> = [
    { name: null, o: { turns: 4, doctrineOpening: false } },
    { name: 'examples:one-positive-per-tool', o: { positives: 1, turns: 4, doctrineOpening: false } },
    { name: 'conversation:2-turns', o: { positives: 1, turns: 2, doctrineOpening: false } },
    { name: 'doctrine:opening-only', o: { positives: 1, turns: 2, doctrineOpening: true } },
    { name: 'examples:negatives-only', o: { positives: 0, turns: 2, doctrineOpening: true } },
  ];
  const trimmed: string[] = [];
  let last = { text: '', estimated: 0 };
  for (const st of steps) {
    if (st.name) trimmed.push(st.name);
    const text = render(st.o);
    last = { text, estimated: estimatePromptTokens(text, tools, user) };
    if (last.estimated <= budgetTokens) return { ...last, trimmed };
  }
  trimmed.push('over-budget');
  return { ...last, trimmed };
}

/** Selection kinds a screen declares → the typed-name suffix a party role admits (ADR-0061). */
const KIND_SUFFIX: Record<string, string> = { person: 'me', me: 'me', org: 'org', organization: 'org', team: 'team', workspace: 'workspace', treasury: 'treasury', 'person-treasury': 'treasury', 'org-treasury': 'treasury', service: 'svc', svc: 'svc', circle: 'circle', church: 'church' };

export function orgPhraseOf(goal: string): string | undefined {
  // The phrase may carry a DOT: "members of calvary.org", "members of alice-home-church.impact" are typed
  // names, and excluding the dot here meant no typed name ever reached the step — the roster read then
  // fell to the addressee (spec 366 R3's incident). Only sentence punctuation ends the phrase.
  // "members of / in / on X" — and the phrasings the compiled roster read ALSO catches: "who belongs to X", "who is in X",
  // "who's part of X". Without them the name was dropped and the plan refused "the ask names Missio Nexus and the step
  // names no org" for the plainest roster question there is (live 2026-09-29).
  const m = goal.match(/\bmembers?\b[^?]*?\b(?:of|in|on)\b\s+(?:the\s+)?([^?,;!]+?)\s*[?.!]*$/i)
    ?? goal.match(/\bwho(?:'s|\s+is|\s+are)?\s+(?:belongs?\s+to|belongs?\s+in|in|on|part\s+of|a\s+member\s+of)\s+(?:the\s+)?([^?,;!]+?)\s*[?.!]*$/i);
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
/**
 * The account a balance question names — or none, meaning the asker's own treasuries (spec 371). Named after the LAST
 * "of/in/does/do/for", the anchor nearest the thing named: "how much money DO i have IN my treasury" names "my treasury",
 * not "i have in my treasury" (the first anchor — which the person was then asked about: 'I could not find "i have in my"',
 * live 2026-09-29). The asker's own words about herself ARE her: a phrase with I / my / me / we / our / us is her own.
 */
export function balanceAccountOf(goal: string): string | undefined {
  const m = goal.match(/.*\b(?:of|in|does|do|for)\s+(?:the\s+)?([a-z0-9][a-z0-9 .'-]*?)\s*(?:hold|have|has|holds|currently)?\s*[?.!]*$/i);
  const phrase = (m?.[1] ?? '').replace(/\s+(treasury|treasuries|account|accounts|wallet|organization|org)$/i, '').replace(/^(treasury|treasuries|account|accounts|wallet)$/i, '').trim();
  if (!phrase || /\b(i|my|me|mine|we|our|ours|us)\b/i.test(phrase)) return undefined;
  return /^(it|there|this|that|you|money|usdc|funds|balance)$/i.test(phrase) ? undefined : phrase;
}

export async function resolveStepArgs(
  args: Record<string, unknown>,
  env: HarnessEnv,
  lookups: PartyLookups,
  where?: {
    stepRef: string; toolId: string; capabilityId?: string; authorityArg?: string; subject?: string; required?: string[];
    /** Spec 420 §10 — the nearest-in-context rule may resolve a bare name among several before asking. */
    nearest?: boolean;
    /** The arguments the TOOL ITSELF describes (its input schema). An argument the tool describes and the ontology
     *  declares no party role for is NOT a party of this step — `catalog.topic.list { parent }` is a topic slug, and
     *  resolving it as an agent asked "which agent is justification?" (seen live). Counterparties stay resolved. */
    schemaArgs?: readonly string[];
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
    /** The realm's TYPED suffix (`treasury`, `org`, `household`, `me`) when known — from the surface's kind
     *  or, absent a surface, from the addressee's own typed name. Finer than `realmKind` (an org-class
     *  realm may be a household, whose parent role differs from an organization's). */
    realmSuffix?: string;
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
    // Spec 394 — THE PERSON'S STANDING INSTRUCTION for this act's acting party, in this room ("from now on, pay
    // from alice3.treasury"): fills the argument they did not speak — never one they did — REVALIDATED: the
    // default must still be one of the agents they could name for the role now (their own, of its kinds), or it
    // is ignored and the question comes back. Cited as `standing`; a verifier never sees it.
    let standing: { value: string; label?: string; saidAs?: string } | null = null;
    if (!current && lookups.standingInstruction) {
      const room = where.addressee && where.addressee.toLowerCase() !== where.subject.toLowerCase() ? where.addressee.toLowerCase() : undefined;
      const hit = await lookups.standingInstruction({ capability: where.capabilityId ?? where.toolId, arg, ...(room ? { context: room } : {}) }).catch(() => null);
      if (hit && /^0x[0-9a-f]{40}$/.test(hit.value)) {
        const kinds = partyTypesFor(where.capabilityId ?? where.toolId, arg) ?? [];
        let stillMine = kinds.length === 0 || kinds.includes('me') && hit.value === where.subject.toLowerCase();
        for (const type of kinds) { if (stillMine) break; if (type === 'me') continue; stillMine = (await ownAgentsOfType(where.subject, type, lookups)).some((c) => c.agent.toLowerCase() === hit.value); }
        if (stillMine) standing = hit;
      }
    }
    if (standing) {
      out[arg] = standing.value;
      lookups.onResolved?.({ arg, raw: partyWord(arg), agent: standing.value, ...(standing.label ? { label: standing.label } : {}), hint: `your standing instruction${standing.saidAs ? `: “${standing.saidAs}”` : ''}`, via: 'standing' });
    } else if (!current) {
      const realmSuffix = where.realmSuffix ?? (where.realmKind ? KIND_SUFFIX[where.realmKind] : undefined);
      const typesHere = partyTypesFor(where.capabilityId ?? where.toolId, arg) ?? [];
      // A role that admits ANY agent (`ap:Agent` — the sender of a message) admits the addressed agent too: a message
      // asked for inside an organization's room is the organization's, and one a service's own run parks for is the
      // service's — the steward who finishes it signs FOR that agent, never quietly as themselves (spec 400 W1 / 375 W2:
      // the runtime's reply, resumed at its custodian's Home, was re-addressed "from" the custodian, who was then asked
      // "that would send the message to you — who did you mean?").
      // …unless the ontology says the act is the ASKER'S OWN wherever it is made (an offer — spec 393 W2): the room never
      // fills it. Declared on the party role (`ownAct`), read here, decided by nothing else.
      const ownAct = partyRole(where.capabilityId ?? where.toolId, arg)?.ownAct === true;
      const admitsRealm = !ownAct && !!realmSuffix && (typesHere.length === 0 || typesHere.includes(realmSuffix));
      if (where.addressee && admitsRealm && where.addressee.toLowerCase() !== where.subject.toLowerCase()) {
        out[arg] = where.addressee.toLowerCase();
        lookups.onResolved?.({ arg, raw: partyWord(arg), agent: where.addressee.toLowerCase(), hint: realmSuffix === 'svc' ? 'this service agent — its own act, signed by its custodian' : 'the organization you are standing in', via: 'context' });
      } else {
        out[arg] = where.subject.toLowerCase();
      }
    }
    const types = partyTypesFor(where.capabilityId ?? where.toolId, arg);
    const isAsker = String(out[arg] ?? '').toLowerCase() === where.subject.toLowerCase();
    // AN AGENT ASKING ITSELF that IS the kind the role wants — a team's coordinator allocating on its own
    // endeavor (a trigger's run, spec 375) — is the party: its own kind (the realm's, from the chain) is in
    // the role's types. Searching "its tree" for an organization asked a team which organization it should
    // be. The realm mapping is `KIND_SUFFIX`: a `team`, a `church`, a `treasury` — not only the three roots.
    const selfSuffix = where.addressee && where.addressee.toLowerCase() === where.subject.toLowerCase()
      ? (where.realmSuffix ?? (where.realmKind ? KIND_SUFFIX[where.realmKind] : undefined)) : undefined;
    if (types?.length && isAsker && selfSuffix && types.includes(selfSuffix)) {
      lookups.onResolved?.({ arg, raw: partyWord(arg), agent: where.subject.toLowerCase(), hint: 'this agent itself — it is of the kind the role names', via: 'context' });
    }
    // A person is not a treasury. When the capability acts on a kind the asker's own SA is not, find the
    // one of THEIR agents that is — the typed suffix already says which. Never a widening: their tree only.
    else if (types?.length && isAsker && !types.includes('me')) {
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
  if (where && (where.selection?.entity || (where.addressee && (where.realmKind || where.realmSuffix)))) {
    // TWO SOURCES OF VALIDATED CONTEXT, most specific first: the entity SELECTED on the screen (spec 361
    // I6 — a member on the roster, a team, a treasury), then the realm the person stands in. A selection is
    // a reference the app checked before it declared it; it is never a sentence the model wrote.
    const realmSuffix = where.realmSuffix ?? (where.realmKind ? KIND_SUFFIX[where.realmKind] : undefined);
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
  const capForRoles = where?.capabilityId ?? where?.toolId;
  for (const key of PARTY_ARGS) {
    // A party is what the ONTOLOGY says this capability's argument is. An argument the tool describes itself, that no
    // role names and that is not a counterparty, is the tool's own value (a topic, a label) — never resolved as an agent.
    if (where?.schemaArgs?.includes(key) && key !== 'workspace' && key !== 'funder' && !COUNTERPARTY_ARGS.has(key) && !PARTY_ROLES.some((r) => r.capability === capForRoles && r.arg === key)) continue;
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
      // "US" AT AN ORGANIZATION IS THAT ORGANIZATION (act laboratory, 2026-09-28): asked at missio-nexus.org, "invite david
      // to join us" planned `org: "us"`, which no tier resolves, and the steward was asked which organization. The room
      // the person stands in is who "we" are — for an ACTING or CONTEXT party only (the ontology's side); a counterparty
      // ("pay us") is left to be resolved or asked. Never when the room is the asker's own agent.
      const room = (where as { addressee?: string }).addressee?.toLowerCase();
      if (room && where.subject && room !== where.subject.toLowerCase() && /^(us|we|our|ours|ourselves|self|itself|this agent|the agent|this (organi[sz]ation|org|team|group|circle|church|household|workspace)|the (organi[sz]ation|org|team))$/i.test(raw.trim())
        && partyRole(where.capabilityId ?? where.toolId, key)?.side !== 'counterparty') {
        out[key] = room;
        lookups.onResolved?.({ arg: key, raw, agent: room, hint: 'the agent you are asking', via: 'context' });
        continue;
      }
      out[key] = await resolveParty(raw, lookups, {
        stepRef: where.stepRef, toolId: where.toolId, argName: key, what: partyWord(key),
        // Spec 420 §10 — the room, and whether the nearest-in-context rule may decide before asking (`resolve/context`).
        ...((where as { addressee?: string }).addressee ? { room: (where as { addressee?: string }).addressee! } : {}),
        ...((where as { nearest?: boolean }).nearest ? { nearest: true } : {}),
        // Spec 385 — the capability the resolution is FOR, so a scoped confirmation memory keys on it.
        ...(where.capabilityId ? { capabilityId: where.capabilityId } : {}),
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
    usdc: { label: 'How much', hint: 'in whole USDC, e.g. 10 or 12.50' },
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
    // AN AGENT ASKING ITSELF that IS the kind the role wants — a team's coordinator allocating on its own
    // endeavor (a trigger's run, spec 375) — is the party: its own kind (the realm's, from the chain) is in
    // the role's types. Searching "its tree" for an organization asked a team which organization it should
    // be. The realm mapping is `KIND_SUFFIX`: a `team`, a `church`, a `treasury` — not only the three roots.
    const selfSuffix = where.addressee && where.addressee.toLowerCase() === where.subject.toLowerCase()
      ? (where.realmSuffix ?? (where.realmKind ? KIND_SUFFIX[where.realmKind] : undefined)) : undefined;
    if (types?.length && isAsker && selfSuffix && types.includes(selfSuffix)) {
      lookups.onResolved?.({ arg, raw: partyWord(arg), agent: where.subject.toLowerCase(), hint: 'this agent itself — it is of the kind the role names', via: 'context' });
    }
    // A person is not a treasury. When the capability acts on a kind the asker's own SA is not, find the
    // one of THEIR agents that is — the typed suffix already says which. Never a widening: their tree only.
    else if (types?.length && isAsker && !types.includes('me')) {
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
      // "US" AT AN ORGANIZATION IS THAT ORGANIZATION (act laboratory, 2026-09-28): asked at missio-nexus.org, "invite david
      // to join us" planned `org: "us"`, which no tier resolves, and the steward was asked which organization. The room
      // the person stands in is who "we" are — for an ACTING or CONTEXT party only (the ontology's side); a counterparty
      // ("pay us") is left to be resolved or asked. Never when the room is the asker's own agent.
      const room = (where as { addressee?: string }).addressee?.toLowerCase();
      if (room && where.subject && room !== where.subject.toLowerCase() && /^(us|we|our|ours|ourselves|self|itself|this agent|the agent|this (organi[sz]ation|org|team|group|circle|church|household|workspace)|the (organi[sz]ation|org|team))$/i.test(raw.trim())
        && partyRole(where.capabilityId ?? where.toolId, key)?.side !== 'counterparty') {
        out[key] = room;
        lookups.onResolved?.({ arg: key, raw, agent: room, hint: 'the agent you are asking', via: 'context' });
        continue;
      }
      out[key] = await resolveParty(raw, lookups, {
        stepRef: where.stepRef, toolId: where.toolId, argName: key, what: partyWord(key),
        // Spec 420 §10 — the room, and whether the nearest-in-context rule may decide before asking (`resolve/context`).
        ...((where as { addressee?: string }).addressee ? { room: (where as { addressee?: string }).addressee! } : {}),
        ...((where as { nearest?: boolean }).nearest ? { nearest: true } : {}),
        // Spec 385 — the capability the resolution is FOR, so a scoped confirmation memory keys on it.
        ...(where.capabilityId ? { capabilityId: where.capabilityId } : {}),
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

  if ((where?.capabilityId === ACCESS_REVOKE_CAPABILITY || where?.capabilityId === CONTACT_REMOVE_TOOL.id) && env.DELEGATION_MANAGER) {
    // Spec 401 — removing a contact IS a revocation: the call's target is the DelegationManager; WHICH grant travels in
    // the calldata (the contact names it), so the caveat bounds the contract, never the contact.
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

/** Spec 421 W2 — the card's "check before you sign" sentence: each argument that came ONLY from someone else's words, with
 *  its value and where from. Empty when every argument is hers. Derived at the ASKER'S door (her sentence), never relayed. */
function whoseWordsWarning(d: Record<string, ArgDerivationV1>, args: Record<string, unknown>, resolved?: ResolvedParties): string {
  const SOURCE: Record<string, string> = { 'messaging.inbox.list': 'a message in your inbox', 'web.read': 'a web page', 'web.search': 'web search results', 'library.public.read': 'a published work', 'kb.retrieve': 'published words' };
  const others = Object.entries(d).filter(([, v]) => v.untrustedOnly).map(([a, v]) => {
    const val = String(args[a] ?? '');
    const shown = /^0x[0-9a-f]{40}$/i.test(val) ? (resolved ? [...resolved.values()].find((p) => p.agent === val.toLowerCase())?.label : undefined) : val;
    // The most SPECIFIC source names it: a message she received beats a page, and both beat the public passages retrieved for
    // every ask (a name like "bob" is in those too) — "taken from published words" for a reply to whoever asked was untrue.
    const order = ['messaging.inbox.list', 'library.public.read', 'web.read', 'web.search', 'kb.retrieve'];
    const src = [...v.from].sort((x, y) => (order.indexOf(x.toolId) + 99) % 99 - (order.indexOf(y.toolId) + 99) % 99).map((f) => SOURCE[f.toolId]).filter(Boolean)[0] ?? 'something someone else wrote';
    return `${partyWord(a)}${shown ? ` (${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown})` : ''} was taken from ${src}`;
  });
  return others.length ? `Check before you sign: ${others.join('; ')} — not from what you said.` : '';
}
/** A relayed note loses any whose-words sentence the RECEIVER wrote: it compared against a routed restatement, not her words. */
const withoutRelayedWarning = (note: string): string => note.replace(/Check before you sign:.*?— not from what you said\.\s*/g, '').trim();

async function askReplyForInner(env: HarnessEnv, input: {
  /** Spec 371 — the tools the run was offered, for rendering a read's `answer` template. */
  tools?: ToolSpec[];
  /** Spec 402 W1 — what the asker's agent remembers about the asker: one more observation the composer is grounded in. */
  memory?: RememberedFactsV1 | null;
  intent: { goal: string }; result: RunResult; addressee: Address;
  /** What the surface said it can render — a prompt it never declared is refused, not stranded. */
  surface?: AskScopeV1;
  composer?: AnswerComposer | null;
  /** Spec 388 — the composer chosen for THIS reply by the evidence it must carry; the route is recorded on the trace. */
  composerFor?: (need: RouteNeed) => Promise<{ composer: AnswerComposer | null; route: RouteDecision }>;
  /** Read-only checks that spare a person a ceremony whose outcome is already knowable (spec 352 §2).
   *  Absent ⇒ no early refusal; the chain still decides. */
  deps?: HarnessDeps;
  /** Spec 361 — the caller supplied its own plan (a SCREEN), so an informational answer carries the
   *  structured result as well as the sentence: a table rendered by parsing prose is a surface that will
   *  eventually disagree with the record it is showing. */
  suppliedPlan?: boolean;
  /** The caller is a SCREEN that renders the structured `results` itself and does NOT show the composed
   *  sentence (perf, 2026-10-02): skip the composer LLM entirely for an informational reply — the rows ride
   *  back on `results` regardless (a supplied plan). Only honoured with `suppliedPlan`; never set by the
   *  conversational surface, which shows the prose. The composer once took 15.6s of an 18.6s read whose
   *  caller discarded the text. Not a correctness change: `results` is the same either way. */
  rowsOnly?: boolean;
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
      // Spec 410 §7 — what the write CARRIES reaches the requirement only where the estate can enforce it (the
      // PayloadClassesEnforcer, generation 3). Elsewhere the requirement names no payload classes: a caveat nobody
      // can redeem is not minted, and the Home is not asked to sign a mandate its chain would refuse.
      ...(env.PAYLOAD_CLASSES_ENFORCER ? {} : { carries: undefined }),
    };
    // BEFORE asking anyone to authorize this: is it already impossible? Walking a person through a
    // signature for a payment their account cannot cover is the same wrong as asking them to grant
    // authority they do not hold — knowable in advance, and cruel to discover afterwards.
    if (input.deps) {
      const refusal = await preconditionRefusal({ capability: required.capability.id, args, env, deps: input.deps, addressee: input.addressee });
      if (refusal) return { kind: 'refused', runRef: r.runRef, outcome: 'denied', error: refusal, receipts: r.receipts };
    }
    // Spec 408 §2.3 — the requirement binds the PLAN the run parked with: the mandate the person signs is for
    // these steps, and a resume that presents another plan is refused (`plan-mismatch`).
    const requirement = await mandateRequirementForStep({ required, intent: input.intent, plan: r.plan, requirementType: REQUIREMENT_TYPE_FOR(r.required.capability.id) });
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
        const validAfter = requirement.validAfter ?? Math.floor(Date.now() / 1000) - 60;
        const g = inviteGrantForRequirement(env, { intentDigest: requirement.intentDigest, validAfter }, org as Address, invitee as Address, r.required.stepRef);
        alsoApprove.push({ purpose: `the invitation grant ${org.slice(0, 10)}… → ${invitee.slice(0, 10)}…`, digest: g.digest });
        // Spec 410 §8 — the organization's side of the two-sided membership credential, in the same prompt: what the
        // member countersigns at acceptance, each then holding a copy in its own vault.
        const facets = { ...(typeof args.kin === 'string' && args.kin.trim() ? { kin: args.kin.trim().toLowerCase() } : {}), ...(typeof args.role === 'string' && args.role.trim() ? { role: args.role.trim().toLowerCase() } : {}) };
        const offer = relationshipOfferFor(env, org as Address, invitee as Address, validAfter, facets);
        alsoApprove.push({ purpose: `the membership credential ${org.slice(0, 10)}… ⇄ ${invitee.slice(0, 10)}… (the organization's signature; the member countersigns on joining)`, digest: offer.digest });
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
        { readSubjectRecord: read, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}), ...(input.deps?.standingContext ? { context: input.deps.standingContext } : {}) },
        { principal: input.principal, subject: delegator },
      ).catch((e: unknown) => { standingUnavailable = e instanceof Error ? e.message : String(e); return undefined; });
    }
    const note = standing ? standingNote(standing, CAPABILITY_WORDS[r.required.capability.id] ?? 'authority') : '';
    // Spec 421 W2 — WHOSE WORDS, judged against HER sentence at THIS door. The loop's own derivation was computed wherever the
    // step ran — for a step routed to an organization's harness (spec 366), against a routed restatement, not her words — and
    // the card said "the organization was taken from published words" of "invite nathan to missio nexus" (live 2026-09-29).
    // The card is hers, so it is derived here: the plan's raw words for this step, her goal, the run's observations.
    const plannedStep = (() => { const m = /^s(\d+)$/.exec(r.required.stepRef); return r.plan.steps.find((st) => st.id === r.required!.stepRef) ?? (m ? r.plan.steps[Number(m[1])] : undefined); })();
    const cardDerivation = deriveArgs(plannedStep?.args ?? r.required.args, input.intent.goal, r.steps);
    return {
      kind: 'authority_required', runRef: r.runRef, requirement, delegator,
      ...(alsoApprove.length ? { alsoApprove } : {}),
      delegate: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
      capability: r.required.capability.id, stepRef: r.required.stepRef,
      summary: `${r.required.capability.id} on ${delegator}`,
      // Spec 421 W2 — WHOSE WORDS: an argument found only in something the run read from another person is named here,
      // and the note says so plainly, so the card she signs shows it ("the recipient came from a message, not from you").
      ...(() => {
        const fromOthers = Object.entries(cardDerivation).filter(([, v]) => v.untrustedOnly).map(([arg, v]) => ({ arg, from: [...new Set(v.from.map((f) => f.toolId))] }));
        return fromOthers.length ? { fromOthers } : {};
      })(),
      ...((): Record<string, unknown> => { const ix = input.interactionFor?.[r.required.capability.id]; return ix?.review || ix?.navigationTarget ? { interaction: { ...(ix.review ? { review: ix.review } : {}), ...(ix.navigationTarget ? { navigationTarget: ix.navigationTarget } : {}) } } : {}; })(),
      ...(standing ? { standing } : {}), ...((): Record<string, unknown> => { const n = [whoseWordsWarning(cardDerivation, r.required!.args, input.resolved), note].filter(Boolean).join(' '); return n ? { note: n } : {}; })(),
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
    // A routed subject's AUTHORITY request (spec 374 W2) is not a ceremony the surface collects as a prompt: it is
    // turned into `authority_required` below, which every surface that presents mandates already handles. Gating it
    // here refused "invite carol to thompson" at the Home with "this needs a authority" (seen 2026-09-13).
    if (kind !== 'authority' && declared?.length && !new Set([...ASSUMED_CEREMONIES, ...declared]).has(kind)) {
      return {
        kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
        error: `this needs ${kind === 'signature' ? 'a signature' : `a ${kind} step`} and this surface cannot collect one — nothing was authorized`,
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
        { readSubjectRecord: input.deps.readSubjectRecord, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}), ...(input.deps.standingContext ? { context: input.deps.standingContext } : {}) },
        { principal: input.principal, subject: input.addressee },
      ).catch(() => null);
      if (st?.relation === 'member') {
        return {
          kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
          error: standingNote(st, CAPABILITY_WORDS[pendingCapability] ?? pendingCapability),
        };
      }
    }
    if (r.prompt.kind === 'authority') {
      // Spec 374 W2 — the subject's authority request, as this asker's own. Delegator, delegate and the
      // requirement are the RECEIVER's words (it minted them; its verifier judges the mandate); `routedAt`
      // is where the step waits, so the resume carries the mandate there.
      const a = r.prompt.authority as { requirement: MandateRequirementV1; delegator: Address; delegate: Address; capability?: string; alsoApprove?: unknown[]; standing?: Standing; summary?: string; note?: string; parties?: ResolvedParty[] };
      return {
        kind: 'authority_required', runRef: r.runRef, requirement: a.requirement, delegator: a.delegator, delegate: a.delegate,
        capability: a.capability ?? r.prompt.toolId, stepRef: r.prompt.stepRef, summary: a.summary ?? `${a.capability ?? r.prompt.toolId} on ${a.delegator}`,
        ...(a.alsoApprove ? { alsoApprove: a.alsoApprove as never } : {}), ...(a.standing ? { standing: a.standing } : {}),
        ...((): Record<string, unknown> => {
          const m = /^s(\d+)$/.exec(r.prompt!.stepRef ?? ''); const st = r.plan.steps.find((x) => x.id === r.prompt!.stepRef) ?? (m ? r.plan.steps[Number(m[1])] : undefined);
          const warn = st ? whoseWordsWarning(deriveArgs(st.args, input.intent.goal, r.steps), st.args, input.resolved) : '';
          const n = [warn, a.note ? withoutRelayedWarning(a.note) : ''].filter(Boolean).join(' ');
          return n ? { note: n } : {};
        })(),
        // THE ASKER'S OWN RESOLUTION SURVIVES THE RELAY. The receiver was handed addresses, so its parties
        // say "0x1659… — said"; but it was THIS run that turned "somali corridor team" into that address —
        // from the person's links, from a remembered choice (spec 385), from the last ask (370 P7) — and
        // that citation is the one thing the person needs in order to say "no, the other one". Where this
        // run resolved the same agent, its record (words, label, hint) is kept; the receiver's fills the rest.
        ...(() => {
          const mine = [...(input.resolved?.values() ?? [])];
          const merged = (a.parties ?? []).map((p) => mine.find((m) => m.arg === p.arg && m.agent.toLowerCase() === p.agent.toLowerCase() && !/^0x[0-9a-f]{40}$/i.test(m.raw)) ?? p);
          return merged.length ? { parties: merged } : {};
        })(),
        routedAt: r.prompt.at,
      } as AskReply;
    }
    if (r.prompt.kind === 'commitment') {
      const cm = r.prompt.commitment;
      const name = cm.at.name ?? cm.at.agent;
      // The receiver's own words travel in the prompt ("Waiting on X — <what it said>"): a person reading
      // "waiting" deserves to know what the other agent is waiting FOR.
      const said = r.prompt.prompt.replace(/^Waiting on [^—]+—\s*/, '').replace(/\.$/, '');
      const parties = [...(input.resolved?.values() ?? [])];
      return { kind: 'waiting', runRef: r.runRef, stepRef: r.prompt.stepRef, on: { agent: cm.at.agent as Address, ...(cm.at.name ? { name: cm.at.name } : {}), runRef: cm.at.runRef }, commitment: cm,
        text: `${name}'s steward has to finish this — ${said || 'it has been asked and is waiting on them'}. It will finish here when they do; nothing was signed for them.`,
        ...(parties.length ? { parties } : {}) };
    }
    const askedAt = r.prompt.kind === 'data' ? (r.prompt as { at?: { agent: string; name?: string; runRef: string; stepRef?: string } }).at : undefined;
    return { kind: 'prompt', runRef: r.runRef, resumeToken: r.resumeToken ?? r.prompt.stepRef, prompt: r.prompt, ...(askedAt ? { routedAt: { ...askedAt, agent: askedAt.agent as Address } } : {}) };
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
    // AN ACT THAT REFUSED DID NOTHING, AND IS SAID SO. A tool may run and decline ("nothing I remember contains …") — its
    // result carries `refused`. Reporting that as "Done — person.memory.forget: done." told a person a fact was forgotten
    // that was not (act laboratory, 2026-09-28). The refusal is the answer, in the tool's words.
    const lastActed = [...r.receipts].reverse().find((rc) => rc.status === 'executed' && rc.risk !== 'informational');
    const lastResult = lastActed ? r.steps.find((o) => o.stepRef === lastActed.stepRef)?.result : undefined;
    const declined = lastResult && typeof lastResult === 'object' && typeof (lastResult as { refused?: unknown }).refused === 'string' ? String((lastResult as { refused: string }).refused) : null;
    if (acted && declined) {
      return withProv({ kind: 'answer', runRef: r.runRef, text: `Nothing was changed: ${declined.charAt(0).toLowerCase()}${declined.slice(1).replace(/[.]?$/, '.')}` });
    }
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
      // Spec 412 W5 — a SUPPLIED multi-step act (an app's one run: save · release · save · release) needs every step's
      // outcome, not the last one's: `results[]` rides on a done reply exactly as it rides on an answer for a supplied plan.
      const stepResults = input.suppliedPlan ? r.steps.filter((o) => o.ok && o.result && typeof o.result === 'object').map((o) => ({ toolId: o.step.toolId, result: o.result })) : [];
      return withProv({ kind: 'done', runRef: r.runRef, result: r.result ?? null, receipts: r.receipts, ...(stepResults.length ? { results: stepResults } : {}), ...(fulfillment ? { fulfillment } : {}), ...(next ? { next } : {}), ...(routedStepsOf(r.steps).length ? { routed: routedStepsOf(r.steps) } : {}), ...(effects.length ? { effects } : {}), ...(decided.length ? { decisions: decided } : {}), ...(ix ? { interaction: { ...(ix.result ? { result: ix.result } : {}), ...(ix.navigationTarget ? { navigationTarget: ix.navigationTarget } : {}) } } : {}) });
    }
    const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
    const evidence = askEvidence(r.steps);
    // A SCREEN'S OWN PLAN gets its rows back; a person gets the sentence. Only for a supplied plan, and
    // only the informational steps — nothing here is a second copy of an ACT's result, which lives on the
    // receipt where it can be checked.
    // Spec 387 W2 — a CATALOG read's items are the deliverable itself (a resource set the caller acts on, each
    // item with its link), so they ride back as rows for any caller, not only a screen's supplied plan.
    // Spec 402 W4 — a read whose contract names a RESULT APP is the deliverable too: its rows ride back for any caller, so
    // the app can render over them beside the sentence (the same reason a catalog read's do).
    const results = r.steps
      .filter((o) => o.ok && o.result && typeof o.result === 'object' && (input.suppliedPlan || isCatalogTool(o.step.toolId) || isPeopleGroupTool(o.step.toolId) || !!input.interactionFor?.[o.step.toolId]?.result))
      .map((o) => ({ toolId: o.step.toolId, result: o.result }));
    const routed = routedStepsOf(r.steps);
    // Spec 402 W4 — the first answered read whose contract names a RESULT app: its binding rides on the reply, with the
    // step it is over, so the surface renders the app beside the sentence. The app's registry decides what the name means.
    const readApp = ((): { result?: string; navigationTarget?: string; toolId?: string } | undefined => {
      for (const o of r.steps) {
        if (!o.ok || o.skipped) continue;
        const ix = input.interactionFor?.[o.step.toolId];
        if (ix?.result) return { result: ix.result, ...(ix.navigationTarget ? { navigationTarget: ix.navigationTarget } : {}), toolId: o.step.toolId };
      }
      return undefined;
    })();
    // Spec 402 W1b — a memory PROPOSED from the conversation: only at her own agent (memory rode in), only when no memory
    // act ran this turn, only from a closed set of first-person markers; the click is the write.
    // Spec 402 W5b — or from a CONNECTED ACCOUNT her agent just read as her: a repeating calendar event is a habit worth
    // keeping, proposed the same way (the click is the write; kept as the connector's, named).
    const memoryNext = input.memory !== undefined && !r.steps.some((o) => o.step.toolId === MEMORY_REMEMBER)
      ? (memoryProposalFor(input.intent.goal, factsOf(input.memory).entries) ?? connectorMemoryProposal(r.steps.filter((o) => o.ok && o.result && typeof o.result === 'object').map((o) => ({ toolId: o.step.toolId, result: o.result })), factsOf(input.memory).entries, (input.intent as { context?: { tz?: string } }).context?.tz))
      : null;
    const withEvidence = (text: string): AskReply => withProv({ kind: 'answer', runRef: r.runRef, text, ...(readApp ? { interaction: readApp } : {}), ...(memoryNext ? { next: memoryNext } : {}), ...(evidence.length ? { evidence } : {}), ...(results.length ? { results } : {}), ...(routed.length ? { routed } : {}) });
    // RENDERED, NOT COMPOSED (spec 371 §2). When every read that ran carries the author's `answer`
    // template and its result has the fields, the reply is the template over the result — the person's
    // unit, no interpretation, no model. The composer is for reads that declare no sentence.
    const offered = input.tools ?? [];
    // The PRE-PLAN retrieval (spec 413 `retrievalQueries`) grounds a composed answer; it is not a deliverable of its own.
    // When every step the PLAN ran declares its sentence (an instruction skill's answer is its reply), the reply is
    // rendered and the passages are not re-composed over it — measured 2026-09-27: the composer re-rendered a skill's
    // answer over five passages (15.6 s of an 18.6 s run) and once contradicted it.
    const readSteps = r.steps.filter((o) => o.ok && !o.skipped && o.step.toolId !== KB_RETRIEVE_TOOL.id);
    if (readSteps.length && readSteps.every((o) => offered.find((t) => t.id === o.step.toolId)?.answer)) {
      const rendered = readSteps.map((o) => renderAnswer(offered.find((t) => t.id === o.step.toolId)!.answer!, o.result));
      if (rendered.every((x): x is string => typeof x === 'string' && x.length > 0)) return withEvidence(rendered.join(' '));
    }
    // ROWS ONLY (perf, 2026-10-02). A screen that reads `results` and never shows the sentence asked for its
    // rows, not prose — do not spend a composer call (up to ~15 s) to phrase text it will discard. The rows
    // already ride back on `results` (a supplied plan). Honoured ONLY for a supplied plan, so the
    // conversational surface — which never sets this and does show the prose — is untouched.
    if (input.rowsOnly && input.suppliedPlan) return withEvidence(raw);
    // Spec 402 W1 — MEMORY AS EVIDENCE. What the asker's agent remembers about the asker rides into the composer as one
    // more observation (`person.memory.recall`), so a sentence that rests on it is GROUNDED in it and the reply's evidence
    // names it — "you told me on …" is checkable, not a hunch. Only for the person's own agent (the route reads the
    // record then); never rendered as truth about anyone else.
    const remembered = input.memory ? factsOf(input.memory).entries.slice(0, 40) : [];
    const memoryStep = remembered.length ? ({ step: { toolId: 'person.memory.recall', args: {}, id: 'memory' }, ok: true, result: { tier: 'private', record: 'memory.facts', note: 'what the asker\'s agent remembers about the asker — use only when the answer rests on it, say "you told me" then, and do not mention memory otherwise', facts: remembered.map((e) => ({ fact: e.fact, learnedAt: e.learnedAt, source: e.source, ...(e.from ? { from: e.from } : {}) })) } } as unknown as (typeof r.steps)[number]) : null;
    const stepsWithMemory = memoryStep ? [...r.steps, memoryStep] : r.steps;
    const evidenceWithMemory = memoryStep ? askEvidence(stepsWithMemory) : evidence;
    let composer = input.composer ?? null;
    if (input.composerFor) {
      // The evidence is what the composer carries (chars/4, plus its own doctrine); the route names who carries it.
      const largestBodyChars = stepsWithMemory.filter((o) => o.ok && o.result !== undefined).reduce((m, o) => Math.max(m, JSON.stringify(o.result).length), 0);
      const need: RouteNeed = { call: 'composer', estimatedTokens: Math.ceil(JSON.stringify(r.steps).length / 4) + 800, ...(largestBodyChars ? { largestBodyChars } : {}) };
      const routed = await input.composerFor(need);
      composer = routed.composer;
      if (input.plannerTrace) input.plannerTrace.route = { ...(input.plannerTrace.route ?? { policy: 'first' }), composer: routed.route };
    }
    if (!composer) return withEvidence(raw);
    try {
      // GROUNDED COMPOSITION — spec 358 W3. Every real gate ran before the invoker; this is the one
      // stage that was ungoverned, and it is where the week's false sentences were written. The prose is
      // checked against the evidence it will be shown WITH: one recompose carrying the governor's own
      // corrections, then the floor — the evidence stated plainly, because after two ungrounded
      // compositions the person gets the observations, not a third guess.
      // Spec 391 — the evidence is FITTED to the composer's budget here, so the drops are on the trace and the
      // governor below judges the prose against what the model actually saw. Never a slice.
      const fitted = fitEvidence(stepsWithMemory, composer.evidenceBudget ?? 24_000);
      if (input.plannerTrace) input.plannerTrace.composerEvidence = { chars: fitted.chars, of: fitted.of, dropped: fitted.dropped };
      let text = await composer.compose({ intent: input.intent, observations: stepsWithMemory, evidence: fitted.items });
      let violations = checkGroundedComposition(text, evidenceWithMemory, input.intent.goal);
      if (violations.length) {
        text = await composer.compose({
          intent: input.intent, observations: stepsWithMemory, evidence: fitted.items,
          corrections: violations.map((v) => v.correction),
        });
        violations = checkGroundedComposition(text, evidenceWithMemory, input.intent.goal);
        if (violations.length) text = groundedFallback(evidence);
      }
      return withEvidence(text);
    } catch (e) {
      // THE FLOOR, AND WHY IT IS THE FLOOR. The evidence stated plainly is the honest reply when no sentence
      // could be composed — but a floor reached in silence reads as the agent's answer. A provider that
      // refused (a free tier's rate limit, spec 377) is named here, so the person knows to wait or to pick
      // another model; nothing here retries on a different one (ADR-0013).
      const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 240);
      return withEvidence(`${raw}\n\n(The answer could not be put into words — ${why} — so the evidence is shown as it was found.)`);
    }
  }
  // When the run failed because the MODEL PROVIDER was the reason there is no answer — rate-limited, or the
  // account is out of credit — say so plainly and actionably instead of the raw adapter error. This is the
  // shape a capped single provider (no working fallback) produces for ANY run that needed the model: e.g. a
  // persona answering a question outside its archetype's capabilities (no rule to resolve it ⇒ a model call),
  // where the default person, which has that capability, answers by rule and never touches the model.
  if (r.error) {
    const f = classifyProviderFailure((input.plannerTrace?.route as { composer?: { provider?: string }; provider?: string } | undefined)?.composer?.provider ?? (input.plannerTrace?.route as { provider?: string } | undefined)?.provider, r.error, env as unknown as Record<string, unknown>);
    if (f.kind !== 'other') {
      const where = f.url ? ` Whoever runs this Home can check ${f.url}.` : '';
      const msg = f.kind === 'exhausted'
        ? `The model this agent runs on (${f.label}) is temporarily unavailable — its account has reached its credit or spending limit.${where} Nothing was answered; please try again once it is restored.`
        : `The model this agent runs on (${f.label}) is temporarily unavailable — it is rate-limited right now. Nothing was answered; please try again in a moment.${f.url ? ` If it keeps happening, the plan's limits are at ${f.url}.` : ''}`;
      return withProv({ kind: 'refused', runRef: r.runRef, outcome: r.outcome, error: msg, receipts: r.receipts });
    }
  }
  return withProv({ kind: 'refused', runRef: r.runRef, outcome: r.outcome, error: r.error ?? 'the run did not complete', receipts: r.receipts });
}

// `AskScopeV1` (spec 353, the scope half of an ask) lives in `@agenticprimitives/harness` `ask-scope.ts` — see the
// re-export above. Scope is honesty; the mandate is authority; it reaches no verifier (353 §4).

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
  'service.create': ['signature'],
  'person.create': ['signature'],
  'treasury.create': ['signature'],
  'organization.membership.invite': ['signature'],  // the org signs the invitation grant
  'organization.member.role.set': ['signature'],    // spec 427 — the organization's mandate for the change
  'coordination.endeavor.request': ['signature'],   // the mandate — asking as you is an act of yours
  'coordination.contribution.propose': ['signature'],
  'coordination.contribution.allocate': ['signature'],  // the org's decision, under a steward's signature
  'coordination.endeavor.satisfy': ['signature'],
  'coordination.milestone.achieve': ['signature'],
  'coordination.step.satisfy': ['signature'],          // the doer's own record, or the steward's as the org
  'coordination.commitment.withdraw': ['signature'],   // the participant's own act
  'coordination.commitment.reallocate': ['signature'], // the org's, under a steward's signature
  'coordination.decision.request': ['signature'],
  'coordination.decision.record': ['signature'],
  'treasury.payment.execute': ['signature'],        // the mandate, and the ladder's second party
  'treasury.fund': ['signature'],                   // the mandate
  'messaging.direct.send': ['signature'],           // the mandate — sending as you is acting as you
  'messaging.topic.post': ['signature'],            // the mandate — posting as you is acting as you
  'github.pr.open': ['signature'],                  // the mandate — the holder's connector acts
  'github.pr.comment': ['signature'],
  'github.pr.merge': ['signature'],                 // the mandate — bound to the work the PR names
  'build.run': ['signature'],                       // the mandate — the workspace's steward signs for THIS task (spec 398 §9 / ap-build B3)
  'build.promote': ['signature'],                   // the mandate — the steward's signature over the exact tuple (commit · config · environment · migration), T29
  'calendar.event.create': ['signature'],           // the mandate — the holder's calendar connector acts (spec 400 W4)
  'gmail.draft.create': ['signature'],              // the mandate — a draft in the holder's mail (spec 402 W2)
  'gmail.message.send': ['signature'],              // the mandate — mail that LEAVES as the holder is the holder acting (spec 402 W5)
  'calendar.event.delete': ['signature'],           // the mandate — the undo is an act on her calendar too (spec 403 W5)
  'gmail.draft.delete': ['signature'],
  'resolution.invitation.request': ['signature'],   // the mandate — asking is an act of yours too
  'treasury.primary.declare': ['signature'],        // the mandate — a public statement of yours
  'access.grant.revoke': ['signature'],             // the mandate — taking authority back is an act too
  'person.credential.add': ['signature'],          // spec 422 — a credential that signs for her is added under one that already does; a surface that cannot sign cannot add
  'organization.membership.accept': ['signature'], // spec 421 — joining SIGNS her membership (at her Home, the Join ceremony); a surface that cannot sign cannot join
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
  // Spec 401 — removing a contact IS that same revocation, of the grant the person gave the contact.
  [CONTACT_REMOVE_TOOL.id]: [methodSelectorOf('revokeDelegationByOwner((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))')],
};

/** Ceremonies every surface is assumed to render: it is a conversation, so it can ask and be answered. */
const ASSUMED_CEREMONIES = ['data', 'confirmation'];
/** The ceremonies an act needs: the table, or — for a capability compiled from an attached MCP server (spec 404,
 *  `mcp.<id>.<tool>`) — the holder's signature, the same rung as any act on a connector. */
export function ceremoniesFor(capabilityId: string): string[] {
  return CAPABILITY_CEREMONIES[capabilityId] ?? (isMcpTool(capabilityId) ? ['signature'] : []);
}

/** Can this surface complete this capability? Silence means yes — a surface that has not said what it
 *  renders is not narrowed by its silence (the same rule as `capabilities`). */
export function surfaceCanRender(capabilityId: string, ceremonies?: string[]): boolean {
  if (!ceremonies?.length) return true;
  const renders = new Set([...ASSUMED_CEREMONIES, ...ceremonies]);
  return ceremoniesFor(capabilityId).every((c) => renders.has(c));
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
        ...(ceremoniesFor(id).length ? { ceremonies: ceremoniesFor(id) as SurfaceCeremony[] } : {}),
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
    // Spec 398 §7.2 — from the contract, for a client's retry affordance and render; read by no gate here.
    ...(playbook?.tools?.[c.id]?.idempotency ? { idempotency: playbook.tools[c.id]!.idempotency } : {}),
    ...(playbook?.tools?.[c.id]?.result?.kind ? { resultKind: playbook.tools[c.id]!.result!.kind } : {}),
  }));
}

/**
 * The action tools this ask may compose: what this agent offers, narrowed by what the SURFACE says it can
 * complete and by the realm the person is standing in. Narrowing only — a surface that names a capability
 * this agent does not have gets nothing extra, and a realm never grants.
 */
/** The risk ladder, ordered. Comparing by index is how "never lower" is enforced. */
// Spec 354 K5 — THE COMPOSITION ROOT IS RING 0 (`@agenticprimitives/harness` `compose.ts`): what a SKILL.md may
// and may not say about a built-in capability lives beside the verifier it protects, not beside the tools it
// governs. This app keeps the name for its callers and adds the one thing Ring 0 leaves to it — where a
// contract's disagreement on an authority field is SAID (the author believes it is in force).
export function mergeContractTool(builtin: ToolSpec, contract: DefinitionToolV1 | undefined): ToolSpec {
  return composeMergeContractTool(builtin, contract, (d) => console.warn(`[playbook] contract for ${d.capability} declares ${d.field}=${d.contract}; the running capability binds ${String(d.running)} and that is what the verifier compares — the contract's value is NOT applied`));
}

/** Spec 404 — the external MCP servers a holder attached, from HER records (`connector.mcp:*`). Read on every ask, never
 *  memoised: a connector removed must be gone on the very next ask in every isolate (removal is final), and an in-isolate
 *  memo would keep a stranger's tool callable for a minute after she took it away. One survey per ask is the price. */
export async function mcpConnectorsOf(deps: { survey?: (subject: string) => Promise<Array<{ recordType: string }>>; readRecords?: (subject: string, keys: string[]) => Promise<Record<string, unknown>> }, holder: string | undefined): Promise<McpConnectorRecordV1[]> {
  if (!holder || !deps.survey || !deps.readRecords) return [];
  const keys = (await deps.survey(holder.toLowerCase())).map((r) => r.recordType).filter((k) => k.startsWith(MCP_CONNECTOR_PREFIX));
  if (!keys.length) return [];
  const recs = await deps.readRecords(holder.toLowerCase(), keys);
  return keys.map((k) => recs[k]).filter(isMcpConnectorRecord).filter((r) => !(r as { removedAt?: string }).removedAt);
}

export function scopedActionTools(surface?: AskScopeV1, playbook?: { capabilityIds: Set<string>; tools?: Record<string, DefinitionToolV1> } | null): ToolSpec[] {
  // An app that DECLARES its capabilities is offered only those (spec 353; the rule is Ring 0's `declaredCapabilities`).
  let tools = declaredCapabilities(HARNESS_ACTION_TOOLS, surface);
  // THE PLAYBOOK NARROWS THE OFFER (spec 354 §4.4): only what this agent's compiled archetype knows how
  // to do. Behavior honesty, not authority — a removed tool is one the planner will not pick; the mandate
  // gate is untouched. Absent playbook ⇒ no narrowing (the bare harness offers everything the surface
  // allows).
  // …AND THE CONTRACT DESCRIBES IT (spec 354 K5): the Ring-0 composition root narrows the built-ins to the
  // definition and puts each kept tool under its contract — see `harness/compose.ts` for the line between
  // describing an act and weakening its gate.
  if (playbook) tools = composeOfferedTools(tools, playbook, (d) => console.warn(`[playbook] contract for ${d.capability} declares ${d.field}=${d.contract}; the running capability binds ${String(d.running)} — NOT applied`));
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
function selectByPayee(rs: { capability: { id: string }; args: Record<string, unknown> }, all: MandatePresentation[], paymentEnforcer?: string, allowedMethodsEnforcer?: string): MandatePresentation | null {
  // Spec 397 `act-as-me` / spec 422: a key that names a DIFFERENT capability does not fit this step — it is left
  // alone and the step PARKS (authority-required for its own args), which is what the surface mints or derives the
  // next key from. Judged by the wire's own `allowedMethods` selector list when it has one; a wire with none, or an
  // undecodable one, is not pre-judged here (the verifier judges the selected mandate alone, afterwards, as always).
  const covers = (p: MandatePresentation): boolean => {
    if (!allowedMethodsEnforcer) return true;
    const wire = p.wire as { caveats?: Array<{ enforcer?: string; terms?: unknown }> };
    const caveat = (wire.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === allowedMethodsEnforcer.toLowerCase());
    if (!caveat) return true;
    try { return decodeAllowedMethodsTerms(caveat.terms as never).map((x) => String(x).toLowerCase()).includes(methodSelector(rs.capability.id).toLowerCase()); } catch { return true; }
  };
  all = all.filter(covers);
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

export async function runUnderMandate(env: HarnessEnv, deps: HarnessDeps, input: HarnessRunInput): Promise<{ result: RunResult; plannerKind: string; resolved: ResolvedParties; interactionFor: Record<string, NonNullable<ToolSpec['interaction']>>; trace: PlannerTraceV1; tools: ToolSpec[]; events: RunEvent[]; presentedRefs: string[]; playbook: { digest: string; triggers?: TriggerV1[] } | null }> {
  const resolved: ResolvedParties = new Map();
  const events: RunEvent[] = [];
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

  // Spec 410 §5 — the versions this runtime RUNS WITH: the T-box manifest digest, and the compiled definition's
  // digest once the playbook is loaded (below). The verifier reads them at verify time and recomputes the
  // intent digest under them; the intent is stamped with the same values before any mandate is minted.
  let currentVersions: VersionBindingV1 | null = null;
  const verifier = delegationMandateVerifier({
    actor: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
    enforcers,
    currentVersions: () => currentVersions,
    // Spec 383 — every wire this turn presented, so a child is verified with its parents or refused.
    presentedAll: () => (input.presented == null ? [] : Array.isArray(input.presented) ? input.presented : [input.presented]).map((w) => w as unknown as Delegation),
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
        metadata: { toolId: r.toolId, risk: r.risk, capability: r.capability ?? null, mandateRef: r.authority?.presentedRef ?? null, via: input.via ?? null, decision: r.authority?.decision.decision ?? null, approvalRecords: r.approvalRecords ?? null, idempotencyKey: r.idempotencyKey ?? null, pendingInput: r.pendingInput ?? null, error: r.error ?? null },
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
  const phaseT0 = Date.now();
  const phases: string[] = [];
  const mark = (name: string) => phases.push(`${name} ${Date.now() - phaseT0}ms`);
  // Spec 390 W3 — the same windows on the RECORD (`marks`), as child spans of `receive_request`, when the
  // caller collects them; the console line above stays for a material ask.
  const timed = <T,>(name: string, fn: () => Promise<T>): Promise<T> => input.marks ? input.marks.time(name, fn) : fn();
  // Remembered for a minute per addressee (`run-memo.ts`): the vault read was 2–3 s of every ask.
  // The RECORD is what is remembered, not the playbook built from it: the playbook carries a Set, and
  // a Set does not survive the cache's JSON. `loadPlaybook` rebuilds from the record every time, cheaply.
  const rememberedRecord = deps.readSubjectRecord
    ? (subject: string, recordType: string) => remembered(`record:${subject.toLowerCase()}:${recordType}`, () => deps.readSubjectRecord!(subject, recordType))
    : undefined;
  // STARTED TOGETHER, AWAITED WHERE NEEDED. The playbook, the standing derivation and the catalog are three
  // independent reads of the addressee's vault, and each cold read is seconds; run one after another they
  // were most of a cold ask (playbook 4 s, then standing 4 s, then the model — seen live, 2026-09-11).
  // Standing and the catalog are awaited further down, exactly where they were.
  const chainIdForWire = Number(env.CHAIN_ID); const dmForWire = env.DELEGATION_MANAGER as Address | undefined;
  const wireRefOf = (wire: unknown): Hex | null => { try { return dmForWire ? hashDelegation(wireToDelegation(wire as never), chainIdForWire, dmForWire) : null; } catch { return null; } };
  // Remembered per (principal, subject) for a minute: 3.2 s of every ask went to re-deriving a relation
  // that does not change between two hands. Standing is honesty, not authority (spec 353 §4) — it reaches
  // no verifier — so a minute-old answer misreports nothing anybody could act on.
  const standingPrincipal = input.person; const standingSubject = input.addressee;
  // A STUDY CONSULTATION'S STANDING IS THE GRANT. The person's agent presented it and `runAgentAsk` verified it
  // (`card-room.ts`); deriving a relation from the coach's records instead cost 2 s of a cold consultation to
  // say less. Named on every receipt like any other standing — evidence, not authority.
  const standingOnce: Promise<ExecutionBindingV1['standing'] | undefined> | null = input.study && standingPrincipal && standingSubject
    ? Promise.resolve({ relation: 'none' as const, subject: standingSubject.toLowerCase(), principal: standingPrincipal.toLowerCase(), because: 'no standing between them — the person\'s agent presented a study grant to this service, verified at admission (wireRef is its digest)', ...(input.study.hash ? { wireRef: input.study.hash } : {}) })
    : standingPrincipal && standingSubject && deps.readSubjectRecord
    ? remembered(`standing:${standingPrincipal.toLowerCase()}:${standingSubject.toLowerCase()}`, () => deriveStanding({ readSubjectRecord: deps.readSubjectRecord, ...(deps.verifyStewardship ? { verifyStewardship: deps.verifyStewardship } : {}), ...(deps.standingContext ? { context: deps.standingContext } : {}), ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}), wireRefOf },
        { principal: standingPrincipal, subject: standingSubject })
      .then((st) => ({ relation: st.relation, subject: st.subject, principal: standingPrincipal.toLowerCase(), because: st.because, ...(st.wireRef ? { wireRef: st.wireRef } : {}) }))
      .catch(() => undefined))
    : null;
  // A SCREEN'S FIXED READ PREPARES ONLY WHAT IT NAMES (2026-10-04). A rowsOnly supplied plan — the bell asking "what
  // invitations do I have" every minute — never re-plans (a tool it names that the agent lacks answers "not offered", see
  // `unoffered` below), so a tool SOURCE its plan does not name cannot change its answer: the catalog, the holder's MCP
  // connectors (a vault survey + read, 1.2–2 s, its minute's memo always expired by a 60 s poll) and the Google status
  // are prepared only when the plan names one of their tools. A conversational ask prepares everything, as before.
  const screenPlanned: Set<string> | null = input.plan && input.rowsOnly && !input.resume ? new Set(input.plan.steps.map((st) => st.toolId)) : null;
  const screenNames = (pred: (id: string) => boolean): boolean => !screenPlanned || [...screenPlanned].some(pred);
  const catalogOnce = screenNames((id) => CATALOG_TOOLS.some((t) => t.id === id) || isPeopleGroupTool(id))
    ? remembered(`catalog:${String(input.addressee ?? '').toLowerCase()}`, () => catalogBindingFor(deps, input.addressee ? String(input.addressee) : undefined))
    : Promise.resolve(null);
  // WHICH PROFILE the record's endpoint serves (`tools/list`, remembered a minute per endpoint; a failed read is not
  // remembered and lists no profile's tools): the content catalog and the people-group catalog share the record key.
  const servedOnce: Promise<string[] | null> = catalogOnce.then((b) => (b ? remembered(`mcp-served:${b.endpoint}`, async () => { const t = await toolsServedAt(b.endpoint); if (!t) throw new Error('tools/list unreadable'); return t; }) : null), () => null).catch(() => null);
  // THE PERSON'S STUDY, STARTED NOW (`card-room.ts`): four reads of HER vault under the grant, independent of
  // everything the harness does before the answering step, so they run beside the playbook load rather than
  // after the gates — read later, where the tool is built. A consultation is on the table's clock.
  const studyOnce = input.study && deps.readSubjectRecord && input.material && typeof input.material.skill === 'string'
    ? (() => {
        const owner = input.study.owner; const reads = input.study.reads; const review = /\.review$/i.test(String(input.material.skill));
        // THIS GAME'S CABINET — the record names the grant was verified against (`cardroom.hand`, or
        // `cardroom.canasta.hand`, …), never hold'em's by default.
        const rec = input.study.records ?? studyRecords(String(input.material.skill));
        const read = (recordType: string) => reads.includes(recordType) ? deps.readSubjectRecord!(owner, recordType).catch(() => null) : Promise.resolve(null);
        const materialInput = input.material.input;
        // A REVIEW READS THE SPAN'S DAYS — seven by default, the request's `days` otherwise — when the grant covers
        // them; advice reads none of them. Read in parallel: a week is seven small reads, not one large one.
        const span = review ? reviewDaysOf(materialInput) : 0;
        const dayTypes = review && reads.includes(rec.dayScope) ? dayRecordsFor(span, new Date(), rec.family) : [];
        return Promise.all([read(rec.hand), read(rec.style), read(rec.read), read(rec.note), read(rec.profile), Promise.all(dayTypes.map((t) => deps.readSubjectRecord!(owner, t).catch(() => null)))])
          .then(([hand, style, playerRead, note, profile, days]) => studyFrom({ access: input.study!, hand, style, read: playerRead, note, profile, material: materialInput, review, days, ...(span ? { span } : {}) }));
      })()
    : null;
  const playbook = await timed('prepare:playbook', () => loadPlaybook(rememberedRecord, String(input.addressee ?? ''), console.log).catch(() => null));
  mark('playbook');
  // Spec 410 §5 — stamp the intent with the versions it is acted under. The mandate a Home mints for this run
  // digests the whole intent (RFC 8785), so the versions are bound; a resume under a moved T-box or definition
  // is refused by the verifier with the moved one named (`version-moved`), never silently reinterpreted.
  // Spec 410 §10 — the ESTATE's adopted manifest when its governance has adopted one (`ADOPTED_ONTOLOGY_MANIFEST_DIGEST`,
  // a deployment fact from an `apgov:AdoptedVersion` proposal), else the package's own; never a guess between them.
  const adopted = String(env.ADOPTED_ONTOLOGY_MANIFEST_DIGEST ?? '').trim();
  if (adopted && !/^0x[0-9a-fA-F]{64}$/.test(adopted)) throw new Error('ADOPTED_ONTOLOGY_MANIFEST_DIGEST is set but is not a bytes32 digest — the estate\'s adopted ontology version is a deployment fact, stated exactly or not at all');
  currentVersions = { ontologyManifestDigest: (adopted || ONTOLOGY_MANIFEST_DIGEST) as Hex, semanticsDigest: (playbook?.digest ?? NO_SEMANTICS_DIGEST) as Hex };
  input.intent.versions = currentVersions;
  // Spec 410 §6 — THE ASK'S CLASSIFIER: does the sentence name an OPEN intent of a published outcome class? Rendered
  // from the ontology's own words (`OUTCOME_CLASSES[].words`), deterministic, stamped once: the stated outcome rides
  // in `intent.constraints.outcome`, the mandate digests it, and `outcomeConformance` refuses every consequential
  // effect the class does not entail before anything reaches the signature sheet. A closed intent stays unstamped.
  if (!input.intent.constraints?.outcome) {
    const stated = classifyOpenIntent(input.intent.goal, OUTCOME_CLASSES);
    if (stated) input.intent.constraints = { ...(input.intent.constraints ?? {}), outcome: stated };
  }
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
      // The account is named after the LAST "of/in/does/do/for" — the one nearest the thing named: "how much money DO i have
      // IN my treasury" names "my treasury", not "i have in my treasury" (the first anchor, which the person then got asked
      // about: 'I could not find "i have in my"' — live 2026-09-29). And the asker's own words about herself ARE her: a
      // phrase with I / my / me / we / our / us is her own treasuries, which the read answers with no account at all.
      const account = balanceAccountOf(goal);
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

  // FAN-OUT CONSULT (spec 380) — compiled BEFORE the roster read, because its sentence contains a roster
  // sentence ("member of Missio Nexus"): matched second, the consult never existed and admission refused an
  // instruction whose only step was a lookup. "ask each member of Missio Nexus whether they are available on Saturday" has
  // one correct shape — enumerate the members, then the consult once per member — and the same reason as
  // the payment fan-out for compiling it: a model given N members emitted one call and the composer promised
  // the rest. The organization phrase and the question clause are read from the sentence; who each member
  // is comes from the roster, and whether they are asked at all from their own opt-in, at the step.
  /**
   * A NAMED SKILL IS NOT A PLANNING PROBLEM (2026-09-17).
   *
   * When a message names a skill this agent's card ADVERTISES, `playbook.answer` is offered and is the tool
   * that answers it — the material is in the message and the judgement is the playbook's. Choosing it still
   * cost a planner turn: the whole tool list, the whole doctrine, sent to a model to be told the one thing
   * the envelope already said. Two model calls for one answer, on the clock of every turn.
   *
   * Mystery Night is that shape at volume — eight characters, each asked `mystery.act` on every beat of
   * every act — and halving it is the difference between a night that costs what a night should and one
   * nobody runs twice.
   *
   * IT IS NOT A SHORTCUT PAST A DECISION, which is why it is compiled rather than guessed: `playbookAnswer`
   * is non-empty only when the message named a skill AND the card advertises it AND a structured call is
   * configured, so by the time this matches there is exactly one tool that can answer and the planner's only
   * possible output is the one written here. The ANSWER is still the model's, once, under the archetype's
   * own instructions — what is saved is the turn spent deciding to ask it.
   */
  const compiledSkillAnswer = (): Plan | null =>
    playbookAnswer.length === 0
      ? null
      : { steps: [{ toolId: PLAYBOOK_ANSWER_TOOL.id, args: {}, id: 's0' }], rationale: 'compiled: the message named an advertised skill' };

  const compiledConsult = (goal: string): Plan | null => {
    const c = consultAskOf(goal);
    if (!c) return null;
    return {
      steps: [
        { toolId: MEMBERSHIP_LIST_TOOL.id, args: c.org ? { org: c.org } : {}, ref: 'roster', id: 's0' },
        { toolId: MEMBER_CONSULT_TOOL.id, args: { ...(c.org ? { org: c.org } : {}), respondent: { $item: 'agent' }, question: c.question }, id: 's1', forEach: { ref: 'roster.members' } },
      ],
      rationale: 'compiled: per-member consult (spec 380)',
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
    return p ? { steps: [{ toolId: 'treasury.payment.execute', args: { ...(p.payee ? { payee: p.payee } : {}), ...(p.payer ? { payer: p.payer } : {}), ...(p.usdc ? { usdc: p.usdc } : {}), ...(p.memo ? { memo: p.memo } : {}) } }], rationale: 'compiled: single payment (spec 355)' } : null;
  };

  // Fan-out guidance (spec 358 W4) — appended to whichever prompt applies. The form is taught, the
  // SAFETY is not delegated to the model: the loop refuses a forEach over anything the producing tool
  // does not declare enumerable, the ontology binding caps the count, and every item re-enters the
  // verifier — a mandate per payment, exactly as if the person had asked N times.
  const contractFor = (conversationTurns: number) => `${systemPrompt}

FOR EVERY / FOR EACH asks ("pay every member of X 2 usdc") are the ONE case where you emit TWO tool
calls, BOTH IN THIS SAME RESPONSE, in order:
  1. organization.membership.list with arguments {"$ref": "roster"} — it enumerates the members.
  2. the per-item capability ONCE — for a payment: treasury.payment.execute with
     {"$forEach": "roster.members", "payee": {"$item": "agent"}, "usdc": "<the amount asked>"}.
The runtime expands call 2 into one act per member, each separately authorized. Do NOT list members
yourself, do NOT emit one call per member, and never fan out over anything except what a tool
enumerates. "Choose the tool" above means one CAPABILITY — this two-call form is still one capability,
fanned out.

${conversationForPrompt(input.conversation, String(input.addressee ?? ''), conversationTurns)}
${input.memory ? factsForPrompt(input.memory) : ''}

A step that should happen ONLY IF an earlier read found something adds {"$when": {"ref": "<name>.<path>",
"exists": true}} (or "exists": false for the other branch) to its arguments — the runtime takes or skips
it from that result; do not plan two alternatives and hope. Reads that need nothing from each other may
be emitted together; the runtime runs them side by side.

When the ask says WHO is to do a step — "have runtime-c3s0.svc pay …", "ask the treasury bot to fund it" —
add {"$executor": "<that agent, exactly as said>"} to THAT step's arguments: the words, never an address. The
step is then handed to that agent under authority the person grants; leave it out when nobody is named.`;
  const fanOutPrompt = contractFor(4);
  // The playbook's own words lead: an agent set to an archetype is TOLD what it is before the rules of
  // asking. Rendered from the compiled definition (spec 354) — versioned and receipted, never a silent
  // prompt edit.
  // Spec 367 W2 — THE SKILL'S OWN EXAMPLES teach the planner. Each contract's utterances, positive and
  // negative, rendered once as few-shot; the same fixtures are the scenario eval set. Absent ⇒ nothing
  // is rendered (an archetype with no examples plans from descriptions, as before).
  const examplesFor = (positivesPerTool?: number) => playbook ? utteranceExamples(Object.values(playbook.tools ?? {}), positivesPerTool) : '';
  const examples = examplesFor();
  const doctrine = playbook ? plannerDoctrineOf(playbook.instructions) : null;
  const withPlaybook = doctrine ? `${doctrine.text}\n\n---\n\n${fanOutPrompt}${examples}` : fanOutPrompt;
  // A provider with a prompt budget (Groq's free plan) is served the same prompt made to FIT — whole parts
  // dropped in a fixed order and each drop recorded — decided at plan time, when the tools it rides with are
  // known. The digest on the trace is of what was actually sent.
  // Spec 388 — under ORCHESTRATION_ROUTE=budget the provider is chosen per call, at plan time, from the prompt's
  // estimate (see `plan` below); `selected` is the deployment's default, kept for the rule-based case.
  // The planner's reported usage lands on the trace (declared below; the planner runs after it exists).
  const notePlannerUsage = (u: ModelUsageV1) => { trace.plannerUsage = addUsage(trace.plannerUsage, u); };
  const selectionProvider = input.selectionProvider ?? input.provider;
  const answerProvider = input.answerProvider ?? input.provider;
  const judgeProvider = input.judgeProvider ?? input.provider;
  const selected = selectPlanner(env as never, { systemPrompt: withPlaybook, maxTokens: ASK_PLANNER_MAX_TOKENS, ...(selectionProvider ? { provider: selectionProvider } : {}), onUsage: notePlannerUsage });
  let plannerModel = selected.model;
  // The compiler answers for the shapes it claims; the model answers for the rest. Not a fallback pair
  // (ADR-0013): the match is deterministic and decided BEFORE any planner runs, the way a rule-based
  // planner rule would be.
  // Spec 367 wave 1 — the trace starts here: which planner actually proposed, and what it could see.
  // A RESUME plans nothing (spec 370 P1): the checkpoint holds the plan this intent was admitted with, and
  // the loop takes it from `resume` — this planner is never consulted on that path. Named so the trace
  // says where the plan came from.
  let plannerUsed: PlannerTraceV1['planner'] = input.replayOf ? 'replay' : input.resume ? 'checkpoint' : input.plan ? 'supplied' : selected.kind;
  const planner: Planner = input.replayOf
    ? { plan: async () => ({ steps: input.replayOf!.plan.steps.map((st) => ({ ...st })), rationale: `replay of ${input.replayOf!.runRef}` }) }
    : input.plan
    // The screen's plan verbatim — interpretation is what Ask ADDS in front of the same boundary, not a
    // toll every caller pays. One-shot: a failed supplied step is the caller's to correct, not a model's
    // to re-plan around (re-planning a click would act on something nobody clicked).
    // Spec 376 W2 — the playbook's SPECIALISTS apply to every plan, a screen's included: who does the work is
    // the agent's behaviour, not the screen's interpretation; a step that names its own executor keeps it.
    ? { plan: async (pin) => withSpecialists({ steps: input.plan!.steps }, playbook?.specialists, pin.tools) }
    : {
        plan: async (pin) => {
          // Spec 376 W2 — "have X …": the executor is peeled off first, and the ask that remains is what the
          // compiled shapes match. A model-planned ask keeps the whole sentence: the planner is taught `$executor`.
          const { executor: named, rest } = executorPrefixOf(pin.intent.goal);
          // 2026-10-01 — HOW A PLAN WITH A REQUIRED INPUT MISSING IS ANSWERED (`skill-selection/hold`, env SKILL_HOLD_DEFAULT;
          // `ask` until the Lab measures `skeleton`). One place for every outcome plan below: the steps are built through
          // this, and a skeleton that ran is on the trace as `skillStage: 'skeleton'` (the plan's `missing` stays on
          // `trace.selection` either way — the hold is recorded; only the answer to it changes).
          const holdMode = holdModeOf(input.variant?.toggles?.['skill-selection/hold'], (env as { SKILL_HOLD_DEFAULT?: string }).SKILL_HOLD_DEFAULT);
          const chainProceedMode = chainProceedModeOf(input.variant?.toggles?.['plan/chain-proceed'], (env as { PLAN_CHAIN_PROCEED_DEFAULT?: string }).PLAN_CHAIN_PROCEED_DEFAULT);
          const outcomeStepsUnderHold = (plan: OutcomePlanV1, labelOf: (iri: string) => string, opts?: Parameters<typeof outcomeSteps>[3]) => {
            const r = stepsUnderHold(plan, holdMode, labelOf, (p) => outcomeSteps(p, pin.intent.goal, labelOf, opts));
            if (r.skeleton) trace.skillStage = 'skeleton';
            // 2026-10-02 — A CHAIN'S TERMINAL STEP PROCEEDS (`plan/chain-proceed`, env PLAN_CHAIN_PROCEED_DEFAULT; `off`
            // until the Lab measures it). The grant chain scored 0.35–0.46 in every arm because the drafter paused at its
            // Stage 1 soft gate after the tracker ran (`chain-proceed.ts`). Applied AFTER the hold: a held plan is the
            // hold's (the skeleton wins — one instruction, never two), so this only ever reaches a plan with nothing missing.
            const cp = stepsUnderChainProceed(r.steps, chainProceedMode, plan.missing.length > 0);
            if (cp.chainProceed) trace.chainProceed = true;
            return cp.steps;
          };
          // Spec 402 W3 — a sentence with a clock, said at the person's own agent, is a routine to keep (read back first).
          // Spec 421 W1 — a CONTINUATION is always the model's: it plans from what was read, which no compiled shape knows.
          const compiled = pin.continuation ? null : compiledSkillAnswer() ?? compiledConsult(rest) ?? compiledRead(rest) ?? compiledFanOut(rest) ?? compiledPayment(rest) ?? (input.person && input.addressee && input.person.toLowerCase() === input.addressee.toLowerCase() ? compiledRoutine(rest) : null);
          if (compiled) {
            plannerUsed = 'compiled';
            // Spec 421 W1 — A COMPILED READ THAT THE SENTENCE WANTS ACTED ON continues: "save the details from my latest
            // message" compiles to the inbox read, and the act it asks for is planned from what the read returns. The
            // test is whether the sentence says one of the offered acts' declared verbs (the contracts', never a list here),
            // and continuation must be on (the loop offers `plan.continue` only then).
            const offersContinue = pin.tools.some((t) => t.id === CONTINUE_STEP_ID);
            const readOnly = compiled.steps.every((st) => !pin.tools.find((t) => t.id === st.toolId)?.capability);
            const said = ` ${rest.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
            const saysAnAct = pin.tools.some((t) => t.capability && (t as { verbs?: string[] }).verbs?.some((v) => said.includes(` ${v.toLowerCase()} `)));
            const out = offersContinue && readOnly && saysAnAct ? { ...compiled, steps: [...compiled.steps, { toolId: CONTINUE_STEP_ID, args: {} }] } : compiled;
            return withSpecialists(named ? withExecutor(out, named) : out, playbook?.specialists, pin.tools);
          }
          // Spec 415 A4 — SELECTION BY DECLARED VOCABULARY: among the playbook's instruction skills, by their contracts'
          // utterances, choosing with a margin or HOLDING (a plan of `ask.unsupported` — no skill, said plainly). The
          // decision is on the trace; the model is not consulted on this path.
          if (!pin.continuation && input.variant?.selection === 'declared') {
            const sources = instructionSourcesOf(playbook);
            const candidates = Object.values(playbook?.tools ?? {}).filter((t) => sources[t.id] && t.utterances?.length).map((t) => ({ id: t.id, utterances: t.utterances! }));
            const sel = selectByDeclaredUtterances(rest, candidates);
            plannerUsed = 'declared';
            trace.selection = { approach: 'declared', chose: sel.chose, ...(sel.hold ? { hold: sel.hold } : {}), rejected: sel.rejected, scores: sel.scores, params: sel.params };
            const step = sel.chose ? { toolId: sel.chose, args: { question: pin.intent.goal }, id: 's0' } : { toolId: UNSUPPORTED_TOOL.id, args: { what: pin.intent.goal }, id: 's0' };
            return withSpecialists({ steps: [step], rationale: sel.chose ? `declared: ${sel.chose} by its utterances` : `declared: held (${sel.hold})` }, playbook?.specialists, pin.tools);
          }
          // Spec 415 A4 — THE THREE ARMS (+ the framed shape). A rule narrows and a judge picks; neither allows. Candidates are
          // the playbook's instruction skills; the arm's decision goes on the trace; a hold plans `ask.unsupported`.
          const arm = input.variant?.selection;
          if (!pin.continuation && (arm === 'ontology' || arm === 'judgment' || arm === 'ontology+judgment' || arm === 'propose+judgment' || arm === 'ontology-first' || arm === 'framed-judgment' || arm === 'outcome' || arm === 'outcome-selective')) {
            const sources = instructionSourcesOf(playbook);
            const skills = Object.values(playbook?.tools ?? {}).filter((t) => sources[t.id]).map((t) => ({ id: t.id, description: t.description, covers: t.covers ?? [], ...(t.excludes?.length ? { excludes: t.excludes } : {}), ...(t.produces?.length ? { produces: t.produces } : {}), ...(t.consumes?.length ? { consumes: input.variant?.toggles?.['skill-selection/necessity'] === 'off' ? t.consumes.map(({ necessity: _n, ...k }) => k) : t.consumes } : {}) }));
            // Spec 418 D4 — `office-prior off` hides the role classes' typical capabilities from the reading.
            const lexicon = input.variant?.toggles?.['skill-selection/office-prior'] === 'off' ? playbook?.domainLexicon?.map(({ uses: _u, ...e }) => e) : playbook?.domainLexicon;
            // The judge's model call is a model invocation of the run like the planner's: on the trace, with its provider,
            // model and why — role `judge`, so a reader can tell the call that chose the skill from the one that answered.
            const fast = input.variant?.judgeProfile === 'fast' || input.variant?.judgeProfile === 'logprob';
            const choose = input.variant?.judgeProfile === 'logprob' ? logprobChoiceFor(env as never, selectionProvider, { onCall: recordStructured('judge') }) : undefined;
            // Spec 416 §4f — WHAT IS KNOWN OF THE ASKER, for the judge's typed reading: their standing (already derived for
            // the receipts, memoised), and under `full` their recent skills here (the operator index, one range read) and
            // — at their own agent — short memory entries. Labels and counts go on the trace, never the memory's words.
            const askerMode = input.variant?.toggles?.['skill-selection/asker-context'] ?? 'relation';
            const asker: AskerContextV1 | undefined = askerMode === 'off' ? undefined : await (async () => {
              const st = standingOnce ? await standingOnce : undefined;
              const rel = !input.person ? undefined : String(input.person).toLowerCase() === String(input.addressee ?? '').toLowerCase() ? 'self' as const
                : st?.relation === 'steward' || st?.relation === 'self' ? 'steward' as const : st?.relation === 'member' ? 'member' as const : 'stranger' as const;
              // A SEEDED asker context (a comparison's starting state) stands in for the asker's live history.
              // …unless the comparison says the asker context is only their standing (`relation`) or nothing (`off`).
              const seeded = input.variant?.toggles?.['skill-selection/asker-context'] ? undefined : input.variant?.askerContext;
              if (seeded) return { ...(rel ? { relation: rel } : {}), ...(seeded.recentSkills?.length ? { recentSkills: seeded.recentSkills.slice(0, 4) } : {}), ...(seeded.memoryTags?.length ? { memoryTags: seeded.memoryTags.slice(0, 6) } : {}), ...(seeded.heldClasses?.length ? { heldClasses: seeded.heldClasses.slice(0, 16) } : {}) };
              if (askerMode !== 'full') return rel ? { relation: rel } : undefined;
              const recent = input.person && input.addressee ? await recentToolsOf(env as never, input.addressee as Address, input.person as Address, Date.now() - 30 * 86_400_000).catch(() => null) : null;
              const skillIds = new Set(Object.keys(sources));
              const recentSkills = (recent ?? []).filter((x) => skillIds.has(x.id)).slice(0, 4);
              const memoryTags = input.memory ? factsOf(input.memory).entries.slice(0, 6).map((e) => (e.tags?.length ? e.tags.join(', ') : e.fact).slice(0, 80)) : [];
              return { ...(rel ? { relation: rel } : {}), ...(recentSkills.length ? { recentSkills } : {}), ...(memoryTags.length ? { memoryTags } : {}) };
            })();
            const call = structuredCallFor(env as never, selectionProvider, { onCall: recordStructured('judge'), ...(fast ? { tier: 'light' as const } : {}) }) as never;
            let chose: string | null;
            const judgeParams = { ...(input.variant?.acceptance ? { acceptance: input.variant.acceptance } : {}), ...(fast ? { profile: input.variant?.judgeProfile === 'logprob' ? 'logprob' as const : 'fast' as const } : {}) };
            if (arm === 'ontology') { const r = selectByOntology(rest, skills, lexicon); trace.selection = { approach: 'ontology', ...r }; chose = r.chose; }
            else if (arm === 'judgment') { const r = await selectByJudgment(rest, skills, call, judgeParams, { ...(lexicon ? { lexicon } : {}), ...(asker ? { asker } : {}), ...(choose ? { choose } : {}) }); trace.selection = { approach: 'judgment', ...r }; chose = r.chose; }
            else if (arm === 'ontology+judgment') { const r = await selectByOntologyThenJudgment(rest, skills, call, judgeParams, lexicon); trace.selection = { approach: 'ontology+judgment', ...r }; chose = r.chose; }
            // Spec 416 W1 — the ontology PROPOSES (recall-first, `excludes` vetoes), the judge decides among the proposed.
            else if (arm === 'ontology-first') { const r = await selectByOntologyFirst(rest, skills, call, judgeParams, lexicon, asker); trace.selection = { approach: 'ontology-first', ...r }; chose = r.chose; }
            else if (arm === 'propose+judgment') { const r = await selectByProposalThenJudgment(rest, skills, call, judgeParams, lexicon); trace.selection = { approach: 'propose+judgment', ...r }; chose = r.chose; }
            else if (arm === 'outcome-selective') {
              // Spec 418 D6 — the cheap pick first; the dataflow questions only when the pick has a producible upstream input.
              const r1 = await selectByJudgment(rest, skills, call, { profile: 'fast', ...(input.variant?.toggles?.['skill-selection/samples'] === '2' ? { samples: 2 } : {}) }, { ...(lexicon ? { lexicon } : {}), ...(asker ? { asker } : {}) });
              plannerUsed = arm;
              if (r1.chose) {
                const r2 = await planForPicked(rest, r1.chose, skills, call, { ...(input.variant?.toggles?.['skill-selection/party-rule'] === 'off' ? { partyRule: false } : {}), ...(input.variant?.toggles?.['skill-selection/downstream'] === 'on' ? { downstream: true } : {}), ...(input.variant?.toggles?.['skill-selection/absence'] === 'v2' ? { absenceWording: 'v2' as const } : {}) }, { ...(lexicon ? { lexicon } : {}), ...(asker ? { asker } : {}) });
                const { judge: planJudge, ...plan2 } = r2;
                trace.selection = { approach: 'outcome-selective', chose: r1.chose, distribution: r1.distribution, judge: r1.judge, ...(r1.reading ? { reading: r1.reading } : {}), ...plan2, planJudge };
                const labels = new Map([...(lexicon ?? []).map((e) => [e.iri, e.label] as const), ...skills.flatMap((x) => [...(x.produces ?? []), ...(x.consumes ?? [])].map((k) => [k.iri, k.label] as const))]);
                const steps = outcomeStepsUnderHold(r2.plan, (iri) => labels.get(iri) ?? iri.split('#').pop() ?? iri, { briefIntermediate: input.variant?.toggles?.['skill-selection/intermediate'] === 'brief' });
                trace.expectedDelivers = expectedDeliversOf(r2.plan.steps, skills, playbook?.domainLexicon);
                return withSpecialists({ steps, rationale: `outcome-selective: ${r2.plan.steps.map((x) => x.tool).join(' → ')}${r2.asked ? '' : ' (no dataflow call)'}` }, playbook?.specialists, pin.tools);
              }
              trace.selection = { approach: 'outcome-selective', chose: null, ...(r1.hold ? { hold: r1.hold } : {}), distribution: r1.distribution, judge: r1.judge };
              chose = null;
            }
            else if (arm === 'outcome') {
              // Spec 417 — the OUTCOME the person wants (one judged call: the result, and what the request supplies), then
              // the path to it by the data graph's arrows from what the asker holds. A chain runs as `$ref`-linked steps.
              const r = await selectByOutcome(rest, skills, call, input.variant?.toggles?.['skill-selection/party-rule'] === 'off' ? { partyRule: false } : {}, { ...(lexicon ? { lexicon } : {}), ...(asker ? { asker } : {}) });
              trace.selection = { approach: 'outcome', ...r };
              plannerUsed = arm;
              if (r.chose && r.plan) {
                const labels = new Map([...(lexicon ?? []).map((e) => [e.iri, e.label] as const), ...skills.flatMap((x) => [...(x.produces ?? []), ...(x.consumes ?? [])].map((k) => [k.iri, k.label] as const))]);
                const steps = outcomeStepsUnderHold(r.plan, (iri) => labels.get(iri) ?? iri.split('#').pop() ?? iri);
                return withSpecialists({ steps, rationale: `outcome: ${r.plan.steps.map((x) => x.tool).join(' → ')}` }, playbook?.specialists, pin.tools);
              }
              chose = null;
            }
            else { const r = await selectByFramedJudgment(rest, skills.filter((x) => x.covers.length), call); trace.selection = { approach: 'framed-judgment', ...r }; chose = r.chose; }
            plannerUsed = arm;
            const why = (trace.selection as { hold?: string }).hold;
            const step = chose ? { toolId: chose, args: { question: pin.intent.goal }, id: 's0' } : { toolId: UNSUPPORTED_TOOL.id, args: { what: pin.intent.goal }, id: 's0' };
            return withSpecialists({ steps: [step], rationale: chose ? `${arm}: ${chose}` : `${arm}: declined (${why})` }, playbook?.specialists, pin.tools);
          }
          // Spec 416 §4f — THE DEFAULT SKILL STAGE (deployment setting `SKILL_SELECTION_DEFAULT=fast`). When the playbook has
          // instruction skills and no comparison chose an approach, the fast judge — one call over the skills' ontology
          // cards and the request's typed reading, the provider's light model — picks among them FIRST. A pick is planned
          // directly (no planner call). "None of these skills" hands the ask to the planner over the agent's other tools:
          // two declared stages, both on the trace (`selection` records the judge's verdict), never a silent retry.
          // Explicit per run (`skill-selection/stage` on | off — so a comparison NAMES it), else the deployment's default.
          const stageToggle = input.variant?.toggles?.['skill-selection/stage'];
          const stageDefault = (env.SKILL_SELECTION_DEFAULT ?? '').trim();
  const stageOn = stageToggle ? stageToggle === 'on' : !input.variant?.selection && !input.variant?.plannerKind && (stageDefault === 'fast' || stageDefault === 'selective');
          const skillSources = stageOn && !pin.continuation && !input.variant?.selection ? instructionSourcesOf(playbook) : {};
          if (Object.keys(skillSources).length) {
            const skills = Object.values(playbook?.tools ?? {}).filter((t) => skillSources[t.id]).map((t) => ({ id: t.id, description: t.description, covers: t.covers ?? [], ...(t.excludes?.length ? { excludes: t.excludes } : {}), ...(t.produces?.length ? { produces: t.produces } : {}), ...(t.consumes?.length ? { consumes: t.consumes } : {}) }));
            const st = standingOnce ? await standingOnce : undefined;
            const relation = !input.person ? undefined : String(input.person).toLowerCase() === String(input.addressee ?? '').toLowerCase() ? 'self' as const : st?.relation === 'steward' || st?.relation === 'self' ? 'steward' as const : st?.relation === 'member' ? 'member' as const : 'stranger' as const;
            const call = structuredCallFor(env as never, selectionProvider, { onCall: recordStructured('judge'), tier: 'light' }) as never;
            const seeded = input.variant?.toggles?.['skill-selection/asker-context'] ? undefined : input.variant?.askerContext;
            // LIVE history (the asker's recent skills here + their memory) only on a REAL ask with the deployment's
            // `SKILL_SELECTION_ASKER_CONTEXT=full` — never under a comparison, whose asker's history is its own test runs.
            const live = !input.variant && (env.SKILL_SELECTION_ASKER_CONTEXT ?? '').trim() === 'full' && input.person && input.addressee
              ? { recentSkills: ((await recentToolsOf(env as never, input.addressee as Address, input.person as Address, Date.now() - 30 * 86_400_000).catch(() => null)) ?? []).filter((x) => skillSources[x.id]).slice(0, 4), memoryTags: input.memory ? factsOf(input.memory).entries.slice(0, 6).map((e) => (e.tags?.length ? e.tags.join(', ') : e.fact).slice(0, 80)) : [] }
              : undefined;
            const ctx = seeded ?? live;
            const seededHeld = (seeded as { heldClasses?: string[] } | undefined)?.heldClasses;
            const asker: AskerContextV1 | undefined = relation || ctx ? { ...(relation ? { relation } : {}), ...(ctx?.recentSkills?.length ? { recentSkills: ctx.recentSkills.slice(0, 4) } : {}), ...(ctx?.memoryTags?.length ? { memoryTags: ctx.memoryTags.slice(0, 6) } : {}), ...(seededHeld?.length ? { heldClasses: seededHeld.slice(0, 16) } : {}) } : undefined;
            // Spec 418 D4 — `office-prior off` hides the role classes' typical capabilities here too (one knob, both paths).
            const stageLexicon = input.variant?.toggles?.['skill-selection/office-prior'] === 'off' ? playbook?.domainLexicon?.map(({ uses: _u, ...e }) => e) : playbook?.domainLexicon;
            const r = await selectByJudgment(rest, skills, call, { profile: 'fast', ...(input.variant?.toggles?.['skill-selection/samples'] === '2' ? { samples: 2 } : {}), ...((input.variant?.toggles?.['skill-selection/fast-version'] ?? ((env as { SKILL_SELECTION_FAST_VERSION?: string }).SKILL_SELECTION_FAST_VERSION?.trim() || 'v2')) === 'v3' ? { fastVersion: 'v3' as const } : {}), ...((input.variant?.toggles?.['skill-selection/split'] ?? ((env as { SKILL_SELECTION_SPLIT?: string }).SKILL_SELECTION_SPLIT?.trim() || 'decline')) === 'clarify' ? { splitToClarify: 0.7 } : {}), ...((input.variant?.toggles?.['skill-selection/borderline'] ?? ((env as { SKILL_SELECTION_BORDERLINE?: string }).SKILL_SELECTION_BORDERLINE?.trim() || 'off')) === 'on' ? { borderline: [0.35, 0.6] as [number, number] } : {}) }, { ...(stageLexicon ? { lexicon: stageLexicon } : {}), ...(asker ? { asker } : {}) });
            trace.selection = { approach: 'judgment', ...r };
            trace.skillStage = r.chose ? 'chose' : 'handed-to-planner';
            // Spec 418 — the pick split between two skills: ask which (a clarify reply), never decline to the planner.
            if (!r.chose && r.hold === 'needs-clarification' && r.rejected.length === 2) {
              plannerUsed = 'judgment'; trace.skillStage = 'clarify';
              const purposeOf = (id: string) => (skills.find((x) => x.id === id)?.description ?? id).split(/\bNOT for\b/i)[0]!.split(/[.—]/)[0]!.trim() || id;
              return withSpecialists({ steps: [{ toolId: ASK_CLARIFY_TOOL.id, args: { options: r.rejected, purposes: r.rejected.map(purposeOf), what: pin.intent.goal }, id: 's0' }], rationale: `skill stage: which of ${r.rejected.join(' / ')}?` }, playbook?.specialists, pin.tools);
            }
            if (r.chose) {
              plannerUsed = 'judgment';
              // Spec 418 A5 — WHAT THE AGENT ALREADY HOLDS: a comparison's seeded state wins; on a real ask, the addressee's
              // own record TYPES (never content) through the domain's record ↔ class bindings, read only when the picked
              // skill consumes a class some binding names — one survey, remembered a minute. Classes only reach the reading.
              const heldNow = await (async (): Promise<{ classes: string[]; from: 'seeded' | 'records' | 'none' }> => {
                if (asker?.heldClasses?.length) return { classes: [...asker.heldClasses], from: 'seeded' };
                if (input.variant?.toggles?.['skill-selection/held'] === 'off' || input.variant?.askerContext) return { classes: [], from: 'none' };
                const consumed = skills.find((x) => x.id === r.chose)?.consumes?.map((k) => k.iri) ?? [];
                const relevant = (playbook?.domainRecords ?? []).filter((m) => consumed.includes(m.class));
                if (!relevant.length || !deps.survey || !input.addressee) return { classes: [], from: 'none' };
                const types = await remembered(`record-types:${String(input.addressee).toLowerCase()}`, () => deps.survey!(String(input.addressee)).then((rs) => rs.map((x) => x.recordType)).catch(() => [] as string[]));
                return { classes: relevant.filter((m) => types.some((t) => t === m.recordType || t.startsWith(`${m.recordType}:`))).map((m) => m.class), from: 'records' };
              })();
              const askerHeld = heldNow.classes.length ? { ...(asker ?? {}), heldClasses: heldNow.classes } : asker;
              // Spec 418 D6 — adopted 2026-09-27 (ledger: pooled +12/−2 over six sets, p = 0.013, no set worse, no extra
              // cost): `SKILL_SELECTION_DEFAULT=selective` — after the pick, one small dataflow call only when the picked
              // skill has a producible upstream input the asker does not hold; the plan may then be a chain.
              // Spec 418 §11 — adopted 2026-09-27 (chain panel 4: +12/−0, p = 0.0005; regressions not significant): the
              // deployment's `SKILL_SELECTION_PLAN` (choice | questions); an explicit `skill-selection/plan` toggle wins.
              const planMode = input.variant?.toggles?.['skill-selection/plan'] ?? ((env as { SKILL_SELECTION_PLAN?: string }).SKILL_SELECTION_PLAN?.trim() || 'questions');
              if (stageDefault === 'selective' && skills.some((x) => x.consumes?.length) && planMode === 'choice') {
                const pc = await choosePlanAround(rest, r.chose, skills, call, { ...(playbook?.domainLexicon ? { lexicon: playbook.domainLexicon } : {}), ...(askerHeld ? { asker: askerHeld } : {}) });
                trace.selection = { approach: 'outcome-selective', chose: r.chose, distribution: r.distribution, judge: r.judge, ...(r.reading ? { reading: r.reading } : {}), ...(heldNow.from !== 'none' ? { held: heldNow } : {}), asked: pc.asked, plan: pc.plan, supplied: {}, planJudge: pc.judge };
                const labels = new Map([...(playbook?.domainLexicon ?? []).map((e) => [e.iri, e.label] as const)]);
                const steps = outcomeStepsUnderHold(pc.plan, (iri) => labels.get(iri) ?? iri.split('#').pop() ?? iri, { briefIntermediate: input.variant?.toggles?.['skill-selection/intermediate'] === 'brief' });
                trace.expectedDelivers = expectedDeliversOf(pc.plan.steps, skills, playbook?.domainLexicon);
                return withSpecialists({ steps, rationale: `skill stage (plan choice): ${pc.chosen.steps.join(' → ')}${pc.asked ? '' : ' (no plan call)'}` }, playbook?.specialists, pin.tools);
              }
              if (stageDefault === 'selective' && skills.some((x) => x.consumes?.length)) {
                const r2 = await planForPicked(rest, r.chose, skills, call, { ...(input.variant?.toggles?.['skill-selection/downstream'] === 'on' ? { downstream: true } : {}), ...(input.variant?.toggles?.['skill-selection/absence'] === 'v2' ? { absenceWording: 'v2' as const } : {}) }, { ...(playbook?.domainLexicon ? { lexicon: playbook.domainLexicon } : {}), ...(askerHeld ? { asker: askerHeld } : {}) });
                const { judge: planJudge, ...plan2 } = r2;
                trace.selection = { approach: 'outcome-selective', chose: r.chose, distribution: r.distribution, judge: r.judge, ...(r.reading ? { reading: r.reading } : {}), ...plan2, planJudge };
                const labels = new Map([...(playbook?.domainLexicon ?? []).map((e) => [e.iri, e.label] as const)]);
                const steps = outcomeStepsUnderHold(r2.plan, (iri) => labels.get(iri) ?? iri.split('#').pop() ?? iri, { briefIntermediate: input.variant?.toggles?.['skill-selection/intermediate'] === 'brief' });
                trace.expectedDelivers = expectedDeliversOf(r2.plan.steps, skills, playbook?.domainLexicon);
                return withSpecialists({ steps, rationale: `skill stage (selective): ${r2.plan.steps.map((x) => x.tool).join(' → ')}${r2.asked ? '' : ' (no dataflow call)'}` }, playbook?.specialists, pin.tools);
              }
              trace.expectedDelivers = expectedDeliversOf([{ tool: r.chose }], skills, playbook?.domainLexicon);
              return withSpecialists({ steps: [{ toolId: r.chose, args: { question: pin.intent.goal }, id: 's0' }], rationale: `skill stage: ${r.chose}` }, playbook?.specialists, pin.tools);
            }
            // "None of these skills": the planner gets the agent's OTHER tools only. Offering it the skills the judge just
            // rejected let it pick one anyway (measured 2026-09-27: a declined out-of-scope ask answered by a skill) and
            // cost ~12k prompt tokens of skill descriptions for nothing.
            pin = { ...pin, tools: pin.tools.filter((t) => !skillSources[t.id] && t.id !== ASK_CLARIFY_TOOL.id) };
          }
          // The model planner never sees the selection stage's clarify tool.
          pin = { ...pin, tools: pin.tools.filter((t) => t.id !== ASK_CLARIFY_TOOL.id) };
          plannerUsed = selected.kind;
          // Spec 415 A4 — a comparison may ask for the rule-based planner on a deployment that offers a model: the
          // same planner `selectPlanner` reaches when no provider is configured, chosen per run and named on the trace.
          if (selected.kind === 'rule-based' || input.variant?.plannerKind === 'rule-based') { plannerUsed = 'rule-based'; return withSpecialists(await RULE_BASED_PLANNER.plan(pin), playbook?.specialists, pin.tools); }
          // Spec 388 — THE ROUTE, decided here where the prompt is whole and the tools are known: the full
          // prompt's estimate against each offered provider's budget and this minute's spend. A provider that
          // carries the whole prompt gets it untrimmed; only when none does is the first one served a fitted prompt.
          const user = `Goal: ${pin.intent.goal}\nContext: ${JSON.stringify(pin.intent.context ?? {})}`;
          const route = await routeProvider(env as never, selectionProvider, { call: 'planner', estimatedTokens: estimatePromptTokens(withPlaybook, pin.tools, user) });
          trace.route = { ...(trace.route ?? { policy: routePolicy(env as never) }), meter: meterFor(env as never).kind, planner: route };
          const provider = route.provider ?? undefined;
          const chosen = provider && provider !== selected.kind ? selectPlanner(env as never, { systemPrompt: withPlaybook, maxTokens: ASK_PLANNER_MAX_TOKENS, provider, onUsage: notePlannerUsage }) : selected;
          plannerUsed = chosen.kind; plannerModel = chosen.model;
          const budget = plannerPromptBudget(env as never, provider ?? null);
          if (budget !== null) {
            const fitted = fitPlannerPrompt({ doctrine: doctrine?.text ?? null, contract: contractFor, examples: examplesFor }, pin.tools, user, budget);
            trace.promptBudget = { tokens: budget, estimated: fitted.estimated, trimmed: fitted.trimmed };
            trace.promptDigest = keccak256(toBytes(fitted.text));
            trace.examplesRendered = (fitted.text.match(/^- /gm) ?? []).length;
            return withSpecialists(await selectPlanner(env as never, { systemPrompt: fitted.text, maxTokens: ASK_PLANNER_MAX_TOKENS, ...(provider ? { provider } : {}), onUsage: notePlannerUsage }).planner.plan(pin), playbook?.specialists, pin.tools);
          }
          return withSpecialists(await chosen.planner.plan(pin), playbook?.specialists, pin.tools);
        },
      };
  // Spec 384 W3 — the campaign's selection binds the planned step to its provider and offer, whoever planned it.
  // Spec 416 — how long the PICK took (the model planner's call, or a selection arm's work), apart from the rest of the
  // turn: a comparison of selection approaches measures this, not the whole ask.
  const timedPlanner: Planner = { plan: async (pin) => { const t0 = Date.now(); try { return await planner.plan(pin); } finally { trace.selectionMs = (trace.selectionMs ?? 0) + (Date.now() - t0); } } };
  const offerBound: Planner = input.engagement
    ? { plan: async (pin) => { const p = await timedPlanner.plan(pin); return { ...p, ...bindSelectedOffer(p, input.engagement) }; } }
    : timedPlanner;
  // Spec 420 §2 — GOAL REGRESSION OVER SITUATIONS (`plan/regression`): the facts the harness knows this turn — the asker's
  // standing at the room, the room's roster when the room is an organization — and the ontology's capability transitions
  // check every act's preconditions before any signature is asked for, insert the reads that settle unknown ones, and name
  // the standing the asker lacks. The model still chose the outcome and the words; nothing here invents a party or an amount.
  const regressionOn = input.variant?.toggles?.['plan/regression'] === 'on' || (!input.variant?.toggles?.['plan/regression'] && ((env as { PLAN_REGRESSION_DEFAULT?: string }).PLAN_REGRESSION_DEFAULT ?? '').trim() === 'on');
  let regressionFacts: FactsV1 | null = null;
  const room = String(input.addressee ?? '').toLowerCase();
  const factsOnce: Promise<FactsV1> | null = regressionOn && room ? (async () => {
    const st = standingOnce ? await standingOnce.catch(() => undefined) : undefined;
    const atRoom = input.person && room === String(input.person).toLowerCase() ? 'self' as const : (st?.relation ?? undefined);
    const roomName = deps.nameOf ? await deps.nameOf(room).catch(() => null) : null;
    const aliases = new Set(['us', 'we', 'our', 'ours', 'ourselves', 'self', 'this organization', 'this org', 'the organization', 'the org', room, ...(roomName ? [roomName.toLowerCase(), roomName.toLowerCase().split('.')[0]!, roomName.toLowerCase().split('.')[0]!.replace(/-/g, ' ')] : [])]);
    const orgLike = ['org', 'team', 'church', 'circle', 'household', 'workspace'].includes(String(deps.addresseeKind ?? '').toLowerCase()) || /\.(org|team|church|circle|household|workspace)$/.test(roomName ?? '');
    const situations: Array<{ situation: string; of: string; in?: string; aliases?: readonly string[] }> = []; const known = new Set<string>();
    if (orgLike && deps.readSubjectRecord) {
      // THE SAME READ THE ROSTER TOOL MAKES (listings ∪ invitation records ∪ membership situations, standing-gated) — a raw
      // `directory.data` read saw three listings and missed every member who joined by invitation (2026-09-28). An INVITATION
      // row is not a membership (appr:invitationIsNotMembership); a member answers to their name, its first word, or a label.
      const roster = await membershipListInvoker(
        { ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}), ...(deps.standingContext ? { context: deps.standingContext } : {}), ...(deps.verifyStewardship ? { verifyStewardship: deps.verifyStewardship } : {}), ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}), ...(deps.readSubjectRecordStatus ? { readSubjectRecordStatus: deps.readSubjectRecordStatus } : {}), ...(deps.resolveName ? { resolveName: deps.resolveName } : {}), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}), ...(deps.survey ? { survey: deps.survey } : {}), ...(deps.readRecords ? { readRecords: deps.readRecords } : {}), ...(deps.addresseeKind !== undefined ? { addresseeKind: deps.addresseeKind } : {}) },
        room as Address, input.person,
      )(MEMBERSHIP_LIST_TOOL.id, { org: room }, { intent: input.intent, step: { toolId: MEMBERSHIP_LIST_TOOL.id, args: { org: room } }, index: 0, operationId: `${input.runRef ?? 'facts'}:regression-roster` } as never).catch(() => null) as { members?: Array<{ agent: string; name?: string | null; via?: string }> } | null;
      if (roster?.members) { known.add(SITUATION_MEMBERSHIP); known.add(SITUATION.MembershipInvitation); for (const r of roster.members) situations.push({ situation: r.via === 'invitation' ? SITUATION.MembershipInvitation : SITUATION_MEMBERSHIP, of: r.agent.toLowerCase(), in: room, ...(r.name ? { aliases: [r.name] } : {}) }); }
    }
    const facts: FactsV1 = { situations, known, room, isRoom: (w) => aliases.has(w), emptyMeansRoom: !!input.person && room !== String(input.person).toLowerCase(), standing: (agent) => (agent === room ? atRoom : input.person && agent === String(input.person).toLowerCase() ? 'self' : undefined) };
    regressionFacts = facts;
    return facts;
  })() : null;
  // Spec 420 §3 — THE OFFER BY STANDING (`offer/standing`: off · annotate · prune): before the planner sees the tools, each act
  // whose transition needs a standing at the room the asker lacks is either marked "not available to the person asking" (the
  // planner is told to say who could, not to plan it) or left out of the offer. No leading harness knows whether a principal
  // CAN authorize a step before proposing it; here the ontology says what standing an act needs and the record says what the
  // asker holds. Behaviour, never authority: the loop's own tool list is untouched and the verifier still judges every step.
  const offerMode = (input.variant?.toggles?.['offer/standing'] ?? ((env as { OFFER_STANDING_DEFAULT?: string }).OFFER_STANDING_DEFAULT ?? 'off').trim()) as 'off' | 'annotate' | 'prune';
  const offerByStanding = (tools: readonly ToolSpec[], facts: FactsV1): ToolSpec[] => {
    if (offerMode === 'off') return [...tools];
    const has = facts.standing(room);
    if (!has || has === 'self') return [...tools];
    const rank: Record<string, number> = { none: 0, member: 1, steward: 2, self: 3 };
    const out: ToolSpec[] = [];
    for (const t of tools) {
      const tr = t.capability?.id ? CAPABILITY_TRANSITIONS.find((x) => x.capability === t.capability!.id) : undefined;
      const need = tr?.requires.find((pre): pre is { standing: 'self' | 'steward' | 'member'; at: string } => 'standing' in pre && (pre.at === 'room' || pre.at === 'org' || pre.at === 'parent'));
      const lacks = need && rank[has]! < rank[need.standing]!;
      if (!lacks) { out.push(t); continue; }
      trace.regression = { ...(trace.regression ?? { inserted: [], gaps: [], violations: [], submissions: [], facts: { standingAtRoom: has, situations: facts.situations.length, known: [...facts.known] } }), offer: [...(trace.regression?.offer ?? []), { toolId: t.id, needs: need.standing, has, mode: offerMode }] };
      if (offerMode === 'prune') continue;
      out.push({ ...t, description: `${t.description} NOT AVAILABLE TO THE PERSON ASKING: it needs a ${need.standing} of this agent and they are a ${has} here — do not plan it; say that a ${need.standing} would have to do it.` });
    }
    return out;
  };
  // Spec 421 W1 — continuation (`plan/continuation`, env PLAN_CONTINUATION_DEFAULT; off until the ledger adopts it).
  const continuationOn = input.variant?.toggles?.['plan/continuation'] === 'on' || (!input.variant?.toggles?.['plan/continuation'] && ((env as { PLAN_CONTINUATION_DEFAULT?: string }).PLAN_CONTINUATION_DEFAULT ?? 'off').trim() === 'on');
  const boundPlanner0: Planner = factsOnce
    ? { plan: async (pin) => {
        const facts0 = await factsOnce;
        const p = await offerBound.plan({ ...pin, tools: offerByStanding(pin.tools, facts0) });
        const facts = await factsOnce;
        const done = completePlan(p, CAPABILITY_TRANSITIONS, facts);
        trace.regression = { ...(trace.regression ?? {}), inserted: done.inserted, gaps: done.gaps.map(({ index, toolId, because }) => ({ index, toolId, because })), violations: done.violations, submissions: done.submissions, facts: { standingAtRoom: facts.standing(room) ?? 'unknown', situations: facts.situations.length, known: [...facts.known] } };
        return done.plan;
      } }
    : offerBound;
  const boundPlanner: Planner = { plan: async (pin) => {
    const p = await boundPlanner0.plan(pin);
    if (pin.continuation) trace.continuations = [...(trace.continuations ?? []), { steps: p.steps.map((st) => ({ toolId: st.toolId })) }];
    return p;
  } };
  const kind = input.plan ? 'supplied' : selected.kind;
  const trace: PlannerTraceV1 = {
    planner: plannerUsed, ...(selected.model ? { model: selected.model } : {}), toolsExposed: [], recalledTurns: input.conversation?.turns.length ?? 0, playbook: playbook ? { archetypeId: playbook.archetypeId, archetypeVersion: playbook.archetypeVersion, digest: playbook.digest } : null,
    promptDigest: keccak256(toBytes(withPlaybook)), examplesRendered: (examples.match(/^- /gm) ?? []).length,
    ...(doctrine ? { instructionsRendered: { chars: doctrine.chars, of: doctrine.of } } : {}),
    admission: [], plan: [], bindings: [],
    ...(input.surface || input.channel ? { surface: { ...(input.surface?.realm?.kind ? { realm: input.surface.realm.kind } : {}), ...(input.surface?.capabilities ? { capabilities: input.surface.capabilities.length } : {}), ...(input.channel ? { channel: input.channel } : {}) } } : {}),
  };
  const recordStructured = (role: 'judge' | 'structured', stepRef?: string) => (c: StructuredCallRecordV1) => { (trace.structuredCalls ??= []).push({ role, ...(stepRef ? { stepRef } : {}), ...c }); };
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
  // Spec 387 W2 — THE ADDRESSEE'S OWN CATALOG, when its name records publish one (`atl:mcpEndpoint`). Listed
  // only then (fail closed), described by the playbook's contract when it has one, and answered by the
  // catalog itself: public metadata with a named source, never a record of ours.
  mark('planner-built');
  const catalog = await timed('prepare:catalog', () => catalogOnce);
  const served = catalog ? await timed('prepare:catalog-profile', () => servedOnce) : null;
  mark('catalog');
  const catalogTools = catalog && servesProfile(served, CATALOG_MCP_TOOL_NAMES) ? CATALOG_TOOLS.map((t) => mergeContractTool(t, playbook?.tools?.[t.id])) : [];
  // The people-group catalog (ap-people-group-catalog/v1) on the same record — its own tools, never the content catalog's.
  const peopleGroupTools = catalog && servesProfile(served, PEOPLE_GROUP_MCP_TOOL_NAMES) ? PEOPLE_GROUP_TOOLS.map((t) => mergeContractTool(t, playbook?.tools?.[t.id])) : [];
  // Spec 404 — the addressee's OWN external MCP connectors: compiled from its records, never narrowed by the playbook
  // (they are the holder's, not the archetype's); a read is her standing, an act her mandate at risk high.
  // Remembered a minute per holder (`run-memo.ts`): a survey and a read of the holder's vault, 1.2–2 s on every ask
  // for a list that changes when she attaches a server at her Home. The records carry no token (`hasToken` only).
  const mcpConnectors = !screenNames((id) => isMcpTool(id) || id === MCP_CONNECTORS_LIST) ? [] : await timed('prepare:mcp-connectors', () => remembered(`mcp-connectors:${String(input.addressee ?? '').toLowerCase()}`, () => mcpConnectorsOf(deps, input.addressee ? String(input.addressee) : undefined)));
  const mcpTools = mcpConnectors.length ? [...mcpConnectorTools(mcpConnectors), (playbook?.tools?.[MCP_CONNECTORS_LIST] ? mergeContractTool(MCP_CONNECTORS_LIST_TOOL, playbook.tools[MCP_CONNECTORS_LIST]!) : MCP_CONNECTORS_LIST_TOOL)] : (playbook?.tools?.[MCP_CONNECTORS_LIST] && deps.survey ? [mergeContractTool(MCP_CONNECTORS_LIST_TOOL, playbook.tools[MCP_CONNECTORS_LIST]!)] : []);
  // A QUESTION OF JUDGEMENT over material the message carried (`playbook.answer`). Listed ONLY when the
  // message names a skill and the addressee's profile publicly advertises it — an agent answers exactly
  // the questions it has said it answers — and when there is a model to answer with. Neither ⇒ absent.
  const material: PlaybookMaterial | null = input.material && typeof input.material.skill === 'string'
    ? { skill: input.material.skill, input: input.material.input, ...(typeof (input.material.input as { question?: unknown } | undefined)?.question === 'string' ? { question: (input.material.input as { question: string }).question } : {}), ...(input.material.answer && typeof input.material.answer === 'object' ? { answer: input.material.answer as Record<string, string> } : {}) }
    : null;
  const advertised = material && input.addressee && deps.advertisedCapabilities ? await timed('prepare:advertised', () => remembered(`advertised:${String(input.addressee).toLowerCase()}`, () => deps.advertisedCapabilities!(input.addressee!).catch(() => [] as string[]))) : [];
  mark('advertised');
  const playbookAnswer = playbookAnswerAvailable({ call: structuredCallFor(env as never, input.provider), material, advertised }) ? [PLAYBOOK_ANSWER_TOOL] : [];
  // Spec 415 A4 — the playbook's INSTRUCTION SKILLS (a tool per skill, answered under its own body): offered only where
  // the corpus is bound, because a tool that cannot run is not listed.
  const instructionTools = env.SKILLS_MCP ? instructionSkillTools(playbook) : [];
  // Spec 421 — A CONNECTOR SHE HAS NOT CONNECTED IS NOT A PLACE TO LOOK. The planner answered "who wrote to me about the
  // rehearsal" by searching Gmail, which alice never connected — "Gmail is not connected", and the message she meant sat in
  // her Home inbox. The read tools stay offered (asked about Gmail by name, the honest answer is "connect it"), with their
  // description saying they are not connected. Read at the person's own agent only, once per turn; a status that cannot be
  // read leaves the tools as they are (the invoker still says "not connected" if it is not).
  const person = input.person ? String(input.person).toLowerCase() : '';
  const atOwnAgent = !!person && person === String(input.addressee ?? '').toLowerCase();
  const googleConnected = atOwnAgent && screenNames((id) => /^(gmail|drive|calendar)\./.test(id)) ? await remembered(`google-connected:${person}`, async () => {
    const [mail, drive, cal] = await Promise.all((['google-gmail', 'google-drive', 'google-calendar'] as const).map((p) => connectorStatus(env as never, person as Address, p).then((x) => x.connected).catch(() => null)));
    return { 'google-gmail': mail, 'google-drive': drive, 'google-calendar': cal } as Record<string, boolean | null>;
  }).catch(() => null) : null;
  const providerOf = (id: string): string | null => id.startsWith('gmail.') ? 'google-gmail' : id.startsWith('drive.') ? 'google-drive' : id.startsWith('calendar.') ? 'google-calendar' : null;
  const unlessConnected = (t: ToolSpec): ToolSpec => {
    const pv = providerOf(t.id);
    if (!pv || !googleConnected || googleConnected[pv] !== false) return t;
    const name = pv === 'google-gmail' ? 'Gmail' : pv === 'google-drive' ? 'Google Drive' : 'Google Calendar';
    return { ...t, description: `NOT CONNECTED — ${name} is not connected for this person, so it holds nothing to find: never search it for what she refers to (her messages are in her Home inbox). Use it only if she names ${name}, to tell her to connect it. ${t.description}` };
  };
  const tools = [
    ...playbookAnswer,
    ...instructionTools,
    ...scopedActionTools(input.surface, playbook), ...catalogTools, ...peopleGroupTools, ...mcpTools, ...ASK_DISCOVERY_TOOLS,
    ...(kbQuestionAvailable({ call: structuredCallFor(env as never, input.provider) }) ? [KB_QUESTION_TOOL] : []),
    // Spec 413 — passages from the public tier (released shelf works + agent descriptions), where the estate binds an index.
    ...(kbModeOf(env as never, input.variant) !== 'off' ? [KB_RETRIEVE_TOOL] : []),
    // Spec 379 — an outside A2A 1.0 agent may ANSWER inside a run; its words are an observation.
    EXTERNAL_AGENT_TOOL,
    // Spec 397 W2 — the enterprise behind this agent: FIND in the registry (only where one is configured — a tool that
    // cannot run is not listed), ENGAGE a discovered agent as the asker (the routed ask, the target planning for itself).
    // OFFERED ONLY WHERE THE PLAYBOOK SAYS SO (the person/org stewards carry the contracts; a content catalog does not):
    // offered to every agent, a publisher's planner picked `engagement.agent.invoke` for "a study on justification"
    // and asked which agent "justification" was (seen live) — the capability model generates the surface, never a list.
    ...(env.ARD_REGISTRY_ORIGIN && playbook?.tools?.[DISCOVERY_FIND_TOOL.id] ? [mergeContractTool(DISCOVERY_FIND_TOOL, playbook.tools[DISCOVERY_FIND_TOOL.id])] : []),
    ...(playbook?.tools?.[ENGAGEMENT_INVOKE_TOOL.id] ? [mergeContractTool(ENGAGEMENT_INVOKE_TOOL, playbook.tools[ENGAGEMENT_INVOKE_TOOL.id])] : []),
    ...(playbook?.tools?.[DISCOVERY_INSPECT_TOOL.id] ? [mergeContractTool(DISCOVERY_INSPECT_TOOL, playbook.tools[DISCOVERY_INSPECT_TOOL.id])] : []),
    // Spec 397 / 341 §5.1b — what the person has been invited to, from their own inbox (their playbook offers it).
    ...(playbook?.tools?.[INVITATIONS_RECEIVED_TOOL.id] ? [mergeContractTool(INVITATIONS_RECEIVED_TOOL, playbook.tools[INVITATIONS_RECEIVED_TOOL.id])] : []),
    // Spec 427 §5.3 — the roles she holds, each organization answering for its own record of her (her playbook offers it).
    ...(playbook?.tools?.[PERSON_ROLES_TOOL.id] ? [mergeContractTool(PERSON_ROLES_TOOL, playbook.tools[PERSON_ROLES_TOOL.id])] : []),
    // Gap register B6a — what is waiting on her (the bell, asked): parked runs + invitations, from her own records.
    ...(playbook?.tools?.[WAITING_LIST_TOOL.id] ? [mergeContractTool(WAITING_LIST_TOOL, playbook.tools[WAITING_LIST_TOOL.id])] : []),
    // Spec 422 §9.1 — what signs for her / how protected her home is (the person-steward playbook offers them).
    ...SECURITY_READ_TOOLS.flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id])] : [])),
    // Spec 400 W1 — the agent's own inbox since a cursor (the runtime-member playbook offers it; a person's may too).
    ...(playbook?.tools?.[INBOX_LIST_TOOL.id] ? [mergeContractTool(INBOX_LIST_TOOL, playbook.tools[INBOX_LIST_TOOL.id])] : []),
    ...(playbook?.tools?.[WORK_SEARCH_TOOL.id] ? [mergeContractTool(WORK_SEARCH_TOOL, playbook.tools[WORK_SEARCH_TOOL.id])] : []),
    // Spec 401 C1 — contacts (the person-steward playbook offers them).
    ...(playbook?.tools?.[CONTACT_INVITE_TOOL.id] ? [mergeContractTool(CONTACT_INVITE_TOOL, playbook.tools[CONTACT_INVITE_TOOL.id])] : []),
    ...(playbook?.tools?.[CONTACT_LIST_TOOL.id] ? [mergeContractTool(CONTACT_LIST_TOOL, playbook.tools[CONTACT_LIST_TOOL.id])] : []),
    ...(playbook?.tools?.[CONTACT_REMOVE_TOOL.id] ? [mergeContractTool(CONTACT_REMOVE_TOOL, playbook.tools[CONTACT_REMOVE_TOOL.id])] : []),
    // Spec 380 — one member of an organization, asked through their own agent (fan-out over the roster).
    MEMBER_CONSULT_TOOL,
    // Spec 384 — ask other agents whether they would take this work, and on what terms (an offer is never accepted here).
    ENGAGEMENT_PROBE_TOOL,
    // The asker's OWN records (spec 356 W2). Needs a model to choose from the survey AND the survey seam
    // itself — absent either, it is not listed rather than listed and broken.
    ...(vaultQuestionAvailable({ call: structuredCallFor(env as never, input.provider) }, deps) ? [VAULT_QUESTION_TOOL] : []),
    MEMBERSHIP_LIST_TOOL,
    // What became of an organization's invitations — accepted, waiting, declined, expired.
    ...(deps.survey && deps.readRecords ? [INVITATIONS_LIST_TOOL] : []),
    // What the asker is PART OF, by agent type (ADR-0061) — their own links, private tier.
    ...(deps.readSubjectRecord ? [AFFILIATIONS_LIST_TOOL] : []),
    // Spec 371 — the balance read: what an account holds now, on chain, in the person's unit.
    ...(deps.valueHeld ? [BALANCE_READ_TOOL] : []),
    // Spec 419 — what an agent holds (public chartered-under edges).
    ...(deps.charteredAgents ? [HOLDINGS_READ_TOOL] : []),
    // Spec 370 P4 — the organization's work, read through the same record the Home's Work surface reads.
    ...(deps.readSubjectRecord ? COORDINATION_READ_TOOLS : []),
    // The person's own access audit — informational, always available on their own surface.
    ...(deps.readGrants ? [ACCESS_LIST_TOOL] : []),
    ...(deps.auditGrants && playbook?.tools?.[ACCESS_AUDIT_TOOL.id] ? [mergeContractTool(ACCESS_AUDIT_TOOL, playbook.tools[ACCESS_AUDIT_TOOL.id])] : []),
    ...GITHUB_TOOLS.filter((t) => !GITHUB_ACTS.has(t.id)).flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id]!)] : [])),
    ...CALENDAR_TOOLS.filter((t) => !CALENDAR_ACTS.has(t.id)).flatMap((t) => (playbook?.tools?.[t.id] ? [unlessConnected(mergeContractTool(t, playbook.tools[t.id]!))] : [])),
    ...MAIL_DRIVE_TOOLS.filter((t) => !MAIL_DRIVE_ACTS.has(t.id)).flatMap((t) => (playbook?.tools?.[t.id] ? [unlessConnected(mergeContractTool(t, playbook.tools[t.id]!))] : [])),
    // Spec 398 §9 — the workspace's build runs, read wherever the playbook carries the contract.
    ...BUILD_TOOLS.filter((t) => !BUILD_ACTS.has(t.id)).flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id]!)] : [])),
    // Spec 402 W5a — a public page read as evidence, wherever the playbook carries the contract.
    ...WEB_TOOLS.flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id]!)] : [])),
    // Spec 405 — the addressee's own Library, read as evidence, wherever the playbook carries the contracts.
    // The W5 acts (save / visibility / publish) are ACTION tools above — listed here too they reached the planner twice,
    // and Gemini refused the whole offer ("Duplicate function declaration found: library_file_save", live 2026-09-21).
    ...(deps.readSubjectRecord ? LIBRARY_TOOLS.filter((t) => !LIBRARY_ACTS.has(t.id)).flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id]!)] : [])) : []),
    // Spec 403 W3 — a web search as evidence, wherever the playbook carries the contract.
    ...WEB_SEARCH_TOOLS.flatMap((t) => (playbook?.tools?.[t.id] ? [mergeContractTool(t, playbook.tools[t.id]!)] : [])),
    // The person's own reads, under their CONTRACTS when the playbook carries them (the result app a contract names
    // rides on the merged tool; spec 402 W4) — the built-in spec otherwise.
    ...(deps.readSubjectRecord ? [PROFILE_READ_TOOL, HOUSEHOLD_READ_TOOL, MEMORY_LIST_TOOL].map((t) => (playbook?.tools?.[t.id] ? mergeContractTool(t, playbook.tools[t.id]!) : t)) : []),
    ...(deps.listTriggers ? ROUTINE_TOOLS.filter((t) => t.id === ROUTINE_LIST).map((t) => (playbook?.tools?.[t.id] ? mergeContractTool(t, playbook.tools[t.id]!) : t)) : []),
    ...(deps.readSubjectRecord ? PREFERENCES_TOOLS.filter((t) => t.id === PREFERENCES_GET).map((t) => (playbook?.tools?.[t.id] ? mergeContractTool(t, playbook.tools[t.id]!) : t)) : []),
    UNSUPPORTED_TOOL,
    // Spec 418 — planned only by the skill stage (see ASK_CLARIFY_TOOL); filtered from the planner's view below.
    ...(Object.keys(instructionSourcesOf(playbook)).length ? [ASK_CLARIFY_TOOL] : []),
  ];
  // ONE TOOL, ONE ENTRY. A family listed as both an act and a read reaches the planner twice, and a provider refuses the
  // whole offer for it (Gemini: "Duplicate function declaration"), so every ask on the agent fails — said here, once,
  // with the ids, instead of surfacing as a planner error on an unrelated question.
  {
    const seen = new Set<string>(); const twice = new Set<string>();
    for (const t of tools) { if (seen.has(t.id)) twice.add(t.id); seen.add(t.id); }
    if (twice.size) throw new Error(`harness offer lists a tool twice: ${[...twice].join(', ')} — an act must not also be in the read list`);
  }
  const harnessLocal = harnessInvoker(deps, env, presentedList, input.mcpInvoke, input.person, input.session, input.surface, input.addressee, playbook);
  // THE ADDRESSEE'S OWN MEMORY of a skill family, in its own vault — read for advice (memoised a minute, like
  // its playbook), written by a review (and the memo dropped, so the next hand's advice sees this round).
  const memoryOwner = input.addressee ? String(input.addressee).toLowerCase() : null;
  const recall = (recordType: string) => remembered(`memory:${memoryOwner}:${recordType}`, () => deps.readSubjectRecord!(memoryOwner!, recordType).catch(() => null));
  // STARTED NOW, READ LATER. The vault read takes most of a second and nothing between here and the answering
  // step depends on it, so it runs beside the gates instead of after them — the clock at a card table is the
  // asker's, and a review reads fresh anyway.
  const prefetched = material && !/\.review$/i.test(material.skill) && memoryOwner && deps.readSubjectRecord ? { recordType: memoryRecordFor(material.skill), value: recall(memoryRecordFor(material.skill)) } : null;
  const memory = memoryOwner && deps.readSubjectRecord && deps.writeSubjectRecord
    ? {
        read: (recordType: string, fresh?: boolean) => fresh ? deps.readSubjectRecord!(memoryOwner, recordType).catch(() => null) : prefetched?.recordType === recordType ? prefetched.value : recall(recordType),
        write: async (recordType: string, record: unknown) => { const out = await deps.writeSubjectRecord!(memoryOwner, recordType, record); await forget(`memory:${memoryOwner}:${recordType}`); return out; },
      }
    : undefined;
  // THE PERSON'S STUDY, under her grant (`card-room.ts`). The addressee is a coach SERVICE and the asker is
  // the person's own agent presenting the grant `runAgentAsk` verified; the records are read from HER vault
  // (the grant's delegator), never the service's, and the one write is a note appended to her cabinet. The
  // four reads start together — they are independent, and a consultation is on the table's clock.
  const study = input.study && studyOnce && deps.readSubjectRecord && material
    ? (() => {
        const owner = input.study.owner;
        const loaded = studyOnce;
        const noteRecord = (input.study.records ?? studyRecords(String(material.skill ?? 'poker.advise'))).note;
        return {
          load: () => loaded,
          coach: input.study.delegate,
          note: input.study.appends.includes(noteRecord) && deps.writeSubjectRecord
            ? async (text: string, extra?: { hand?: number; scope?: string; leak?: { pattern: string; count: number; of: number; cost?: number; metric?: string }; change?: string }) => {
                const by = deps.nameOf && input.addressee ? (await deps.nameOf(String(input.addressee)).catch(() => null)) ?? String(input.addressee) : String(input.addressee ?? '');
                const prev = await deps.readSubjectRecord!(owner, noteRecord).catch(() => null);
                return deps.writeSubjectRecord!(owner, noteRecord, appendNote(prev, { by, at: new Date().toISOString(), text, ...(extra?.hand ? { hand: extra.hand } : {}), ...(extra?.scope ? { scope: extra.scope } : {}), ...(extra?.leak ? { leak: extra.leak } : {}), ...(extra?.change ? { change: extra.change } : {}) }));
              }
            : undefined,
        };
      })()
    : undefined;
  const answerInvoke = playbookAnswer.length
    ? playbookAnswerInvoker({ call: structuredCallFor(env as never, input.provider, { onCall: recordStructured('structured') }), instructions: playbook?.instructions ?? null, material, advertised, agentName: deps.nameOf && input.addressee ? await deps.nameOf(String(input.addressee)).catch(() => null) : null, ...(memory ? { memory } : {}), ...(study ? { study } : {}) })
    : null;
  // Spec 416 §4h — the model an instruction skill answers with (`skill-selection/answer-model`), and, under
  // `quality/judge: pairwise`, BOTH answers in parallel judged side by side (both orders, neutral labels): the run returns
  // its own model's answer; the other answer and the judgment are a comparison's instrument (numbers on the trace only).
  // Spec 418 — the answer tier: default · light · strong (a stronger model, measured side by side before any use).
  type AnswerTier = 'default' | 'light' | 'strong' | 'minimal';
  // Spec 418 A1 — the deployment's answer tier (`SKILL_ANSWER_MODEL_DEFAULT`, adopted `minimal` on effort-a1); a comparison names its own.
  const envTier = ((env as { SKILL_ANSWER_MODEL_DEFAULT?: string }).SKILL_ANSWER_MODEL_DEFAULT ?? '').trim();
  const ownTier: AnswerTier = ((input.variant?.toggles?.['skill-selection/answer-model'] as AnswerTier | undefined) ?? (['light', 'strong', 'minimal'].includes(envTier) ? envTier as AnswerTier : 'default'));
  const otherTier: AnswerTier = ((input.variant?.toggles?.['quality/against'] as AnswerTier | undefined) ?? (ownTier === 'light' ? 'default' : 'light'));
  const answerLight = ownTier === 'light';
  const agentNameForSkill = instructionTools.length && deps.nameOf && input.addressee ? await deps.nameOf(String(input.addressee)).catch(() => null) : null;
  // Spec 418 A1 — stream the answer (`answer/stream` on, or the deployment's ANSWER_STREAM_DEFAULT); never for the
  // side-by-side's second answer. Drafts go to the progress stream; the first words' time goes on the trace.
  const streamOn = ((input.variant?.toggles?.['answer/stream'] ?? ((env as { ANSWER_STREAM_DEFAULT?: string }).ANSWER_STREAM_DEFAULT?.trim() || 'off')) === 'on');
  const applyWith = (tier: AnswerTier, recorded: boolean) => skillApplyInvoker({ call: undefined, callFor: (stepRef) => structuredCallFor(env as never, answerProvider, { ...(recorded ? { onCall: recordStructured('structured', stepRef) } : {}), ...(tier !== 'default' ? { tier } : {}) }),
    ...(streamOn && recorded ? {
      streamFor: (stepRef: string) => textStreamFor(env as never, answerProvider, { onCall: recordStructured('structured', stepRef), ...(tier !== 'default' ? { tier } : {}) }),
      onDraft: (stepRef: string, draft: string) => input.onProgress?.({ type: 'AnswerDraft', stepRef, said: 'Writing the answer…', draft: draft.slice(-6000) }),
      onFirstWords: (_stepRef: string, ms: number) => { if (trace.answerFirstWordsMs === undefined) { trace.answerFirstWordsMs = ms; trace.answerFirstWordsAt = Date.now(); } },
    } : {}), ...(input.variant?.toggles?.['skill-selection/answer'] === 'off' ? { pickOnly: true } : {}), sources: instructionSourcesOf(playbook), readSkill: skillReaderFor(env.SKILLS_MCP!), agentName: agentNameForSkill });
  const pairwise = input.variant?.toggles?.['quality/judge'] === 'pairwise';
  const skillInvoke: ToolInvoker | null = !instructionTools.length ? null : !pairwise ? applyWith(ownTier, true) : async (toolId, args, ctx) => {
    const [own, other] = await Promise.all([applyWith(ownTier, true)(toolId, args, ctx), applyWith(otherTier, false)(toolId, args, ctx).catch(() => null)]);
    const a = (x: unknown) => (x && typeof x === 'object' && typeof (x as { answer?: unknown }).answer === 'string' ? (x as { answer: string }).answer : null);
    const ownA = a(own), otherA = a(other);
    const card = instructionTools.find((t) => t.id === toolId)?.description ?? toolId;
    const qcall = structuredCallFor(env as never, judgeProvider);
    if (ownA && otherA && qcall) {
      const pref = await judgeAnswerPreference({ request: String(args.question ?? input.intent.goal), skillCard: card, answers: { [ownTier]: ownA, [otherTier]: otherA } }, qcall as never).catch(() => null);
      if (pref) trace.pairwise = { judge: pref.judge.name, preference: pref.preference, ms: pref.ms, ...(pref.error ? { error: pref.error.slice(0, 200) } : {}) };
    }
    return own;
  };
  const instructionIds = new Set(instructionTools.map((t) => t.id));
  const localInvoke: ToolInvoker = async (toolId, args, ctx) => {
    mark(`invoke:${toolId}:start`);
    try { return await (answerInvoke && toolId === PLAYBOOK_ANSWER_TOOL.id ? answerInvoke(toolId, args, ctx) : skillInvoke && instructionIds.has(toolId) ? skillInvoke(toolId, args, ctx) : harnessLocal(toolId, args, ctx)); }
    finally { mark(`invoke:${toolId}:end`); }
  };
  mark('tools-listed');
  trace.toolsExposed = tools.map((t) => t.id);
  // Spec 367 §5 — THE EXECUTION BINDING on every receipt: the intent digest, the person, the agent the step
  // is about, the resource and authority it names, the outcome class it was expected to establish, its
  // stable operation identity, and where each party came from. Evidence only; no gate reads it.
  const intentDigest = keccak256(toBytes(JSON.stringify({ goal: input.intent.goal, addressee: input.addressee ?? null, asker: input.person ?? null })));
  // Spec 376 — which steps were HANDED OFF, and to whose run: the receipt's `delegatedTo`.
  const handedOff = new Map<string, { agent: Address; runRef: string; childRef: string }>();
  // Spec 383 W2 — THE STANDING THIS RUN ACTS UNDER, derived once and named on every receipt: for whom, by
  // whom, and — for a steward — the stewardship wire the receiver verified, by digest. A routed act's
  // receipt at the organization then says "for Missio Nexus, under steward wire 0x…" without anyone
  // trusting the asker's word for it. Evidence only: the mandate chain is what the verifier judged.
  let standingLink: ExecutionBindingV1['standing'] | undefined;
  if (standingOnce) standingLink = await timed('prepare:standing', () => standingOnce);
  mark('standing');
  const bindingFor = (rs: ResolvedStep): ExecutionBindingV1 => {
    const sourceOf = (v: unknown): NonNullable<ExecutionBindingV1['argSources']>[string] => {
      const low = String(v ?? '').toLowerCase();
      const hit = [...resolved.values()].find((r) => r.agent.toLowerCase() === low);
      if (!hit) return 'said';
      return hit.via === 'context' ? 'context' : hit.via === 'standing' ? 'standing' : hit.ruleId ? 'decision' : hit.hint?.startsWith('remembered') ? 'memory' : hit.ownedBy ? 'disclosed' : /^0x[0-9a-f]{40}$/i.test(hit.raw) ? 'said' : 'resolver';
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
      ...((input.inResponseTo || handedOff.get(rs.stepRef))
        ? { correlation: { ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}), ...(handedOff.get(rs.stepRef) ? { delegatedTo: { agent: handedOff.get(rs.stepRef)!.agent, runRef: handedOff.get(rs.stepRef)!.runRef } } : {}) } }
        : {}),
      ...(standingLink ? { standing: standingLink } : {}),
      // Spec 383 — the actor context of this hop (ADR-0052): for whom, who started it, whose harness ran it.
      ...(input.addressee ? { actor: { ...(input.via ? { via: input.via } : {}), ...(input.person ? { rootPrincipal: input.person.toLowerCase() } : {}), ...(input.inResponseTo?.agent ? { originatingAgent: input.inResponseTo.agent.toLowerCase() } : input.person ? { originatingAgent: input.person.toLowerCase() } : {}), actingAgent: input.addressee.toLowerCase() } } : {}),
    };
  };
  // THE REALM'S TYPED SUFFIX, whether or not a surface declared it (spec 367 §7 / 371 §2.1). A person's
  // own agent is `me`; any other addressee's typed name says what it is. Without this a probe or a peer
  // that sends no `surface` left "create a service agent" asking "who is the parent?" inside the person's
  // own realm, while the same words with the Home's surface filled it — one fill, one answer.
  // The TYPED NAME decides, never who is asking: `alice.me` is a person's realm, `missio-nexus.org` an
  // organization's, `alice3.treasury` an account's. (A first cut read "the addressee is the asker ⇒ me",
  // which is true for a person and false for every agent that asks on its own behalf — a trigger firing
  // inside an ORG would have called its realm a person's.)
  const realmSuffix: string | undefined = input.addressee && deps.nameOf
    ? (((await deps.nameOf(input.addressee).catch(() => null)) ?? '').split('.').pop() || undefined)
    : undefined;
  mark('runIntent-start');
  // Spec 413 W3 — the playbook's declared retrieval guidance, spent as ONE pre-plan `kb.retrieve` step where the estate
  // enables it (`KB_RETRIEVAL=playbook`). The query is the person's own sentence; the topics are the playbook's, sent as
  // declared scope and echoed on the receipt. The passages ground the composed answer; no planner reads them.
  const goalText = String((input.intent as { goal?: unknown }).goal ?? '').trim();
  // A rowsOnly ask composes nothing (the screen renders the rows), so it has no answer to ground: no retrieval — the bell's
  // minute-by-minute invitations read spent an embedding + a vector search on every poll for passages nothing read.
  const retrieval = !input.rowsOnly && kbModeOf(env as never, input.variant) === 'playbook' && playbook?.retrievalQueries?.length && goalText && tools.some((t) => t.id === KB_RETRIEVE_TOOL.id)
    ? { toolId: KB_RETRIEVE_TOOL.id, args: { query: goalText, topics: playbook.retrievalQueries },
        // 416 §4g — the passages ground a COMPOSED answer; a plan whose every step renders its own sentence (an
        // instruction skill's answer) needs none, so the retrieval is decided on the plan and skipped then.
        onlyIf: (plan: { steps: ReadonlyArray<{ toolId: string }> }) => !plan.steps.every((st) => !!tools.find((t) => t.id === st.toolId)?.answer) }
    : null;
  if (input.comparison || input.variant) trace.comparison = true;
  // A SCREEN'S READ OF A CAPABILITY THIS AGENT DOES NOT HAVE (the Today calendar card on a persona whose archetype
  // never exposes calendar.events.list) is not a failed run and not a denial: the honest answer to the screen is
  // "not offered here", one row per step, and nothing runs. Only a rowsOnly supplied plan — a screen — gets this; a
  // conversational ask never sets rowsOnly and still meets admission's refusal in words.
  const unoffered = !!(input.plan && input.rowsOnly && !input.resume && input.plan.steps.length
    && input.plan.steps.every((st) => !tools.some((t) => t.id === st.toolId)));
  const result: RunResult = unoffered ? {
    outcome: 'completed', runRef: input.runRef ?? 'run', receipts: [], plan: { steps: input.plan!.steps.map((st) => ({ toolId: st.toolId, args: st.args ?? {}, ...(st.id ? { id: st.id } : {}) })) },
    steps: input.plan!.steps.map((st, i) => ({ step: { toolId: st.toolId, args: st.args ?? {} }, ok: true, stepRef: st.id ?? `s${i}`, result: { connected: false, offered: false, refused: `this agent does not offer ${st.toolId}` } })),
    result: { connected: false, offered: false },
  } : await runIntent(input.intent, {
    planner: boundPlanner, tools, bindingFor,
    ...(continuationOn && !input.plan ? { continuation: { max: 2 } } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(retrieval ? { retrieval } : {}),

    // Spec 366 R1 — a step ABOUT ANOTHER AGENT is answered by that agent. The tool declares which argument
    // names its subject; the resolver has already turned the person's words into an address in THEIR
    // tier; if that address is not the agent addressed, the step goes to the subject's own harness with
    // the asker's session, and what comes back is the subject's own answer (or its refusal, in its
    // words). The local invoker never reads another principal's records for a routed step.
    // Spec 374 §1 — a step routed to another agent is JUDGED there: no mandate is asked of the asker here.
    authorityJudgedElsewhere: (rs) => routedSubjectFor(rs.tool, rs.args, input.addressee),
    invoke: async (toolId, args, ctx) => {
      // Spec 370 P6 — on a replay nothing runs: the record answers, or refuses a step it never held.
      if (input.replayOf) return replayingInvoker(input.replayOf)(toolId, args, ctx);
      const tool = tools.find((t) => t.id === toolId);
      // Spec 376 — A HAND-OFF. The step names an executor that is not this harness: the step runs THERE,
      // under a child mandate attenuated from the mandate this run presented. Minted here by this
      // harness's own Smart Agent (the parent's delegate), bound to the sub-intent, sent with the step;
      // verified where it is used; recorded here as handed off, never as run.
      const executor = typeof ctx.step.executor === 'string' && /^0x[0-9a-fA-F]{40}$/.test(ctx.step.executor) ? (ctx.step.executor.toLowerCase() as Address) : null;
      if (executor && executor !== String(input.addressee ?? '').toLowerCase()) {
        if (!deps.handoffTo || !deps.signAsHarness) throw new Error(`this agent cannot hand a step to ${executor} — hand-offs are not wired here`);
        const stepRefH = ctx.step.id ?? `s${ctx.index}`;
        const enforcersH = harnessEnforcers(env);
        const chainId = Number(env.CHAIN_ID);
        const dm = env.DELEGATION_MANAGER as Address;
        // THE PARENT: the mandate this run presented for this step — the same one the verifier judged.
        const parentP = presentedList.length > 1 && tool?.capability?.id === 'treasury.payment.execute'
          ? selectByPayee({ capability: { id: tool.capability.id }, args }, presentedList, enforcersH.payment)
          : (presentedList[0] ?? null);
        if (!parentP) throw new Error('a hand-off attenuates a mandate this run holds, and none was presented for this step');
        const parent = parentP.wire as Delegation;
        const type = tool?.capability?.id === 'treasury.payment.execute' ? PAYMENT_RAR_TYPE : CAPABILITY_RAR_TYPE;
        const parentReq = readMandate(parent, type, enforcersH as never);
        if (!parentReq) throw new Error('the presented delegation carries no intent binding this harness can read — a standing capability cannot parent a child mandate');
        // THE CHILD IS BOUND TO THE SAME INTENT the person signed for (spec 336 §8.3: authority attenuates
        // within one intent, never onto a new one — `baseIsSubset` refuses a different digest). It narrows
        // the WINDOW to minutes; the step's own nonce (intent digest + step ref) makes it single-use on
        // chain. The specialist's run is admitted against the parent's intent, verbatim.
        const stepWords = `${tool ? toolWordsFor(tool) : toolId}: ${Object.entries(args).map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}`;
        const subIntent = { goal: input.intent.goal, ...(input.intent.context ? { context: input.intent.context as Record<string, unknown> } : {}) };
        const now = Math.floor(Date.now() / 1000);
        const requirement: MandateRequirementV1 = {
          ...parentReq,
          validAfter: Math.max(parentReq.validAfter ?? 0, now - 60),
          validUntil: Math.min(parentReq.validUntil, now + 600),
        };
        let saltH = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) saltH = (saltH << 8n) | BigInt(b);
        const derived = deriveMandate({ parent, parentRequirement: parentReq, requirement, grantee: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address, enforcers: enforcersH as never, chainId, delegationManager: dm, salt: saltH });
        if (!derived.ok) throw new Error(`the child mandate could not be derived: ${derived.reason}`);
        const child: Delegation = { ...derived.delegation, signature: await deps.signAsHarness(derived.digest) };
        const childRef = derived.digest;
        const wireOf = (d: Delegation) => ({ ...d, salt: d.salt.toString() });
        const parentAgent = String(input.addressee ?? input.person ?? '').toLowerCase() as Address;
        const operationId = `${input.runRef ?? 'run'}:${stepRefH}`;
        handedOff.set(stepRefH, { agent: executor, runRef: '', childRef });
        // The parent run's SUPPLIED inputs for this step — the second party's approval above all — travel
        // with the step, re-keyed to the one step the specialist runs: an approval given for the person's
        // mandate is inherited by the child derived from it (the executor's port judges it over the parent).
        const carried = inputsFor(ctx.supplied, stepRefH).map((x) => ({ ...x, stepRef: 's0' }));
        const answer = await deps.handoffTo({ executor, intent: subIntent, plan: { steps: [{ toolId, args, id: 's0' }] }, presented: [wireOf(child), wireOf(parent)], ...(carried.length ? { supplied: carried } : {}), parent: { agent: parentAgent, runRef: input.runRef ?? 'run', stepRef: stepRefH, operationId, childRef } });
        const exName = answer.via.name ?? (await deps.nameOf?.(executor).catch(() => null)) ?? executor;
        if (answer.via.runRef) handedOff.set(stepRefH, { agent: executor, runRef: answer.via.runRef, childRef });
        const viaH = { ...answer.via, agent: executor, observedVia: 'handoff' as const, childRef };
        if (!answer.ok) {
          if (answer.needs && answer.via.runRef && !tool?.answers) {
            throw new InputRequired({
              kind: 'commitment', stepRef: stepRefH, toolId,
              prompt: `Waiting on ${exName} — ${answer.said || 'it holds the step and has not finished'}.`,
              commitment: { id: operationId, debtor: executor, creditor: parentAgent, content: { capability: toolId, args, goal: stepWords }, conditions: `${exName} finishes the step under the child mandate`, state: 'proposed', at: { agent: executor, ...(answer.via.name ? { name: answer.via.name } : {}), runRef: answer.via.runRef } },
            });
          }
          throw new Error(`${exName} did not run the step: ${answer.refused ?? 'no answer'}`);
        }
        const rH = (answer.result && typeof answer.result === 'object') ? (answer.result as Record<string, unknown>) : { result: answer.result };
        return observeResult(toolId, { ...rH, via: viaH, note: `${String(rH.note ?? '')} Done by ${exName} under a child mandate this agent attenuated from yours — say so in one clause.`.trim() });
      }
      // Spec 397 W2 — FIND: the registry, deterministically; a read of public facts.
      if (toolId === DISCOVERY_FIND_CAPABILITY) return discoveryFindInvoker({ registryOrigin: env.ARD_REGISTRY_ORIGIN, ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) })(toolId, args, ctx);
      // Spec 397 W2 — ENGAGE: one message to another agent, sent by this agent AS THE ASKER (session or app credential),
      // the target planning for itself under its own playbook (`harness.ask` names the whole ask, not one step). The same
      // routed hop as spec 366; the answer is the target's own, an observation here.
      let engaged: { target: Address; said: string } | null = null;
      if (toolId === ENGAGEMENT_INVOKE_CAPABILITY) {
        const namedAgent = String(args.agent ?? '').trim();
        const message = String(args.message ?? '').trim();
        if (!namedAgent) return { refused: 'name the agent to engage (agent) — as discovery returned it' };
        if (!message) return { refused: 'nothing to ask — the message is empty' };
        const target = /^0x[0-9a-fA-F]{40}$/.test(namedAgent) ? (namedAgent.toLowerCase() as Address) : ((await deps.resolveName?.(namedAgent.toLowerCase()).catch(() => null)) ?? null) as Address | null;
        if (!target) return { refused: `the registry names no agent called “${namedAgent}”`, interpretation: `looked “${namedAgent}” up in the registry` };
        if (input.addressee && target === String(input.addressee).toLowerCase()) return { refused: 'that is this agent — engage another one, or just ask' };
        engaged = { target, said: message };
      }
      const subject = engaged ? engaged.target : routedSubjectFor(tool, args, input.addressee);
      if (!subject) return localInvoke(toolId, args, ctx);
      if (!deps.askSubjectAgent) {
        return { refused: `this agent cannot ask ${subject} — agent-to-agent asks are not wired here`, via: { agent: subject } };
      }
      const stepRef = ctx.step.id ?? `s${ctx.index}`;
      const subjectName = await deps.nameOf?.(subject).catch(() => null) ?? null;
      const whoName = subjectName ? `${subjectName} (${subject})` : subject;
      // Spec 374 §4 — THE DEBTOR'S ANSWER, delivered: this run suspended on a commitment and the subject's
      // agent has now said what came of it. The step takes that as its result; nothing is re-asked.
      const delivered = inputsFor(ctx.supplied, stepRef).find((x: SuppliedInputV1) => x.delivered)?.delivered;
      if (delivered) {
        const via = { agent: subject, ...(subjectName ? { name: subjectName } : {}), ...(delivered.runRef ? { runRef: delivered.runRef } : {}), observedVia: 'delivered' as const, ...(delivered.receipts?.length ? { receipts: delivered.receipts as Array<{ stepRef: string; capability?: string; status: string }> } : {}) };
        if (delivered.outcome === 'answer') {
          const r: Record<string, unknown> = (delivered.result && typeof delivered.result === 'object') ? (delivered.result as Record<string, unknown>) : { result: delivered.result };
          return { ...r, via, note: `${String(r.note ?? '')} Done by ${whoName}'s own agent, under its steward's signature — say so in one clause.`.trim() };
        }
        return { refused: `${whoName} ${delivered.outcome === 'refused' ? 'refused' : 'could not finish'}: ${delivered.said ?? ''}`.trim(), via, note: `${whoName}'s own agent decided this; relay its words.` };
      }
      // Spec 374 W2 — A CONTINUATION. This step already waits at the subject's agent (the checkpoint says
      // where); what this turn presented or supplied goes to THAT run, not to a fresh ask. The receiver
      // resumes its own run under its own gates.
      const at = input.routedAt?.[stepRef];
      const presentedNow = input.presented ? (Array.isArray(input.presented) ? input.presented : [input.presented]) : [];
      // What this turn supplied for HER step is the answer to the SUBJECT's step: re-keyed to the step the subject named.
      const suppliedThere = inputsFor(ctx.supplied, stepRef).map((x) => (at?.stepRef ? { ...x, stepRef: at.stepRef } : x));
      const cont = at ? { runRef: at.runRef, ...(presentedNow.length ? { presented: presentedNow } : {}), ...(suppliedThere.length ? { supplied: suppliedThere } : {}) } : undefined;
      const correlation = { operationId: `${input.runRef ?? 'run'}:${stepRef}`, runRef: input.runRef ?? 'run', stepRef, intentDigest };
      // Appendix M8 — THE RECEIVER'S RUN IS NAMED BEFORE IT ANSWERS, so its progress can be read while it
      // runs and this run's record can cite it. A continuation reads the run it continues.
      const receiverRunRef = cont ? cont.runRef : receiverRunRefFor(correlation.runRef, stepRef);
      // Appendix M8 — THE SUBJECT'S OWN LINES, RELAYED. While the hop is in flight, the receiver's progress
      // is read under the asker's session and each sentence lands in THIS run's stream, prefixed with
      // the receiver's name: "missio-nexus.org: Reading who belongs…". Words only — its record stays its own.
      let stopRelay = false;
      const relayName = subjectName ?? subject;
      // The subject's own progress lines are relayed while the hop runs — under the asker's session, or (spec 397) for a
      // run admitted through a client, as the asker by name on an in-Worker read the receiver trusts as it trusts the hop.
      const relay = input.onProgress && (input.session || input.appCredential) && deps.readSubjectProgress
        ? (async () => {
            let after = 0;
            const read = deps.readSubjectProgress!;
            const session = input.session;
            const emit = input.onProgress!;
            while (!stopRelay) {
              let got: Awaited<ReturnType<typeof read>>;
              try { got = await read({ subject, runRef: receiverRunRef, ...(session ? { session } : {}), ...(input.person ? { asker: input.person } : {}), after, wait: 1500 }); } catch { break; }
              for (const line of got.lines) {
                after = Math.max(after, line.seq);
                if (line.terminal) continue;
                emit({ type: 'Relayed', said: `${relayName}: ${line.said}`, from: { agent: subject, ...(subjectName ? { name: subjectName } : {}) }, ...(line.stepRef ? { stepRef: line.stepRef } : {}) });
              }
              if (got.terminal) break;
              if (!got.lines.length) await new Promise((r) => setTimeout(r, 300));
            }
          })().catch(() => undefined)
        : Promise.resolve();
      // Spec 390 W2 — the hop rides under THIS run's trace (the caller's when one arrived, else derived from
      // the run reference — the same rule `traceIdFor` applies to the record) with the routed step as parent.
      const hopTrace = { traceparent: formatTraceparent(input.traceContext?.traceId ?? await traceIdOf(correlation.runRef), await spanIdOf(correlation.runRef, correlation.stepRef)), ...(input.traceContext?.tracestate ? { tracestate: input.traceContext.tracestate } : {}) };
      const answer = await deps.askSubjectAgent({
        subject, toolId: engaged ? STANDARD_SURFACE_SKILL : toolId, args: engaged ? {} : args, goal: engaged ? engaged.said : input.intent.goal, ...(input.person ? { asker: input.person } : {}), ...(input.session ? { session: input.session } : {}), ...(input.appCredential ? { appCredential: input.appCredential } : {}), ...(input.addressee && input.person && String(input.addressee).toLowerCase() !== String(input.person).toLowerCase() ? { via: String(input.addressee).toLowerCase() as Address } : {}),
        trace: hopTrace,
        ...(cont ? {} : { runRef: receiverRunRef }),
        // R: this step's stable operation identity, for the receiver to name in S (spec 367 §8).
        correlation,
        ...(cont ? { continue: cont } : {}),
      }).finally(() => { stopRelay = true; });
      await relay;
      const who = answer.via.name ? `${answer.via.name} (${subject})` : subject;
      if (!answer.ok) {
        // Spec 374 — AN ACT THE SUBJECT PARKED FOR ITS OWN STEWARD. The subject's agent took the request
        // and is waiting on someone this asker is not; this run holds the commitment and waits with it.
        // A READ that came back `needs` is a question relayed in the subject's words, as before.
        if (answer.needs && answer.via.runRef && (!tool?.answers || engaged)) {
          const name = answer.via.name ?? subjectName ?? subject;
          const nwEarly = (answer.needsWhat && typeof answer.needsWhat === 'object') ? (answer.needsWhat as { kind?: string; prompt?: { kind?: string; prompt?: string; fields?: Array<Record<string, unknown>> } }) : null;
          // Spec 397 — THE SUBJECT'S OWN DATA QUESTION, relayed to the asker (an engaged ministry asking which item, say):
          // this run parks with that question in the subject's words; the answer supplied here continues the SUBJECT's run
          // (the continuation below), exactly as spec 387 W3's continue_task did for a gateway's task.
          if (nwEarly?.kind === 'prompt' && nwEarly.prompt?.kind === 'data') {
            const there = { agent: subject, ...(answer.via.name ? { name: answer.via.name } : {}), runRef: answer.via.runRef, ...(typeof (nwEarly.prompt as { stepRef?: unknown }).stepRef === 'string' ? { stepRef: (nwEarly.prompt as { stepRef: string }).stepRef } : {}) };
            input.routedAt = { ...(input.routedAt ?? {}), [stepRef]: there };
            throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: `${name} asks: ${nwEarly.prompt.prompt ?? 'more is needed'}`, fields: (nwEarly.prompt.fields ?? []) as never, at: there });
          }
          // Spec 374 W2 — THE STEWARD SHAPE. The subject's agent asked for ITS mandate (or a signature) and
          // this asker STEWARDS it (the receiver derived that from the wire they presented): the request is
          // relayed as the asker's own, their Home mints it exactly as for a local step, and the resume
          // carries it to the subject's parked run. The asker signs as the organization's custodian;
          // this agent relays and never signs.
          const nw = (answer.needsWhat && typeof answer.needsWhat === 'object') ? (answer.needsWhat as { kind?: string; standing?: { relation?: string }; requirement?: unknown; prompt?: { kind?: string; prompt?: string; digest?: string; signer?: string; payload?: unknown } }) : null;
          const stewardHere = nw?.standing?.relation === 'steward';
          if (nw?.kind === 'authority_required' && nw.requirement && stewardHere) {
            throw new InputRequired({
              kind: 'authority', stepRef, toolId,
              prompt: `${name} asks for its own mandate for this — you steward it, so it is yours to grant.`,
              authority: nw as Record<string, unknown>,
              at: { agent: subject, ...(answer.via.name ? { name: answer.via.name } : {}), runRef: answer.via.runRef },
            });
          }
          if (nw?.kind === 'prompt' && nw.prompt?.kind === 'signature' && nw.prompt.digest && nw.prompt.signer && stewardHere) {
            // The receiver's own signature prompt, relayed: the digest and signer are its words; the
            // answer travels back as this step's supplied input.
            input.routedAt = { ...(input.routedAt ?? {}), [stepRef]: { agent: subject, ...(answer.via.name ? { name: answer.via.name } : {}), runRef: answer.via.runRef } };
            throw new InputRequired({ kind: 'signature', stepRef, toolId, prompt: `${name}: ${nw.prompt.prompt ?? 'sign this'}`, digest: nw.prompt.digest, signer: nw.prompt.signer, ...(nw.prompt.payload !== undefined ? { payload: nw.prompt.payload } : {}) });
          }
          throw new InputRequired({
            kind: 'commitment', stepRef, toolId,
            prompt: `Waiting on ${name}'s steward — ${answer.said || 'they have to finish this at their own agent'}.`,
            commitment: {
              id: `${input.runRef ?? 'run'}:${stepRef}`, debtor: subject, creditor: (input.addressee ?? input.person ?? subject).toLowerCase(),
              content: { capability: toolId, args, goal: input.intent.goal },
              conditions: `a steward of ${name} finishes it`, state: 'proposed',
              at: { agent: subject, ...(answer.via.name ? { name: answer.via.name } : {}), runRef: answer.via.runRef },
            },
          });
        }
        return { refused: answer.refused ?? `${who} did not answer`, via: answer.via, note: `${who}'s own agent was asked and answered this way; relay its words, do not retry or guess.` };
      }
      const r = (answer.result && typeof answer.result === 'object') ? (answer.result as Record<string, unknown>) : { result: answer.result };
      // Spec 397 W2 — AN ENGAGEMENT'S RESULT IS WHAT THE OTHER AGENT SAID. Its words (with the links it gave) are the
      // payload; the results it drew on are reduced to titles and links so the whole stays inline — an answer that
      // went to the artifact store with a one-line summary left the composer saying "nothing matched" (seen live).
      if (engaged) {
        const drawn = Array.isArray(r.results) ? (r.results as Array<{ toolId?: string; result?: unknown }>) : [];
        const items = drawn.flatMap((d) => {
          const res = (d.result && typeof d.result === 'object') ? (d.result as { resources?: unknown[]; items?: unknown[]; count?: number; total?: number }) : {};
          const list = (Array.isArray(res.resources) ? res.resources : Array.isArray(res.items) ? res.items : []) as Array<Record<string, unknown>>;
          return list.slice(0, 12).map((it) => ({ title: String(it.title ?? it.name ?? ''), ...(typeof it.url === 'string' ? { link: it.url } : typeof it.link === 'string' ? { link: it.link } : {}), ...(typeof it.type === 'string' ? { type: it.type } : {}) }));
        });
        // Spec 433 W2 — WHAT THE OTHER AGENT CITED, compactly: a content service that answers from a signed corpus returns
        // each verse it leaned on with its signed citation (~3.5 KB each, 28 KB for eight — over the 8 KB offload line, which
        // is the very incident that reduced hops to words). The reader's page needs the reference, the text, the edition and
        // the agent's grade to show the verse and to re-verify it live against the corpus; the signed credential it can fetch
        // fresh. So those ride (≤ 12, text ≤ 240 chars, ~3 KB), the credentials stay at the service's own run.
        const citedRaw = drawn.flatMap((d) => { const res = (d.result && typeof d.result === 'object') ? (d.result as { citations?: unknown[] }) : {}; return Array.isArray(res.citations) ? res.citations : []; })
          .concat(Array.isArray((r as { citations?: unknown[] }).citations) ? ((r as { citations?: unknown[] }).citations as unknown[]) : []);
        const cited = citedRaw.slice(0, 12).flatMap((c) => {
          if (!c || typeof c !== 'object') return [];
          const x = c as Record<string, unknown>;
          const reference = String(x.reference ?? x.osis ?? '').trim(); if (!reference) return [];
          return [{ reference, ...(typeof x.osis === 'string' ? { osis: x.osis } : {}), ...(typeof x.edition === 'string' ? { edition: x.edition } : {}),
            ...(typeof x.text === 'string' ? { text: x.text.slice(0, 240) } : {}), ...(typeof x.support === 'string' ? { support: x.support } : {}),
            ...(typeof x.commitmentVerified === 'boolean' ? { commitmentVerified: x.commitmentVerified } : {}), ...(typeof x.descriptorId === 'string' ? { descriptorId: x.descriptorId } : {}),
            ...(typeof x.note === 'string' ? { note: x.note.slice(0, 200) } : {}) }];
        });
        return {
          said: String(r.text ?? ''),
          source: { agent: subject, ...(answer.via.name ? { name: answer.via.name } : {}) },
          ...(items.length ? { drewOn: { steps: drawn.map((d) => d.toolId).filter(Boolean), items } } : {}),
          ...(cited.length ? { cited, ...(typeof (r as { topic?: unknown }).topic === 'string' ? { topic: (r as { topic: string }).topic } : {}) } : {}),
          via: answer.via,
          note: `Said by ${who}'s own agent, answering as itself — relay its words and every link it gave, name it as the source, add nothing beside it. An observation, never a record of this agent's.`,
        };
      }
      return observeResult(toolId, { ...r, via: answer.via, note: `${String(r.note ?? '')} Answered by ${who}'s own agent — say so in one clause.`.trim() });
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
    // Spec 376 W2 — WHO IS TO DO IT, from the plan's words to an agent in the asker's own tier. The same
    // resolver every party goes through: a name several agents answer to is a question, never a guess;
    // the choice is recorded on the trace as the `executor` binding. An executor that is this agent runs here.
    resolveExecutor: async ({ step, tool }) => {
      const named = String(step.executor ?? '').trim();
      if (!named) return undefined;
      const agent = await resolveParty(named, { ...deps, ...(input.session ? { session: input.session } : {}), onResolved: (r: ResolvedParty) => { const key = `${r.arg}:${r.agent}`; if (r.label || !resolved.has(key)) resolved.set(key, r); } } as never,
        { stepRef: 'pending', toolId: tool.id, ...(tool.capability?.id ? { capabilityId: tool.capability.id } : {}), argName: 'executor', what: 'the agent to do it', ...(input.person ? { subject: input.person } : {}) });
      return agent.toLowerCase() === String(input.addressee ?? '').toLowerCase() ? undefined : agent;
    },
    normalizeArgs: ({ toolId, tool, args }) => resolveStepArgs(args, env, { ...deps, ...(input.session ? { session: input.session } : {}),
      // Spec 420 §10 — the on-chain kind of a display-named candidate (a roster row), read from the record, never from the row.
      ...(deps.agentTypeOf ? { agentKindOf: deps.agentTypeOf } : {}),
      onCandidates: (e: NonNullable<PlannerTraceV1['resolution']>[number]) => { trace.resolution = [...(trace.resolution ?? []), e].slice(-12); },
      // Spec 370 P7 — what recent asks resolved, for a pronoun or a repeated name. The same addressee's turns first.
      ...(input.conversation ? { recentParties: async () => recentParties(input.conversation, { addressee: String(input.addressee ?? '') }) } : {}),
      // Spec 385 — the person's DURABLE scoped confirmation memory (their own vault), consulted before the
      // rolling window; revalidated against the candidates the resolver found. Evidence, never a grant.
      ...(deps.readSubjectRecord && input.person ? { preferredChoice: async (scope: { word: string; capability: string; arg: string }, candidates: ReadonlyArray<{ agent: string }>) => {
        const prefs = (await deps.readSubjectRecord!(String(input.person).toLowerCase(), CONFIRMATION_RECORD).catch(() => null)) as ConfirmationPreferencesV1 | null;
        // Spec 394 — the room the ask is in namespaces the memory: the same room first, then the room-less entry.
        const room = input.addressee && String(input.addressee).toLowerCase() !== String(input.person).toLowerCase() ? String(input.addressee).toLowerCase() : undefined;
        const hit = pickPreferred(prefs, { ...scope, ...(room ? { context: room } : {}) }, candidates);
        return hit ? { agent: hit.agent, ...(hit.label ? { label: hit.label } : {}) } : null;
      } } : {}),
      // Spec 394 — the person's STANDING INSTRUCTIONS (their own vault): a declared default for an act's argument,
      // read for the room the ask is in then `any`. Fills an unspoken acting party; revalidated by the resolver.
      ...(deps.readSubjectRecord && input.person ? { standingInstruction: async (scope: { capability: string; arg: string; context?: string }) => {
        const rec = (await deps.readSubjectRecord!(String(input.person).toLowerCase(), STANDING_RECORD).catch(() => null)) as StandingInstructionsV1 | null;
        const hit = standingFor(rec, scope);
        return hit ? { value: hit.value, ...(hit.label ? { label: hit.label } : {}), ...(hit.saidAs ? { saidAs: hit.saidAs } : {}) } : null;
      } } : {}),
      onResolved: (r) => {
      // The SAME party can be reported twice — once resolved from words or from the asker's own tree, and
      // once again as the plain address it now is. Keep whichever knows its name: overwriting a labelled
      // record with a bare address is how "nathan.treasury" became "0x2c47…" on the card a person reads
      // before signing.
      const key = `${r.arg}:${r.agent}`;
      if (r.label || !resolved.has(key)) resolved.set(key, r);
    } }, {
      stepRef: 'pending', toolId, ...(tool.capability?.id ? { capabilityId: tool.capability.id } : {}),
      schemaArgs: Object.keys(((tool.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {}),
      // A SCREEN'S OWN PLAN may state base units; a planner may not (see the unit guard above).
      ...(input.plan ? { computedUnits: true } : {}),
      // What this capability lets the substrate decide rather than ask (spec 363 W5).
      ...(tool.decisions?.length ? { consults: tool.decisions } : {}),
      // WHOSE authority this step spends — declared by the tool, never inferred from the sentence.
      ...(tool.capability?.authorityArg ? { authorityArg: tool.capability.authorityArg } : {}),
      ...(input.person ? { subject: input.person } : {}),
      ...((input.variant?.toggles?.['resolve/context'] ?? ((env as { RESOLVE_CONTEXT_DEFAULT?: string }).RESOLVE_CONTEXT_DEFAULT ?? 'off').trim()) === 'on' ? { nearest: true } : {}),
      // Spec 367 §7 / 361 I6 — the validated application context a party may be filled from.
      ...(input.addressee ? { addressee: input.addressee } : {}),
      // The surface's realm kind; absent a surface, the addressee's ON-CHAIN kind (ADR-0046 — the record, of which
      // a typed suffix is only a projection). A steward claiming an organization's parked step from a script
      // sent no surface, the organization's name carries a legacy root, and the payer fell to the steward's own
      // treasury: the organization's step, paid with the steward's money (spec 384 W3, live).
      ...(input.surface?.realm?.kind ? { realmKind: input.surface.realm.kind } : deps.addresseeKind ? { realmKind: deps.addresseeKind } : {}),
      ...(realmSuffix && realmSuffix in CLASS_FOR_SUFFIX ? { realmSuffix } : {}),
      ...(input.surface?.selection ? { selection: input.surface.selection } : {}),
      // The tool's OWN declaration of what it cannot work without — asked for, never inferred.
      required: (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    }),
    ports: {
      events: (e) => {
        events.push(e);
        mark(`event:${e.type}`);
        if (e.type === 'PlanRefused') trace.admission.push({ refused: e.violations, replanned: e.replanning });
        else if (e.type === 'PlanCreated') trace.admission.push({ refused: [], replanned: false });
        if (input.onProgress) {
          const line = progressLine(e, tools, (id) => CAPABILITY_WORDS[id]);
          if (line) input.onProgress(line);
        }
      },
      mandateVerifier: verifier, policyEvaluator: policy,
      approvalPort: suppliedApprovalsPort(deps, env, input.approvals ?? [], input.supplied, input.person, presentedList), receiptSink,
      // Spec 410 §3 — RECONCILE BEFORE ACT, per effect kind. Asked before every non-read step whether THIS operation
      // already happened; a lost response after a commit is found here and never becomes a second effect.
      reconcile: harnessReconcilePort(deps, env, presentedList, input.intent, String(input.addressee ?? '').toLowerCase(), { ...(input.routedAt ? { routedAt: input.routedAt } : {}) }),
      // PLAN ADMISSION (spec 367 W1) — the plan's SHAPE, judged from declarations before any step runs:
      // an instruction must be answered by an act (`verbs` on the action tools); a placeholder is not an
      // argument; a step whose tool declares a `subject` may not leave it empty when the sentence names
      // an agent the asker KNOWS (their own links — private tier, never the directory). Refused ⇒ one
      // re-plan told why ⇒ refused in words. The verifier still judges every admitted step.
      planAdmission: planAdmission([
        // Spec 379 — a step aimed at an OUTSIDE executor (a card URL, or an address this deployment does not
        // serve) may run only a read; an act there is refused before anything is spent.
        externalExecutorsReadOnly((ex) => /^https:\/\//.test(ex) || (/^0x[0-9a-fA-F]{40}$/.test(ex) && !!deps.isServedHere && !deps.isServedHere(ex))),
        // Spec 410 §6 — an OPEN intent's stated outcome (`intent.constraints.outcome`) bounds what may be OFFERED: an
        // effect the outcome does not entail, a bounded argument outside what was stated, a write carrying what the
        // outcome does not entail disclosing — refused here, before any signature is asked for. The ontology says
        // what an outcome entails (`outcomeClassOf`); a planner prompt never does.
        outcomeConformance(ontologyOutcomeClassOf),
        // Whether a plan ANSWERS THE SENTENCE (an instruction needs an act; a question needs a read) is a judgement of a PLANNED
        // plan. A SUPPLIED plan was decided already — a Home button, or ONE step of another agent's plan routed here (spec
        // 366): the routed roster check of "invite nathan to missio nexus" arrived with the whole sentence as its goal and was
        // refused as "an instruction answered by a lookup" (live 2026-09-29, the invite e2e).
        ...(input.plan ? [] : [instructionNeedsAct]),
        noPlaceholders,
        // A plan naming a tool this agent does not offer is refused here (one re-plan, told which
        // tools it has) rather than hard-failing in the loop with `unknown_tool` — the model naming a
        // capability the agent lacks (e.g. calendar.events.list on a game persona) recovers to a tool it has.
        capabilitiesAvailable,
        dependenciesProvided,
        branchesDecidable,
        ...(input.plan ? [] : [questionAnsweredByRead]),
        // Spec 418 §12 / 420 — the "from the words" rules hold a PLANNER to what the person said. A SUPPLIED plan (a Home button,
        // a screen's form) carries the person's own input — often in base units ("amount": "4000000" for "4 usdc") — and is not a
        // paraphrase: applying them there stripped the Fund button's amount (found by the act laboratory's UX-action cases).
        ...(input.plan ? [] : [numbersFromTheWords, actingPartyFromTheWords((capability: string, arg: string) => partyRole(capability, arg)?.side)]),
        partiesDistinct((capability, arg) => partyRole(capability, arg)?.side),
        // Spec 420 §2 — a step the facts contradict, or whose standing the asker lacks, is refused by name (the facts were
        // gathered while planning; a run without them passes here and the verifier judges as always).
        ...(factsOnce ? [transitionsHold(CAPABILITY_TRANSITIONS, () => regressionFacts ?? { situations: [], known: new Set<string>(), room, standing: () => undefined })] : []),
        kindNamedIsChartered(CHILD_AGENT_KINDS.map((k) => ({ capability: k.capability, noun: k.noun, words: [...new Set([k.noun, k.tld, ...(k.tld === 'org' ? ['organization'] : [])])] }))),
        subjectNamedInAsk(async () => {
          if (!input.person || !deps.readSubjectRecord) return [];
          const doc = await deps.readSubjectRecord(input.person, 'relationships.data').catch(() => null);
          return relationshipRows(doc).map((r) => ({ name: r.name, agent: r.agent }));
        }),
      ]),
      // spec 360 — what the playbook promised FOLLOWS a successful step. Isolated by the loop: an effect
      // that cannot be delivered never fails the act that produced it.
      // R917-H-4 (spec 409 §8): a REPLAY re-derives verdicts and runs nothing — so nothing follows it either. A
      // replayed payment re-writing the payee's receipt and re-sending the DM was an effect with no act behind it.
      ...(input.replayOf ? {} : { effectSink: declaredEffectSink(
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
      ) }),
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
        const theirs = await loadPlaybook(deps.readSubjectRecord, actor, console.log).catch(() => null);
        if (theirs?.declaredEffects?.[capabilityId]?.length) return theirs.declaredEffects[capabilityId]!;
      }
      return playbook?.declaredEffects?.[capabilityId] ?? [];
    },
    presented,
    // The keyring's selector: a payment step is judged under the mandate whose PaymentEnforcer caveat
    // names its payee. Selection reads a caveat; it verifies nothing — the verifier still judges the one
    // selected mandate alone (ADR-0013: one mechanism, deterministically chosen).
    selectPresentation: (rs, all) => selectByPayee(rs, all, enforcers.payment, enforcers.allowedMethods),
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
    // Spec 418 §12 — a comparison run (a variant) never commits a self-acting write: the estate stays the stated one.
    ...(input.comparison || input.variant ? { dryRunSelfActs: true } : {}),
    // Spec 354 §4.5 — the playbook that admitted this run (canonical id + version + definition digest),
    // stamped onto every receipt by the loop. Absent ⇒ the bare harness; receipts carry no skillRef.
    ...(playbook ? { skillRef: { skillId: playbook.archetypeId, version: playbook.archetypeVersion, commitment: playbook.digest } } : {}),
    // Spec 414 A1 — and each step names the SKILL.md its own tool was compiled from, when the definition says (415 S1).
    ...(playbook?.tools ? { skillOf: (toolId: string) => { const t = Object.values(playbook.tools ?? {}).find((d) => (d as { id?: string; capability?: { id?: string } }).id === toolId || (d as { capability?: { id?: string } }).capability?.id === toolId) as { source?: { skillId: string; version: string; contractDigest: string } } | undefined; return t?.source ? { id: t.source.skillId, version: t.source.version, contractDigest: t.source.contractDigest } : undefined; } } : {}),
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    now,
  });
  // Spec 361 I2 — the interaction bindings of the tools this run OFFERED (contract-merged), keyed by
  // capability id, so the reply can say where its outcome lives. Display data; decides nothing.
  mark('runIntent-done');
  if (material) console.log(`[phases ${String(input.addressee ?? '').slice(0, 10)}] ${phases.join(' · ')}`);
  const interactionFor: Record<string, NonNullable<ToolSpec['interaction']>> = {};
  for (const t of tools) if (t.interaction) interactionFor[t.capability?.id ?? t.id] = t.interaction;
  trace.planner = plannerUsed;
  // Spec 388 — the model is the ROUTED provider's, not the default's the trace was opened with.
  if (plannerModel) trace.model = plannerModel; else delete trace.model;
  trace.plan = result.plan.steps.map((s) => ({ toolId: s.toolId, args: s.args }));
  trace.bindings = [...resolved.values()].map((r) => ({
    arg: r.arg, raw: r.raw, agent: r.agent, ...(r.label ? { label: r.label } : {}),
    source: r.via === 'context' ? 'context' : r.via === 'standing' ? 'standing' : r.ruleId ? 'decision' : r.hint?.startsWith('remembered') ? 'memory' : r.ownedBy ? 'disclosed' : /^0x[0-9a-f]{40}$/i.test(r.raw) ? 'said' : 'resolver',
    // A memory's citation rides the binding: an ANSWER carries no parties, so the How pane is the only place
    // a person reading "who is in rich" can see that "rich" was settled from what they chose last time
    // (spec 370 P7) or confirmed before (spec 385) — and say otherwise.
    ...(r.because ? { because: r.because } : r.hint?.startsWith('remembered') ? { because: r.hint } : {}),
  }));
  return { result, plannerKind: kind, resolved, interactionFor, trace, tools, events, presentedRefs: presentedList.map((p) => p.ref), playbook: playbook ? { digest: playbook.digest, ...(playbook.triggers?.length ? { triggers: playbook.triggers } : {}) } : null };
}
