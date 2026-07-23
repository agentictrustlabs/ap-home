# @agenticprimitives-demo/mcp

## 0.0.2-alpha.18

### Patch Changes

- @agenticprimitives/verifiable-credentials@0.0.0-alpha.17
- @agenticprimitives/types@1.0.0-alpha.20
- @agenticprimitives/audit@1.0.0-alpha.20
- @agenticprimitives/key-custody@1.0.0-alpha.20
- @agenticprimitives/delegation@1.0.0-alpha.20
- @agenticprimitives/tool-policy@1.0.0-alpha.20
- @agenticprimitives/mcp-runtime@1.0.0-alpha.20
- @agenticprimitives/agent-naming@1.0.0-alpha.20

## 0.0.2-alpha.17

### Patch Changes

- @agenticprimitives/verifiable-credentials@0.0.0-alpha.16
- @agenticprimitives/types@1.0.0-alpha.19
- @agenticprimitives/audit@1.0.0-alpha.19
- @agenticprimitives/key-custody@1.0.0-alpha.19
- @agenticprimitives/delegation@1.0.0-alpha.19
- @agenticprimitives/tool-policy@1.0.0-alpha.19
- @agenticprimitives/mcp-runtime@1.0.0-alpha.19
- @agenticprimitives/agent-naming@1.0.0-alpha.19

## 0.0.2-alpha.16

### Patch Changes

- Updated dependencies [77acde0]
  - @agenticprimitives/agent-naming@1.0.0-alpha.18
  - @agenticprimitives/delegation@1.0.0-alpha.18
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.18
  - @agenticprimitives/types@1.0.0-alpha.18
  - @agenticprimitives/audit@1.0.0-alpha.18
  - @agenticprimitives/key-custody@1.0.0-alpha.18
  - @agenticprimitives/tool-policy@1.0.0-alpha.18
  - @agenticprimitives/verifiable-credentials@0.0.0-alpha.15

## 0.0.2-alpha.15

### Patch Changes

- 528b69e: Spec 311 server complement — `GET /custody/vault-key/is-bound` now does a
  CURRENCY check, not just existence. A vault-key binding row survives a
  full-reset redeploy, but its stored authorization binds the old
  DelegationManager and no longer ERC-1271-verifies against the new one — so
  existence-only `is-bound` returned `bound: true`, the client skipped
  re-binding, and every read failed `vault_key_unauthorized` forever.
  `isVaultKeyBindingCurrent` re-runs the read path's signature verify; a stale
  binding now returns `bound: false` + `stale: true` so onboarding re-binds
  against the live contracts. Fail-open only on RPC error (no re-bind storm on a
  transient blip; the per-read path fail-closes on the same check).
- Updated dependencies [f646aa3]
- Updated dependencies [2f5e96c]
- Updated dependencies [e21098f]
- Updated dependencies [bdd6424]
  - @agenticprimitives/key-authorization@0.0.0-alpha.4
  - @agenticprimitives/verification-receipts@0.0.0-alpha.1
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.17
  - @agenticprimitives/verifiable-credentials@0.0.0-alpha.14
  - @agenticprimitives/agent-naming@1.0.0-alpha.17
  - @agenticprimitives/delegation@1.0.0-alpha.17
  - @agenticprimitives/types@1.0.0-alpha.17
  - @agenticprimitives/audit@1.0.0-alpha.17
  - @agenticprimitives/key-custody@1.0.0-alpha.17
  - @agenticprimitives/tool-policy@1.0.0-alpha.17

## 0.0.2-alpha.14

### Patch Changes

- Updated dependencies [71c68e3]
  - @agenticprimitives/audit@1.0.0-alpha.16
  - @agenticprimitives/edge-runtime@0.0.0-alpha.2
  - @agenticprimitives/delegation@1.0.0-alpha.16
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.16
  - @agenticprimitives/key-custody@1.0.0-alpha.16
  - @agenticprimitives/types@1.0.0-alpha.16
  - @agenticprimitives/tool-policy@1.0.0-alpha.16
  - @agenticprimitives/agent-naming@1.0.0-alpha.16
  - @agenticprimitives/verifiable-credentials@0.0.0-alpha.13

## 0.0.2-alpha.13

