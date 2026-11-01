# The paged Library catalog

Status: implemented on branch `library-paged-catalog`, on top of the compact-catalog codec (PR #78). Revised after two
independent data-safety reviews:

- **First review:** copy-on-write pages, as-stored switch reads, vault-side compare-and-set, an authenticated restore,
  and a strict root.
- **Second review:**
  - a resumable rollback;
  - the vault refusing to switch an owner off without a restore;
  - a deploy preflight;
  - readers that survive collection;
  - a sweep for leaked generations. Not deployed. **No owner's data changes until an operator runs `activate`
for that owner.** The deploy alone does change some behaviour for everyone; see "Behaviour changes before any
`activate`".

## What and why

`content.catalog` is one vault record per owner: the Library index, a JSON array of entries, sealed whole
(`vault_objects`, ciphertext = base64(AES-GCM(JSON))). Demo Admin (`0x6142b0fca982f6701cf2248bf368ab44a48c5725`) holds
3,001 entries, 6.1 MB of ciphertext even after the compact codec. Every save read, decrypted, expanded, cloned and
rewrote all of it inside the interactions Durable Object. At about 4.5 MB that ran the DO out of memory, and
`CATALOG_MAX` (3,000) now blocks publishing.

A **paged** owner keeps the same list as a root and up to 32 page records. A save writes one new page generation and
swaps the root. The cap rises to 10,000 for a paged owner.

**Bytes per save.** Measured in `test/library-paged.test.ts` on 6,000 synthetic documents with release signatures
(3.6 MB compact):

- A save by id moves 374 KB in total: root and page each read twice and written once, plus the document's own record.
- That is 5.2 % of the 7.2 MB a whole-list save moved (one full read plus one full write).

## Record shapes

```ts
// content.catalog.root
{
  format: 'ap.catalog.paged.v2',
  active: boolean,                  // the switch: only `true` makes the pages the catalog
  pageCount: 32,                    // what this root was split with; every reader uses it
  pages: [{ k, gen, count, hash, prevGen }],
                                    // gen: the generation of content.catalog.p<k>.g<gen> (null = empty page, no record)
                                    // hash = sha256(JSON.stringify(plain rows)); prevGen = the generation the previous root named
  total, order,                     // order: one symbol per assembled row: its page ('0-9a-zA-Z-_') or '~' (root bucket)
  folders: [...],                   // the root bucket: folder rows and any row that is not a document, in list order
  migratedFrom?: { hash, total, legacyRev, at }, // prepare: catalogDigest(legacy) and the legacy record's STORED rev
  activation?:  { legacyRev, at },  // activate: the legacy record's stored rev at the switch
  restore?:     { nonce, expiresAt, fromRev, toRev },
                                    // deactivate: the one legacy write the vault accepts while paged — over fromRev,
                                    // landing as toRev = fromRev + 1. Kept until the owner is switched off (resumable).
  seq, updatedAt,
}
// content.catalog.p<k>.g<gen>: compactCatalog(rows). Written ONCE (the vault refuses a second write of the same name).
```

**Order.** I chose an order *string* in the root. Each bucket keeps its rows in their relative list order, so the
sequence of bucket symbols is the whole merge, and `assemble(split(x))` reproduces `x` position for position. No field
is added to an entry, and the string is 1 byte per row.

**Digests use the root's own page count.** Every digest the switch compares (prepare, verify, the resume check, the
read-back) is taken under the root's own `pageCount`. A test takes a 16-page owner through activate, an edit,
deactivate and an interrupted-then-resumed deactivate.

**A strict root.**

- No root record at all means a legacy owner.
- A root that parses and is inactive still means legacy.
- An active root means the pages.
- A root that exists but is **deleted or does not parse is an error on every read and write**, never a quiet return to
  the frozen legacy record. `parseCatalogRoot` checks the shape, every page ref, and the order against the counts.
- A page the root names that is missing, or whose row count differs from the root, is an error.

## Copy-on-write: the root swap is the only commit

A write proceeds in five steps:

