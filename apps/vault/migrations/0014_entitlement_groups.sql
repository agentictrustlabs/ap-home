-- D2 group-conferred entitlements (D2 — "subjectGroup roster-resolved"; e.g. a uupg coalition).
--
-- An org can issue ONE entitlement to a subjectGroup instead of to each member SA individually,
-- collapsing the O(orgs×members) fan-out. The group's OWNER (e.g. an Alliance SA) maintains the roster
-- of member SAs (reading actors). The entitlement resolver, when a cross-principal read comes in,
-- resolves the reading actor's group memberships and matches group grants (actor = 'group:<group_id>')
-- in addition to direct grants.
--
--   group_id = the opaque subjectGroup value carried in the entitlement (e.g. urn:uupg:coalition)
--   member   = a reading actor SA in the group (lowercased)
--   owner    = the SA that maintains this roster (lowercased) — only it may mutate the group
CREATE TABLE IF NOT EXISTS entitlement_groups (
  group_id   TEXT NOT NULL,
  member     TEXT NOT NULL,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member)
);

-- Resolver lookup: which groups is a reading actor in?
CREATE INDEX IF NOT EXISTS idx_group_by_member ON entitlement_groups (member);
-- Owner console: the roster a given owner maintains.
CREATE INDEX IF NOT EXISTS idx_group_by_owner ON entitlement_groups (owner, group_id);
