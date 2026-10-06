// The organization's COMMON NAME, as a relying app receives it.
//
// The RECORD is `org.profile` in the ORG's own vault, written by a steward over the stewardship
// delegation (`OrgProfileManager`). A relying app cannot read that vault and the broker holds no
// credential that could, so the two fields an app shows a person — the name people call the
// organization and its website — are PROJECTED onto the steward's related-org link (`orgProfile`),
// exactly as `status` is projected from `org.lifecycle` (ADR-0055): written after the record, read
// back without a vault read per row.
//
// WHY IT IS RETURNED BESIDE `orgName` AND NEVER INSTEAD OF IT. `orgName` is the naming-service name
// (`global-church.org`): unique, resolvable, and read by people as a website address, which it is
// not. `displayName` is what the steward typed ("Global.Church"): not unique, not resolvable, and
// only as true as the steward made it. An app needs the first to identify the organization and the
// second to show it.
//
// The key on the link is `orgProfile`, not `displayName`: a link already carries `displayName` for
// the name a MEMBER shares with the organization (spec 321), which is a fact about the person.

/** The projected slice of `org.profile` — the two fields a relying app is given. */
export interface OrgProfileProjection {
  displayName?: string;
  website?: string;
}

const MAX_DISPLAY_NAME = 80;
const MAX_WEBSITE = 200;

/**
 * Reduce a client-supplied profile to what may be stored on the link.
 *
 * `website` is kept only when it parses as an http(s) URL: a relying app will render it as a link,
 * and a projection that can hold `javascript:` is one that hands every app an injection to defend
 * against. Anything else is dropped rather than repaired, so what is stored is what the steward
 * wrote or nothing.
 *
 * Returns `{}` for a profile with neither field, which the caller stores as "no projection" — a
 * steward who clears the name must be able to make it stop appearing.
 */
export function sanitizeOrgProfileProjection(input: unknown): OrgProfileProjection {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const displayName = typeof p.displayName === 'string' ? p.displayName.trim().slice(0, MAX_DISPLAY_NAME) : '';
  const rawSite = typeof p.website === 'string' ? p.website.trim() : '';
  let website = '';
  if (rawSite && rawSite.length <= MAX_WEBSITE) {
    try {
      const u = new URL(rawSite);
      if (u.protocol === 'https:' || u.protocol === 'http:') website = rawSite;
    } catch { /* not a URL — dropped */ }
  }
  return { ...(displayName ? { displayName } : {}), ...(website ? { website } : {}) };
}

/**
 * The fields to spread into what a relying app receives for one organization.
 *
 * `displayName` is OMITTED when it says nothing `orgName` does not. The creation ceremonies seed
 * `org.profile.displayName` with the name the organization was created under, so an organization
 * whose steward has never edited the profile carries its own naming-service name there (or the bare
 * label). Returning that would have an app prefer "global-church.org" as the common name — the very
 * string this field exists to get away from — so a `displayName` equal to `orgName`, or to its first
 * label, is treated as absent. Absent therefore means one thing to an app: show `orgName`.
 */
export function orgCommonNameFields(orgName: unknown, stored: unknown): OrgProfileProjection {
  const p = sanitizeOrgProfileProjection(stored);
  const name = String(orgName ?? '').trim().toLowerCase();
  const shown = (p.displayName ?? '').toLowerCase();
  const addsNothing = !shown || shown === name || shown === name.split('.')[0];
  return { ...(addsNothing ? {} : { displayName: p.displayName }), ...(p.website ? { website: p.website } : {}) };
}