### Patch Changes

- @agenticprimitives/types@1.0.0-alpha.15
- @agenticprimitives/audit@1.0.0-alpha.15
- @agenticprimitives/key-custody@1.0.0-alpha.15
- @agenticprimitives/delegation@1.0.0-alpha.15
- @agenticprimitives/tool-policy@1.0.0-alpha.15
- @agenticprimitives/mcp-runtime@1.0.0-alpha.15
- @agenticprimitives/agent-naming@1.0.0-alpha.15
- @agenticprimitives/verifiable-credentials@0.0.0-alpha.12

## 0.0.2-alpha.12

### Patch Changes

- Updated dependencies [5ee7d28]
  - @agenticprimitives/audit@1.0.0-alpha.14
  - @agenticprimitives/chain-state-viem@0.0.0-alpha.2
  - @agenticprimitives/delegation@1.0.0-alpha.14
  - @agenticprimitives/key-custody@1.0.0-alpha.14
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.14
  - @agenticprimitives/types@1.0.0-alpha.14
  - @agenticprimitives/tool-policy@1.0.0-alpha.14
  - @agenticprimitives/agent-naming@1.0.0-alpha.14
  - @agenticprimitives/verifiable-credentials@0.0.0-alpha.11

## 0.0.2-alpha.11

### Patch Changes

- @agenticprimitives/types@1.0.0-alpha.13
- @agenticprimitives/audit@1.0.0-alpha.13
- @agenticprimitives/key-custody@1.0.0-alpha.13
- @agenticprimitives/delegation@1.0.0-alpha.13
- @agenticprimitives/tool-policy@1.0.0-alpha.13
- @agenticprimitives/mcp-runtime@1.0.0-alpha.13
- @agenticprimitives/agent-naming@1.0.0-alpha.13

## 0.0.2-alpha.10

### Patch Changes

- Updated dependencies [72101cd]
  - @agenticprimitives/key-authorization@0.0.0-alpha.3
  - @agenticprimitives/mcp-oauth@0.0.0-alpha.2
  - @agenticprimitives/entitlements@0.0.0-alpha.2
  - @agenticprimitives/agent-naming@1.0.0-alpha.12
  - @agenticprimitives/delegation@1.0.0-alpha.12
  - @agenticprimitives/key-custody@1.0.0-alpha.12
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.12
  - @agenticprimitives/types@1.0.0-alpha.12
  - @agenticprimitives/audit@1.0.0-alpha.12
  - @agenticprimitives/tool-policy@1.0.0-alpha.12

## 0.0.2-alpha.9

### Patch Changes

- Updated dependencies [4be81e2]
- Updated dependencies [5ebe83a]
- Updated dependencies [463fe8a]
- Updated dependencies [ab65637]
- Updated dependencies [56289ef]
- Updated dependencies [5322a07]
- Updated dependencies [09aaaed]
  - @agenticprimitives/agent-naming@1.0.0-alpha.11
  - @agenticprimitives/delegation@1.0.0-alpha.11
  - @agenticprimitives/key-custody@1.0.0-alpha.11
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.11
  - @agenticprimitives/tool-policy@1.0.0-alpha.11
  - @agenticprimitives/vault@0.0.0-alpha.2
  - @agenticprimitives/key-authorization@0.0.0-alpha.2
  - @agenticprimitives/types@1.0.0-alpha.11
  - @agenticprimitives/audit@1.0.0-alpha.11

## 0.0.2-alpha.8

### Patch Changes

- Updated dependencies [8f69514]
- Updated dependencies [75a24d9]
  - @agenticprimitives/key-custody@1.0.0-alpha.10
  - @agenticprimitives/delegation@1.0.0-alpha.10
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.10
  - @agenticprimitives/agent-naming@1.0.0-alpha.10
  - @agenticprimitives/types@1.0.0-alpha.10
  - @agenticprimitives/audit@1.0.0-alpha.10
  - @agenticprimitives/tool-policy@1.0.0-alpha.10

## 0.0.2-alpha.7

### Patch Changes

