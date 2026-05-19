# apps/demo-mcp

Demo MCP server playing the role of a "person repository." Hono on port 8788. Holds simple PII (full_name, email, phone, notes) in a local SQLite DB.

Tools exposed:
- `POST /tools/get_profile` — read the caller's profile (delegation-verified)
- `POST /tools/update_profile` — update the caller's profile (delegation-verified, validated)
- `POST /_dev/seed` — dev-only, bypasses delegation (useful for testing before mcp-runtime is wired)

## Dev

```bash
pnpm dev:mcp
```

Env:

```
PORT=8788
MCP_DB_PATH=./demo-mcp.db
```

## Status

Tool handlers return 501 until `@agenticprimitives/mcp-runtime`'s `withDelegation` wrapper is implemented. The DB layer is real and ready — once the auth pipeline lands, swapping the stub handler for `withDelegation(config, ({ principal }) => getProfile(principal))` is one line per tool.

Classification tags (`@sa-tool`, `@sa-auth`, `@sa-risk-tier`, etc.) are already attached as JSDoc comments per [`specs/204-tool-policy.md`](../../specs/204-tool-policy.md).
