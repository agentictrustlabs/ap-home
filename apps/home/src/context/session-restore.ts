/** Restore a persisted session on load only if one exists AND we're not mid Google-redirect
 *  (?code/connect_status) or a site-login enroll (?delegate). Those mint their own.
 *
 *  `org-create` is the exception: Gather (and Field) open it as a SECOND Home trip after
 *  site-login. `?delegate` used to skip restore, so a social member who just granted the
 *  app landed on "Welcome / Continue with Social" with their Home session sitting in
 *  localStorage. Owner-ops reuse the recognized session — restore them. */
export function shouldRestoreFromUrl(
  href: string,
  hasLocalSession: boolean,
  hasSsoCookie: boolean,
): boolean {
  try {
    const u = new URL(href);
    if (u.searchParams.has('code') || u.searchParams.has('connect_status')) return false;
    if (u.searchParams.has('delegate')) {
      const template = u.searchParams.get('delegation_template') ?? u.searchParams.get('template') ?? '';
      if (template !== 'org-create') return false;
    }
    return hasLocalSession || hasSsoCookie;
  } catch {
    return false;
  }
}
