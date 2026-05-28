// Back-compat facade — demo-sso-next's domain config now lives in `./domain`
// (the single source, ADR-0021). Existing imports from `./lib/host` keep working.
export * from './domain';
