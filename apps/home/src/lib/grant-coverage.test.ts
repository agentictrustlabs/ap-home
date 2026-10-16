import { describe, expect, it } from 'vitest';
import { interactionsGrantResources, missingGrantScopes } from './grant-coverage';

describe('grant coverage', () => {
  it('a grant issued today names the pairwise secret', () => {
    expect(interactionsGrantResources('demo-mcp')).toContain('vault:identity.pairwise-secret');
  });
  it('reports what an older grant lacks', () => {
    const issued = interactionsGrantResources('demo-mcp');
    const held = issued.filter((r) => r !== 'vault:identity.pairwise-secret');
    expect(missingGrantScopes(issued, held)).toEqual(['vault:identity.pairwise-secret']);
    expect(missingGrantScopes(issued, issued)).toEqual([]);
  });
  it('unknown coverage is not missing', () => {
    expect(missingGrantScopes(['vault:a'], undefined)).toBeNull();
    expect(missingGrantScopes(['vault:a'], [])).toBeNull();
  });
});
