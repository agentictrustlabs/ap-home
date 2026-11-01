# The paged Library catalog

Status: implemented on branch `library-paged-catalog` (on top of the compact-catalog codec, PR #78). Not deployed. **No
owner changes until an operator runs `activate` for that owner.**

## What and why

`content.catalog` is one vault record per owner: the Library index, a JSON array of entries, sealed whole
(`vault_objects`, ciphertext = base64(AES-GCM(JSON))). Demo Admin (`0x6142b0fca982f6701cf2248bf368ab44a48c5725`) holds
3,001 entries, 6.1 MB of ciphertext even after the compact codec. Every save read, decrypted, expanded, cloned and
rewrote all of it inside the interactions Durable Object; at ~4.5 MB that ran the DO out of memory, and `CATALOG_MAX`
(3,000) now blocks publishing.

A **paged** owner keeps the same list as 33 records, and a save moves one page and the root:

| record | holds |
| --- | --- |
| `content.catalog.root` | the switch, the order, the folders, and an index of the pages |
| `content.catalog.p<k>`, k = 0..31 | the document rows whose page is `fnv1a32(id) mod 32`, in list order, compact-coded (`catalog-codec.ts`) |

Measured in `test/library-paged.test.ts` (6,000 synthetic documents with release signatures, 3.6 MB compact): a save by
id moves 371 KB of records in total (two reads and one write of its page and the root, plus the document's own record).
That is 5.1 % of the 7.2 MB a whole-list save moved (one full read plus one full write). The cap goes to 10,000 for a
paged owner.

## Record shapes

```ts
// content.catalog.root
{
  format: 'ap.catalog.paged.v1',
  active: boolean,            // the switch: only `true` makes the pages the catalog
  pageCount: 32,              // what this root was split with; every reader uses it
  pages: [{ k, count, hash }],// hash = sha256(JSON.stringify(plain rows of page k))
  total: number,              // rows in the assembled list
  order: string,              // one symbol per assembled row: its page ('0-9a-zA-Z-_') or '~' (the root bucket)
  folders: [...],             // the root bucket: folder rows and any row that is not a document, in list order
  migratedFrom?: { hash, total, at }, // what `prepare` copied: catalogDigest(legacy list)
  rev: number, updatedAt: number,
}
// content.catalog.p<k>: compactCatalog(rows), so it is either the plain array or { $format: 'ap.catalog.compact.v2', sigBases, entries }
```

**Order.** The brief allowed either an ordinal on each entry or an order list in the root. I chose an order *string* in
the root. Each bucket keeps its rows in their relative list order, so the sequence of bucket symbols is the whole merge.
`assemble(split(x))` reproduces `x` position for position. No field is added to an entry that a reader would see, and
the string is 1 byte per row (10 KB at the cap), where a list of ids would be about 250 KB.

**Rows that are not documents** go to the root bucket: folders (the effective-policy rule needs all of them on every
save), and anything without a string `id` and `name`. Today's whole-list save quietly drops such rows (`rawCatalogOf`
filters them). The paged form keeps them.

**Torn writes.** Changed pages are written first and the root last. If a write tears between the two, a page holds
rows the root does not describe. Assembly never drops them: rows past the order are appended in bucket order. A
page-local edit re-fits the order to the page it read. A page the root says holds rows but that is **absent** is an
error and never an empty page (`pageRows`).

## Where it is enforced (the seam)

- **`catalog-pages.ts`**: the format. It exists as the same bytes in `apps/agent-runtime/src` and `apps/vault/src`, and
  a test in each app holds the two copies equal (as with the codec).
- **The interactions DO** (`interactions-do.ts`, `vaultFor`): every reader and writer of `content.catalog` in the
  object passes through it. That covers the runtime's `internal.coordination.vaultRead`/`vaultWrite`, the Home's
  `record.get`/`record.put` (person) and `content.get`/`content.put` (org, including the scoped merge), and the
  org-package and skill reads.
  - read: root active → pages (batches of 8 via `get_vault_records`) → assembled plain array. Otherwise the legacy
    record as before. A grant that cannot read the root (an app's grant scoped to `vault:content.catalog` exactly) asks
    the vault for `content.catalog`, and the vault assembles it.
  - write (whole list): root active → only the pages whose hash changed, then the root. Otherwise the legacy record as
    before. Serialized with the switch and the page edit (`catalogExclusive`).
  - The runtime's held minute (`libraryDocs`) holds pages (compact) and the root, never the assembled list.
  - The page records cannot be written by naming them (`vaultWrite` 403; `record.put`/`content.put` 400). Only the
    catalog paths write them.
  - `record.put` now drops the held copy of a Library record it writes. It bypassed `writeDoc`, so the runtime's next
    read got a copy up to a minute old. That was the bug.
- **The vault service** (`catalog-read.ts`, `readVaultRecordData`): `get_vault_record`, `get_vault_records` (and so the
  Home's `content.getMany`), `get_entitled_record` and the native ingress all return the same assembled, expanded array.
  - `get_entitled_record` used to project the stored compact object, so a member got `{}`. Now it projects the
    assembled array.
  - Pages are the catalog's storage and not separate grants: a caller authorized for `vault:content.catalog` reads the
    catalog.
  - A whole-list write of a paged owner's **legacy** record is refused (`catalog_paged`). Otherwise an app writing the
    vault directly would land its write where no reader looks. Only the rollback passes `pagedRestore: true`.
- **The runtime save** (`library-paged.ts`, entered from `libraryWriteHeld` when the root is active): it reads the root
  and one page through `catalogStore`, which bypasses the run's memo so a scan never keeps every page. It runs the same
  pure rules over folders plus that page. It writes the document's record first, then `internal.library.catalogEdit`.
  That edit reads the root and the page fresh, replaces each row by id or appends it, and writes the page and then the
  root.
  - A differential test runs ten acts (saves by id, saves by path, a new folder, a skill in it, visibility by name,
    releases of a page and of a bundle folder) against both paths. The answers, the index and every artifact record
    come out identical.
  - All of this runs inside the existing `holdCatalog` lease. `holdCatalog` now also forgets the run memo of the root
    and the pages.

## What still touches the whole list

- **Every whole-list reader**, on purpose: `library.files.list`, `library.file.read`, the public shelf, the publisher
  contract, the Home's GET, the org-package read. They get the same array as before (assembled in the DO or the vault).
  Their memory is O(N), as it is today.
- **Whole-list writers**: the Home (person `record.put`, org `content.put`) still sends the whole list. The DO pages
  the write and stores only the changed pages, but the request is still O(N) in the Home and the DO.
- **Page by page, one page held at a time** (only matches kept): a save that names no well-formed id (today's rule
  lands it on the document already at that path, so every page is looked at), a visibility change or a release named
  by `name` rather than `id` (the match tiers are Library-wide), a release of a bundle folder (its bundle root covers
  every document in it), and the indexer hint after a change to a folder (up to 50 documents under it).
- **The switch itself**: `prepare` and `verify` hold the legacy list plus one page. `deactivate` holds the assembled
  list plus the read-back.

## Concurrency: what is still racy

- Runtime saves hold the `holdCatalog` lease, and inside the DO every catalog write (page edit, whole-list write,
  switch) is serialized. Two writes can therefore never interleave inside a page or tear the root against each other.
- **The Home's writers take no lease.** They read the list, change it, and write the whole list back. A runtime save
  that lands between the Home's read and its write is dropped by that write, because its row is missing from the
  Home's list. The race is the same as today and paging does not widen it. Routing the Home through the lease would not
  close it either, because the window is the Home's own read → write across two requests. The fix would be for the Home
  to send edits (`catalogEdit`-style) instead of lists. Not done here: Home is untouched.
- The Home person read falls back to its KV cache when the vault answers nothing, and then writes that list back. A
  stale KV list can overwrite newer entries. This is unchanged.

## The switch: copy → verify → switch (never move)

The DO op is `internal.library.paged` (in-Worker marker only). The operator's door is `POST /custody/library/paged`
(bridge-HMAC, audience `custody.library.paged`, CSRF-exempt like the other bridge routes), driven by
`apps/agent-runtime/scripts/catalog-paged.mts`. That script is a dry run by default: without `--execute` it sends only
`status`. A switch action is refused while a Library save holds the lease (`catalog_busy`) and holds the lease itself
while it runs.

1. `status`: the root (if any), the legacy record's total and digest, and whether the legacy record is unchanged since
   prepare.
2. `prepare`: reads the legacy record and writes all 32 pages plus an **inactive** root, with
   `migratedFrom = catalogDigest(legacy)` (digested page by page and never serialized whole). The legacy record is not
   touched. It is refused if the owner is already active.
3. `verify`: compares the pages to the legacy record entry by entry (canonical value and exact JSON key order), plus
   the order string, the root bucket and the count. It reports the first 20 mismatches.
4. `activate`: runs only if verify passes **now** and `catalogDigest(legacy) === migratedFrom.hash` (no write since
   prepare). It sets `active: true` on the root. The script also runs `verify` first and refuses on failure.
5. `deactivate` (the rollback): assembles the **current** pages, which include every save since the switch, writes them
   to the legacy record (`pagedRestore`), reads it back and compares it to the pages, and only then sets `active:
   false`. `migratedFrom` is reset to the restored record, so `activate` can be run again straight away. If the
   read-back does not match, the owner stays paged and nothing is lost.

Once an owner is active, the legacy record is the frozen pre-switch backup. The paged path never writes it, and the
vault refuses anyone else's whole-list write of it.

Per-owner procedure (for example Demo Admin): `status` → `prepare --execute` → `verify --execute` → read the report →
`activate --execute` → watch a save or publish → done. To undo, run `deactivate --execute`.

## Deploy order

1. **Vault service first.** It must assemble a paged `content.catalog` for every non-DO reader, and refuse legacy
   writes over an active root, before any root can become active. Until a root is active this deploy changes no
   answer. The only differences are that `get_entitled_record` now expands a compact catalog, and that every
   `content.catalog` write costs one extra root read.
2. **Agent-runtime** (the Worker and the DO in one deploy). With no active root anywhere, the DO behaves as before. The
   costs are one root read per catalog read or write (held for a minute in the runtime's read) and one root read per
   runtime save.
3. **Home**: no change is needed. Home writes go through the DO seam. If the Home cap (`MAX_ARTIFACTS_DEFAULT` 2000 /
   `LIBRARY_MAX_ARTIFACTS`) should follow the paged cap, that is a separate Home change. It is not aligned here.
4. Then, per owner, the switch above.

**Never roll back the vault service while any owner is active.** An older vault serves the frozen legacy record to
non-DO readers. Run `deactivate` for each active owner first. Rolling back the agent-runtime while an owner is active fails safe but
fails. The old DO still reads correctly, because it asks the vault for `content.catalog` and the new vault assembles
it. Its whole-list writes go to the legacy record and are refused with `catalog_paged`, so they fail loudly rather than
vanish, but every save fails. Deactivate first.

## Rebalance seam

`pageCount` is recorded in the root and every reader uses it. To change it, run the same switch: prepare under a new
count, verify, activate. Today `prepare` always uses `CATALOG_PAGE_COUNT` (32). The symbol table allows up to 64 pages;
going beyond that needs a new order encoding (a `v2` format).

## Known costs and risks

- A paged read opens 33 envelopes (root + 32 pages) where it used to open 1, both at the vault and through the DO's
  batch read. The DEK cache softens repeats. A cold read pays 33 unwraps.
- `list_vault_record` and the vault viewer now show `content.catalog.root` and `content.catalog.p*`. A `vault.query`
  selector over `content.catalog` sees the stored shape (compact before, root/pages now). Nothing in this repo queries
  it that way.
- Change detection on whole-list writes trusts the root's page hashes. Suppose a torn write left page k newer than the
  root, and a later writer restores exactly the pre-tear content of page k. That page would be skipped. A theoretical
  gap; the next edit of that page repairs it.
