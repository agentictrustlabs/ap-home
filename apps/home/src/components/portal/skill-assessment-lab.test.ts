// Spec 415 §5b — the Lab renders the baked report: what was tested, per-intent right/wrong with the expected and chosen
// skill, per-skill results, recommendations with the change to make, and the glossary. Server-rendered so a runtime
// error or an empty section fails here, not in front of a person.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillAssessmentLab } from './SkillAssessmentLab';
import report from '../../evals/skill-assessment.json';

describe('the Lab', () => {
  const html = renderToStaticMarkup(createElement(SkillAssessmentLab));
  const count = (id: string) => html.split(`data-testid="${id}"`).length - 1;
  it('explains what is tested and states the headline', () => {
    expect(html).toContain('What this tests.');
    for (const h of (report as { headline: string[] }).headline) expect(html).toContain(h.replace(/&/g, '&amp;').slice(0, 30));
  });
  it('lists the recommendations to act on, each with the change to make', () => {
    const act = (report as { recommendations: Array<{ severity: string }> }).recommendations.filter((r) => r.severity === 'act').length;
    expect(count('lab-recommendation')).toBe(act);
    expect(html).toContain('Change:');
  });
  it('shows every test of the selected experiment with what should and what did happen', () => {
    expect(count('lab-intent')).toBeGreaterThan(0);
    expect(html).toMatch(/should be <strong>[^<]+<\/strong> · chose <strong>/);
  });
  it('shows every skill and the glossary', () => {
    expect(count('lab-skill')).toBe((report as { skillContracts: unknown[] }).skillContracts.length);
    expect(html).toContain('should have declined');
    expect(html).toContain('counts as wrong');
  });
});
