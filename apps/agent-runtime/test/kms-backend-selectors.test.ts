/**
 * Every backend the env may NAME must be a backend the selectors can BUILD.
 *
 * `sessionManagerFor` had no `agentic-kms` branch: setting it fell through to `local-aes`, whose
 * production guard then threw at the first envelope call. Fail-closed, so nothing was weakened — but a
 * deployment that had moved every other path to AKCS would find sessions broken for a reason the code
 * never stated. Found while planning the faithchain cutover, not by a test, which is why this exists.
 *
 * The per-deployment split is the point: faithchain runs `agentic-kms`, Base Sepolia stays `gcp-kms`.
 * They are separate Worker envs, so the selectors must handle BOTH — not one with the other as a
 * leftover branch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const FED = readFileSync(new URL('../src/fed-token.ts', import.meta.url), 'utf8');

function fn(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', i + 1);
  const nextExport = src.indexOf('\nexport ', i + 1);
  const end = Math.min(...[next, nextExport].filter((n) => n > -1));
  return src.slice(i, end > 0 ? end : i + 4000);
}

describe('sessionManagerFor', () => {
  const body = fn(SRC, 'sessionManagerFor');

  it('can build agentic-kms', () => {
    expect(body).toContain("backend === 'agentic-kms'");
    expect(body).toContain("backend: 'agentic-kms'");
  });

  it('still builds gcp-kms — Base Sepolia stays on it', () => {
    expect(body).toContain("backend === 'gcp-kms'");
  });

  it('reads the backend from the WORKER env, not only process.env', () => {
    // Workers carry config on the env object; reading only process.env made this selector see
    // `undefined` where every other selector in the file sees the configured backend.
    expect(body).toContain('env.A2A_KMS_BACKEND as KmsBackend');
  });

  it('never falls back to local-aes for a NAMED remote backend', () => {
    // local-aes is reachable only as the final else — never from inside an agentic or gcp branch.
    const agentic = body.slice(body.indexOf("backend === 'agentic-kms'"), body.indexOf("} else if"));
    expect(agentic).not.toContain('local-aes');
  });
});

describe('every envelope selector agrees on the backend set', () => {
  it('fed-token can build both remote backends too', () => {
    const body = fn(FED, 'envelopeProvider');
    expect(body).toContain("backend === 'agentic-kms'");
    expect(body).toContain("backend: 'gcp-kms'");
  });
});

describe('custody derivation honours the configured backend', () => {
  const IDX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const AKCS = readFileSync(new URL('../src/akcs.ts', import.meta.url), 'utf8');

  it('EVERY deriveSubjectCustodian call passes the backend', () => {
    // `deriveSubjectCustodian` defaults to local-aes when no backend is passed, and not one of these
    // call sites passed one — so person custody (C_sub) was derived in-process by HKDF whatever
    // A2A_KMS_BACKEND said. Flipping the env would have moved the relayer and the envelopes and left
    // the custody master exactly where it was.
    const lines = IDX.split('\n');
    const missed: number[] = [];
    lines.forEach((line, i) => {
      if (!line.includes('deriveSubjectCustodian(')) return;
      const window = lines.slice(i, i + 3).join('\n');
      if (!window.includes('custodyDerivationOpts(')) missed.push(i + 1);
    });
    expect(missed, `call sites still defaulting to local-aes: ${missed.join(', ')}`).toEqual([]);
  });

  it('there is at least one such call site, so the check cannot pass vacuously', () => {
    expect(IDX.split('\n').filter((l) => l.includes('deriveSubjectCustodian(')).length).toBeGreaterThan(5);
  });

  it('custody may be pinned separately from the deployment backend', () => {
    // A staged cutover moves one path at a time; absent the override, custody follows the deployment.
    expect(AKCS).toContain('A2A_CUSTODY_KMS_BACKEND');
  });

  it('agentic-kms custody fails closed on missing AKCS config', () => {
    // agenticKmsConfig throws on a missing value — a custody key is the last thing that should
    // quietly downgrade.
    const fn = AKCS.slice(AKCS.indexOf('export function custodyDerivationOpts'));
    expect(fn).toContain('agenticKmsConfig(env');
    expect(fn).not.toContain("?? 'local-aes'\n    ;");
  });
});
