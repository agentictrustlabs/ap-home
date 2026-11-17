# Workspace readiness after an estate build

The coach-assist build exposed two missing birthrights: no naming gate was installed, and the
runtime's outbound email binding was omitted. A completed hosted estate must support ordinary
email sign-in and named organization/workspace creation.

The naming gate is unique to the estate. Read priced roots from the pinned contracts deployment,
resolve `naming.svc` using that deployment, verify each root's governor and the clerk's custody,
and submit only missing `setGate` calls. Verify every root afterward. Store the gate key with the
estate's sealed custody material and install it only in that estate's Home. The town clerk key
belongs only in the town's protected build environment; it never goes to an estate or its owner.
An owner-hosted build reports its public gate address for the town's finish step.

Hosted estates may use the town's explicitly configured outbound sender on the same Cloudflare
account. They receive their own runtime binding and display name; inbound email zones are not
copied. A cross-account estate must configure its own sender. Missing mail must be reported.

Playbook reads remain request-scoped through the Home's membership/custody check. A deployment
lock independently approves the compiled definition digest. A workspace must refuse a task when
its assigned definition cannot be read, validated, digest-checked, and approved.

Validation: exercise governor/custodian refusal and idempotence; test hosted versus cross-account
mail configuration; check every live priced root and the Home's naming-ticket readiness. Do not
create another organization to test the fix or reclaim the existing unnamed account implicitly.