- @agenticprimitives/types@1.0.0-alpha.9
- @agenticprimitives/audit@1.0.0-alpha.9
- @agenticprimitives/key-custody@1.0.0-alpha.9
- @agenticprimitives/delegation@1.0.0-alpha.9
- @agenticprimitives/tool-policy@1.0.0-alpha.9
- @agenticprimitives/mcp-runtime@1.0.0-alpha.9
- @agenticprimitives/agent-naming@1.0.0-alpha.9

## 0.0.2-alpha.6

### Patch Changes

- Updated dependencies [fa345d7]
  - @agenticprimitives/delegation@1.0.0-alpha.8
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.8
  - @agenticprimitives/agent-naming@1.0.0-alpha.8
  - @agenticprimitives/types@1.0.0-alpha.8
  - @agenticprimitives/audit@1.0.0-alpha.8
  - @agenticprimitives/key-custody@1.0.0-alpha.8
  - @agenticprimitives/tool-policy@1.0.0-alpha.8

## 0.0.2-alpha.5

### Patch Changes

- Updated dependencies [a04a0e4]
- Updated dependencies [ba49084]
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.7
  - @agenticprimitives/delegation@1.0.0-alpha.7
  - @agenticprimitives/agent-naming@1.0.0-alpha.7
  - @agenticprimitives/types@1.0.0-alpha.7
  - @agenticprimitives/audit@1.0.0-alpha.7
  - @agenticprimitives/key-custody@1.0.0-alpha.7
  - @agenticprimitives/tool-policy@1.0.0-alpha.7

## 0.0.2-alpha.4

### Patch Changes

- @agenticprimitives/types@1.0.0-alpha.6
- @agenticprimitives/audit@1.0.0-alpha.6
- @agenticprimitives/key-custody@1.0.0-alpha.6
- @agenticprimitives/delegation@1.0.0-alpha.6
- @agenticprimitives/tool-policy@1.0.0-alpha.6
- @agenticprimitives/mcp-runtime@1.0.0-alpha.6
- @agenticprimitives/agent-naming@1.0.0-alpha.6

## 0.0.2-alpha.3

### Patch Changes

- Updated dependencies [5475cf9]
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.5
  - @agenticprimitives/types@1.0.0-alpha.5
  - @agenticprimitives/audit@1.0.0-alpha.5
  - @agenticprimitives/key-custody@1.0.0-alpha.5
  - @agenticprimitives/delegation@1.0.0-alpha.5
  - @agenticprimitives/tool-policy@1.0.0-alpha.5
  - @agenticprimitives/agent-naming@1.0.0-alpha.5

## 0.0.2-alpha.2

### Patch Changes

- Updated dependencies [91b5888]
- Updated dependencies [e4c99dc]
- Updated dependencies [6337c17]
  - @agenticprimitives/key-custody@1.0.0-alpha.4
  - @agenticprimitives/mcp-runtime@1.0.0-alpha.4
  - @agenticprimitives/agent-naming@1.0.0-alpha.4
  - @agenticprimitives/delegation@1.0.0-alpha.4
  - @agenticprimitives/types@1.0.0-alpha.4
  - @agenticprimitives/audit@1.0.0-alpha.4
  - @agenticprimitives/tool-policy@1.0.0-alpha.4

## 0.0.2-alpha.1

### Patch Changes

- Updated dependencies [4dde508]
  - @agenticprimitives/types@0.1.0-alpha.3
  - @agenticprimitives/audit@0.1.0-alpha.3
  - @agenticprimitives/key-custody@0.1.0-alpha.3
  - @agenticprimitives/delegation@0.1.0-alpha.3
  - @agenticprimitives/tool-policy@0.1.0-alpha.3
  - @agenticprimitives/mcp-runtime@0.1.0-alpha.3
  - @agenticprimitives/agent-naming@0.1.0-alpha.3

## 0.0.2-alpha.0

### Patch Changes

- Updated dependencies
  - @agenticprimitives/types@0.1.0-alpha.2
  - @agenticprimitives/audit@0.1.0-alpha.2
  - @agenticprimitives/key-custody@0.1.0-alpha.2
  - @agenticprimitives/delegation@0.1.0-alpha.2
  - @agenticprimitives/tool-policy@0.1.0-alpha.2
  - @agenticprimitives/mcp-runtime@0.1.0-alpha.2
  - @agenticprimitives/agent-naming@0.1.0-alpha.2
