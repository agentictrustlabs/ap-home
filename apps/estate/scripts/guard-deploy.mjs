// `pnpm deploy:faithnet` runs this first. The site deploys from master by CI (.github/workflows/estate-deploy.yml). By hand, it deploys only what
// master holds: a deploy from a branch replaces the live site with that branch, and drops any route or page it lacks. That stranded everybody
// signing out on 2026-11-05. It cannot stop a bare `wrangler deploy`.
import { execSync } from 'node:child_process';

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
sh('git fetch -q origin master');
const refuse = (why) => { console.error(`refusing to deploy: ${why}. The site deploys from master.`); process.exit(1); };
if (sh('git status --porcelain -- .')) refuse('apps/estate has uncommitted changes');
if (sh('git rev-parse HEAD') !== sh('git rev-parse origin/master')) refuse('HEAD is not origin/master');
