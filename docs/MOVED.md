# MOVED

<!-- The text the CUT PR drops into Ring 0 at `apps/<app>/MOVED.md` when this app leaves agenticprimitives
     (spec 399 §5.1 / §5.6). Fill the placeholders; keep it to these lines. -->

This app now lives in **ap-home** (`<repository url>`), extracted with history from agenticprimitives at commit
`<ring-0 commit>` into `<product commit>` on `<date>`.

- Deployer of record: ap-home (see its `DEPLOYER.md`). Worker names, DO bindings and migration tags are unchanged.
- Product specs: copied to `ap-home/specs/`; the Ring-0 copies are pointers listed in `specs/INDEX.md`.
- Ops scripts: `ap-home/scripts/`.
- Reversible by reverting the cut PR for seven nights after `<date>`.