1. Plan against the root as stored, including its D1 `rev`.
2. Write each changed page under a **new generation name** (`newGeneration`: the next seq plus 48 random bits).
3. Swap the root by **compare-and-set** on its stored rev. This is one guarded SQL statement at the vault.
4. Read nothing else.
5. After the swap, collect the generations named by the previous root's `prevGen`. Each page keeps the generation
   the previous root named as `prevGen` until its next change. The collection is best effort. A collection lost to
   a failure or an eviction is found by the **sweep** (`catalog_commit` op `sweep`), which tombstones every page
   record the current root names neither as `gen` nor as `prevGen`. The DO runs the sweep:
   - after a failed collection;
   - every 16th root swap;
   - from the operator's door (`sweep` action).

   **The sweep never takes a page that may be in flight.** The vault enforces two rules:
   - It never tombstones a generation whose sequence (the base-36 prefix of its name) is greater than the current
     root's `seq`. Such a page belongs to a writer whose root swap has not landed yet.
   - It never tombstones a page record written in the last five minutes.

   Separately, the root swap re-checks that every page it names is live **inside its own guarded statement**. A
   tombstone (from a sweep, a collect, or anything else) that lands between the swap's check and its write fails the
   swap with `catalog_conflict`; it can never produce a root that names a missing page. The third review's probe is a
   repo test.

**What a failure at each point does:**

- **A failure before the swap is invisible.** The written generations are unnamed, and the writer collects them on its
  way out.
- **Bucket moves are atomic.** Moving a document into a folder or back, and renaming a folder, change the page and the
  root together, because the page is only reachable through the root.
- **A late write cannot roll a page back.** The root names the exact generation, and a generation is never rewritten.
- **A second writer planned against an old root loses** on the compare-and-set and changes nothing.
- **A reader holding an older root** can find a page missing: two later commits changed that page, and the second
  collected the generation the reader's root named. It then re-reads the root once. If the root moved, it reads again
  against the new one. Only if the root is unchanged is the missing page an integrity error. This applies in the
  vault's read, the DO's read, and the runtime save, which re-runs the whole act once, but only if nothing has been
  written yet.

Tests cover each of these: a write failing at every step of the plan (including a doc→folder move and a folder rename
in the same plan), bucket moves interrupted at every vault call, two interleaved writers, and a deactivate interrupted
at every vault call.

## The authenticated door at the vault

- **`set_vault_record`** (and the native ingress) refuse every write and tombstone of the paged family:
  `content.catalog.root` and `content.catalog.p<k>[.g<gen>]` return `catalog_record_reserved`. A write of the legacy
  `content.catalog` is refused while the owner is paged (`catalog_paged`). Otherwise it lands only if the root's stored
  rev is unchanged since it was checked; this is one statement, and a lost race returns `catalog_switched`.
- **`get_catalog_records`** and **`catalog_commit`** are registered only on the service-MAC `/tools/*` path. The
  interactions DO calls them; no proxy route forwards them, and they are not on the native ingress. They are
  authorized as a read or write of `vault:content.catalog`: the pages are that record's storage.
  - `get_catalog_records` returns the legacy record, the root and pages **as stored** (never assembled), with their
    stored versions.
  - `catalog_commit` has four operations:
    - `pages`: new generations only, written once.
    - `root`: a compare-and-set on the root's rev, and every page the root names must exist. The switch's guarantees
      are enforced **here, whatever the caller says**:
      - **No stored root:** only an *inactive* root can be written (a prepare).
      - **A stored root that is deleted or does not parse:** refused. It must be repaired by hand. This also covers a
        revival of a deleted root via `expectRootRev: -2`, which is refused.
      - **Inactive → active:** the activation names the legacy rev it checked. The legacy record must still be at that
        rev, re-checked **in the same statement**. Its digest must equal the new root's digest, so the switch is only
        ever onto an identical copy.
      - **Active → active:** the activation is unchanged. The restore stamp is either kept as it is, or replaced by a
        stamp whose `fromRev` is the frozen rev or the previous stamp's `toRev`, while the legacy record is at that rev
        (same statement). A stamp is never dropped while the owner is paged.
      - **Active → inactive:** only after a restore. The stored root must carry a stamp. The legacy record must be at
        the stamp's `toRev` (same statement), and its digest must be the paged catalog's. The new root names that rev
        and keeps the pages. A swap to inactive without a restore is refused. This was the second review's probe: it
        would have dropped every edit made since activation.
    - `restore`: the legacy write the vault accepts while paged, under all of these:
      - the live nonce in the stored stamp;
      - over exactly the stamp's `fromRev` (anything else is `catalog_legacy_moved`);
      - the root not moved since the stamp (one statement).
    - `collect`: tombstones named generations that no root names.
    - `sweep`: tombstones every page record the current root names neither as `gen` nor as `prevGen`.
