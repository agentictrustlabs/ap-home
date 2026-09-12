import { describe, it, expect } from 'vitest';
import { recipeSaveTarget, recipeSummary } from './recipe';
const FILE = 'pay-the-rent.SKILL.md';   // the corpus's file convention, not a word shown to anyone
const R = { name: 'pay-the-rent', fileName: FILE, capabilities: ['treasury.payment.execute'], roles: [{ role: 'payer', from: 'treasury.payment.execute' }, { role: 'payee', from: 'treasury.payment.execute' }], steps: [{ n: 1, capability: 'treasury.payment.execute', args: { payer: '{payer}', payee: '{payee}', amount: '1200' } }], skillMd: '---\nname: pay-the-rent\n---\n# pay the rent\n', notes: [] };
describe('save as recipe (398 APUX-034)', () => {
  it('saves into the workspace\'s Library as a skill artifact under recipes/, scoped to the org when the run was the org\'s', () => {
    const own = recipeSaveTarget(R, { kind: 'person' });
    expect(own.scopeQuery).toBe(''); expect(own.libraryHref).toBe('/library?folder=recipes');
    expect(own.artifact).toMatchObject({ name: FILE, kind: 'skill', source: 'blob', folder: 'recipes', contentType: 'text/markdown' });
    expect(Buffer.from(own.artifact.bytesB64, 'base64').toString('utf8')).toBe(R.skillMd);
    const org = recipeSaveTarget(R, { kind: 'org', org: '0xABC0000000000000000000000000000000000001' });
    expect(org.scopeQuery).toBe('?org=0xabc0000000000000000000000000000000000001');
    expect(org.libraryHref).toBe('/org/0xabc0000000000000000000000000000000000001/library?folder=recipes');
  });
  it('says what the draft holds and that authority is asked for anew', () => {
    expect(recipeSummary(R)).toBe('1 step · 1 capability · 2 roles ({payer}, {payee}) · no keys, no mandates — authority is asked for anew when it is assigned');
  });
});
