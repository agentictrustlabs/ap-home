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
/** The sizing rule itself. It lives in one helper because TWO endpoints need it — `/account/build-call-
 *  userop` and `/custody/oidc/name-agent`, whose typed claim is the call that exposed the limit. */
const SIZER = SRC.slice(SRC.indexOf('async function sizeCallGas'), SRC.indexOf('function subregistryForTld'));
const HANDLER = SRC.slice(SRC.indexOf("app.post('/account/build-call-userop'"), SRC.indexOf("app.post('/account/submit-call-userop'"));

describe('the call-gas sizing rule', () => {
  it('estimates the call rather than trusting the default', () => {
    expect(SIZER).toContain('estimateGas');
    expect(SIZER).toContain('callGasLimit');
  });

  it('is applied by every endpoint that builds a CALL userOp', () => {
    // Deploy ops default to 2.5M and have headroom; call ops default to 800k and do not.
    expect(HANDLER).toContain('sizeCallGas(c.env, body.sender, body.callData)');
    expect(SRC).toContain('sizeCallGas(c.env, body.agent, callData)');
  });

  it('adds headroom over the estimate', () => {
    // An estimate is the successful path's cost; a userOp that lands a block later can cost more.
    expect(SIZER).toMatch(/estimated \* 5n\) \/ 4n/);
  });

  it('only RAISES the limit — a cheap call keeps the smaller default', () => {
    // The paymaster must hold deposit for maxCost, computed from the LIMITS. Raising every op's limit to
    // fix a few would raise the deposit every op needs, so the override applies only above the default.
    expect(SIZER).toMatch(/sized > 800_000n/);
  });

  it('falls back to the default when the call is not estimable, and says so', () => {
    // Sizing a call is not deciding whether it is allowed — an unestimable call still gets built and
    // fails honestly at submission rather than being refused here.
    expect(SIZER).toMatch(/catch\s*\{[\s\S]*?estimate-failed/);
  });
});

describe('gas sizing is reported, not silent', () => {
  it('tells the caller whether the limit was measured or defaulted', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain("gasBasis: 'estimated' | 'default' | 'estimate-failed'");
    expect(src).toContain("gasBasis: 'estimate-failed'");
    expect(src).toMatch(/userOpHash,\n\s*gasBasis,/);
  });
});