- **`set_vault_record`** of `content.catalog` with `data: null` is a tombstone again for a legacy owner, as before the
  paged index. For a paged owner it is refused.
- **Every catalog read** (`get_vault_record`, `get_vault_records` and therefore the Home's `content.getMany`,
  `get_entitled_record`, the native ingress) goes through `readVaultRecordData`. That is the legacy record expanded, or
  the pages assembled. An entitlement's field projection applies to the assembled array.

**The trust boundary**, stated precisely: the commit door is the service MAC plus a tool name only the DO's catalog path
calls. `get_catalog_records` and `catalog_commit` are callable by **any holder of the service MAC key** that also holds
an owner's grant.

- **Who holds the MAC key today.** In this repo, `A2A_MAC_SECRET` is held by `apps/vault` and `apps/agent-runtime`. It is
  generated by `scripts/bootstrap-estate.mts` and `scripts/gen-dev-vars.ts`, and listed in `scripts/estate-shape.mts`.
  Sibling checkouts of ap-home (`ap-home-personas`, `ap-home-old-extraction`) carry the same configuration for their own
  deployments. Under `agentic-kms` the MAC key is derived inside AKCS (`ap-mac-v1`) for whoever holds the tenant's
  AKCS credential.
- **What a MAC holder can and cannot do.** The vault's own checks bound what such a caller can do, whatever it sends:
  - a compare-and-set root;
  - activation only onto an identical copy;
  - deactivation only after a restore;
  - a restore only over the stamped rev;
  - generations written once.

  None of these lets it overwrite the frozen legacy record or drop a paged owner's edits. It can still write a valid
  paged state of its own making, exactly as it could write `content.catalog` before.
- **Not done.** Narrowing the door to the DO module alone would need a dedicated secret shared by the DO and the vault.

## The seam in the interactions DO

Every reader and writer of `content.catalog` in the object passes through `vaultFor`:

- the runtime's `vaultRead` / `vaultWrite`;
- the Home's `record.*` and `content.*` (including the scoped merge);
- the org-package and skill reads.

**Calls and the per-principal limit (120 verified calls / 60 s).** A transient 5xx on `get_catalog_records` is retried
(bounded at 4 tries). Commits are not retried: a compare-and-set or a write-once page must not be repeated blind.

- **Runtime save of a paged owner:** at most 4 vault calls (root read, page read, pages, root swap), plus a collect
  when a page changes again. A held root and held page generations cut that further.
- **Whole-list write:** decided on the held root, with no extra call. The vault guards it: a stale decision is
  refused (`catalog_paged`, `catalog_switched` or `catalog_conflict`) and retried once on a fresh root.
- **Switch actions** (40-entry test owner): prepare 9 calls, activate 28 (one per page compared), deactivate 10.

**Read.** The DO reads the root as stored. Active means it reads the pages (held generations first; a generation never
changes, so a held one is always current) and assembles them. Otherwise it reads the legacy record. A broken root is an
error.

**Whole-list write.** Active means it writes changed pages as new generations and swaps the root. Otherwise the legacy
write goes to the vault, which guards it. All catalog writes, edits and switch actions in the object are serialized
(`catalogExclusive`).

