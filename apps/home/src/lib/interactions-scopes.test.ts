import { describe, expect, it } from 'vitest';
import { APP_AGREEMENT_SCOPES, INTERACTIONS_APP_SCOPES } from '@ap-home/shared';

describe('the interactions grant', () => {
  it('lets the person\'s own Home read and amend her agreement-acceptance records', () => {
    expect(APP_AGREEMENT_SCOPES).toEqual(['vault:agreement-acceptance:*']);
    const group = INTERACTIONS_APP_SCOPES.find((g) => g.resources.includes('vault:agreement-acceptance:*'));
    expect(group).toBeDefined();
    expect(group?.ops).toContain('read');
    expect(group?.ops).toContain('write');
  });
});
