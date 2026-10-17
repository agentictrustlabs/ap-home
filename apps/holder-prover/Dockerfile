# THE HOLDER'S PROVER (private-scripture W4) — a Cloudflare Container beside the agent runtime. Why a container: the OpenAC 1k
# Prepare PROVING key is 274 MB; a Worker cannot hold it. wrangler builds this image on `deploy --env faithnet`
# ([[env.faithnet.containers]] in ../agent-runtime/wrangler.toml). Build context = this directory: server.mjs, package.json,
# the openac-sdk patch (the device key signs through a callback, never as a raw scalar), and keys/ (the 1k proving AND
# verifying keys, ≈560 MB, copied from `~/.cache/openac-5.0.0` — gitignored).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
WORKDIR /prover
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock 2>&1 | tail -2
COPY openac-sdk@5.0.0.patch /tmp/
RUN cd node_modules/openac-sdk && patch -p1 < /tmp/openac-sdk@5.0.0.patch
COPY keys/1k_prepare_proving.key keys/1k_prepare_verifying.key keys/1k_show_proving.key keys/1k_show_verifying.key /keys/
COPY server.mjs ./
ENV NODE_ENV=production PORT=8080 OPENAC_KEYS_DIR=/keys NODE_OPTIONS=--max-old-space-size=3584
EXPOSE 8080
CMD ["node", "server.mjs"]