**Other rules:**

- `internal.library.catalogEdit` is the runtime save's one-page edit. It reads the root fresh and its pages by
  generation.
- Page records cannot be written by naming them: `vaultWrite` returns 403, and `record.put` / `content.put` return 400.
- `record.put` drops the held copy of a Library record it writes. It bypassed `writeDoc`, so the runtime's next read
  got a copy up to a minute old.

**Read grants (S4) are catalog writes too.** `library.grant.issue` and `library.grant.revoke` record on a catalog entry's
`grants[]`. For a paged owner they take the same one-page edit, by id, under the lease:

- **Issue on a document:** reads the root and that document's page.
- **Issue on a folder:** writes the root alone; a new folder entry is appended to the root bucket.
- **Revoke:** finds the grant page by page.

A legacy owner is written as before, and a side-by-side test holds the two equal. The other S2/S4/S5 readers
(`library.grants.list`, `library.granted.read`, the grant preconditions) read the whole list through the seam.

**The runtime save** (`library-paged.ts`) reads the root and the document's page through `catalogStore`, which bypasses
the run's memo. It runs the same pure rules, writes the document's record, and then calls `catalogEdit`. A differential
test runs ten acts on both the paged and the whole-list path, and the answers, the index and every artifact record come
out identical.

## The switch: copy → verify → switch (never move)

The DO op is `internal.library.paged` (in-Worker marker only). The operator's door is `POST /custody/library/paged`
(bridge-HMAC, audience `custody.library.paged`). It is driven by `apps/agent-runtime/scripts/catalog-paged.mts`, which
is a dry run by default. A switch action is refused while a Library save holds the lease (`catalog_busy`), and holds
the lease itself while it runs.

**Every switch action reads the legacy record AS STORED** (`get_catalog_records`). An ordinary read would assemble the
pages and compare pages to pages; that was the review's first finding.

1. **`status`**:
   - the root;
   - the legacy record's stored rev, total and digest;
   - `legacyUnchangedSincePrepare` (when inactive) or `legacyUnchangedSinceActivate` (when active).
2. **`prepare`**: copies the legacy record into new page generations plus an inactive root. It records
   `migratedFrom = { hash: catalogDigest(legacy), legacyRev }`. The legacy record is not touched.
3. **`verify`**: compares the pages to the legacy record entry by entry (value and key order), plus the order, the root
   bucket and the count.
4. **`activate`**: runs only if verify passes now **and** the legacy record's stored rev and digest equal
   `migratedFrom`. It swaps the root to active with `activation.legacyRev`, and the vault re-checks that rev atomically.
5. **`deactivate`** (the rollback). It is **resumable**: run it again after any failure, and it continues from what
   the vault says. All checks come before any write:
   - **Checks:**
     - The legacy record must be at the rev the switch froze (`activation.legacyRev`), or at the `toRev` of this
       rollback's own stamp, meaning its restore already landed. Anything else is `catalog_legacy_moved`: nothing is
       written, merge by hand.
     - Every page is read fresh and must match its hash.
     - The digest of the current paged catalog is computed.
   - **Writes:**
     1. If the stamp's restore already landed and the legacy record's digest equals the pages', go straight to the
        swap.
     2. Otherwise, stamp a restore over the legacy record's current rev (`fromRev`, landing as `toRev`), and restore.
        The vault checks the nonce, the `fromRev`, and that the root has not moved.
     3. Read the record back **as stored**: its rev and its digest.
     4. Swap the root to inactive, naming the restored rev. The vault refuses this swap unless the restore happened and
        matches.
   - **On success:** `migratedFrom` is reset to the restored record, so `activate` can be run again straight away.
   - **When the swap's answer is lost:** a deactivate whose swap already landed answers `ok, already`. `activate`
     behaves the same way when its own swap's answer was lost.
   - **Tested:** every vault call of prepare, activate and deactivate, interrupted both before the vault ran it and
     after it ran with its answer lost. In every case the catalog reads the same, and running the action again
     finishes it. The reviewer's probe cases (a lost read-back, a lost swap) are among these tests.

