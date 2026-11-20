import { describe, expect, it } from 'vitest';
import { ACCOUNT_DEPLOYED_TOPIC, accountDeployedFor } from './deploy-landed.js';

const ME = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const OTHER = '0x1111111111111111111111111111111111111111';
const pad = (a: string) => `0x${'0'.repeat(24)}${a.toLowerCase().slice(2)}`;
const deployed = (sender: string) => ({ topics: [ACCOUNT_DEPLOYED_TOPIC, `0x${'ab'.repeat(32)}`, pad(sender)] });

describe('accountDeployedFor', () => {
  it('is true only for an AccountDeployed event naming this sender', () => {
    expect(accountDeployedFor({ logs: [deployed(ME)] }, ME)).toBe(true);
    expect(accountDeployedFor({ logs: [deployed(ME)] }, ME.toLowerCase())).toBe(true);
  });
  it('is false for a receipt with no logs — a batch that reverted outright', () => {
    expect(accountDeployedFor({ logs: [] }, ME)).toBe(false);
    expect(accountDeployedFor({}, ME)).toBe(false);
  });
  it('is false when the only account created in the bundle is someone else’s', () => {
    expect(accountDeployedFor({ logs: [deployed(OTHER)] }, ME)).toBe(false);
  });
  it('ignores other events that happen to carry the sender', () => {
    expect(accountDeployedFor({ logs: [{ topics: [`0x${'49'.repeat(32)}`, `0x${'ab'.repeat(32)}`, pad(ME)] }] }, ME)).toBe(false);
  });
});
