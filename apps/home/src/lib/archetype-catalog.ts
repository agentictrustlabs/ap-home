// THE APP-CONFIG ARCHETYPE CATALOG — spec 354 §3, the default archetype per agent type.
//
// "Every derived agent type maps to a DEFAULT ARCHETYPE in app config" (spec 354 §3) — the mapping is
// product, not package, so it lives here in the Home. Each entry is a compiled AgentHarnessDefinitionV1,
// produced by the ~/skills compiler (@skills/archetype-compiler) and committed verbatim. The
// `check:archetype-catalog` test re-validates every one against the Ring-0 schema and re-derives its
// digest, so a drifted paste is caught, not shipped.
//
// This is the DEFAULTS catalog. Custom / refined archetypes come from the corpus (skills-a2a's
// /archetypes/:aid/definition) once a domain context is seeded — a later increment; the ceremony reads
// from whichever source, because both hand back the same AgentHarnessDefinitionV1.
//
// A catalog entry GRANTS NOTHING (spec 354 §1): assigning it changes what the agent knows how to do, and
// the mandate still decides what it may do. The ceremony renders that sentence; this file only carries
// the behavior.
import type { AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';

export interface CatalogArchetype {
  key: string;
  label: string;
  summary: string;
  definition: AgentHarnessDefinitionV1;
}

const DEFS = {
  "treasury": {
    "type": "ap.agent-harness-definition.v1",
    "archetypeId": "skill:archetypes/treasury-steward",
    "archetypeVersion": "1.0.0",
    "applicableAgentTypes": [
      "treasury"
    ],
    "instructions": "You are a Treasury Steward.\nHolds funds and pays on its owner\u2019s behalf, only under mandate.\n\nWhat you can do: Make payments, Fund the treasury, Read its records. Each acts only under a mandate the person grants for that request; you ask for the authority you need and never assume it.\n\nWhat you reason over: Treasury, PaymentMandate.\n\nAnswer questions from what your tools actually return, never from what seems plausible. When an instruction needs authority you do not hold, say what you would need and let the person grant it.",
    "tools": [
      {
        "id": "treasury.payment.execute",
        "description": "Execute a payment from a treasury under a signed payment mandate. Takes the payee (a name or address), the asset, and the amount.",
        "capability": {
          "id": "treasury.payment.execute",
          "action": "execute",
          "resourceArg": "asset",
          "authorityArg": "payer"
        },
        "risk": "high",
        "inputSchema": {
          "type": "object",
          "properties": {
            "payer": {
              "type": "string"
            },
            "payee": {
              "type": "string"
            },
            "asset": {
              "type": "string"
            },
            "usdc": {
              "type": "string"
            }
          },
          "required": [
            "payee"
          ]
        }
      },
      {
        "id": "treasury.fund",
        "description": "Fund a treasury with an asset under a mandate.",
        "capability": {
          "id": "treasury.fund",
          "action": "fund",
          "resourceArg": "asset",
          "authorityArg": "funder"
        },
        "risk": "high"
      },
      {
        "id": "vault.records.query",
        "description": "Answer a question about the records the acting agent may read (its own, and orgs it stewards)."
      }
    ],
    "requiredMandateTypes": [
      "urn:ap:rar:treasury.fund",
      "urn:ap:rar:treasury.payment.execute"
    ],
    "approvalPolicyRefs": [
      "treasuryPaymentPolicy"
    ],
    "retrievalQueries": [
      "Treasury",
      "PaymentMandate"
    ],
    "evidenceRequirements": [
      "FundingReceipt",
      "PaymentReceipt"
    ],
    "sourceCommitments": {
      "skill:archetypes/treasury-steward@1.0.0": "id:treasury-steward"
    }
  },
  "bookkeeper": {
    "type": "ap.agent-harness-definition.v1",
    "archetypeId": "skill:archetypes/bookkeeper",
    "archetypeVersion": "1.0.0",
    "applicableAgentTypes": [
      "org",
      "person",
      "service",
      "team",
      "treasury"
    ],
    "instructions": "You are a Bookkeeper.\nReads and reports on the books. Moves nothing.\n\nWhat you can do: Read records, List members. Each acts only under a mandate the person grants for that request; you ask for the authority you need and never assume it.\n\nWhat you reason over: Treasury.\n\nAnswer questions from what your tools actually return, never from what seems plausible. When an instruction needs authority you do not hold, say what you would need and let the person grant it.",
    "tools": [
      {
        "id": "vault.records.query",
        "description": "Answer a question about the records the acting agent may read (its own, and orgs it stewards)."
      },
      {
        "id": "organization.membership.list",
        "description": "List the members of an organization the acting agent belongs to."
      }
    ],
    "requiredMandateTypes": [],
    "approvalPolicyRefs": [],
    "retrievalQueries": [
      "Treasury"
    ],
    "evidenceRequirements": [],
    "sourceCommitments": {
      "skill:archetypes/bookkeeper@1.0.0": "id:bookkeeper"
    }
  },
  "orgSteward": {
    "type": "ap.agent-harness-definition.v1",
    "archetypeId": "skill:archetypes/org-steward",
    "archetypeVersion": "1.0.0",
    "applicableAgentTypes": [
      "church",
      "circle",
      "org",
      "team"
    ],
    "instructions": "You are a Organization Steward.\nRuns an organization: invites members, charters teams, sends on its behalf.\n\nWhat you can do: Invite members, Charter teams, Send messages, List members, Read records. Each acts only under a mandate the person grants for that request; you ask for the authority you need and never assume it.\n\nWhat you reason over: OrganizationMembership.\n\nAnswer questions from what your tools actually return, never from what seems plausible. When an instruction needs authority you do not hold, say what you would need and let the person grant it.",
    "tools": [
      {
        "id": "organization.membership.invite",
        "description": "Invite a member into an organization the acting agent stewards.",
        "capability": {
          "id": "organization.membership.manage",
          "action": "invite",
          "resourceArg": "org"
        },
        "risk": "medium"
      },
      {
        "id": "organization.team.create",
        "description": "Charter a team under an organization.",
        "capability": {
          "id": "organization.team.create",
          "action": "create"
        },
        "risk": "medium"
      },
      {
        "id": "messaging.direct.send",
        "description": "Send a direct message as the acting agent.",
        "capability": {
          "id": "messaging.direct.send",
          "action": "send",
          "resourceArg": "recipient"
        },
        "risk": "medium"
      },
      {
        "id": "organization.membership.list",
        "description": "List the members of an organization the acting agent belongs to."
      },
      {
        "id": "vault.records.query",
        "description": "Answer a question about the records the acting agent may read (its own, and orgs it stewards)."
      }
    ],
    "requiredMandateTypes": [
      "urn:ap:rar:messaging.direct.send",
      "urn:ap:rar:organization.membership.invite",
      "urn:ap:rar:organization.team.create"
    ],
    "approvalPolicyRefs": [
      "organizationMembershipPolicy"
    ],
    "retrievalQueries": [
      "OrganizationMembership"
    ],
    "evidenceRequirements": [
      "MembershipInvitation",
      "TeamGenesis"
    ],
    "sourceCommitments": {
      "skill:archetypes/org-steward@1.0.0": "id:org-steward"
    }
  }
} as unknown as { treasury: AgentHarnessDefinitionV1; bookkeeper: AgentHarnessDefinitionV1; orgSteward: AgentHarnessDefinitionV1 };

export const ARCHETYPE_CATALOG: CatalogArchetype[] = [
  { key: 'treasury-steward', label: 'Treasury Steward', summary: 'Holds funds and pays under mandate; can read its own records.', definition: DEFS.treasury },
  { key: 'bookkeeper', label: 'Bookkeeper', summary: 'Reads and reports on the books. Moves nothing.', definition: DEFS.bookkeeper },
  { key: 'org-steward', label: 'Organization Steward', summary: 'Invites members, charters teams, sends on the org’s behalf.', definition: DEFS.orgSteward },
];

/** The archetypes assignable to an agent of this kind — the ceremony filters to these (spec 354 §3:
 *  assignment never crosses class). */
export function catalogFor(agentType: string | undefined): CatalogArchetype[] {
  const k = (agentType ?? '').toLowerCase();
  // The definition's applicableAgentTypes is the ONE authoritative list of which classes may take an
  // archetype (run admission checks the same field). Filtering on it here means the ceremony and the
  // harness can never disagree about eligibility.
  return ARCHETYPE_CATALOG.filter((a) => a.definition.applicableAgentTypes.includes(k));
}

// AgentKind (connect-client) → ADR-0061 type slug the catalog filters on. A treasury (person- or
// org-) is Treasury-typed; a workspace coordinator and a plain service are Service-typed; team / circle
// / church keep their own suffix. The ceremony passes the managed agent's `.kind`; this narrows the
// catalog to only what that class may become.
export const KIND_TO_TYPE_SLUG: Record<string, string> = {
  'person-treasury': 'treasury',
  'org-treasury': 'treasury',
  workspace: 'service',
  service: 'service',
  team: 'team',
  circle: 'circle',
  church: 'church',
  org: 'org',
};

/** Catalog archetypes assignable to a managed agent of this `AgentKind`. */
export function catalogForKind(kind: string | undefined): CatalogArchetype[] {
  return catalogFor(KIND_TO_TYPE_SLUG[(kind ?? '').toLowerCase()]);
}
