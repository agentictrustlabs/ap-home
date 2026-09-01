/**
 * The call gas is sized to the call.
 *
 * `buildCallUserOp` defaults `callGasLimit` to 800k, sized for the heaviest path it knew about (a factory
 * deploy, ~600-700k). A TYPED name claim is heavier: it registers the profile subject, declares
 * `atl:agentType`, and claims the label. Measured on faithchain: 1,080,642 gas — against 302,387 for the
 * untyped claim it replaced. Over the limit the inner call runs out of gas, the userOp fails, and
 * /account/submit-call-userop 500s with nothing on chain to point at.
 *
 * The batch SIMULATES fine (eth_call has no such cap), so nothing about the calls looks wrong; only the
 * gas number shows it. That is why this pins the sizing rule rather than the calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
const HANDLER = SRC.slice(SRC.indexOf("app.post('/account/build-call-userop'"), SRC.indexOf("app.post('/account/submit-call-userop'"));

describe('build-call-userop sizes the call gas', () => {
  it('estimates the call rather than trusting the default', () => {
    expect(HANDLER).toContain('estimateGas');
    expect(HANDLER).toContain('callGasLimit');
  });

  it('adds headroom over the estimate', () => {
    // An estimate is the successful path's cost; a userOp that lands a block later can cost more.
    expect(HANDLER).toMatch(/estimated \* 5n\) \/ 4n/);
  });

  it('only RAISES the limit — a cheap call keeps the smaller default', () => {
    // The paymaster must hold deposit for maxCost, computed from the LIMITS. Raising every op's limit to
    // fix a few would raise the deposit every op needs, so the override applies only above the default.
    expect(HANDLER).toMatch(/sized > 800_000n/);
  });

  it('falls back to the default when the call is not estimable, and says so', () => {
    // Sizing a call is not deciding whether it is allowed — an unestimable call still gets built and
    // fails honestly at submission rather than being refused here.
    expect(HANDLER).toMatch(/catch\s*\{[\s\S]*?default\s*\n?\s*\/\/ stands|catch\s*\{[\s\S]*?estimate-failed/);
  });
});

describe('gas sizing is reported, not silent', () => {
  it('tells the caller whether the limit was measured or defaulted', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain("let gasBasis: 'estimated' | 'default' | 'estimate-failed'");
    expect(src).toContain("gasBasis = 'estimate-failed'");
    expect(src).toMatch(/userOpHash,\n\s*gasBasis,/);
  });
});
