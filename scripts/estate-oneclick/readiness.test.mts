import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNamingGate } from './naming-gate.mts';
import { stampEnvBlock } from './env-blocks.mts';
import { HOSTED_STEPS, OWN_STEPS } from './plan.mts';

test('a retry preserves the gate and custody file; the file stays private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'estate-gate-'));
  try {
    const file = join(dir, '.estate-test.local');
    writeFileSync(file, "RPC_URL='https://rpc.example'\n", { mode: 0o644 });
    const first = ensureNamingGate(file);
    assert.deepEqual(ensureNamingGate(file), first);
    assert.match(readFileSync(file, 'utf8'), /^RPC_URL='https:\/\/rpc.example'/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, 'NAMING_GATE_PRIVATE_KEY=broken\n');
    assert.throws(() => ensureNamingGate(file), /malformed/);
    assert.equal(readFileSync(file, 'utf8'), 'NAMING_GATE_PRIVATE_KEY=broken\n');
  } finally { rmSync(dir, { recursive: true }); }
});

const toml = '[env.faithnet]\nname = "demo-a2a-faithnet"\n[env.faithnet.vars]\nEMAIL_FROM = "old@faithnet.ai"\nEMAIL_ZONES = "faithnet.me"\n[[env.faithnet.send_email]]\nname = "SEND_EMAIL"\n';
const input = {
  id: 'test-estate', app: 'runtime' as const,
  names: { runtime: 'test-runtime', vault: 'test-vault', edge: 'test-edge', homeMcp: 'test-home-mcp', approval: 'test-approval' },
  hosts: { runtime: 'https://runtime.example', vault: 'https://vault.example', edge: 'https://edge.example', homeMcp: 'https://home-mcp.example' },
  homeOrigin: 'https://home.example', derived: {}, siblingExtras: [],
};
test('hosted outbound mail is explicitly configured without inheriting inbound zones', () => {
  const { block } = stampEnvBlock(toml, { ...input, outboundEmail: { from: 'invites@faithnet.ai', name: 'Test Estate' } });
  assert.match(block, /\[\[env.test-estate.send_email\]\]/);
  assert.match(block, /EMAIL_FROM = "invites@faithnet.ai"/);
  assert.match(block, /EMAIL_FROM_NAME = "Test Estate"/);
  assert.doesNotMatch(block, /EMAIL_ZONES|old@/);
});
test('cross-account mail requires the owner to configure a sender', () => {
  assert.doesNotMatch(stampEnvBlock(toml, { ...input, crossAccount: true }).block, /send_email|EMAIL_FROM/);
  const { block } = stampEnvBlock(toml, { ...input, crossAccount: true, outboundEmail: { from: 'signin@owner.example', name: 'Owner' } });
  assert.match(block, /send_email/);
  assert.match(block, /signin@owner.example/);
});
test('hosted approval precedes Home launch; an owner gets approval from the town finish step', () => {
  assert.ok(HOSTED_STEPS.indexOf('names') < HOSTED_STEPS.indexOf('home'));
  assert.ok(OWN_STEPS.finish.includes('names'));
  assert.ok(!(OWN_STEPS.estate as readonly string[]).includes('names'));
});
