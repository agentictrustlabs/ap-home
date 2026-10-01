// Spec 397 §11.4 — the skill a host keeps names every tool and the three rules a host got wrong (the Muse incident).
import { describe, it, expect } from 'vitest';
import { homeSkillMarkdown } from '../src/skill.js';
import { TOOLS } from '../src/tools.js';
import { SERVER } from '../src/whitelabel.js';

describe('the Home skill', () => {
  const md = homeSkillMarkdown('https://home-mcp.example');
  it('names every tool the server offers', () => { for (const t of TOOLS) expect(md).toContain(`\`${t.name}`); });
  it('says a person is reached by a message from their own agent, never by engage or addressee', () => {
    expect(md).toMatch(/send carol\.me a message/);
    expect(md).toMatch(/NEVER a person/);
    expect(md).toMatch(/refuses them for anyone but its own person/);
  });
  it('says what authority_required means and that an act is never re-run to read its reply', () => {
    expect(md).toMatch(/authority_required/); expect(md).toMatch(/grant_link/); expect(md).toMatch(/acted_under/);
    expect(md).toMatch(/Do not re-run an act/);
  });
  it('the initialize instructions carry the same three rules in short', () => {
    expect(SERVER.instructions).toMatch(/person's agent answers only its own person/);
    expect(SERVER.instructions).toMatch(/Never re-run an act/);
    expect(SERVER.instructions).toMatch(/skill\.md/);
  });
});
