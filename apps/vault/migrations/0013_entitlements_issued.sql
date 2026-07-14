-- spec 277/278 — cross-principal ENTITLEMENTS (org → member).
--
-- The issuer LEDGER + authority store for AgenticEntitlementCredentialV1s an org issues to a member
-- (a different SA who does NOT custody the org). This table IS the trusted authority the entitlement
-- resolver consults: the @agenticprimitives/entitlements matching engine deliberately checks no
-- signature (credentials are trusted upstream), so a row here = a valid grant. Access to the org's
-- data is gated SOLELY by a matching, granted, unexpired row — never by custody/stewardship.
--
--   principal = the data OWNER (the org SA whose vault is read), lowercased
--   actor     = the GRANTEE (the member SA authorized to read), lowercased
--   resource  = the vault resource the grant covers (e.g. vault:impact-profile (or vault:uupg:*))
CREATE TABLE IF NOT EXISTS entitlements_issued (
  id           TEXT PRIMARY KEY,                  -- urn:ap:entitlement:<uuid>
  principal    TEXT NOT NULL,                     -- org (data owner)
  actor        TEXT NOT NULL,                     -- member (grantee)
  resource     TEXT NOT NULL,
  audience     TEXT NOT NULL,
  credential   TEXT NOT NULL,                     -- full AgenticEntitlementCredentialV1 JSON
  issued_by    TEXT,                              -- token principal that issued (the org)
  valid_until  TEXT,                              -- ISO 8601, nullable = no expiry
  status       TEXT NOT NULL DEFAULT 'granted',   -- granted | revoked
  created_at   TEXT NOT NULL
);

-- Resolver lookup: granted, unexpired grants for (owner, grantee).
CREATE INDEX IF NOT EXISTS idx_entitlements_lookup ON entitlements_issued (principal, actor, status);
-- Issuer console: everything an org has issued.
CREATE INDEX IF NOT EXISTS idx_entitlements_by_issuer ON entitlements_issued (principal, status);
