/** The estate under test, from the baseURL — never a hardcoded brand. A per-handle home is a subdomain of
 *  the registrable domain of `SSO_BASE_URL`, so this is what "they reached a home" means on any estate.
 *  Hardcoding `impact-agent` here is what tied these specs to the estate retired on 2026-10-13. */
export const estateDomain = (): string => {
  const host = new URL(process.env.SSO_BASE_URL ?? 'https://www.faithnet.me').hostname;
  return host.split('.').slice(-2).join('.');
};
