// spec 324 §7 Tier-2 — the org's pending MembershipApplications, stored as a plain whole-doc record
// `org.applications` in the org's vault (read/written via the org's InteractionsDO applications.get/put ops).
// A non-member's application must surface reliably to the steward, so it does NOT ride the inbox.
export interface OrgApplication {
  applicationId: string;
  /** Applicant SA (0x). */
  applicant: string;
  message: string;
  submittedAt: string;
}

export interface OrgApplicationsDoc {
  applications: OrgApplication[];
}
