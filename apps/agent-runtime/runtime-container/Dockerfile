# SPEC 400 W1c — the runtime member's Container: Node + `ap runtime serve` + the ACP agent, next to the Worker.
# Build input: @agenticprimitives/runtime-member + acp from npm (pinned below); the Container is a CONSUMER of the kit,
# never a checkout.
# wrangler builds this image on `deploy --env faithnet` (see [[env.faithnet.containers]]).
#
# What runs: `ap runtime serve` on :8080, woken by the Worker's queue consumer (POST /wake). The agent it spawns is
# named by AP_RUNTIME_AGENT — `acp-stub-agent` (the deterministic stub; the live gate's agent) or `claude-code-acp`
# (Claude Code over ACP; needs the operator's ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). The member's record
# and key arrive as AP_RUNTIME_RECORD / AP_RUNTIME_KEY from the Worker's secrets (see src/runtime-container.ts).
FROM node:22-slim
WORKDIR /host
# LAYER 1 (stable, cached, pushed once): the outside deps — the kit's peer (viem), the ACP adapter for Claude Code,
# Claude Code itself. Nothing of ours in it, so a kit change never re-pushes these hundreds of MB.
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock viem@^2.52.2 @zed-industries/claude-code-acp@0.16.2 @anthropic-ai/claude-code@2.1.270 2>&1 | tail -2 \
 && ln -s /host/node_modules/.bin/claude-code-acp /usr/local/bin/claude-code-acp
# LAYER 2 (per kit change, small): the kit, FROM NPM at the exact versions this repository pins (ap-home is a consumer —
# there is no workspace to pack; Ring 0 built ./tarballs from its own packages). Bump with the coherent set.
ARG RUNTIME_MEMBER_VERSION=0.0.0-alpha.4
ARG ACP_VERSION=0.0.0-alpha.4
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock @agenticprimitives/runtime-member@$RUNTIME_MEMBER_VERSION @agenticprimitives/acp@$ACP_VERSION 2>&1 | tail -2 \
 && printf '#!/bin/sh\nexec node /host/node_modules/@agenticprimitives/acp/bin/acp-stub-agent.mjs "$@"\n' > /usr/local/bin/acp-stub-agent && chmod +x /usr/local/bin/acp-stub-agent \
 && ln -sf /host/node_modules/.bin/ap-runtime /usr/local/bin/ap-runtime
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# The member's name comes from the record the Worker supplies; the agent from AP_RUNTIME_AGENT.
CMD ["sh", "-c", "exec ap-runtime serve --member \"$AP_RUNTIME_MEMBER\" --agent \"${AP_RUNTIME_AGENT:-acp-stub-agent}\" --port 8080"]
