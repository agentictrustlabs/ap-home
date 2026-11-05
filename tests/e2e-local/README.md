# The Home, built for real, tested locally (spec 445 §14)

The real production build in a real browser, with an in-memory KV and a scriptable chain (`fake-backends.mjs`). No live
estate, no gas, no model calls. The preview is behind Vercel Authentication and the live Home has no flag turned on, so this
is the only place the remembered path runs end to end before W4.

    tests/e2e-local/build.sh                          # builds with the test flags, and restores them
    npx playwright test -c tests/e2e-local

`build.sh` leaves a build with the reader `on` in `apps/home/.next`. Delete it before running the Home locally for anything else.
