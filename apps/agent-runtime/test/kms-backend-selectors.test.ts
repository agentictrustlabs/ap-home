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
