// spec 334 §6 gather phase — the SPARQL guard is the security boundary for LLM-authored queries
// against the shared public triplestore. The data is public, so the threat is ABUSE of the store:
// mutation, federation (SSRF), and heap/time exhaustion. These lock the refusals.
import { describe, expect, it } from 'vitest';

import { guardSparql, digestRows, PUBLIC_GRAPH_MAX_QUERY_CHARS } from '../src/public-graph.js';

describe('guardSparql — read-only enforcement', () => {
  it('accepts a bounded SELECT', () => {
    expect(guardSparql('SELECT ?s WHERE { ?s a ?t } LIMIT 10').ok).toBe(true);
  });

  it('accepts an ASK', () => {
    expect(guardSparql('ASK { ?s a ?t }').ok).toBe(true);
  });

  it('refuses every SPARQL Update / management verb', () => {
    for (const q of [
      'INSERT DATA { <a> <b> <c> }',
      'DELETE WHERE { ?s ?p ?o }',
      'DROP GRAPH <g>',
      'CLEAR ALL',
      'CREATE GRAPH <g>',
      'LOAD <http://evil/data>',
      'WITH <g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }',
    ]) {
      const r = guardSparql(q);
      expect(r.ok, q).toBe(false);
      expect(r.error).toMatch(/read-only|SELECT/i);
    }
  });

  it('refuses SERVICE (federation / SSRF)', () => {
    const r = guardSparql('SELECT ?s WHERE { SERVICE <http://attacker/sparql> { ?s ?p ?o } } LIMIT 5');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SERVICE|federation/i);
  });

  it('refuses a non-SELECT/ASK body even without a mutation verb', () => {
    expect(guardSparql('DESCRIBE <http://example/thing>').ok).toBe(false);
  });

  it('refuses empty and over-long queries', () => {
    expect(guardSparql('').ok).toBe(false);
    expect(guardSparql('   ').ok).toBe(false);
    expect(guardSparql('SELECT ?s WHERE { ?s ?p ?o } # ' + 'x'.repeat(PUBLIC_GRAPH_MAX_QUERY_CHARS)).ok).toBe(false);
  });

  it('is not fooled by lowercase or leading prefixes', () => {
    expect(guardSparql('PREFIX gc:<x:> select ?s where { ?s a gc:Thing } limit 3').ok).toBe(true);
    expect(guardSparql('PREFIX gc:<x:> delete where { ?s ?p ?o }').ok).toBe(false);
  });

  it('does not false-positive on verbs appearing inside identifiers/labels', () => {
    // "loaded"/"created" contain LOAD/CREATE as substrings but not as words.
    expect(guardSparql('SELECT ?loadedAt ?createdBy WHERE { ?s <p:loadedAt> ?loadedAt } LIMIT 5').ok).toBe(true);
  });
});

describe('digestRows — bounded rendering', () => {
  it('renders a header + rows', () => {
    const out = digestRows('Query 1', [{ pg: 'Kurux', country: 'India' }, { pg: 'Sora', country: 'India' }]);
    expect(out).toContain('Query 1');
    expect(out).toContain('pg | country');
    expect(out).toContain('Kurux | India');
  });

  it('handles the no-rows case', () => {
    expect(digestRows('Query 2', [])).toBe('Query 2: (no rows)');
  });
});
