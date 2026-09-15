# apps/

One directory per deployable. Copied in from Ring 0 with history (`git filter-repo` on a CLONE, never on origin),
or created new. Each carries its own `wrangler.toml` on the layout in `../wrangler.example.toml`, its `.secrets.<env>`
(gitignored), and imports `@agenticprimitives/*` only at the exact versions in `../agentic.lock.json`.