Once an owner is active, the legacy record is the frozen pre-switch backup. Nothing writes it except the restore.

**Measured peak memory of the switch.** These are live heap samples, with a forced GC at each vault call, in one
process that also runs the vault (so they are an upper bound for the DO). The workload is 3,000 entries: 5.2 MB
compact, 12.6 MB expanded, about 6.9 MB of ciphertext, so somewhat larger than Demo Admin.

| action | live peak over idle |
| --- | --- |
| prepare | 19.0 MB |
| verify | 15.7 MB |
| activate | 15.6 MB |
| one page edit | 0.5 MB |
| deactivate | 20.9 MB |

Deactivate holds the compact restore body and the read-back, never the pages, the assembled list and the read-back
together. Garbage between collections comes on top of these figures.

**Per-owner procedure** (for example Demo Admin): `status` → `prepare --execute` → `verify --execute` → read the
report → `activate --execute` → watch a save or publish. To undo, run `deactivate --execute`.

**Runbook: a deactivate that did not finish.**

1. Run `status`. `paged: true` with `rollbackInProgress` shows the stamp's `fromRev`/`toRev` and whether its restore
   has landed (`restoreLanded`).
2. Run `deactivate --execute` again. That is all that is needed after a 5xx, a throttle, a lost answer or an eviction.
3. If it answers `catalog_legacy_moved`, the legacy record was written by something other than this rollback while
   the owner was paged. That needs a write that bypassed every vault guard. The owner stays paged and nothing is lost.
   Compare the legacy record (`status` → `legacy`) with the pages by hand, then write the merge back as the paged
   catalog (a whole-list `content.catalog` write through the DO). Then restore the legacy record's version to the
   stamp's chain, which is an operator action on D1. Do not deactivate until it is merged.
4. If it answers `catalog_restore_mismatch`, run `deactivate` again. A further restore over the rev the previous one
   produced is allowed.

**Runbook: a broken root.** The owner's Library fails closed until the root is repaired:

- **A deleted root:** clear `deleted_at` on the `vault:content.catalog.root` row in D1. The row keeps its data.
- **A root that does not parse:** restore it from the last good value (the root is small; check `seq`).

The vault refuses to write over either state.

## What still touches the whole list

- **Whole-list readers, by design.** `library.files.list`, `library.file.read`, the public shelf, the publisher
  contract, the Home's GET and the org-package read all get the same array as before. Their memory is O(N).
- **Whole-list writers.** The Home (person `record.put`, org `content.put`) still sends the whole list. The DO stores
  only changed pages, but the request is still O(N).
