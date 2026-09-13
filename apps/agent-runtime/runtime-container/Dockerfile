# SPEC 400 W1c — the runtime member's Container: Node + `ap runtime serve` + the ACP agent, next to the Worker.
# Build input: ./tarballs, made by `node runtime-container/build.mjs` — @agenticprimitives/runtime-member and the
# closure of its workspace dependencies as npm tarballs; the Container is a CONSUMER of the kit, never a checkout.
# wrangler builds this image on `deploy --env faithnet` (see [[env.faithnet.containers]]).
#
# What runs: `ap runtime serve` on :8080, woken by the Worker's queue consumer (POST /wake). The agent it spawns is
# named by AP_RUNTIME_AGENT — `acp-stub-agent` (the deterministic stub; the live gate's agent) or `claude-code-acp`
# (Claude Code over ACP; needs the operator's ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). The member's record
# and key arrive as AP_RUNTIME_RECORD / AP_RUNTIME_KEY from the Worker's secrets (see src/runtime-container.ts).
FROM node:22-slim
WORKDIR /host
COPY tarballs ./tarballs
# The kit and its closure from the tarballs; its peer (viem); the ACP adapter for Claude Code; Claude Code.
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock ./tarballs/*.tgz viem@^2.52.2 @zed-industries/claude-code-acp@0.16.2 @anthropic-ai/claude-code@2.1.270 2>&1 | tail -2 \
 && rm -rf ./tarballs \
 && printf '#!/bin/sh\nexec node /host/node_modules/@agenticprimitives/acp/bin/acp-stub-agent.mjs "$@"\n' > /usr/local/bin/acp-stub-agent && chmod +x /usr/local/bin/acp-stub-agent \
 && ln -s /host/node_modules/.bin/claude-code-acp /usr/local/bin/claude-code-acp \
 && ln -s /host/node_modules/.bin/ap-runtime /usr/local/bin/ap-runtime
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# The member's name comes from the record the Worker supplies; the agent from AP_RUNTIME_AGENT.
CMD ["sh", "-c", "exec ap-runtime serve --member \"$AP_RUNTIME_MEMBER\" --agent \"${AP_RUNTIME_AGENT:-acp-stub-agent}\" --port 8080"]
