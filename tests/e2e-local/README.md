# The Home, built for real, tested locally (spec 445 §14)

The real production build in a real browser, with an in-memory KV and a scriptable chain (`fake-backends.mjs`). No live
estate, no gas, no model calls. The preview is behind Vercel Authentication, so this is where wires can be revoked at will.

    tests/e2e-local/build.sh                          # builds with the test flags, and restores them
    npx playwright test -c tests/e2e-local

`build.sh` leaves a build with a test flag in `apps/home/.next`. Delete it before running the Home locally for anything else.