- **Page by page, one page held at a time** (only matches kept):
  - a save naming no well-formed id (today's rule looks for the document already at that path);
  - visibility or publish named by `name` rather than `id`;
  - a release of a bundle folder;
  - the indexer hint after a folder change.

## Concurrency: what is still racy

- Runtime saves hold the `holdCatalog` lease. The DO serializes every catalog write, and the root swap is a
  compare-and-set at the vault, so two writers can never interleave inside a page or overwrite each other's root.
- **The Home's writers take no lease.** A runtime save that lands between the Home's read and its whole-list write is
  dropped by that write. The race is the same as today. The fix is for the Home to send edits instead of lists; Home
  is untouched here.
- The Home person read falls back to its KV cache when the vault answers nothing, and can write a stale list back.
  This is unchanged.

## Behaviour changes before any `activate`

These apply to every owner from the moment the code is deployed:

- **A legacy save refuses on a failed index read.** When the harness supplies `readSubjectRecordStatus` (it does), a
  catalog read that *failed* now refuses the save ("could not be read … nothing was saved"). Before, it was read as an
  empty Library and the index was overwritten with one entry.
- **`library.file.visibility` no longer writes `content.artifact.<id>`** unless the entry still carries its bytes
  inline. It used to write the record from the index entry, which erased the document's body.
- **Extra root reads.**
  - **Agent-runtime:** every catalog read and write through the DO first reads the root (held for a minute on the
    runtime's read), and every runtime save reads it once (`pagedRootOf`). If that read fails, the operation fails
    closed.
  - **Vault:** every `content.catalog` write reads the root (the guard) and every catalog read reads it. A paged read
    opens up to 33 envelopes; the DEK cache softens repeats.
- **Narrowly scoped grants are not broken.** The root and pages are authorized as `vault:content.catalog`. Any grant
  that could read or write the catalog before can read or write it now; there is no new scope requirement. The vault
  still refuses ordinary writes of the reserved names.
- **`get_entitled_record`** of a compact catalog now returns the expanded array instead of `{}`.
- **`list_vault_record`** and the vault viewer show `content.catalog.root` and page generations for prepared or active
  owners.

## Deploy order and rollback runbook

**Deploy preflight.** `pnpm --filter @ap-home/agent-runtime run deploy -- --env <name>` now runs `scripts/deploy.mts`.
It reads `MCP_URL` for that env from `wrangler.toml` (or `VAULT_URL`), asks the vault's `/health`, and refuses to
deploy unless the answer names `catalogDoor: ap.catalog.paged.v2`. Only then does it run `wrangler deploy` with the
same arguments.

- **A bare `wrangler deploy --env faithnet|impact-agent`** runs the same check. `wrangler.toml` gives both environments
  a `build.command` of `deploy.mts --preflight-only`, which wrangler runs before bundling. Verified with
  `wrangler deploy --dry-run`: the deploy stops against a vault without the door and passes against one with it.
  CI and the estate's deploy scripts go through one of these two routes.
- **Skipping it:** set `VAULT_PREFLIGHT_ACK=deploy-without-catalog-door`.
- **Not covered:** a deploy to a new environment that has no `[env.<name>.build]`. If the check is skipped, every
  Library read and save for every owner fails closed with "deploy apps/vault first".
- **There is no 404→legacy fallback, on purpose.** After a vault rollback, a fallback would serve frozen records and
  accept writes into them.

**Deploy in this order:**

1. **The vault service first.** It adds the catalog door, the guards and the assembling read. With no root anywhere,
   it answers exactly as before except for the changes listed above.
2. **Then the agent-runtime** (Worker and DO together). **Never deploy it before the vault.** The new DO reads the root
   through `get_catalog_records`, and against an old vault that tool is a 404. The DO then fails closed: every Library
   read and save fails with "deploy apps/vault first". Nothing is lost, but nothing works.
3. **Home: no change needed.** Home writes go through the DO seam. The Home cap (`MAX_ARTIFACTS_DEFAULT` 2000 /
   `LIBRARY_MAX_ARTIFACTS`) is not aligned to 10,000 here; that is a separate Home change.
4. **Then, per owner, the switch above.**

**Rollback.** Before rolling back **either** service, run `deactivate --execute` for every owner whose `status` says
`paged: true`, and confirm `status` afterwards. If someone rolls back without doing that:

- **Vault rolled back with active owners.** Ordinary reads by the Home, apps and members return the frozen legacy
  record: stale, missing every save since the switch. Legacy writes are accepted again, landing in that frozen record.
  The new DO, if still deployed, fails closed (404 on the catalog door). The pages remain intact in D1. To recover:
  redeploy the new vault, then compare `status`. If the legacy rev moved while the old vault was up, `deactivate`
  refuses with `catalog_legacy_moved`, and the two sides must be merged by hand.
- **Agent-runtime rolled back with active owners** (vault still new). The old DO reads correctly, because the vault
  assembles. Its whole-list writes are refused (`catalog_paged`), and its old-style writes of `content.catalog.p<k>` /
  root are refused (`catalog_record_reserved`). Every save fails loudly; nothing is lost. Redeploy, or roll back only
  after `deactivate`.

## Rebalance seam

`pageCount` is recorded in the root and every reader uses it. To change it, run the switch under a new count: prepare,
verify, activate. The symbol table allows up to 64 pages.
