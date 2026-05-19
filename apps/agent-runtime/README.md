# apps/demo-a2a

The demo a2a-agent server. Hono on port 8787 by default. Holds:

- A master signer (read from env via `@agenticprimitives/key-custody`'s `LocalSecp256k1Signer`).
- Per-user sessions in a local SQLite DB (`a2a-sessions.db`). Session private keys are envelope-encrypted via `LocalAesProvider`.
- Mints `DelegationToken` envelopes for downstream MCP servers.

## Dev

```bash
pnpm dev:a2a
```

Env (set in `.env` or shell):

```
A2A_KMS_BACKEND=local-aes
A2A_SESSION_SECRET=<hex>           # dev only; never use in prod
A2A_MASTER_PRIVATE_KEY=0x...        # dev master signer; never use in prod
SESSION_JWT_SECRETS=devkid:<hex>   # for identity-auth JWT
RPC_URL=http://127.0.0.1:8545      # Anvil
CHAIN_ID=31337
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `POST /auth/siwe-verify` | verify SIWE message → mint JWT session |
| `POST /session/init` | start a new session, return `sessionId` + `sessionKeyAddress` |
| `POST /session/package` | accept user-signed delegation, activate session |
| `POST /tools/:name` | proxy a tool call to the appropriate MCP |

All routes return 501 until the corresponding `@agenticprimitives/*` packages are implemented.
